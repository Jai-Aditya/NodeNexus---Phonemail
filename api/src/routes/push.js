// Browser push notifications. The frontend's service worker subscribes with our public
// VAPID key and sends the subscription here. Users with a subscription get pushes instead of SMS.

import { sendJson, readJson } from '../http/util.js';
import { requireUser } from '../auth/sessions.js';

export function pushRoutes(router, { sessions, push }) {
  const auth = (h) => requireUser(sessions, h);

  router.get('/api/push/public-key', async (req, res) => {
    sendJson(res, 200, { public_key: (await push.vapidKeys()).publicKey });
  });

  router.post('/api/push/subscriptions', auth(async (req, res) => {
    const body = await readJson(req);
    await push.subscribe(req.user.id, body.subscription ?? body, req.headers['user-agent'] || '');
    sendJson(res, 201, { ok: true });
  }));

  router.delete('/api/push/subscriptions', auth(async (req, res) => {
    const body = await readJson(req);
    await push.unsubscribe(req.user.id, body.endpoint);
    sendJson(res, 200, { ok: true });
  }));
}
