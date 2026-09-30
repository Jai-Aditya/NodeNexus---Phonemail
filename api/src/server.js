// Entry point: wires everything together and starts the HTTP server.

import http from 'node:http';
import { loadConfig } from './config.js';
import { connect, waitForSchema, migrate } from './db.js';
import { sessionStore } from './auth/sessions.js';
import { otpProvider } from './auth/otp.js';
import { RateLimiter } from './auth/ratelimit.js';
import { accounts as accountsStore } from './accounts.js';
import { twilioClient } from './twilio/client.js';
import { pushStore } from './push/store.js';
import { EventHub, listenForMailEvents } from './realtime/events.js';
import { AlertSender } from './realtime/alerts.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const sql = connect(cfg.databaseUrl);

await waitForSchema(sql); // the Go mail service owns the users table and creates it first
if (cfg.migrateOnStart) await migrate(sql);

const twilio = twilioClient(cfg);
const sessions = sessionStore(sql, cfg, {
  // Logging out (or changing the password) also ends live-update streams at once.
  onRevoke: ({ hashes, userId, exceptHash }) =>
    hashes ? deps.hub.closeSessions(hashes) : deps.hub.closeUser(userId, exceptHash),
});
const deps = {
  cfg,
  sql,
  twilio,
  sessions,
  accounts: accountsStore(sql, cfg),
  otp: otpProvider(cfg, sql, twilio),
  push: pushStore(sql, cfg),
  hub: new EventHub({ maxPerUser: cfg.maxStreamsPerUser, sessionAlive: (h) => sessions.alive(h) }),
  limiter: new RateLimiter(),
};
await deps.push.vapidKeys(); // make sure push keys exist before the first request
deps.alerts = new AlertSender(deps);
deps.alerts.start();
const listener = await listenForMailEvents(deps);

const server = http.createServer(createApp(deps));
// A client must finish SENDING its request within 5 minutes (enough for a 25 MB upload on
// a slow phone link). This limits only the upload side: live-update streams (/api/events)
// are long RESPONSES and are not affected. 0 here would let a slow client hold a
// connection open forever.
server.requestTimeout = 300_000;
server.headersTimeout = 30_000;
server.listen(cfg.port, () => {
  console.log(`PhoneMail API on :${cfg.port} (auth: ${cfg.authMode}, mail service: ${cfg.mailServiceUrl})`);
  if (cfg.authMode === 'console') console.log('AUTH_MODE=console: one-time codes are printed in this log. Development only!');
  if (!twilio.canSendSms) console.log('Twilio SMS not configured: SMS alerts and sign-up texts are only logged.');
});

const purge = setInterval(() => deps.sessions.purgeExpired().catch(() => {}), 3600_000);
purge.unref();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  deps.hub.close(); // end live streams so the server can close
  await deps.alerts.stop(); // unsent alerts stay queued for the next start
  // Stop accepting connections, let requests in progress finish (up to 10 s), then stop.
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  const force = setTimeout(() => server.closeAllConnections(), 10_000);
  await closed;
  clearTimeout(force);
  await listener.unlisten().catch(() => {});
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
