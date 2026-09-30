// PostgreSQL connection (postgres.js) and the API service's own migrations.

import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function connect(url, options = {}) {
  return postgres(url, {
    max: 10,
    idle_timeout: 30,
    // bigint (int8) ids come back as JavaScript numbers rather than strings.
    // Numbers are exact up to 9 quadrillion, far more ids than we'll ever have.
    types: {
      bigint: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) },
    },
    transform: { undefined: null },
    onnotice: () => {},
    ...options,
  });
}

/** Waits until the database answers AND the mail service has created the users table. */
export async function waitForSchema(sql, { attempts = 60 } = {}) {
  for (let i = 1; ; i++) {
    try {
      const [row] = await sql`SELECT to_regclass('public.users') IS NOT NULL AS ready`;
      if (row.ready) return;
      if (i === 1) console.log('waiting for the mail service to create the users table...');
    } catch (err) {
      if (i === 1) console.log(`waiting for the database: ${err.message}`);
    }
    if (i >= attempts) throw new Error('database or users table not ready (is the mail service running?)');
    await sleep(2000);
  }
}

/** Applies src/migrations/*.sql files that haven't run yet, in name order. */
export async function migrate(sql) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727275)`; // one migrator at a time
    await tx`CREATE TABLE IF NOT EXISTS api_schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const [done] = await tx`SELECT 1 FROM api_schema_migrations WHERE version = ${version}`;
      if (done) continue;
      await tx.unsafe(await readFile(path.join(dir, file), 'utf8'));
      await tx`INSERT INTO api_schema_migrations (version) VALUES (${version})`;
      console.log(`applied migration ${version}`);
    }
  });
}
