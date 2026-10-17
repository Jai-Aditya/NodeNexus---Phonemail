// Push subscriptions per user, and the server's VAPID keys (generated once, kept in the database).
// Browsers subscribe with Web Push; the phone apps register a device token (iPhone: APNs, Android:
// FCM). A notification goes to all of them.

import { generateVapidKeys, sendPush } from './webpush.js';
import { apnsPayload, apnsSender } from './apns.js';
import { fcmSender } from './fcm.js';
import { badRequest, conflict } from '../http/util.js';

// The push services browsers use: Chrome/Edge-on-Android (Google), Firefox (Mozilla),
// Safari (Apple), Edge on Windows (Microsoft).
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];
const MAX_SUBSCRIPTIONS = 10; // browsers/apps with notifications on, per person
// Device tokens: APNs gives 64 hex characters (longer is allowed for the future); FCM tokens are
// long and made of letters, digits, '-', '_' and ':'.
const TOKEN_FORMAT = { ios: /^[0-9a-f]{64,200}$/i, android: /^[\w:-]{20,4096}$/ };

/** The phone senders from the settings; a platform whose key isn't set up gets none (its tokens wait). */
export function mobileSenders(cfg) {
  const out = {};
  try {
    if (cfg.apns?.keyFile && cfg.apns.keyId && cfg.apns.teamId) out.apns = apnsSender(cfg.apns);
  } catch (err) {
    console.error(`APNs is not set up: ${err.message}`);
  }
  try {
    if (cfg.fcm?.serviceAccountFile) out.fcm = fcmSender(cfg.fcm);
  } catch (err) {
    console.error(`FCM is not set up: ${err.message}`);
  }
  return out;
}

export function pushStore(sql, cfg, senders = mobileSenders(cfg)) {
  let vapid = null;

  async function refreshHasPush(userId) {
    await sql`UPDATE users SET has_push = EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = ${userId})
                                       OR EXISTS (SELECT 1 FROM mobile_push_tokens WHERE user_id = ${userId})
              WHERE id = ${userId}`;
  }

  return {
    /** Loads the VAPID keys, creating them on first start. */
    async vapidKeys() {
      if (vapid) return vapid;
      const fresh = generateVapidKeys();
      await sql`INSERT INTO app_settings (key, value) VALUES ('vapid', ${sql.json(fresh)})
                ON CONFLICT (key) DO NOTHING`;
      const [row] = await sql`SELECT value FROM app_settings WHERE key = 'vapid'`;
      vapid = row.value;
      return vapid;
    },

    async subscribe(userId, sub, userAgent = '') {
      const endpoint = sub?.endpoint;
      const p256dh = sub?.keys?.p256dh;
      const auth = sub?.keys?.auth;
      if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
        throw badRequest('Send the browser\'s PushSubscription (endpoint and keys.p256dh, keys.auth).');
      }
      let url;
      try {
        url = new URL(endpoint);
      } catch {
        throw badRequest('Invalid push endpoint.');
      }
      if (!cfg.allowInsecurePush) { // (tests use a local fake push service)
        if (url.protocol !== 'https:') throw badRequest('Push endpoints must use https.');
        // Only real browser push services: otherwise anyone could make the server send
        // requests to an address of their choosing (e.g. something inside the network).
        if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) throw badRequest('Unknown push service.');
      }
      if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) {
        throw badRequest('Invalid push subscription keys.');
      }
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM push_subscriptions
                                    WHERE user_id = ${userId} AND endpoint <> ${endpoint}`;
      if (count >= MAX_SUBSCRIPTIONS) {
        throw conflict('too_many_devices', `Notifications are on for ${MAX_SUBSCRIPTIONS} browsers or apps already. Turn them off on one first.`);
      }
      await sql`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
        VALUES (${userId}, ${endpoint}, ${p256dh}, ${auth}, ${userAgent.slice(0, 300)})
        ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`;
      await refreshHasPush(userId);
    },

    async unsubscribe(userId, endpoint) {
      await sql`DELETE FROM push_subscriptions WHERE user_id = ${userId} AND endpoint = ${endpoint ?? ''}`;
      await refreshHasPush(userId);
    },

    /**
     * A phone app's device token: {platform: "ios" | "android", token, sandbox?}, tied to the session
     * that registered it (the token is removed when that session ends).
     */
    async registerDevice(userId, body, sessionHash = null) {
      const platform = body?.platform;
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (!TOKEN_FORMAT[platform]) throw badRequest('platform must be ios or android.');
      if (!TOKEN_FORMAT[platform].test(token)) throw badRequest('Invalid device token.');
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM mobile_push_tokens
                                    WHERE user_id = ${userId} AND token <> ${token}`;
      if (count >= MAX_SUBSCRIPTIONS) {
        throw conflict('too_many_devices', `Notifications are on for ${MAX_SUBSCRIPTIONS} phones already. Sign out on one first.`);
      }
      // The same phone signed in as someone else before: the token moves to this person.
      const [before] = await sql`SELECT user_id FROM mobile_push_tokens WHERE token = ${token}`;
      await sql`
        INSERT INTO mobile_push_tokens (user_id, platform, token, sandbox, session_hash)
        VALUES (${userId}, ${platform}, ${token}, ${body.sandbox === true}, ${sessionHash})
        ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
          sandbox = EXCLUDED.sandbox, session_hash = EXCLUDED.session_hash, last_seen_at = now()`;
      await refreshHasPush(userId);
      if (before && before.user_id !== userId) await refreshHasPush(before.user_id);
    },

    async unregisterDevice(userId, token) {
      await sql`DELETE FROM mobile_push_tokens WHERE user_id = ${userId} AND token = ${String(token ?? '')}`;
      await refreshHasPush(userId);
    },

    /**
     * Pushes to every browser and phone of the user; drops subscriptions and tokens that no longer
     * exist. Returns how many were delivered (0 makes the alert fall back to SMS).
     */
    async notify(userId, payload) {
      const subs = await sql`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ${userId}`;
      const phones = await sql`SELECT token, platform, sandbox FROM mobile_push_tokens WHERE user_id = ${userId}`;
      let delivered = 0;
      let dropped = false;
      if (subs.length) {
        const keys = await this.vapidKeys();
        for (const s of subs) {
          try {
            if ((await sendPush(s, payload, keys, cfg.vapidSubject)) === 'gone') {
              await sql`DELETE FROM push_subscriptions WHERE endpoint = ${s.endpoint}`;
              dropped = true;
            } else {
              delivered++;
            }
          } catch (err) {
            console.error(`push to user ${userId} failed: ${err.message}`);
          }
        }
      }
      for (const p of phones) {
        const send = p.platform === 'ios' ? senders.apns : senders.fcm;
        if (!send) continue; // that platform isn't set up on this server yet
        try {
          const result = p.platform === 'ios'
            ? await send(p.token, apnsPayload(payload), p.sandbox)
            : await send(p.token, payload);
          if (result === 'gone') {
            await sql`DELETE FROM mobile_push_tokens WHERE token = ${p.token}`;
            dropped = true;
          } else {
            delivered++;
          }
        } catch (err) {
          console.error(`${p.platform} push to user ${userId} failed: ${err.message}`);
        }
      }
      // Also when nothing got through: tokens may have left with their sessions since has_push was set.
      if (dropped || delivered === 0 || delivered < subs.length + phones.length) await refreshHasPush(userId);
      return delivered;
    },
  };
}
