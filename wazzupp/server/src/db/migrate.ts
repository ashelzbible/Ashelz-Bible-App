import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(log = true): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(7770001)');
    await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations(name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
        if (log) console.log(`applied ${file}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${e}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(7770001)').catch(() => {});
    client.release();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
