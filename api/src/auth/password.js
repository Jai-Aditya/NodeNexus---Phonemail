// Password hashing with scrypt (built into Node): slow on purpose, salted, no extra library.

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { badRequest } from '../http/util.js';

const scryptAsync = promisify(scrypt);
const N = 16384, r = 8, p = 1, KEYLEN = 64;

/** Stored format: scrypt$N$r$p$<salt b64>$<hash b64> */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, rr, pp, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(rr), p: Number(pp),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function checkNewPassword(password) {
  if (typeof password !== 'string') throw badRequest('Enter a password.');
  if (password.length < 8) throw badRequest('Use at least 8 characters for your password.');
  if (password.length > 200) throw badRequest('That password is too long.');
  return password;
}

/** A random temporary password for accounts created by phone call / SMS in password mode. */
export function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (l/1, o/0)
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
