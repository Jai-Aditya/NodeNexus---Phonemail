// Web Push without a library: VAPID sign-in (RFC 8292) + payload encryption (RFC 8291, "aes128gcm").
// The browser gives us a subscription { endpoint, keys: { p256dh, auth } }; to notify it we POST
// an encrypted message to that endpoint (a push service run by Google, Mozilla or Apple).

import {
  createECDH, createHmac, createCipheriv, randomBytes, generateKeyPairSync, createPrivateKey, sign,
} from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** A new VAPID key pair: the server's identity towards push services. */
export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const publicKey = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return { publicKey: b64u(publicKey), privateKey: jwk.d };
}

function privateKeyObject(vapid) {
  const pub = fromB64u(vapid.publicKey);
  return createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
}

/** The Authorization header proving to the push service that this server sent the message. */
export function vapidAuthorization(endpoint, vapid, subject, now = Date.now()) {
  const audience = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const unsigned = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: privateKeyObject(vapid), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/**
 * Encrypts `payload` for one browser (RFC 8291). `asKeys` and `salt` are random in real use;
 * tests pass the RFC's fixed values to check the output byte for byte.
 */
export function encryptPayload(payload, p256dh, authSecret, { asPrivateKey, salt } = {}) {
  const uaPublic = fromB64u(p256dh);
  const auth = fromB64u(authSecret);
  const ecdh = createECDH('prime256v1');
  if (asPrivateKey) ecdh.setPrivateKey(fromB64u(asPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 65 bytes, uncompressed
  salt = salt ? fromB64u(salt) : randomBytes(16);

  // Shared secret, then HKDF steps exactly as RFC 8291 section 3.4.
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(auth, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  // One record: the payload, then the 0x02 "last record" delimiter.
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // Header: salt (16) | record size (4) | key id length (1) | key id = our public key (65)
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

/**
 * Sends one push. Returns 'ok', or 'gone' when the browser unsubscribed
 * (the caller should delete that subscription).
 */
export async function sendPush(subscription, payload, vapid, subject) {
  const body = encryptPayload(JSON.stringify(payload), subscription.p256dh, subscription.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) throw new Error(`push service returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return 'ok';
}
