// Test harness: a fresh database, a fake mail service, a fake Twilio and a fake push service.
// Needs a PostgreSQL database you don't mind wiping:
//   TEST_DATABASE_URL=postgres://phonemail:phonemail@localhost:5432/phonemail_test npm test

import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { connect, migrate } from '../src/db.js';
import { sessionStore } from '../src/auth/sessions.js';
import { otpProvider } from '../src/auth/otp.js';
import { RateLimiter } from '../src/auth/ratelimit.js';
import { accounts as accountsStore } from '../src/accounts.js';
import { pushStore } from '../src/push/store.js';
import { EventHub } from '../src/realtime/events.js';
import { AlertSender } from '../src/realtime/alerts.js';
import { createApp } from '../src/app.js';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://phonemail:phonemail@localhost:5432/phonemail_test';
const here = path.dirname(fileURLToPath(import.meta.url));
const GO_MIGRATIONS = path.join(here, '..', '..', 'mailsvc', 'internal', 'db', 'migrations');

export const TOKEN = 'test-internal-token';
export const AUTH_TOKEN = 'test-twilio-auth-token';

/** Wipes the test database and creates the mail service's tables plus ours. */
export async function freshDatabase() {
  const sql = connect(TEST_DB, { max: 5 });
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS ltree;');
  for (const f of (await readdir(GO_MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort()) {
    await sql.unsafe(await readFile(path.join(GO_MIGRATIONS, f), 'utf8')); // the mail service's schema
  }
  await migrate(sql);
  return sql;
}

/** Starts an HTTP server on a random port; resolves to { url, close }. */
export function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, server, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
    });
  });
}

/** Records every request it gets and answers with a canned JSON reply. */
export async function fakeMailService() {
  const requests = [];
  const svc = await listen(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url === '/health') return res.end('ok');
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ echo: req.url }));
  });
  return { ...svc, requests };
}

/** Pretends to be Twilio: remembers texts and hands out codes. */
export function fakeTwilio() {
  return {
    sms: [],
    canSendSms: true,
    async sendSms(to, body) {
      if (this.failNext) { const err = this.failNext; this.failNext = null; throw err; }
      this.sms.push({ to, body });
      return 'sent';
    },
    async startVerification() {},
    async checkVerification() { return false; },
  };
}

/** Builds the whole app (same wiring as server.js) against the test database. */
export async function startApp(sql, env = {}, extra = {}) {
  const mail = extra.mail;
  const cfg = loadConfig({
    INTERNAL_TOKEN: TOKEN,
    AUTH_MODE: 'console',
    MAIL_SERVICE_URL: mail?.url || 'http://127.0.0.1:9',
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    PUBLIC_BASE_URL: 'https://phonemail.test',
    CORS_ORIGINS: 'http://localhost:5173',
    ALLOW_INSECURE_PUSH: 'true',
    SMS_COUNTRY_CODES: '91,44',
    SMS_PER_SECOND: '1000', // no pacing delays in tests
    AVATAR_DIR: path.join(here, '..', 'data', 'test-avatars'),
    ...env,
  });
  const twilio = fakeTwilio();
  const otp = otpProvider(cfg, sql, twilio);
  const codes = {};
  // Remember console-mode codes so tests can "read the SMS".
  const otpSpy = otp && {
    ...otp,
    async start(phone) { codes[phone] = await otp.start(phone); },
  };
  const hub = new EventHub({ maxPerUser: cfg.maxStreamsPerUser });
  const deps = {
    cfg, sql, twilio,
    sessions: sessionStore(sql, cfg, {
      onRevoke: ({ hashes, userId, exceptHash }) =>
        hashes ? hub.closeSessions(hashes) : hub.closeUser(userId, exceptHash),
    }),
    accounts: accountsStore(sql, cfg),
    otp: otpSpy,
    push: pushStore(sql, cfg),
    hub,
    limiter: new RateLimiter(),
    log: false,
  };
  deps.alerts = new AlertSender(deps); // not started: tests call deps.alerts.runOnce()
  const srv = await listen(createApp(deps));
  return {
    ...deps, codes, url: srv.url,
    async close() {
      deps.hub.close();
      deps.limiter.close();
      await srv.close();
    },
    /** fetch with JSON, the CSRF header and a cookie jar. */
    client() {
      let cookie = '';
      const call = async (method, p, body, headers = {}) => {
        const h = { 'X-Requested-With': 'test', ...headers };
        if (cookie) h.Cookie = cookie;
        let payload = body;
        if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
          h['Content-Type'] = 'application/json';
          payload = JSON.stringify(body);
        }
        const r = await fetch(srv.url + p, { method, headers: h, body: payload });
        const set = r.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
        const text = await r.text();
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        return { status: r.status, headers: r.headers, json, text };
      };
      return {
        call,
        get: (p, h) => call('GET', p, undefined, h),
        post: (p, b, h) => call('POST', p, b ?? {}, h),
        put: (p, b, h) => call('PUT', p, b, h),
        patch: (p, b, h) => call('PATCH', p, b, h),
        del: (p, b, h) => call('DELETE', p, b, h),
        get cookie() { return cookie; },
      };
    },
  };
}
