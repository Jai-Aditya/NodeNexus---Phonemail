// Builds the HTTP request handler: security checks first, then the routes.

import { randomUUID } from 'node:crypto';
import { Router } from './http/router.js';
import { sendJson, sendError, ApiError } from './http/util.js';
import { requireUser, bearerToken } from './auth/sessions.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { pushRoutes } from './routes/push.js';
import { mailProxy } from './routes/mail.js';
import { twilioRoutes } from './twilio/webhooks.js';
import { eventsRoute } from './realtime/events.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
// Calls that send an email: new message, reply, sending a draft.
const SEND_PATHS = [/^\/api\/mail\/messages$/, /^\/api\/mail\/messages\/\d+\/reply$/, /^\/api\/mail\/drafts\/\d+\/send$/];

/**
 * deps: { cfg, sql, sessions, accounts, otp, twilio, push, hub, limiter, log }
 * Returns (req, res) => void, ready for http.createServer.
 */
export function createApp(deps) {
  const { cfg, sql, sessions, hub, log = true } = deps;
  const router = new Router();
  const auth = (h) => requireUser(sessions, h);

  authRoutes(router, deps);
  meRoutes(router, deps);
  pushRoutes(router, deps);
  twilioRoutes(router, deps);

  // Live updates for the logged-in user (Server-Sent Events).
  router.get('/api/events', auth(eventsRoute(hub)));

  // Everything mail-related goes to the Go service, with limits on the costly calls:
  // every email can trigger SMS alerts (money), and search can list registered numbers.
  const proxy = mailProxy(cfg);
  router.any('/api/mail/*', auth(async (req, res) => {
    const uid = req.user.id;
    if (req.method === 'POST' && SEND_PATHS.some((re) => re.test(req.path))) {
      deps.limiter.hit(`send:minute:${uid}`, cfg.sendPerMinute, 60, "You're sending too fast. Wait a minute and try again.");
      deps.limiter.hit(`send:day:${uid}`, cfg.sendPerDay, 86400, "You've reached today's sending limit.");
    } else if (req.method === 'GET' && req.path === '/api/mail/search') {
      deps.limiter.hit(`search:${uid}`, 30, 60, 'Too many searches. Wait a minute and try again.');
    } else if (req.method === 'GET' && req.path === '/api/mail/suggest') {
      // Suggestions while typing a recipient: generous for typing, too low to scan for numbers.
      deps.limiter.hit(`suggest:${uid}`, 120, 60, 'Slow down a little: too many lookups.');
    }
    return proxy(req, res);
  }));

  // Download my data: one JSON file with the account, aliases, groups, drafts and every
  // message in full (attachments are listed; each downloads by id). It reads the whole
  // mailbox, so it's limited to a few per hour.
  router.get('/api/me/export', auth(async (req, res) => {
    deps.limiter.hit(`export:${req.user.id}`, 3, 3600, 'You can download your data 3 times an hour.');
    req.path = '/api/mail/export';
    return proxy(req, res);
  }));

  // Is everything up? Used by Docker's healthcheck.
  router.get('/api/health', async (req, res) => {
    const checks = { database: false, mail_service: false };
    try {
      await sql`SELECT 1`;
      checks.database = true;
    } catch { /* reported below */ }
    try {
      const r = await fetch(`${cfg.mailServiceUrl}/health`, { signal: AbortSignal.timeout(2000) });
      checks.mail_service = r.ok;
    } catch { /* reported below */ }
    const ok = checks.database && checks.mail_service;
    sendJson(res, ok ? 200 : 503, { ok, ...checks, auth_mode: cfg.authMode });
  });

  return async function app(req, res) {
    const started = Date.now();
    // Every request gets an ID (or keeps the one nginx gave it). It's in our log line, in
    // the mail service's log, in the X-Request-ID response header and in 500 errors, so a
    // user's "it failed" can be matched to the exact log lines in both services.
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-ID', req.id);
    if (log) {
      res.on('finish', () => {
        const path = req.url.split('?')[0];
        if (path !== '/api/health' && path !== '/api/events') {
          console.log(`[${req.id}] ${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
        }
      });
    }

    // Security headers on every response.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // The API only returns data (JSON, pictures, files), never pages: if a response is
    // ever opened as a page, nothing in it may run or load anything.
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
    if (cfg.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    try {
      // CORS: only listed origins may call the API from a browser (with cookies).
      // If the frontend is served from the same origin, CORS_ORIGINS can stay empty.
      const origin = req.headers.origin;
      if (origin && cfg.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, Authorization',
            'Access-Control-Max-Age': '600',
          });
          return res.end();
        }
      } else if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      // CSRF protection: every state-changing /api request must carry X-Requested-With.
      // A plain HTML form on another site can't add custom headers, and a script on another
      // site can't either without passing the CORS check above.
      // Requests authenticated with a Bearer token (native apps) don't need it: a browser never
      // adds an Authorization header on its own, so another site can't forge one.
      if (!SAFE_METHODS.has(req.method) && req.url.startsWith('/api/') && !req.headers['x-requested-with']
          && !bearerToken(req)) {
        throw new ApiError(403, 'csrf', 'Missing X-Requested-With header.');
      }

      await router.handle(req, res);
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.destroy();
    }
  };
}
