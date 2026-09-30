import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, hkdfSync, createDecipheriv } from 'node:crypto';
import { freshDatabase, fakeMailService, startApp, listen, TOKEN, AUTH_TOKEN } from './helpers.js';
import { twilioSignature } from '../src/twilio/client.js';
import { handleMailEvent } from '../src/realtime/events.js';
import { clientIp } from '../src/http/util.js';
import { loadConfig } from '../src/config.js';

let sql, mail, app;

before(async () => {
  sql = await freshDatabase();
  mail = await fakeMailService();
  app = await startApp(sql, {}, { mail });
});

after(async () => {
  await app?.close();
  await mail?.close();
  await sql?.end();
});

/** Logs a number in with a one-time code (console mode) and returns the client. */
async function login(phone, client = 'web') {
  const c = app.client();
  const s = await c.post('/api/auth/otp/start', { phone });
  assert.equal(s.status, 200, s.text);
  const r = await c.post('/api/auth/otp/verify', { phone, code: app.codes[s.json.phone], client });
  assert.ok(r.status === 200 || r.status === 201, r.text);
  return { c, user: r.json.user };
}

describe('basics', () => {
  test('health reports the database and the mail service', async () => {
    const r = await app.client().get('/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, database: true, mail_service: true, auth_mode: 'console' });
  });

  test('the sign-in page learns the number to call or text, once Twilio is set up', async (t) => {
    assert.equal((await app.client().get('/api/auth/config')).json.signup_number, undefined);
    const tw = await startApp(sql, { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_FROM_NUMBER: '+15550001111' }, { mail });
    t.after(() => tw.close());
    assert.equal((await tw.client().get('/api/auth/config')).json.signup_number, '+15550001111');
  });

  test('unknown paths are 404, wrong methods 405', async () => {
    const c = app.client();
    assert.equal((await c.get('/api/nope')).status, 404);
    assert.equal((await c.get('/api/auth/login')).status, 405);
  });

  test('state-changing requests need X-Requested-With (CSRF)', async () => {
    const r = await fetch(app.url + '/api/auth/otp/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"phone":"9876511111"}',
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, 'csrf');
  });

  test('behind a proxy only the last X-Forwarded-For entry counts', () => {
    const req = (xff) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '172.18.0.1' } });
    // nginx appends the real address; anything before it came from the client.
    assert.equal(clientIp(req('6.6.6.6, 203.0.113.9'), true), '203.0.113.9');
    assert.equal(clientIp(req('203.0.113.9'), true), '203.0.113.9');
    assert.equal(clientIp(req('6.6.6.6'), false), '172.18.0.1', 'not trusted unless TRUST_PROXY');
  });

  test('refuses to start with a default or short shared secret', () => {
    assert.throws(() => loadConfig({ INTERNAL_TOKEN: 'change-me-dev-token' }), /INTERNAL_TOKEN/);
    assert.throws(() => loadConfig({ INTERNAL_TOKEN: 'short', NODE_ENV: 'production' }), /INTERNAL_TOKEN/);
    assert.ok(loadConfig({ INTERNAL_TOKEN: 'a'.repeat(32), NODE_ENV: 'production' }));
  });

  test('API responses may never run as a page', async () => {
    const r = await app.client().get('/api/health');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  });

  test('CORS only for listed origins', async () => {
    const ok = await fetch(app.url + '/api/me', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
    const bad = await fetch(app.url + '/api/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });
});

describe('OTP login', () => {
  test('a new number signs up, gets a cookie and a profile', async () => {
    const c = app.client();
    const start = await c.post('/api/auth/otp/start', { phone: '98765 00011' });
    assert.equal(start.status, 200);
    assert.equal(start.json.phone, '+919876500011');
    assert.equal(start.json.code, undefined, 'the code must never be sent to the client');

    const wrong = await c.post('/api/auth/otp/verify', { phone: '9876500011', code: '000000' === app.codes['+919876500011'] ? '111111' : '000000' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'wrong_code');

    const ok = await c.post('/api/auth/otp/verify', { phone: '+91 98765 00011', code: app.codes['+919876500011'], client: 'web' });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.created, true);
    assert.equal(ok.json.user.address, '9876500011@phonemail.com');
    assert.equal(ok.json.user.created_via, 'web');
    assert.match(ok.headers.get('set-cookie'), /pm_session=.+; Path=\/; SameSite=Lax; Max-Age=\d+; HttpOnly/);
    assert.equal(ok.json.token, undefined, 'browsers never get the raw token');

    const me = await c.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.phone, '+919876500011');
  });

  test('apps get a Bearer token instead of a cookie, and it works like one', async () => {
    const c = app.client();
    await c.post('/api/auth/otp/start', { phone: '9876500019' });
    const r = await c.post('/api/auth/otp/verify', { phone: '9876500019', code: app.codes['+919876500019'], client: 'mobile' });
    assert.equal(r.status, 201);
    assert.equal(r.json.user.created_via, 'mobile');
    assert.equal(r.headers.get('set-cookie'), null);
    assert.ok(r.json.token && r.json.expires_in > 0);
    const bearer = { Authorization: `Bearer ${r.json.token}` };
    const call = (method, p, body) => fetch(app.url + p, {
      method, headers: { ...bearer, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    });
    assert.equal((await call('GET', '/api/me')).status, 200);
    // No X-Requested-With needed with a Bearer token (a browser can't forge that header).
    assert.equal((await call('PATCH', '/api/me', { display_name: 'App user' })).status, 200);
    assert.equal((await call('POST', '/api/auth/logout', {})).status, 200);
    assert.equal((await call('GET', '/api/me')).status, 401, 'logout ends the token');
    const forged = await fetch(app.url + '/api/me', { headers: { Authorization: 'Bearer not-a-real-token-at-all-000' } });
    assert.equal(forged.status, 401);
  });

  test('a code works only once', async () => {
    const c = app.client();
    await c.post('/api/auth/otp/start', { phone: '9876500012' });
    const code = app.codes['+919876500012'];
    assert.equal((await c.post('/api/auth/otp/verify', { phone: '9876500012', code })).status, 201);
    assert.equal((await c.post('/api/auth/otp/verify', { phone: '9876500012', code })).status, 401);
  });

  test('asking for codes too fast is limited', async () => {
    const c = app.client();
    assert.equal((await c.post('/api/auth/otp/start', { phone: '9876500013' })).status, 200);
    const again = await c.post('/api/auth/otp/start', { phone: '9876500013' });
    assert.equal(again.status, 429);
    assert.ok(Number(again.headers.get('retry-after')) > 0);
  });

  test('the registration portal creates the account but does not log in', async () => {
    const c = app.client();
    await c.post('/api/auth/otp/start', { phone: '9876500014' });
    const r = await c.post('/api/auth/otp/verify', { phone: '9876500014', code: app.codes['+919876500014'], client: 'portal' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, { created: true, address: '9876500014@phonemail.com' });
    assert.equal(r.headers.get('set-cookie'), null);
  });

  test('two numbers with the same last 10 digits cannot both register', async () => {
    const c = app.client();
    await c.post('/api/auth/otp/start', { phone: '+449876500011' });
    const r = await c.post('/api/auth/otp/verify', { phone: '+449876500011', code: app.codes['+449876500011'] });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'number_taken');
  });

  test('numbers in countries we do not text are refused (SMS pumping)', async () => {
    const r = await app.client().post('/api/auth/otp/start', { phone: '+12025550123' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'country_not_supported');
  });

  test('test numbers (TEST_PHONE_PREFIX) are never texted: no codes, no alerts', async (t) => {
    const tn = await startApp(sql, { TEST_PHONE_PREFIX: '+9155555' }, { mail });
    t.after(() => tn.close());
    const r = await tn.client().post('/api/auth/otp/start', { phone: '5555500001' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'test_number');
    const { twilioClient } = await import('../src/twilio/client.js');
    const tw = twilioClient(loadConfig({ INTERNAL_TOKEN: TOKEN, TEST_PHONE_PREFIX: '+9155555', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'x', TWILIO_FROM_NUMBER: '+15550001111' }));
    assert.equal(await tw.sendSms('+915555500001', 'hello'), 'blocked');
  });

  test('bad phone numbers are rejected', async () => {
    const r = await app.client().post('/api/auth/otp/start', { phone: '12345' });
    assert.equal(r.status, 400);
  });

  test('logout ends the session', async () => {
    const { c } = await login('9876500015');
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    assert.equal((await c.get('/api/me')).status, 401);
  });
});

describe('profile', () => {
  test('update name and language', async () => {
    const { c } = await login('9876500021');
    const r = await c.patch('/api/me', { display_name: '  Kavya Rao ', language: 'ta' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.display_name, 'Kavya Rao');
    assert.equal(r.json.language, 'ta');
    assert.equal((await c.patch('/api/me', { language: 'not a language!' })).status, 400);
  });

  test('signature and undo-send time', async () => {
    const { c } = await login('9876500091');
    const before = await c.get('/api/me');
    assert.equal(before.json.signature, '');
    assert.equal(before.json.undo_send_seconds, 10);
    const r = await c.patch('/api/me', { signature: 'Kavya\nPhoneMail', undo_send_seconds: 30 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.signature, 'Kavya\nPhoneMail');
    assert.equal(r.json.undo_send_seconds, 30);
    assert.equal((await c.patch('/api/me', { undo_send_seconds: 7 })).status, 400);
    assert.equal((await c.patch('/api/me', { signature: 'x'.repeat(1001) })).status, 400);
  });

  test('aliases: add, list, reject bad or taken ones, remove', async () => {
    const { c } = await login('9876500022');
    const { c: other } = await login('9876500023');
    const add = await c.post('/api/me/aliases', { alias: 'Kavya.Rao' });
    assert.equal(add.status, 201, add.text);
    assert.equal(add.json.alias, 'kavya.rao@phonemail.com');
    assert.equal((await other.post('/api/me/aliases', { alias: 'kavya.rao' })).json.error.code, 'alias_taken');
    assert.equal((await c.post('/api/me/aliases', { alias: 'admin' })).status, 409);
    assert.equal((await c.post('/api/me/aliases', { alias: '9876543210' })).status, 400);
    assert.equal((await c.post('/api/me/aliases', { alias: 'x@gmail.com' })).status, 400);
    assert.deepEqual((await c.get('/api/me/aliases')).json.aliases, ['kavya.rao@phonemail.com']);
    assert.equal((await c.del('/api/me/aliases/kavya.rao')).status, 200);
    assert.deepEqual((await c.get('/api/me/aliases')).json.aliases, []);
  });

  test('profile picture upload checks the file really is an image', async () => {
    const { c } = await login('9876500024');
    const { readFile } = await import('node:fs/promises');
    const png = await readFile(new URL('./fixtures/plain.png', import.meta.url)); // a real PNG, no metadata
    const up = await c.put('/api/me/avatar', png, { 'Content-Type': 'image/png' });
    assert.equal(up.status, 200, up.text);
    assert.match(up.json.avatar_url, /^\/api\/avatars\/\d+-[\w-]{16}\.png$/);
    const img = await fetch(app.url + up.json.avatar_url);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);

    const fake = await c.put('/api/me/avatar', Buffer.from('<script>alert(1)</script>'), { 'Content-Type': 'image/png' });
    assert.equal(fake.status, 400);
    const header = Buffer.concat([png.subarray(0, 8), randomBytes(64)]); // a PNG signature with junk after it
    assert.equal((await c.put('/api/me/avatar', header, { 'Content-Type': 'image/png' })).status, 400);
    assert.equal((await fetch(app.url + '/api/avatars/..%2F..%2Fpackage.json')).status, 404);
  });
});

test('profile pictures lose their GPS position and camera details, keep their rotation', async () => {
  const { readFile } = await import('node:fs/promises');
  const { c } = await login('9876500029');
  for (const [file, type] of [['gps.jpg', 'image/jpeg'], ['gps.png', 'image/png'], ['gps.webp', 'image/webp']]) {
    const original = await readFile(new URL(`./fixtures/${file}`, import.meta.url));
    assert.ok(original.includes('SecretPhone'), 'the fixture carries camera metadata');
    const up = await c.put('/api/me/avatar', original, { 'Content-Type': type });
    assert.equal(up.status, 200, up.text);
    const pic = Buffer.from(await (await fetch(app.url + up.json.avatar_url)).arrayBuffer());
    assert.ok(!pic.includes('SecretPhone') && !pic.includes('home'), `${file}: metadata removed`);
    assert.ok(pic.length > 0 && pic.length < original.length, `${file}: still an image, smaller`);
    if (type === 'image/jpeg') {
      assert.ok(pic.includes(Buffer.from([0x01, 0x12, 0x00, 0x03])), 'the rotation (Orientation tag) is kept');
    }
  }
});

describe('account deletion and export', () => {
  test('deleting needs a fresh code (no password) and is carried out by the mail service', async () => {
    const { c, user } = await login('9876500073');
    mail.requests.length = 0;
    assert.equal((await c.del('/api/me', {})).status, 400, 'a code is required');
    assert.equal((await c.del('/api/me', { code: '000001' })).status, 401);
    app.limiter.reset('otp-start:phone:+919876500073');
    await c.post('/api/auth/otp/start', { phone: '9876500073' });
    const r = await c.del('/api/me', { code: app.codes['+919876500073'] });
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('set-cookie'), /pm_session=; .*Max-Age=0/);
    const call = mail.requests.find((q) => q.url === '/account');
    assert.equal(call.method, 'DELETE');
    assert.equal(call.headers['x-user-id'], String(user.id));
  });

  test('accounts with a password confirm with it', async (t) => {
    const pw = await startApp(sql, { AUTH_MODE: 'password' }, { mail });
    t.after(() => pw.close());
    const c = pw.client();
    await c.post('/api/auth/register', { phone: '9876500074', password: 'my password' });
    assert.equal((await c.del('/api/me', { password: 'wrong one' })).status, 401);
    assert.equal((await c.del('/api/me', { password: 'my password' })).status, 200);
  });

  test('export streams the mail service file, limited to 3 an hour', async () => {
    const { c } = await login('9876500075');
    mail.requests.length = 0;
    for (let i = 0; i < 3; i++) assert.equal((await c.get('/api/me/export')).status, 200);
    assert.equal(mail.requests[0].url, '/export');
    assert.equal((await c.get('/api/me/export')).status, 429);
  });
});

describe('mail service gateway', () => {
  test('forwards requests with the shared secret and the user id', async () => {
    const { c, user } = await login('9876500031');
    mail.requests.length = 0;
    const r = await c.get('/api/mail/conversations?filter=unread&limit=20');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { echo: '/conversations?filter=unread&limit=20' });
    const seen = mail.requests[0];
    assert.equal(seen.headers['x-internal-token'], TOKEN);
    assert.equal(seen.headers['x-user-id'], String(user.id));
    assert.equal(seen.headers.cookie, undefined, 'cookies must not leak to the mail service');

    const send = await c.post('/api/mail/messages', { to: '9876500001@phonemail.com', subject: 'Hi', body: 'Hello' });
    assert.equal(send.status, 201);
    assert.equal(mail.requests[1].method, 'POST');
    assert.deepEqual(JSON.parse(mail.requests[1].body), { to: '9876500001@phonemail.com', subject: 'Hi', body: 'Hello' });
  });

  test('a client cannot pretend to be someone else', async () => {
    const { c, user } = await login('9876500032');
    mail.requests.length = 0;
    await c.get('/api/mail/conversations', { 'X-User-ID': '1', 'X-Internal-Token': 'guess' });
    assert.equal(mail.requests[0].headers['x-user-id'], String(user.id));
    assert.equal(mail.requests[0].headers['x-internal-token'], TOKEN);
  });

  test('needs a login', async () => {
    assert.equal((await app.client().get('/api/mail/conversations')).status, 401);
  });

  test('each request has an ID, passed on to the mail service', async () => {
    const { c } = await login('9876500035');
    mail.requests.length = 0;
    const r = await c.get('/api/mail/conversations');
    const id = r.headers.get('x-request-id');
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(mail.requests[0].headers['x-request-id'], id);
    const kept = await c.get('/api/me', { 'X-Request-ID': 'nginx-abc12345' }); // from nginx: kept
    assert.equal(kept.headers.get('x-request-id'), 'nginx-abc12345');
  });

  test('sending is rate limited per person; reading is not', async (t) => {
    const lim = await startApp(sql, { SEND_PER_MINUTE: '2' }, { mail });
    t.after(() => lim.close());
    const c = lim.client();
    await c.post('/api/auth/otp/start', { phone: '9876500034' });
    await c.post('/api/auth/otp/verify', { phone: '9876500034', code: lim.codes['+919876500034'] });
    assert.equal((await c.post('/api/mail/messages', { to: { address: '1' } })).status, 201);
    assert.equal((await c.post('/api/mail/messages/5/reply', { body_text: 'x' })).status, 201);
    const third = await c.post('/api/mail/drafts/9/send', {});
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.equal((await c.get('/api/mail/conversations')).status, 200);
  });

  test('502 when the mail service is down', async (t) => {
    const down = await startApp(sql, { MAIL_SERVICE_URL: 'http://127.0.0.1:9' });
    t.after(() => down.close());
    const c = down.client();
    await c.post('/api/auth/otp/start', { phone: '9876500033' });
    await c.post('/api/auth/otp/verify', { phone: '9876500033', code: down.codes['+919876500033'] });
    const r = await c.get('/api/mail/conversations');
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'mail_unavailable');
    assert.equal((await c.get('/api/health')).status, 503);
  });
});

describe('password mode (no OTP provider)', () => {
  let pw;
  before(async () => { pw = await startApp(sql, { AUTH_MODE: 'password' }, { mail }); });
  after(async () => { await pw.close(); });

  test('register, log in, change password', async () => {
    const c = pw.client();
    assert.equal((await c.get('/api/auth/config')).json.mode, 'password');
    assert.equal((await c.post('/api/auth/otp/start', { phone: '9876500041' })).status, 400);
    assert.equal((await c.post('/api/auth/register', { phone: '9876500041', password: 'short' })).status, 400);
    const reg = await c.post('/api/auth/register', { phone: '9876500041', password: 'correct horse' });
    assert.equal(reg.status, 201, reg.text);
    assert.equal((await c.post('/api/auth/register', { phone: '9876500041', password: 'correct horse' })).json.error.code, 'account_exists');

    const other = pw.client();
    assert.equal((await other.post('/api/auth/login', { phone: '9876500041', password: 'wrong horse' })).status, 401);
    assert.equal((await other.post('/api/auth/login', { phone: '9876500099', password: 'wrong horse' })).status, 401);
    assert.equal((await other.post('/api/auth/login', { phone: '9876500041', password: 'correct horse' })).status, 200);

    const change = await c.put('/api/me/password', { current_password: 'correct horse', new_password: 'battery staple' });
    assert.equal(change.status, 200, change.text);
    assert.equal((await c.get('/api/me')).status, 200, 'this device stays logged in');
    assert.equal((await other.get('/api/me')).status, 401, 'other devices are logged out');
    assert.equal((await other.post('/api/auth/login', { phone: '9876500041', password: 'battery staple' })).status, 200);
  });

  test('someone guessing a password locks only themselves out, not the owner', async (t) => {
    const px = await startApp(sql, { AUTH_MODE: 'password', TRUST_PROXY: 'true' }, { mail });
    t.after(() => px.close());
    const owner = px.client();
    assert.equal((await owner.post('/api/auth/register', { phone: '9876500043', password: 'owner password' })).status, 201);
    const from = (ip) => ({ 'X-Forwarded-For': ip });
    const attacker = px.client();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await attacker.post('/api/auth/login', { phone: '9876500043', password: `guess ${i}` }, from('203.0.113.66'));
    }
    assert.equal(last.status, 429, 'the guesser is stopped');
    const ok = await px.client().post('/api/auth/login', { phone: '9876500043', password: 'owner password' }, from('198.51.100.7'));
    assert.equal(ok.status, 200, 'the owner, from their own address, still gets in');
  });

  test('forgot password: a code by SMS sets a new one and signs out other devices', async (t) => {
    const px = await startApp(sql, { AUTH_MODE: 'password' }, { mail });
    t.after(() => px.close());
    const other = px.client();
    assert.equal((await other.post('/api/auth/register', { phone: '9876500076', password: 'old password' })).status, 201);
    assert.equal((await px.client().get('/api/auth/config')).json.password_reset, true);

    px.twilio.sms.length = 0;
    const c = px.client();
    assert.equal((await c.post('/api/auth/password/reset/start', { phone: '9876500077' })).status, 200, 'same reply for unknown numbers');
    assert.equal(px.twilio.sms.length, 0, '...but no text is sent (or paid for)');
    assert.equal((await c.post('/api/auth/password/reset/start', { phone: '9876500076' })).status, 200);
    const code = px.twilio.sms[0].body.match(/code is (\d{6})/)[1];
    assert.equal((await c.post('/api/auth/password/reset', { phone: '9876500076', code: '000000', new_password: 'new password' })).status, 401);
    const r = await c.post('/api/auth/password/reset', { phone: '9876500076', code, new_password: 'new password' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await c.get('/api/me')).status, 200, 'signed in');
    assert.equal((await other.get('/api/me')).status, 401, 'other devices signed out');
    assert.equal((await px.client().post('/api/auth/login', { phone: '9876500076', password: 'old password' })).status, 401);
    assert.equal((await px.client().post('/api/auth/login', { phone: '9876500076', password: 'new password' })).status, 200);
    assert.equal((await c.post('/api/auth/password/reset', { phone: '9876500076', code, new_password: 'again pass' })).status, 401, 'a code works once');
  });

  test('SMS sign-up texts a temporary password that works', async () => {
    const form = { From: '+919876500042', Body: 'join' };
    const r = await twilioPost(pw, '/twilio/sms', form);
    assert.equal(r.status, 200);
    const pass = r.text.match(/temporary password is (\w+)/)?.[1];
    assert.ok(pass, r.text);
    const login = await pw.client().post('/api/auth/login', { phone: '9876500042', password: pass });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.created_via, 'sms');
  });
});

/** POSTs a webhook the way Twilio does, with a valid signature. */
async function twilioPost(target, p, form, signature) {
  const sig = signature ?? twilioSignature(AUTH_TOKEN, 'https://phonemail.test' + p, form);
  const r = await fetch(target.url + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
    body: new URLSearchParams(form).toString(),
  });
  return { status: r.status, text: await r.text() };
}

describe('Twilio sign-up (IVR and SMS)', () => {
  test('unsigned or forged webhooks are rejected', async () => {
    assert.equal((await twilioPost(app, '/twilio/sms', { From: '+919876500051', Body: 'JOIN' }, 'forged')).status, 403);
    const [u] = await sql`SELECT 1 FROM users WHERE phone = '+919876500051'`;
    assert.equal(u, undefined);
  });

  test('SMS JOIN creates the account and replies with the address', async () => {
    const r = await twilioPost(app, '/twilio/sms', { From: '+919876500052', Body: ' Join ' });
    assert.equal(r.status, 200);
    assert.match(r.text, /<Message>Welcome to PhoneMail! Your email address is 9876500052@phonemail.com\./);
    const again = await twilioPost(app, '/twilio/sms', { From: '+919876500052', Body: 'JOIN' });
    assert.match(again.text, /already have a PhoneMail account/);
    const other = await twilioPost(app, '/twilio/sms', { From: '+919876500052', Body: 'hello?' });
    assert.match(other.text, /reply JOIN/);
  });

  test('IVR: the menu, then pressing 1 creates the account and texts the details', async () => {
    const menu = await twilioPost(app, '/twilio/voice', { From: '+919876500053', CallSid: 'CA1' });
    assert.match(menu.text, /<Gather numDigits="1"[^>]*action="\/twilio\/voice\/menu"/);
    assert.match(menu.text, /press 1/);

    const wrong = await twilioPost(app, '/twilio/voice/menu', { From: '+919876500053', Digits: '5' });
    assert.match(wrong.text, /<Redirect/);

    app.twilio.sms.length = 0;
    const press = await twilioPost(app, '/twilio/voice/menu', { From: '+919876500053', Digits: '1' });
    assert.match(press.text, /Your account is ready/);
    assert.match(press.text, /9 8 7 6 5 0 0 0 5 3, at phonemail dot com/);
    const [u] = await sql`SELECT created_via FROM users WHERE phone = '+919876500053'`;
    assert.equal(u.created_via, 'ivr');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(app.twilio.sms[0].to, '+919876500053');
    assert.match(app.twilio.sms[0].body, /9876500053@phonemail\.com/);
  });
});

describe('push subscriptions', () => {
  test('only real browser push services are accepted', async () => {
    const { pushStore } = await import('../src/push/store.js');
    const store = pushStore(null, { allowInsecurePush: false });
    const keys = { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
    for (const endpoint of ['https://evil.example/push', 'https://fcm.googleapis.com.evil.example/x', 'http://fcm.googleapis.com/x']) {
      await assert.rejects(store.subscribe(1, { endpoint, keys }), /push/i, endpoint);
    }
  });
});

describe('live updates and alerts', () => {
  /** Opens /api/events and collects events until `count` have arrived. */
  async function openStream(cookie) {
    const ctrl = new AbortController();
    const r = await fetch(app.url + '/api/events', { headers: { Cookie: cookie }, signal: ctrl.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const reader = r.body.getReader();
    const events = [];
    let buf = '';
    const state = { ended: false };
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { state.ended = true; break; }
          buf += Buffer.from(value).toString();
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const type = frame.match(/^event: (.*)$/m)?.[1];
            const data = frame.match(/^data: (.*)$/m)?.[1];
            if (type) events.push({ type, data: JSON.parse(data) });
          }
        }
      } catch { /* aborted */ }
    })();
    const waitFor = async (n) => {
      for (let i = 0; i < 100 && events.length < n; i++) await new Promise((r) => setTimeout(r, 20));
      return events;
    };
    const waitEnded = async () => {
      for (let i = 0; i < 100 && !state.ended; i++) await new Promise((r) => setTimeout(r, 20));
      return state.ended;
    };
    return { events, waitFor, waitEnded, close: () => { ctrl.abort(); return pump; } };
  }

  test('logging out ends that session\'s live stream at once; other sessions keep theirs', async () => {
    const { c: tab1 } = await login('9876500068');
    const tab2 = app.client();
    app.limiter.reset('otp-start:phone:+919876500068'); // a second code at once, for a second session
    await tab2.post('/api/auth/otp/start', { phone: '9876500068' });
    await tab2.post('/api/auth/otp/verify', { phone: '9876500068', code: app.codes['+919876500068'] });
    const s1 = await openStream(tab1.cookie);
    const s2 = await openStream(tab2.cookie);
    await s1.waitFor(1);
    await s2.waitFor(1);
    await tab1.post('/api/auth/logout', {});
    assert.equal(await s1.waitEnded(), true, 'the logged-out stream must close');
    assert.equal(s2.events.length, 1);
    await tab2.post('/api/auth/logout', { everywhere: true });
    assert.equal(await s2.waitEnded(), true, 'log out everywhere closes every stream');
  });

  test('a user can hold only a few live streams; the oldest closes', async () => {
    const { c } = await login('9876500065');
    const streams = [];
    for (let i = 0; i < app.cfg.maxStreamsPerUser + 1; i++) {
      streams.push(await openStream(c.cookie));
      await streams[i].waitFor(1);
    }
    assert.equal(await streams[0].waitEnded(), true);
    for (const s of streams) await s.close();
  });

  /** Queues an alert the way the mail service does with a delivery, then runs the sender once. */
  async function alert(userId, conv, senderId, subject, msg = 1) {
    await sql`INSERT INTO alert_queue (user_id, conversation_id, message_id, sender_id, subject)
              VALUES (${userId}, ${conv}, ${msg}, ${senderId}, ${subject})`;
    await app.alerts.runOnce();
  }
  const statusOf = async (conv) => (await sql`SELECT status, attempts, last_error FROM alert_queue
                                              WHERE conversation_id = ${conv} ORDER BY id`);

  test('SMS alerts: at most one per chat in a while, with a shortened subject', async () => {
    const { user: sender } = await login('9876500066');
    const { user: rcpt } = await login('9876500067');
    app.twilio.sms.length = 0;
    await alert(rcpt.id, 501, sender.id, 'One');
    await alert(rcpt.id, 501, sender.id, 'Two'); // same chat, moments later: no second text
    await alert(rcpt.id, 502, sender.id, 'x'.repeat(200)); // another chat: texted, subject cut
    assert.equal(app.twilio.sms.length, 2);
    assert.match(app.twilio.sms[0].body, /Subject: One\.$/);
    assert.match(app.twilio.sms[1].body, /Subject: x{39}…\.$/);
    assert.deepEqual((await statusOf(501)).map((r) => r.status), ['sms', 'skipped']);
  });

  test('a failed text is retried later; a hopeless one is not', async () => {
    const { TwilioError } = await import('../src/twilio/client.js');
    const { user: sender } = await login('9876500071');
    const { user: rcpt } = await login('9876500072');
    app.twilio.sms.length = 0;
    app.twilio.failNext = new TwilioError(429, { code: 20429, message: 'Too many requests' });
    await alert(rcpt.id, 511, sender.id, 'Busy');
    let [row] = await statusOf(511);
    assert.deepEqual([row.status, row.attempts], ['pending', 1], 'kept for a retry');
    await sql`UPDATE alert_queue SET next_attempt_at = now() WHERE conversation_id = 511`; // time passes
    await app.alerts.runOnce();
    [row] = await statusOf(511);
    assert.equal(row.status, 'sms');
    assert.equal(app.twilio.sms.length, 1);

    app.twilio.failNext = new TwilioError(400, { code: 21211, message: 'Invalid To number' });
    await alert(rcpt.id, 512, sender.id, 'Bad number');
    [row] = await statusOf(512);
    assert.equal(row.status, 'failed', 'a number Twilio rejects is not retried');
  });

  test('a new message reaches open tabs, and an SMS goes to users without push', async () => {
    const { c: kavyaClient, user: kavya } = await login('9876500061');
    await kavyaClient.patch('/api/me', { display_name: 'Kavya' });
    const { c: meena, user: meenaUser } = await login('9876500062');

    const stream = await openStream(meena.cookie);
    await stream.waitFor(1);
    assert.equal(stream.events[0].type, 'ready');

    app.twilio.sms.length = 0;
    const ev = {
      type: 'message', message_id: 7, conversation_id: 3, sender_id: kavya.id,
      sender_address: '9876500061@phonemail.com', subject: 'Lunch?', user_ids: [meenaUser.id],
    };
    await handleMailEvent(JSON.stringify(ev), app);
    const got = await stream.waitFor(2);
    assert.equal(got[1].type, 'message');
    assert.equal(got[1].data.message_id, 7);
    await stream.close();
    await alert(meenaUser.id, 3, kavya.id, 'Lunch?', 7); // the alert the mail service queued with it

    // The exact wording the brief asks for.
    assert.deepEqual(app.twilio.sms, [{
      to: '+919876500062',
      body: 'You have received an email from Kavya (9876500061@phonemail.com). Subject: Lunch?.',
    }]);
  });

  test('the mail service\'s NOTIFY is picked up through LISTEN', async () => {
    const { listenForMailEvents } = await import('../src/realtime/events.js');
    const { c, user } = await login('9876500063');
    const stream = await openStream(c.cookie);
    await stream.waitFor(1);
    const listener = await listenForMailEvents(app);
    await sql`SELECT pg_notify('mail_events', ${JSON.stringify({ type: 'group_created', conversation_id: 9, user_ids: [user.id] })})`;
    const got = await stream.waitFor(2);
    assert.equal(got[1]?.type, 'group_created');
    await listener.unlisten();
    await stream.close();
  });

  test('users with push get an encrypted push instead of an SMS', async (t) => {
    // A fake push service that keeps what it receives.
    const received = [];
    const pushSvc = await listen(async (req, res) => {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201);
      res.end();
    });
    t.after(() => pushSvc.close()); // close it even when an assertion fails

    // A "browser": its own key pair and auth secret.
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const authSecret = randomBytes(16);

    const { c, user } = await login('9876500064');
    const key = await c.get('/api/push/public-key');
    assert.equal(Buffer.from(key.json.public_key, 'base64url').length, 65);
    const sub = await c.post('/api/push/subscriptions', {
      endpoint: pushSvc.url + '/push/abc',
      keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
    });
    assert.equal(sub.status, 201, sub.text);
    assert.equal((await c.get('/api/me')).json.has_push, true);

    app.twilio.sms.length = 0;
    await alert(user.id, 4, null, 'Push me', 8);
    assert.equal((await statusOf(4))[0].status, 'push');

    assert.equal(app.twilio.sms.length, 0, 'no SMS for app users');
    assert.equal(received.length, 1);
    const { headers, body } = received[0];
    assert.equal(headers['content-encoding'], 'aes128gcm');
    assert.match(headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

    // Decrypt it like the browser would (RFC 8291).
    const salt = body.subarray(0, 16);
    const idLen = body[20];
    const serverKey = body.subarray(21, 21 + idLen);
    const cipher = body.subarray(21 + idLen);
    const shared = browser.computeSecret(serverKey);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), browser.getPublicKey(), serverKey]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, info, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(cipher.subarray(cipher.length - 16));
    const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
    assert.equal(plain[plain.length - 1], 2, 'last record delimiter');
    const payload = JSON.parse(plain.subarray(0, -1).toString());
    assert.equal(payload.body, 'Push me');
    assert.equal(payload.conversation_id, 4);

    // Unsubscribing switches the user back to SMS.
    await c.del('/api/push/subscriptions', { endpoint: pushSvc.url + '/push/abc' });
    assert.equal((await c.get('/api/me')).json.has_push, false);
  });
});
