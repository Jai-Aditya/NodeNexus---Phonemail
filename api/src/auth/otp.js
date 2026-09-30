// One-time codes: sent by Twilio Verify (AUTH_MODE=twilio) or printed in the log (AUTH_MODE=console).

import { randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../http/util.js';
import { TwilioError } from '../twilio/client.js';
import { maskPhone } from './phone.js';

const sha256 = (s) => createHash('sha256').update(s).digest();

export function otpProvider(cfg, sql, twilio) {
  if (cfg.authMode === 'twilio') {
    return {
      async start(phone) {
        try {
          await twilio.startVerification(phone);
        } catch (err) {
          if (err instanceof TwilioError) {
            console.error(`Twilio Verify start failed for ${maskPhone(phone)}: ${err.message}`);
            // 60200 invalid number, 60203 too many sends, 21608 unverified number on a trial account
            if (err.twilioCode === 60203) throw new ApiError(429, 'too_many_requests', 'Too many codes sent to this number. Try again later.');
            if (err.twilioCode === 21608 || err.twilioCode === 60200) {
              throw new ApiError(400, 'cannot_send', 'We can\'t send a code to this number.');
            }
            throw new ApiError(502, 'sms_failed', 'Couldn\'t send the code. Please try again.');
          }
          throw err;
        }
      },
      async check(phone, code) {
        try {
          return await twilio.checkVerification(phone, code);
        } catch (err) {
          if (err instanceof TwilioError) {
            if (err.twilioCode === 60202) throw new ApiError(429, 'too_many_requests', 'Too many wrong codes. Request a new one.');
            throw new ApiError(502, 'sms_failed', 'Couldn\'t check the code. Please try again.');
          }
          throw err;
        }
      },
    };
  }

  if (cfg.authMode === 'console') {
    return localCodes(sql, async (phone, code) => console.log(`[dev OTP] code for ${phone}: ${code}`));
  }

  return null; // password mode: no one-time codes
}

/**
 * Codes we make and store ourselves (hashed, 10 minutes, 5 tries, one use); `deliver`
 * gets them to the person: printed in the log (console mode) or texted (resetCodes).
 */
function localCodes(sql, deliver) {
  return {
    async start(phone) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await sql`
        INSERT INTO otp_codes (phone, code_hash, expires_at)
        VALUES (${phone}, ${sha256(code).toString('hex')}, now() + interval '10 minutes')
        ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash,
          expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`;
      await deliver(phone, code);
      return code; // returned only for tests; never sent to the client
    },
    async check(phone, code) {
      const [row] = await sql`
        UPDATE otp_codes SET attempts = attempts + 1
        WHERE phone = ${phone} AND expires_at > now()
        RETURNING code_hash, attempts`;
      if (!row) return false;
      if (row.attempts > 5) {
        await sql`DELETE FROM otp_codes WHERE phone = ${phone}`;
        throw new ApiError(429, 'too_many_requests', 'Too many wrong codes. Request a new one.');
      }
      const ok = timingSafeEqual(sha256(code), Buffer.from(row.code_hash, 'hex'));
      if (ok) await sql`DELETE FROM otp_codes WHERE phone = ${phone}`; // one use only
      return ok;
    },
  };
}

/**
 * Codes for resetting a forgotten password. With sign-in codes on (Twilio Verify or console),
 * the same codes; in password mode, our own codes sent as a plain SMS if Twilio can text.
 * null = no way to prove the number, so no reset.
 */
export function resetCodes(cfg, sql, twilio, otp) {
  if (otp) return otp;
  if (!twilio.canSendSms) return null;
  return localCodes(sql, async (phone, code) => {
    const result = await twilio.sendSms(phone, `Your PhoneMail code is ${code}. It expires in 10 minutes. Don't share it.`);
    if (result !== 'sent') throw new ApiError(400, 'cannot_send', "We can't send a code to this number.");
  });
}
