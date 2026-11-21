// Idempotent database provisioning, run at every start as the database OWNER (the application never uses
// that login): applies pending migrations, then creates/refreshes the three least-privilege service roles.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { derive, ROLES } from './derive.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = process.env.MIGRATIONS_DIR ?? join(here, '../infrastructure/db/migrations');
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is required');
const { rolePasswords } = derive(process.env.MASTER_SECRET);

const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
try {
  await client.query('SELECT pg_advisory_lock(727274)'); // serialise concurrent starts
  await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await client.query('SELECT version FROM public.schema_migrations')).rows.map((r) => r.version));
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    if (applied.has(f)) continue;
    console.log(`provision: applying ${f}`);
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(migrationsDir, f), 'utf8'));
      await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [f]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (/permission denied to create role|must have CREATEROLE/i.test(err.message)) {
        throw new Error(`${err.message}\nThe database login in DATABASE_OWNER_URL must be allowed to create roles (CREATEROLE).`);
      }
      throw err;
    }
  }
  for (const [key, { name, group }] of Object.entries(ROLES)) {
    const lit = (await client.query('SELECT quote_literal($1) AS l', [rolePasswords[key]])).rows[0].l;
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount > 0;
    await client.query(exists ? `ALTER ROLE ${name} LOGIN PASSWORD ${lit}` : `CREATE ROLE ${name} LOGIN PASSWORD ${lit}`);
    await client.query(`GRANT ${group} TO ${name}`);
  }
  console.log('provision: database ready');
} finally {
  await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
  await client.end();
}
