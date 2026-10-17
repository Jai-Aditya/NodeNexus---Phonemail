// Apple Push Notification service (APNs) for the iPhone app: HTTP/2 to Apple, authorised with a
// short-lived ES256 token signed by the .p8 key made in the Apple Developer account. No library needed.
// The notification carries the "NEW_MAIL" category, whose Reply and Mark as read actions the app
// handles (they show on a paired Apple Watch too).

import http2 from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PRODUCTION = 'https://api.push.apple.com';
const SANDBOX = 'https://api.sandbox.push.apple.com'; // apps built for development

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** What Apple delivers to the app for one new email. */
export function apnsPayload({ title, body, conversation_id, message_id }) {
  return {
    aps: {
      alert: { title, body },
      sound: 'default',
      'thread-id': `conv-${conversation_id}`, // groups a chat's notifications together
      category: 'NEW_MAIL',
      'mutable-content': 1,
    },
    conversation_id,
    message_id,
  };
}

/** The provider token Apple asks for: {alg ES256, kid} . {iss team, iat}, signed with the .p8 key. */
export function apnsJwt({ key, keyId, teamId }, now = Math.floor(Date.now() / 1000)) {
  const unsigned = `${b64({ alg: 'ES256', kid: keyId })}.${b64({ iss: teamId, iat: now })}`;
  const sig = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${unsigned}.${sig}`;
}

/**
 * A sender for the given key: send(deviceToken, payload, sandbox) resolves to 'sent', or 'gone' when
 * Apple says the token is no longer valid (the app was removed, or the token belongs elsewhere).
 */
export function apnsSender({ keyFile, keyId, teamId, topic }) {
  const key = createPrivateKey(readFileSync(keyFile));
  const sessions = new Map();
  let jwt = null;
  let jwtAt = 0;

  // Apple accepts a token for an hour and dislikes a new one more than every 20 minutes.
  function authorization() {
    const now = Math.floor(Date.now() / 1000);
    if (!jwt || now - jwtAt > 40 * 60) {
      jwt = apnsJwt({ key, keyId, teamId }, now);
      jwtAt = now;
    }
    return `bearer ${jwt}`;
  }

  // One HTTP/2 connection per Apple host, reused for every notification.
  function session(sandbox) {
    const host = sandbox ? SANDBOX : PRODUCTION;
    let s = sessions.get(host);
    if (!s || s.closed || s.destroyed) {
      s = http2.connect(host);
      s.on('error', () => sessions.delete(host));
      s.on('goaway', () => { sessions.delete(host); s.close(); });
      s.unref();
      sessions.set(host, s);
    }
    return s;
  }

  return (deviceToken, payload, sandbox = false) => new Promise((resolve, reject) => {
    let req;
    try {
      req = session(sandbox).request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: authorization(),
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
    } catch (err) {
      return reject(err);
    }
    let status = 0;
    let data = '';
    req.setTimeout(15_000, () => { req.close(); reject(new Error('APNs did not answer in time')); });
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (status === 200) return resolve('sent');
      let reason = '';
      try { reason = JSON.parse(data).reason || ''; } catch { /* no body */ }
      if (status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(reason)) return resolve('gone');
      reject(new Error(`APNs ${status} ${reason}`.trim()));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}
