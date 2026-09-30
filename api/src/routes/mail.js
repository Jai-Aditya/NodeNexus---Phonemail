// Gateway to the Go mail service: /api/mail/<path> -> MAIL_SERVICE_URL/<path>,
// adding the shared secret and the logged-in user's id. Bodies stream straight
// through, so file uploads and downloads never sit in memory.

import { Readable } from 'node:stream';
import { ApiError } from '../http/util.js';

const PASS_REQUEST = ['content-type', 'content-length', 'accept'];
const PASS_RESPONSE = ['content-type', 'content-length', 'content-disposition', 'x-content-type-options'];

export function mailProxy(cfg) {
  return async (req, res) => {
    const rest = req.path.slice('/api/mail'.length) || '/';
    if (rest === '/health') throw new ApiError(404, 'not_found', 'No such endpoint.');
    const target = cfg.mailServiceUrl + rest + (req.query.size ? '?' + req.query.toString() : '');

    const headers = { 'X-Internal-Token': cfg.internalToken, 'X-User-ID': String(req.user.id), 'X-Request-ID': req.id };
    for (const h of PASS_REQUEST) if (req.headers[h]) headers[h] = req.headers[h];
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method) || req.headers['content-length'] > 0;

    let upstream;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: hasBody ? req : undefined,
        duplex: hasBody ? 'half' : undefined,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      console.error(`mail service unreachable: ${err.message}`);
      throw new ApiError(502, 'mail_unavailable', 'The mail service is not responding. Please try again.');
    }

    const out = { 'Cache-Control': 'no-store' };
    for (const h of PASS_RESPONSE) {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(upstream.status, out);
    if (!upstream.body || req.method === 'HEAD') return res.end();
    await new Promise((resolve, reject) => {
      Readable.fromWeb(upstream.body).on('error', reject).pipe(res).on('finish', resolve).on('error', reject);
    });
  };
}
