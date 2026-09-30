// Twilio over plain HTTPS (no SDK): Verify (one-time codes), Messaging (SMS) and
// webhook signature checks. Docs: https://www.twilio.com/docs/verify/api, /docs/sms/api,
// /docs/usage/webhooks/webhooks-security

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isTestNumber, smsAllowed, maskPhone } from '../auth/phone.js';
import { ApiError } from '../http/util.js';

export const countryNotSupported = () =>
  new ApiError(400, 'country_not_supported', "PhoneMail can't send texts to numbers in that country yet.");

export class TwilioError extends Error {
  constructor(status, body) {
    super(body?.message || `Twilio returned HTTP ${status}`);
    this.status = status;
    this.twilioCode = body?.code;
  }
}

export function twilioClient(cfg) {
  // Never text countries we don't serve, whichever code path asks (defence in depth).
  // Test numbers (TEST_PHONE_PREFIX) are never texted either.
  const allowed = (to) => smsAllowed(to, cfg.smsCountryCodes) && !isTestNumber(to, cfg.testPhonePrefix);
  const { accountSid, authToken, verifySid, fromNumber } = cfg.twilio;
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  async function post(url, params) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new TwilioError(res.status, body);
    return body;
  }

  return {
    canSendSms: Boolean(accountSid && authToken && fromNumber),

    /** Asks Twilio Verify to text a one-time code to `phone`. */
    async startVerification(phone) {
      if (!allowed(phone)) throw countryNotSupported();
      await post(`https://verify.twilio.com/v2/Services/${verifySid}/Verifications`, { To: phone, Channel: 'sms' });
    },

    /** True if `code` is the right, unexpired code for `phone`. */
    async checkVerification(phone, code) {
      try {
        const r = await post(`https://verify.twilio.com/v2/Services/${verifySid}/VerificationCheck`, { To: phone, Code: code });
        return r.status === 'approved';
      } catch (err) {
        // 404 = no pending code (expired, already used, or never sent).
        if (err instanceof TwilioError && err.status === 404) return false;
        throw err;
      }
    },

    /** Sends a plain SMS from our Twilio number: 'sent', 'blocked' (country) or 'not_configured'. */
    async sendSms(to, body) {
      if (!allowed(to)) {
        console.log(`[sms blocked] ${maskPhone(to)}: a test number, or a country not in SMS_COUNTRY_CODES`);
        return 'blocked';
      }
      if (!this.canSendSms) {
        console.log(`[sms not configured] to ${to}: ${body}`);
        return 'not_configured';
      }
      await post(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, { From: fromNumber, To: to, Body: body });
      return 'sent';
    },
  };
}

/**
 * Twilio signs each webhook: base64(HMAC-SHA1(authToken, fullUrl + each POST param
 * name+value, sorted by name)). We recompute it and compare.
 */
export function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function validTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
