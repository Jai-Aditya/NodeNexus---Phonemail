// Firebase Cloud Messaging (HTTP v1) for the Android app. The server signs in to Google with the
// Firebase project's service account (an RS256 assertion exchanged for an hour-long access token)
// and sends one message per device. Messages are data-only: the app builds the notification itself,
// with its Reply and Mark as read actions (which show on Wear OS watches too).

import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** The FCM message for one new email (data values must be strings). */
export function fcmMessage(token, { title, body, conversation_id, message_id }) {
  return {
    token,
    android: { priority: 'high' },
    data: {
      type: 'new_mail',
      title: String(title),
      body: String(body),
      conversation_id: String(conversation_id),
      message_id: String(message_id),
    },
  };
}

/** A sender for the service account: send(deviceToken, payload) resolves to 'sent' or 'gone'. */
export function fcmSender({ serviceAccountFile }) {
  const sa = JSON.parse(readFileSync(serviceAccountFile, 'utf8'));
  const key = createPrivateKey(sa.private_key);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  let access = null;
  let until = 0;

  async function bearer() {
    if (access && Date.now() < until - 60_000) return access;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat: now, exp: now + 3600,
    })}`;
    const assertion = `${unsigned}.${sign('sha256', Buffer.from(unsigned), key).toString('base64url')}`;
    const r = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`FCM sign-in failed (${r.status})`);
    const j = await r.json();
    access = j.access_token;
    until = Date.now() + (j.expires_in || 3600) * 1000;
    return access;
  }

  return async (deviceToken, payload) => {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: fcmMessage(deviceToken, payload) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return 'sent';
    const text = await r.text();
    // The app was removed or the token replaced: forget the token.
    if (r.status === 404 || /UNREGISTERED/.test(text) || (r.status === 400 && /registration token/i.test(text))) return 'gone';
    throw new Error(`FCM ${r.status} ${text.slice(0, 200)}`);
  };
}
