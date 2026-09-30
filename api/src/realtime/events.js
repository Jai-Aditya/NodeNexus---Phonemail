// Live updates. The mail service announces each delivery and group change with
// pg_notify('mail_events', ...). We LISTEN for it and stream it to the user's open browser
// tabs and apps (Server-Sent Events). Push/SMS alerts are sent by alerts.js.

import { sendJson } from '../http/util.js';

export class EventHub {
  /**
   * opts.maxPerUser: open streams allowed per user (the oldest is closed beyond that).
   * opts.sessionAlive(hashes): resolves to the subset of session hashes that still exist;
   * checked every few minutes so streams also end when a session expires or is deleted
   * some other way (another API instance, an admin, the database).
   */
  constructor({ maxPerUser = 5, sessionAlive = null, recheckMs = 5 * 60_000 } = {}) {
    this.clients = new Map(); // userId -> Map(res -> sessionHash), oldest first
    this.maxPerUser = maxPerUser;
    this.heartbeat = setInterval(() => this.broadcastComment('ping'), 25_000);
    this.heartbeat.unref?.();
    if (sessionAlive) {
      this.recheck = setInterval(() => this.dropDeadSessions(sessionAlive).catch(() => {}), recheckMs);
      this.recheck.unref?.();
    }
  }

  /** GET /api/events: keeps the response open and writes events as they happen. */
  open(req, res, userId, sessionHash) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tell proxies like nginx not to buffer the stream
    });
    res.write('retry: 3000\n\n'); // browsers reconnect after 3s if the connection drops
    let streams = this.clients.get(userId);
    if (!streams) this.clients.set(userId, (streams = new Map()));
    streams.set(res, sessionHash);
    // Over the limit: close the oldest. Removed from the map right away, because the
    // 'close' event that normally removes it only fires later.
    for (const old of streams.keys()) {
      if (streams.size <= this.maxPerUser) break;
      streams.delete(old);
      old.end();
    }
    this.send(userId, 'ready', { user_id: userId });
    res.on('close', () => {
      streams.delete(res);
      if (!streams.size && this.clients.get(userId) === streams) this.clients.delete(userId);
    });
  }

  send(userId, type, data) {
    const streams = this.clients.get(userId);
    if (!streams) return 0;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams.keys()) res.write(frame);
    return streams.size;
  }

  broadcastComment(text) {
    for (const streams of this.clients.values()) for (const res of streams.keys()) res.write(`: ${text}\n\n`);
  }

  isOnline(userId) {
    return this.clients.has(userId);
  }

  /** Ends the streams opened with these sessions (logout). */
  closeSessions(hashes) {
    const drop = new Set(hashes);
    for (const streams of this.clients.values()) {
      for (const [res, hash] of streams) if (drop.has(hash)) res.end();
    }
  }

  /** Ends a user's streams, except those of one session (log out everywhere, password change). */
  closeUser(userId, exceptHash = null) {
    const streams = this.clients.get(userId);
    if (!streams) return;
    for (const [res, hash] of streams) if (hash !== exceptHash) res.end();
  }

  async dropDeadSessions(sessionAlive) {
    const all = new Set();
    for (const streams of this.clients.values()) for (const hash of streams.values()) all.add(hash);
    if (!all.size) return;
    const alive = new Set(await sessionAlive([...all]));
    this.closeSessions([...all].filter((h) => !alive.has(h)));
  }

  close() {
    clearInterval(this.heartbeat);
    clearInterval(this.recheck);
    for (const streams of this.clients.values()) for (const res of streams.keys()) res.end();
    this.clients.clear();
  }
}

/** Handles one mail_events notification: live updates to open tabs and apps. */
export async function handleMailEvent(raw, { hub, alerts }) {
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    console.error('bad mail event:', raw);
    return;
  }
  const recipients = Array.isArray(ev.user_ids) ? ev.user_ids : [];

  // Live update for recipients, and for the sender's other tabs/devices.
  for (const uid of recipients) hub.send(uid, ev.type, ev);
  if (ev.sender_id && !recipients.includes(ev.sender_id)) hub.send(ev.sender_id, ev.type, ev);

  // Push/SMS alerts are queued by the mail service with the delivery itself (alert_queue);
  // this only tells the sender to look now instead of at its next check.
  if (ev.type === 'message') alerts?.wake();
}

/** Starts listening for mail events; postgres.js reconnects automatically. */
export async function listenForMailEvents(deps) {
  return deps.sql.listen('mail_events', (payload) => {
    handleMailEvent(payload, deps).catch((err) => console.error('mail event failed:', err));
  });
}

export function eventsRoute(hub) {
  return async (req, res) => {
    if (req.method === 'HEAD') return sendJson(res, 200, {});
    hub.open(req, res, req.user.id, req.user.session_hash);
  };
}
