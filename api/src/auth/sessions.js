// Login sessions: a random token in an HttpOnly cookie; the database stores only its SHA-256.

import { randomBytes, createHash } from 'node:crypto';
import { parseCookies, serializeCookie, unauthorized } from '../http/util.js';

export const COOKIE = 'pm_session';

/** The session token of a request: an `Authorization: Bearer` header (apps) or the cookie (browsers). */
export function requestToken(req) {
  const bearer = bearerToken(req);
  return bearer ?? parseCookies(req.headers.cookie)[COOKIE];
}

export function bearerToken(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * hooks.onRevoke({ hashes } | { userId, exceptHash }) runs after sessions are deleted,
 * so live-update streams opened with them can be closed at once.
 */
export function sessionStore(sql, cfg, hooks = {}) {
  const maxAge = cfg.sessionDays * 24 * 3600;
  const revoked = (what) => hooks.onRevoke?.(what);

  return {
    /**
     * Creates a session. Returns the Set-Cookie header value (browsers) and the raw token,
     * which only native apps are given, to send as `Authorization: Bearer <token>`.
     */
    async create(userId, userAgent = '') {
      const token = randomBytes(32).toString('base64url');
      await sql`
        INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
        VALUES (${sha256(token)}, ${userId}, now() + ${maxAge + ' seconds'}::interval, ${userAgent.slice(0, 300)})`;
      return { cookie: serializeCookie(COOKIE, token, { maxAge, secure: cfg.cookieSecure }), token, maxAge };
    },

    /** Returns the logged-in user for this request, or null. */
    async load(req) {
      const token = requestToken(req);
      if (!token || token.length > 100) return null;
      const hash = sha256(token);
      const [row] = await sql`
        SELECT u.id, u.phone, u.phone_local, u.display_name, u.language, u.avatar_url,
               u.has_push, u.created_via, u.password_hash IS NOT NULL AS has_password,
               s.last_seen_at
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ${hash} AND s.expires_at > now()`;
      if (!row) return null;
      // Remember activity, at most every 10 minutes (saves a write on every request).
      if (Date.now() - new Date(row.last_seen_at).getTime() > 10 * 60 * 1000) {
        await sql`UPDATE sessions SET last_seen_at = now() WHERE token_hash = ${hash}`;
      }
      delete row.last_seen_at;
      row.session_hash = hash;
      return row;
    },

    /** Ends this session; returns a Set-Cookie header that clears the cookie. */
    async destroy(req) {
      const token = requestToken(req);
      if (token) {
        const hash = sha256(token);
        await sql`DELETE FROM sessions WHERE token_hash = ${hash}`;
        revoked({ hashes: [hash] });
      }
      return serializeCookie(COOKIE, '', { maxAge: 0, secure: cfg.cookieSecure });
    },

    /** Logs a user out everywhere except (optionally) one session. */
    async destroyAllFor(userId, exceptHash = null) {
      await sql`DELETE FROM sessions WHERE user_id = ${userId}
                AND (${exceptHash}::text IS NULL OR token_hash <> ${exceptHash})`;
      revoked({ userId, exceptHash });
    },

    /** Which of these session hashes still exist and haven't expired. */
    async alive(hashes) {
      const rows = await sql`SELECT token_hash FROM sessions
                             WHERE token_hash IN ${sql(hashes)} AND expires_at > now()`;
      return rows.map((r) => r.token_hash);
    },

    async purgeExpired() {
      await sql`DELETE FROM sessions WHERE expires_at < now()`;
    },
  };
}

/** Wraps a handler so it only runs for logged-in users (req.user is set). */
export function requireUser(sessions, handler) {
  return async (req, res) => {
    req.user = await sessions.load(req);
    if (!req.user) throw unauthorized();
    return handler(req, res);
  };
}
