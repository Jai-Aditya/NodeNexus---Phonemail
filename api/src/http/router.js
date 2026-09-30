// A tiny router for node:http. Patterns look like "/api/me/aliases/:alias";
// a pattern ending in "/*" matches everything under that prefix (req.params.rest).

import { sendError, notFound, ApiError } from './util.js';

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const wildcard = pattern.endsWith('/*');
    const parts = (wildcard ? pattern.slice(0, -2) : pattern).split('/').filter(Boolean);
    this.routes.push({ method, parts, wildcard, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }
  any(p, h) { return this.add('*', p, h); }

  /** Finds the route for a request; returns { handler, params } or an error status. */
  match(method, pathname) {
    const segs = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      const params = matchParts(r, segs);
      if (!params) continue;
      pathMatched = true;
      if (r.method === method || r.method === '*' || (method === 'HEAD' && r.method === 'GET')) {
        return { handler: r.handler, params };
      }
    }
    return { status: pathMatched ? 405 : 404 };
  }

  /** Runs the matching handler; turns thrown errors into JSON error responses. */
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    req.path = url.pathname;
    req.query = url.searchParams;
    const m = this.match(req.method, url.pathname);
    try {
      if (!m.handler) {
        throw m.status === 405
          ? new ApiError(405, 'method_not_allowed', 'That method is not allowed here.')
          : notFound('No such endpoint.');
      }
      req.params = m.params;
      await m.handler(req, res);
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else {
        console.error('error after response started:', err);
        res.destroy();
      }
    }
  }
}

function matchParts(route, segs) {
  const { parts, wildcard } = route;
  if (wildcard ? segs.length < parts.length : segs.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    let s;
    try {
      s = decodeURIComponent(segs[i]);
    } catch {
      return null;
    }
    if (p.startsWith(':')) params[p.slice(1)] = s;
    else if (p !== s) return null;
  }
  if (wildcard) params.rest = segs.slice(parts.length).join('/');
  return params;
}
