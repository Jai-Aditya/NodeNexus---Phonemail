// Push subscriptions per user, and the server's VAPID keys (generated once, kept in the database).

import { generateVapidKeys, sendPush } from './webpush.js';
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

export function pushStore(sql, cfg) {
  let vapid = null;

  async function refreshHasPush(userId) {
    await sql`UPDATE users SET has_push = EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = ${userId})
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

    /** Pushes to every browser the user subscribed; drops subscriptions that no longer exist. */
    async notify(userId, payload) {
      const subs = await sql`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ${userId}`;
      const keys = await this.vapidKeys();
      let delivered = 0;
      for (const s of subs) {
        try {
          if ((await sendPush(s, payload, keys, cfg.vapidSubject)) === 'gone') {
            await sql`DELETE FROM push_subscriptions WHERE endpoint = ${s.endpoint}`;
          } else {
            delivered++;
          }
        } catch (err) {
          console.error(`push to user ${userId} failed: ${err.message}`);
        }
      }
      if (delivered < subs.length) await refreshHasPush(userId);
      return delivered;
    },
  };
}
