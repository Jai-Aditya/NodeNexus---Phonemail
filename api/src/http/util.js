// Small HTTP helpers: JSON in/out, errors, cookies, client IP.

/** An error the client should see: an HTTP status, a stable code and a message. */
export class ApiError extends Error {
  constructor(status, code, message, extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg) => new ApiError(400, 'bad_request', msg);
export const unauthorized = (msg = 'Please log in.') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (msg) => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found.') => new ApiError(404, 'not_found', msg);
export const conflict = (code, msg) => new ApiError(409, code, msg);
export const tooMany = (msg, retryAfter) =>
  new ApiError(429, 'too_many_requests', msg, retryAfter ? { retry_after: retryAfter } : undefined);

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function sendError(res, err) {
  if (err instanceof ApiError) {
    const headers = err.extra?.retry_after ? { 'Retry-After': String(err.extra.retry_after) } : {};
    sendJson(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } }, headers);
    return;
  }
  const id = res.getHeader('X-Request-ID');
  console.error(`[${id ?? '-'}] internal error:`, err);
  const error = { code: 'internal', message: 'Something went wrong.' };
  if (id) error.request_id = id; // quote this when reporting the problem
  sendJson(res, 500, { error });
}

/** Reads the whole request body, refusing anything over `limit` bytes. */
export async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'too_large', 'The request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Reads a JSON object body. An empty body counts as {}. */
export async function readJson(req, limit = 1 << 20) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const raw = await readBody(req, limit);
  if (raw.length === 0) return {};
  if (type !== 'application/json') throw badRequest('Send the body as JSON (Content-Type: application/json).');
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest('Invalid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('The JSON body must be an object.');
  }
  return value;
}

/** Reads an application/x-www-form-urlencoded body (Twilio webhooks) into a plain object. */
export async function readForm(req, limit = 64 << 10) {
  const raw = await readBody(req, limit);
  return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && !(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

/**
 * The client's IP. Directly connected: the socket address. Behind one trusted proxy
 * (nginx with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`): the LAST
 * X-Forwarded-For entry. nginx appends the address it saw to whatever the client sent,
 * so earlier entries are the client's own claims and can be anything; only the last
 * one was written by our proxy.
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const last = fwd?.split(',').pop().trim();
    if (last) return last;
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Checks a value is a string no longer than max (after trimming). */
export function optString(v, field, max) {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw badRequest(`${field} must be text.`);
  const s = v.trim();
  if (s.length > max) throw badRequest(`${field} can be at most ${max} characters.`);
  return s;
}
