// Phone numbers are stored in E.164 form: "+" then 10–15 digits, e.g. +919876543210.

import { badRequest } from '../http/util.js';

/**
 * Normalises what a person typed: "98765 43210", "09876543210", "+91-98765-43210",
 * "919876543210" → "+919876543210" (with defaultCountryCode "91").
 */
export function normalizePhone(input, defaultCountryCode = '91') {
  if (typeof input !== 'string' || !input.trim()) throw badRequest('Enter a phone number.');
  const raw = input.trim();
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) {
    // already international
  } else if (raw.startsWith('00')) {
    digits = digits.slice(2); // 00 is the international prefix
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = defaultCountryCode + digits.slice(1); // national trunk 0
  } else if (digits.length === 10) {
    digits = defaultCountryCode + digits;
  }
  if (digits.length < 10 || digits.length > 15 || digits.startsWith('0')) {
    throw badRequest('That doesn\'t look like a valid phone number.');
  }
  return '+' + digits;
}

/** The mailbox part of a user's address: the last 10 digits (matches the database's phone_local). */
export const phoneLocal = (e164) => e164.slice(-10);

export const addressOf = (e164, domain) => `${phoneLocal(e164)}@${domain}`;

/** "+919876543210" → "+91•••••43210", for logs. */
export const maskPhone = (e164) => e164.slice(0, 3) + '•'.repeat(Math.max(0, e164.length - 8)) + e164.slice(-5);

/** True for a test number (TEST_PHONE_PREFIX): never texted. */
export const isTestNumber = (e164, prefix) => Boolean(prefix) && e164.startsWith(prefix);

/** True if we may text this number: its country code is in SMS_COUNTRY_CODES. */
export const smsAllowed = (e164, countryCodes) => countryCodes.some((cc) => e164.startsWith('+' + cc));
