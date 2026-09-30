// The logged-in user's own account: profile, picture, password and alias addresses.

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sendJson, readJson, readBody, badRequest, notFound, optString, ApiError } from '../http/util.js';
import { requireUser } from '../auth/sessions.js';
import { stripMetadata } from '../images.js';
import { hashPassword, verifyPassword, checkNewPassword } from '../auth/password.js';

const AVATAR_TYPES = {
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
  'image/gif': { ext: 'gif', magic: (b) => b.subarray(0, 4).toString() === 'GIF8' },
};
const EXT_TYPES = Object.fromEntries(Object.entries(AVATAR_TYPES).map(([t, v]) => [v.ext, t]));
const MAX_AVATAR = 2 << 20; // 2 MB
const AVATAR_FILE = /^[0-9]+-[A-Za-z0-9_-]{16}\.(png|jpg|webp|gif)$/;

export function meRoutes(router, { cfg, sql, sessions, accounts, otp, hub, limiter }) {
  const auth = (h) => requireUser(sessions, h);

  router.get('/api/me', auth(async (req, res) => {
    sendJson(res, 200, await accounts.profile(req.user.id));
  }));

  router.patch('/api/me', auth(async (req, res) => {
    const body = await readJson(req);
    const display_name = optString(body.display_name, 'display_name', 60);
    const language = optString(body.language, 'language', 12);
    if (language !== undefined && !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language)) {
      throw badRequest('language must be a language code like "en", "ta" or "hi".');
    }
    // A signature added under new emails, and how long "Undo" is offered after Send.
    const signature = optString(body.signature, 'signature', 1000);
    let undo_send_seconds;
    if (body.undo_send_seconds !== undefined) {
      undo_send_seconds = Number(body.undo_send_seconds);
      if (![0, 5, 10, 20, 30].includes(undo_send_seconds)) throw badRequest('undo_send_seconds must be 0, 5, 10, 20 or 30.');
    }
    await accounts.updateProfile(req.user.id, { display_name, language, signature, undo_send_seconds });
    sendJson(res, 200, await accounts.profile(req.user.id));
  }));

  // Profile picture: send the image itself as the body, e.g. fetch(url, {method: 'PUT', body: file}).
  router.put('/api/me/avatar', auth(async (req, res) => {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const kind = AVATAR_TYPES[type];
    if (!kind) throw badRequest('Upload a PNG, JPEG, WebP or GIF image.');
    const data = await readBody(req, MAX_AVATAR);
    if (data.length === 0 || !kind.magic(data)) throw badRequest('That file isn\'t a valid image of that type.');
    const clean = stripMetadata(data, type); // no GPS position, camera or time in public pictures
    await mkdir(cfg.avatarDir, { recursive: true });
    const file = `${req.user.id}-${randomBytes(12).toString('base64url')}.${kind.ext}`;
    await writeFile(path.join(cfg.avatarDir, file), clean);
    await removeAvatarFile(cfg, req.user.avatar_url);
    await accounts.updateProfile(req.user.id, { avatar_url: `/api/avatars/${file}` });
    sendJson(res, 200, await accounts.profile(req.user.id));
  }));

  router.delete('/api/me/avatar', auth(async (req, res) => {
    await removeAvatarFile(cfg, req.user.avatar_url);
    await accounts.updateProfile(req.user.id, { avatar_url: '' });
    sendJson(res, 200, await accounts.profile(req.user.id));
  }));

  // Pictures are public (like on WhatsApp), served by their unguessable file name.
  router.get('/api/avatars/:file', async (req, res) => {
    const { file } = req.params;
    if (!AVATAR_FILE.test(file)) throw notFound();
    let data;
    try {
      data = await readFile(path.join(cfg.avatarDir, file));
    } catch {
      throw notFound();
    }
    res.writeHead(200, {
      'Content-Type': EXT_TYPES[file.split('.').pop()],
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=31536000, immutable', // the name changes when the picture does
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });

  // Set or change the password. People who log in with one-time codes can set one too.
  router.put('/api/me/password', auth(async (req, res) => {
    const body = await readJson(req);
    const next = checkNewPassword(body.new_password);
    const user = await accounts.byPhone(req.user.phone);
    if (user.password_hash && !(await verifyPassword(String(body.current_password ?? ''), user.password_hash))) {
      throw new ApiError(401, 'wrong_password', 'Your current password is wrong.');
    }
    await accounts.setPassword(req.user.id, await hashPassword(next));
    await sessions.destroyAllFor(req.user.id, req.user.session_hash); // log out other devices
    sendJson(res, 200, { ok: true });
  }));

  // Delete my account (decided 30 Sep): the number, profile, aliases, sessions and own copies
  // of mail are erased; mail already sent stays with its recipients, from "Deleted account".
  // Confirmed with the password, or, for accounts without one, a fresh one-time code
  // (request it with POST /api/auth/otp/start first), so a borrowed unlocked phone or a
  // stolen session isn't enough.
  router.delete('/api/me', auth(async (req, res) => {
    const body = await readJson(req);
    limiter.hit(`delete-account:${req.user.id}`, 5, 900, 'Too many attempts. Try again in a few minutes.');
    const user = await accounts.byPhone(req.user.phone);
    if (user.password_hash) {
      if (!(await verifyPassword(String(body.password ?? ''), user.password_hash))) {
        throw new ApiError(401, 'wrong_password', 'Your password is wrong.');
      }
    } else {
      const code = String(body.code ?? '').replace(/\s/g, '');
      if (!otp || !/^\d{4,10}$/.test(code)) throw badRequest('Enter the code we sent you to confirm.');
      if (!(await otp.check(req.user.phone, code))) throw new ApiError(401, 'wrong_code', 'That code is wrong or has expired.');
    }

    // The mail service erases everything in one transaction (the users row, and with it
    // sessions, push subscriptions and aliases).
    let r;
    try {
      r = await fetch(`${cfg.mailServiceUrl}/account`, {
        method: 'DELETE',
        headers: { 'X-Internal-Token': cfg.internalToken, 'X-User-ID': String(req.user.id), 'X-Request-ID': req.id },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ApiError(502, 'mail_unavailable', 'The mail service is not responding. Please try again.');
    }
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}))).error || {};
      throw new ApiError(r.status, err.code || 'delete_failed', err.message || 'Could not delete the account.');
    }
    await sql`DELETE FROM otp_codes WHERE phone = ${req.user.phone}`;
    await removeAvatarFile(cfg, req.user.avatar_url);
    hub.closeUser(req.user.id); // its sessions are gone: end its live streams too
    console.log(`account ${req.user.id} deleted`);
    sendJson(res, 200, { deleted: true }, { 'Set-Cookie': await sessions.destroy(req) });
  }));

  router.get('/api/me/aliases', auth(async (req, res) => {
    const { aliases } = await accounts.profile(req.user.id);
    sendJson(res, 200, { aliases });
  }));

  router.post('/api/me/aliases', auth(async (req, res) => {
    const body = await readJson(req);
    const alias = await accounts.addAlias(req.user.id, body.alias);
    sendJson(res, 201, { alias });
  }));

  router.delete('/api/me/aliases/:alias', auth(async (req, res) => {
    await accounts.removeAlias(req.user.id, req.params.alias);
    sendJson(res, 200, { ok: true });
  }));
}

async function removeAvatarFile(cfg, url) {
  const file = url?.startsWith('/api/avatars/') ? url.slice('/api/avatars/'.length) : '';
  if (AVATAR_FILE.test(file)) await unlink(path.join(cfg.avatarDir, file)).catch(() => {});
}
