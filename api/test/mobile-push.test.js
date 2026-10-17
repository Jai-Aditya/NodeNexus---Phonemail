// Phone app notifications: device tokens, and new-mail alerts sent through Apple (APNs) and
// Firebase (FCM). The real senders are replaced by fakes that record what they were asked to send.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { freshDatabase, fakeMailService, startApp } from './helpers.js';
import { apnsJwt, apnsPayload } from '../src/push/apns.js';
import { fcmMessage } from '../src/push/fcm.js';

const IOS_TOKEN = 'ab'.repeat(32);
const ANDROID_TOKEN = 'fcm-token_123:APA91b-example-token-value';

let sql, mail, app;
const sent = { apns: [], fcm: [] };
const answer = { apns: 'sent', fcm: 'sent' };

before(async () => {
  sql = await freshDatabase();
  mail = await fakeMailService();
  app = await startApp(sql, {}, {
    mail,
    pushSenders: {
      apns: async (token, payload, sandbox) => { sent.apns.push({ token, payload, sandbox }); return answer.apns; },
      fcm: async (token, payload) => { sent.fcm.push({ token, payload }); return answer.fcm; },
    },
  });
});

after(async () => {
  await app?.close();
  await mail?.close();
  await sql?.end();
});

async function login(phone) {
  const c = app.client();
  const s = await c.post('/api/auth/otp/start', { phone });
  assert.equal(s.status, 200, s.text);
  const r = await c.post('/api/auth/otp/verify', { phone, code: app.codes[s.json.phone], client: 'web' });
  assert.ok(r.status === 200 || r.status === 201, r.text);
  return { c, user: r.json.user };
}

const hasPush = async (id) => (await sql`SELECT has_push FROM users WHERE id = ${id}`)[0].has_push;

/** Queues one new-mail alert for the user, as the mail service does, and runs the sender. */
async function alert(userId, subject = 'Lunch on Sunday?') {
  const [{ id: sender }] = await sql`INSERT INTO users (phone, display_name) VALUES (${'+9198765' + String(Date.now()).slice(-5)}, 'Asha Rao') RETURNING id`;
  const [{ id }] = await sql`INSERT INTO alert_queue (user_id, conversation_id, message_id, sender_id, subject)
                             VALUES (${userId}, 41, 42, ${sender}, ${subject}) RETURNING id`;
  await app.alerts.runOnce();
  return (await sql`SELECT status, last_error FROM alert_queue WHERE id = ${id}`)[0];
}

describe('phone push', () => {
  test('device tokens are checked', async () => {
    const { c } = await login('9876501001');
    assert.equal((await c.post('/api/push/devices', { platform: 'windows', token: IOS_TOKEN })).status, 400);
    assert.equal((await c.post('/api/push/devices', { platform: 'ios', token: 'not hex' })).status, 400);
    assert.equal((await c.post('/api/push/devices', { platform: 'android', token: 'x' })).status, 400);
    assert.equal((await app.client().post('/api/push/devices', { platform: 'ios', token: IOS_TOKEN })).status, 401);
  });

  test('a registered iPhone and Android phone get new-mail pushes instead of SMS', async () => {
    const { c, user } = await login('9876501002');
    assert.equal((await c.post('/api/push/devices', { platform: 'ios', token: IOS_TOKEN, sandbox: true })).status, 201);
    assert.equal((await c.post('/api/push/devices', { platform: 'android', token: ANDROID_TOKEN })).status, 201);
    assert.equal(await hasPush(user.id), true);
    sent.apns.length = 0;
    sent.fcm.length = 0;
    const smsBefore = app.twilio.sms.length;

    const a = await alert(user.id);
    assert.equal(a.status, 'push');
    assert.equal(app.twilio.sms.length, smsBefore, 'no SMS when a push got through');

    assert.equal(sent.apns.length, 1);
    const ios = sent.apns[0];
    assert.equal(ios.token, IOS_TOKEN);
    assert.equal(ios.sandbox, true);
    assert.equal(ios.payload.aps.category, 'NEW_MAIL');
    assert.equal(ios.payload.aps['thread-id'], 'conv-41');
    assert.equal(ios.payload.aps.alert.body, 'Lunch on Sunday?');
    assert.match(ios.payload.aps.alert.title, /Asha Rao/);
    assert.equal(ios.payload.message_id, 42);

    assert.equal(sent.fcm.length, 1);
    assert.equal(sent.fcm[0].token, ANDROID_TOKEN);
    assert.equal(sent.fcm[0].payload.conversation_id, 41);
  });

  test('a token the push service no longer knows is dropped', async () => {
    const { c, user } = await login('9876501003');
    const token = 'cd'.repeat(32);
    await c.post('/api/push/devices', { platform: 'ios', token });
    answer.apns = 'gone';
    try {
      await alert(user.id);
    } finally {
      answer.apns = 'sent';
    }
    assert.equal((await sql`SELECT count(*)::int AS n FROM mobile_push_tokens WHERE token = ${token}`)[0].n, 0);
    assert.equal(await hasPush(user.id), false, 'no device left: SMS alerts apply again');
  });

  test('signing in as someone else on the same phone moves the token', async () => {
    const first = await login('9876501004');
    const second = await login('9876501005');
    const token = 'ef'.repeat(32);
    await first.c.post('/api/push/devices', { platform: 'ios', token });
    await second.c.post('/api/push/devices', { platform: 'ios', token });
    assert.equal(await hasPush(first.user.id), false);
    assert.equal(await hasPush(second.user.id), true);
    assert.equal((await second.c.del('/api/push/devices', { token })).status, 200);
    assert.equal(await hasPush(second.user.id), false);
  });

  test('the APNs payload and provider token are what Apple expects', () => {
    const p = apnsPayload({ title: 'Ravi', body: 'Bill', conversation_id: 7, message_id: 8 });
    assert.deepEqual(p.aps.alert, { title: 'Ravi', body: 'Bill' });
    assert.equal(p.aps['mutable-content'], 1);
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwt = apnsJwt({ key: privateKey, keyId: 'ABC123DEFG', teamId: 'RAKS7AXSK2' }, 1_800_000_000);
    const [h, c, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'ABC123DEFG' });
    assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { iss: 'RAKS7AXSK2', iat: 1_800_000_000 });
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  });

  test('the FCM message is data-only with string values', () => {
    const m = fcmMessage('tok', { title: 'Ravi', body: 'Bill', conversation_id: 7, message_id: 8 });
    assert.equal(m.android.priority, 'high');
    assert.equal(m.notification, undefined);
    assert.deepEqual(m.data, { type: 'new_mail', title: 'Ravi', body: 'Bill', conversation_id: '7', message_id: '8' });
  });
});
