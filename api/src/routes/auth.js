// Sign-up and login. Two modes (see AUTH_MODE):
//   otp      - phone number + one-time code (Twilio Verify, or printed in the log in "console" mode)
//   password - phone number + password (the brief's fallback when no OTP provider is available)
// `client` says where the request came from: "web", "mobile" (the phone-sized web app) or
// "portal" (the registration-only page, which creates the account but doesn't log in).

import { sendJson, readJson, badRequest, ApiError, conflict, clientIp } from '../http/util.js';
import { normalizePhone, addressOf, maskPhone, smsAllowed, isTestNumber } from '../auth/phone.js';
import { countryNotSupported } from '../twilio/client.js';
import { hashPassword, verifyPassword, checkNewPassword } from '../auth/password.js';
import { resetCodes } from '../auth/otp.js';

const CLIENTS = { web: 'web', mobile: 'mobile', portal: 'portal' };
// A real-looking hash so a login for an unknown number takes as long as a real one.
let dummyHash;

export function authRoutes(router, { cfg, sql, otp, twilio, sessions, accounts, limiter }) {
  const otpMode = cfg.authMode !== 'password';
  const reset = resetCodes(cfg, sql, twilio, otp);
  const via = (client) => CLIENTS[client] || 'web';

  /** After a successful sign-up/login: portal gets no session; everyone else gets a cookie. */
  async function finish(req, res, userId, created, client) {
    if (client === 'portal') {
      const { address } = await accounts.profile(userId);
      return sendJson(res, created ? 201 : 200, { created, address });
    }
    const session = await sessions.create(userId, req.headers['user-agent'] || '');
    const body = { created, user: await accounts.profile(userId) };
    if (client === 'mobile') {
      // Native apps keep the token and send it as `Authorization: Bearer <token>`.
      // Browsers never see it: their cookie is HttpOnly, out of reach of page scripts.
      Object.assign(body, { token: session.token, expires_in: session.maxAge });
      return sendJson(res, created ? 201 : 200, body);
    }
    sendJson(res, created ? 201 : 200, body, { 'Set-Cookie': session.cookie });
  }

  router.get('/api/auth/config', async (req, res) => {
    sendJson(res, 200, {
      mode: otpMode ? 'otp' : 'password',
      password_reset: Boolean(reset),
      domain: cfg.mailDomain,
      default_country_code: cfg.defaultCountryCode,
      // The Twilio number people can call (press 1) or text JOIN to, to sign up without the app.
      signup_number: cfg.twilio.accountSid && cfg.twilio.fromNumber ? cfg.twilio.fromNumber : undefined,
    });
  });

  const testNumber = () => new ApiError(400, 'test_number', 'This is a test number: sign in with its password (Use a password instead).');

  router.post('/api/auth/otp/start', async (req, res) => {
    if (!otpMode) throw new ApiError(400, 'otp_disabled', 'One-time codes are off; use your password.');
    const body = await readJson(req);
    const phone = normalizePhone(body.phone, cfg.defaultCountryCode);
    if (isTestNumber(phone, cfg.testPhonePrefix)) throw testNumber();
    if (!smsAllowed(phone, cfg.smsCountryCodes)) throw countryNotSupported();
    limiter.hit(`otp-start:ip:${clientIp(req, cfg.trustProxy)}`, 100, 3600);
    limiter.hit(`otp-start:phone:${phone}`, 1, 30, 'Please wait 30 seconds before asking for another code.');
    limiter.hit(`otp-start:phone-hour:${phone}`, 5, 3600, 'Too many codes requested for this number. Try again later.');
    await otp.start(phone);
    console.log(`OTP sent to ${maskPhone(phone)}`);
    sendJson(res, 200, { sent: true, phone });
  });

  router.post('/api/auth/otp/verify', async (req, res) => {
    if (!otpMode) throw new ApiError(400, 'otp_disabled', 'One-time codes are off; use your password.');
    const body = await readJson(req);
    const phone = normalizePhone(body.phone, cfg.defaultCountryCode);
    const code = String(body.code ?? '').replace(/\s/g, '');
    if (!/^\d{4,10}$/.test(code)) throw badRequest('Enter the code we sent you.');
    limiter.hit(`otp-verify:ip:${clientIp(req, cfg.trustProxy)}`, 60, 900);
    limiter.hit(`otp-verify:phone:${phone}`, 10, 900, 'Too many wrong codes. Request a new one later.');
    if (!(await otp.check(phone, code))) {
      throw new ApiError(401, 'wrong_code', 'That code is wrong or has expired.');
    }
    limiter.reset(`otp-verify:phone:${phone}`);
    const { id, created } = await accounts.findOrCreate(phone, via(body.client));
    await finish(req, res, id, created, body.client);
  });

  router.post('/api/auth/register', async (req, res) => {
    if (otpMode) throw new ApiError(400, 'password_signup_disabled', 'Sign up with a one-time code instead.');
    const body = await readJson(req);
    const phone = normalizePhone(body.phone, cfg.defaultCountryCode);
    const password = checkNewPassword(body.password);
    limiter.hit(`register:ip:${clientIp(req, cfg.trustProxy)}`, 10, 3600, 'Too many sign-ups from here. Try again later.');
    if (await accounts.byPhone(phone)) {
      throw conflict('account_exists', 'This number already has an account. Log in instead.');
    }
    const { id, created } = await accounts.findOrCreate(phone, via(body.client));
    if (!created) throw conflict('account_exists', 'This number already has an account. Log in instead.');
    await accounts.setPassword(id, await hashPassword(password));
    await finish(req, res, id, true, body.client);
  });

  router.post('/api/auth/login', async (req, res) => {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone, cfg.defaultCountryCode);
    const password = typeof body.password === 'string' ? body.password : '';
    // Wrong-password limits, keyed so a stranger can't lock someone out of their account:
    //  - per address + number: the normal limit; it only blocks whoever is guessing;
    //  - per address: one address trying many numbers;
    //  - per number, much higher: many addresses guessing one number together.
    const ip = clientIp(req, cfg.trustProxy);
    limiter.hit(`login:ip:${ip}`, 50, 900);
    limiter.hit(`login:ip-phone:${ip}:${phone}`, 10, 900, 'Too many attempts. Try again in a few minutes.');
    limiter.hit(`login:phone:${phone}`, 100, 3600, 'Too many attempts for this number. Try again later.');
    const user = await accounts.byPhone(phone);
    dummyHash ??= await hashPassword('dummy-password');
    const ok = await verifyPassword(password, user?.password_hash || dummyHash);
    if (!user || !user.password_hash || !ok) {
      throw new ApiError(401, 'wrong_credentials', 'Phone number or password is wrong.');
    }
    limiter.reset(`login:ip-phone:${ip}:${phone}`);
    await finish(req, res, user.id, false, body.client === 'portal' ? 'web' : body.client);
  });

  // Forgot password: prove the number with a code by SMS, then choose a new password.
  // The reply is the same whether or not the number has an account (no way to test which
  // numbers are registered), but a code is only sent, and paid for, when it has one.
  router.post('/api/auth/password/reset/start', async (req, res) => {
    if (!reset) throw new ApiError(400, 'reset_unavailable', "Password reset by SMS isn't available here.");
    const body = await readJson(req);
    const phone = normalizePhone(body.phone, cfg.defaultCountryCode);
    if (isTestNumber(phone, cfg.testPhonePrefix)) throw testNumber();
    if (!smsAllowed(phone, cfg.smsCountryCodes)) throw countryNotSupported();
    limiter.hit(`reset-start:ip:${clientIp(req, cfg.trustProxy)}`, 20, 3600);
    limiter.hit(`reset-start:phone:${phone}`, 1, 30, 'Please wait 30 seconds before asking for another code.');
    limiter.hit(`reset-start:phone-hour:${phone}`, 5, 3600, 'Too many codes requested for this number. Try again later.');
    if (await accounts.byPhone(phone)) {
      await reset.start(phone);
      console.log(`password reset code sent to ${maskPhone(phone)}`);
    }
    sendJson(res, 200, { sent: true, phone });
  });

  router.post('/api/auth/password/reset', async (req, res) => {
    if (!reset) throw new ApiError(400, 'reset_unavailable', "Password reset by SMS isn't available here.");
    const body = await readJson(req);
    const phone = normalizePhone(body.phone, cfg.defaultCountryCode);
    const code = String(body.code ?? '').replace(/\s/g, '');
    if (!/^\d{4,10}$/.test(code)) throw badRequest('Enter the code we sent you.');
    const password = checkNewPassword(body.new_password);
    limiter.hit(`reset:phone:${phone}`, 10, 900, 'Too many wrong codes. Request a new one later.');
    const user = await accounts.byPhone(phone);
    if (!user || !(await reset.check(phone, code))) {
      throw new ApiError(401, 'wrong_code', 'That code is wrong or has expired.');
    }
    await accounts.setPassword(user.id, await hashPassword(password));
    await sessions.destroyAllFor(user.id); // anyone signed in with the old password is signed out
    await finish(req, res, user.id, false, body.client === 'portal' ? 'web' : body.client);
  });

  router.post('/api/auth/logout', async (req, res) => {
    const body = await readJson(req);
    if (body.everywhere) {
      const user = await sessions.load(req);
      if (user) await sessions.destroyAllFor(user.id);
    }
    const cookie = await sessions.destroy(req);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  });
}
