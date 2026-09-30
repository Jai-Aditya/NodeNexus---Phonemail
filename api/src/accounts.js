// Accounts: creating users, profiles and alias addresses. The API service is the
// only writer of the users and aliases tables.

import { badRequest, conflict, notFound } from './http/util.js';
import { addressOf } from './auth/phone.js';

const VIA = new Set(['ivr', 'sms', 'portal', 'web', 'mobile']);
const MAX_ALIASES = 5;
// Addresses people expect to reach the organisation, never a user.
const RESERVED = new Set([
  'abuse', 'admin', 'administrator', 'help', 'hostmaster', 'info', 'mailer-daemon', 'noc',
  'no-reply', 'noreply', 'postmaster', 'root', 'security', 'support', 'webmaster', 'phonemail',
]);

export function accounts(sql, cfg) {
  return {
    /**
     * Returns the user with this phone, creating the account if it's new.
     * `via` records how the account was created (ivr, sms, portal, web, mobile).
     */
    async findOrCreate(phone, via) {
      if (!VIA.has(via)) via = 'web';
      try {
        const [created] = await sql`
          INSERT INTO users (phone, created_via) VALUES (${phone}, ${via})
          ON CONFLICT (phone) DO NOTHING
          RETURNING id`;
        if (created) return { id: created.id, created: true };
      } catch (err) {
        // Another number with the same last 10 digits already has that mailbox.
        if (err.code === '23505' && err.constraint_name === 'users_phone_local_key') {
          throw conflict('number_taken', 'This number can\'t be registered: its mailbox address is already in use.');
        }
        throw err;
      }
      const [existing] = await sql`SELECT id FROM users WHERE phone = ${phone}`;
      return { id: existing.id, created: false };
    },

    async byPhone(phone) {
      const [u] = await sql`SELECT id, password_hash FROM users WHERE phone = ${phone}`;
      return u || null;
    },

    /** The profile the frontend shows (never the password hash). */
    async profile(userId) {
      const [u] = await sql`
        SELECT id, phone, display_name, language, avatar_url, has_push, created_via,
               signature, undo_send_seconds, password_hash IS NOT NULL AS has_password
        FROM users WHERE id = ${userId}`;
      if (!u) throw notFound('User not found.');
      const aliases = await sql`SELECT alias FROM aliases WHERE user_id = ${userId} ORDER BY alias`;
      return {
        ...u,
        address: addressOf(u.phone, cfg.mailDomain),
        aliases: aliases.map((a) => a.alias),
        auth_mode: cfg.authMode === 'password' ? 'password' : 'otp',
      };
    },

    async updateProfile(userId, fields) {
      const set = {};
      if (fields.display_name !== undefined) set.display_name = fields.display_name;
      if (fields.language !== undefined) set.language = fields.language;
      if (fields.avatar_url !== undefined) set.avatar_url = fields.avatar_url;
      if (fields.signature !== undefined) set.signature = fields.signature;
      if (fields.undo_send_seconds !== undefined) set.undo_send_seconds = fields.undo_send_seconds;
      if (Object.keys(set).length) {
        await sql`UPDATE users SET ${sql(set)} WHERE id = ${userId}`;
      }
    },

    async setPassword(userId, hash) {
      await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;
    },

    /** Turns "Kavya.Rao" or "kavya.rao@phonemail.com" into a valid full alias, or explains why not. */
    normalizeAlias(input) {
      if (typeof input !== 'string' || !input.trim()) throw badRequest('Enter an alias.');
      let local = input.trim().toLowerCase();
      if (local.includes('@')) {
        const [l, domain] = local.split('@');
        if (domain !== cfg.mailDomain) throw badRequest(`Aliases must end in @${cfg.mailDomain}.`);
        local = l;
      }
      if (local.length < 3 || local.length > 30) throw badRequest('An alias must be 3–30 characters.');
      if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(local) || /[._-]{2}/.test(local)) {
        throw badRequest('Use letters, numbers, dots, dashes or underscores (not at the start or end, and not two in a row).');
      }
      // Must contain a letter, so it can never look like someone's phone number.
      if (!/[a-z]/.test(local)) throw badRequest('An alias must contain at least one letter.');
      if (RESERVED.has(local) || cfg.reservedAliases.includes(local)) throw conflict('alias_taken', 'That alias isn\'t available.');
      return `${local}@${cfg.mailDomain}`;
    },

    async addAlias(userId, input) {
      const alias = this.normalizeAlias(input);
      return sql.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`; // serialise per user
        const [{ count }] = await tx`SELECT count(*)::int AS count FROM aliases WHERE user_id = ${userId}`;
        if (count >= MAX_ALIASES) throw conflict('too_many_aliases', `You can have at most ${MAX_ALIASES} aliases.`);
        const [row] = await tx`
          INSERT INTO aliases (alias, user_id) VALUES (${alias}, ${userId})
          ON CONFLICT (alias) DO NOTHING RETURNING alias`;
        if (!row) throw conflict('alias_taken', 'That alias is already taken.');
        return alias;
      });
    },

    async removeAlias(userId, input) {
      const alias = input.includes('@') ? input.toLowerCase() : `${input.toLowerCase()}@${cfg.mailDomain}`;
      const rows = await sql`DELETE FROM aliases WHERE alias = ${alias} AND user_id = ${userId} RETURNING alias`;
      if (!rows.length) throw notFound('You don\'t have that alias.');
    },
  };
}
