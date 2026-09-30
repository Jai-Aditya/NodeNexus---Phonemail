// New-mail alerts, sent from the alert_queue table the mail service fills in the same
// transaction as each delivery (so no alert is lost to a restart or a dropped connection).
//
// For each queued alert: a push notification if the person enabled push on some device,
// otherwise (the brief) an SMS: "You have received an email from <Sender>. Subject: <Subject>."
//   - SMS go out one after another at SMS_PER_SECOND (Twilio refuses bursts from one number);
//   - at most one SMS per person per chat every SMS_ALERT_MINUTES (checked in the table,
//     so it holds across restarts);
//   - a failure Twilio may recover from (busy, server error, network) is retried with
//     growing waits, up to 5 attempts; other failures (e.g. an invalid number) are final.

import { TwilioError } from '../twilio/client.js';
import { maskPhone } from '../auth/phone.js';

const MAX_ATTEMPTS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cuts text to max characters on a character boundary, adding "…". */
export function shorten(text, max) {
  const chars = [...String(text ?? '').replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('').trimEnd() + '…';
}

export class AlertSender {
  constructor({ sql, push, twilio, cfg }) {
    Object.assign(this, { sql, push, twilio, cfg });
    this.nextSmsAt = 0;
    this.stopped = true;
  }

  /** Runs until stop(): works through the queue, then waits for wake() or 5 seconds. */
  start() {
    this.stopped = false;
    this.purgeTimer = setInterval(() => this.purge().catch(() => {}), 3600_000);
    this.purgeTimer.unref?.();
    this.done = (async () => {
      while (!this.stopped) {
        let n = 0;
        try {
          n = await this.runOnce();
        } catch (err) {
          console.error(`alerts: ${err.message}`);
        }
        if (n === 0 && !this.stopped) await this.idle(5000);
      }
    })();
  }

  /** A new message arrived (mail_events): look at the queue now rather than in 5 s. */
  wake() {
    this.wakeup?.();
  }

  idle(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.wakeup = () => { this.wakeup = null; done(); };
    });
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.purgeTimer);
    this.wake();
    await this.done;
  }

  /**
   * Claims a batch of due alerts and handles them in order. Claiming pushes each row's
   * next_attempt_at 2 minutes ahead (a lease): if this process dies mid-batch, the rows
   * become due again and are retried; another API process would skip them meanwhile.
   */
  async runOnce(batch = 50) {
    const rows = await this.sql`
      UPDATE alert_queue SET next_attempt_at = now() + interval '2 minutes'
      WHERE id IN (SELECT id FROM alert_queue WHERE status = 'pending' AND next_attempt_at <= now()
                   ORDER BY id LIMIT ${batch} FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id, conversation_id, message_id, sender_id, subject, attempts`;
    rows.sort((a, b) => a.id - b.id);
    for (const a of rows) {
      if (this.stopped && this.done) break; // shutting down: the lease returns them to the queue
      await this.deliver(a);
    }
    return rows.length;
  }

  async deliver(a) {
    const { sql, cfg } = this;
    const [u] = await sql`SELECT phone, has_push FROM users WHERE id = ${a.user_id}`;
    if (!u) return this.finish(a, 'skipped', 'recipient no longer exists');
    if (!u.phone) return this.finish(a, 'skipped', 'recipient is outside PhoneMail'); // they get it by email
    // addr_key: the sender's 10 digits, or an outside sender's whole address (Gmail etc.).
    const [s] = a.sender_id ? await sql`SELECT display_name, addr_key FROM users WHERE id = ${a.sender_id}` : [];
    const address = s ? (s.addr_key.includes('@') ? s.addr_key : `${s.addr_key}@${cfg.mailDomain}`) : null;
    const from = !s ? 'Deleted account' : s.display_name ? `${shorten(s.display_name, 30)} (${address})` : address;
    const subject = a.subject.trim() || '(no subject)';
    try {
      if (u.has_push) {
        const delivered = await this.push.notify(a.user_id, {
          title: from, body: subject, conversation_id: a.conversation_id, message_id: a.message_id,
        });
        if (delivered > 0) return this.finish(a, 'push');
        // No working subscription any more: fall back to SMS, like a user without the app.
      }
      if (!cfg.smsAlerts) return this.finish(a, 'skipped', 'SMS_ALERTS is off');
      const [recent] = await sql`
        SELECT 1 FROM alert_queue
        WHERE user_id = ${a.user_id} AND conversation_id = ${a.conversation_id} AND status = 'sms'
          AND done_at > now() - ${cfg.smsAlertMinutes} * interval '1 minute'
        LIMIT 1`;
      if (recent) return this.finish(a, 'skipped', 'texted about this chat recently');

      // Pace: one text per 1/SMS_PER_SECOND seconds from our number.
      const wait = this.nextSmsAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextSmsAt = Date.now() + 1000 / cfg.smsPerSecond;
      // The subject is cut so a long, attacker-written subject can't become a free
      // multi-part (or phishing) text from our number.
      const result = await this.twilio.sendSms(u.phone,
        `You have received an email from ${from}. Subject: ${shorten(subject, 40)}.`);
      return this.finish(a, result === 'sent' ? 'sms' : 'skipped', result === 'sent' ? null : result);
    } catch (err) {
      const retryable = err instanceof TwilioError ? err.status === 429 || err.status >= 500 : true;
      const attempts = a.attempts + 1;
      if (!retryable || attempts >= MAX_ATTEMPTS) {
        console.error(`alert to ${maskPhone(u.phone)} failed for good: ${err.message}`);
        return this.finish(a, 'failed', err.message, attempts);
      }
      const delay = Math.min(3600, 30 * 2 ** (attempts - 1)); // 30 s, 1 min, 2 min, 4 min
      await sql`UPDATE alert_queue SET attempts = ${attempts}, last_error = ${String(err.message).slice(0, 500)},
                  next_attempt_at = now() + ${delay} * interval '1 second'
                WHERE id = ${a.id}`;
    }
  }

  async finish(a, status, note = null, attempts = a.attempts) {
    await this.sql`UPDATE alert_queue SET status = ${status}, done_at = now(), attempts = ${attempts},
                     last_error = ${note && String(note).slice(0, 500)}
                   WHERE id = ${a.id}`;
  }

  /** Finished alerts are kept a week (for the one-SMS-per-chat rule and for checking), then removed. */
  async purge() {
    await this.sql`DELETE FROM alert_queue WHERE status <> 'pending' AND created_at < now() - interval '7 days'`;
  }
}
