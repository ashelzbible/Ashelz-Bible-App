import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '../../../infrastructure/db/migrations');
const ENGINE_DIR = join(here, '../../biochem-engine');

/** Set TEST_ADMIN_DATABASE_URL to a superuser URL to enable the integration tests. */
export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;

export interface TestDb {
  admin: pg.Client;
  urls: { phi: string; worker: string; identity: string };
  teardown(): Promise<void>;
}

function withUser(base: string, user: string, db: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = '';
  u.pathname = `/${db}`;
  return u.toString();
}

/** Create a throwaway database, apply every migration, create one login role per service. */
export async function createTestDb(): Promise<TestDb> {
  const suffix = randomBytes(4).toString('hex');
  const dbName = `fert_it_${suffix}`;
  const roles = { phi: `it_phi_${suffix}`, worker: `it_worker_${suffix}`, identity: `it_identity_${suffix}` };

  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const admin = new pg.Client({ connectionString: withUser(ADMIN_URL!, new URL(ADMIN_URL!).username, dbName) });
  await admin.connect();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    await admin.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  await root.query(`CREATE ROLE ${roles.phi} LOGIN IN ROLE phi_app`);
  await root.query(`CREATE ROLE ${roles.worker} LOGIN IN ROLE engine_worker`);
  await root.query(`CREATE ROLE ${roles.identity} LOGIN IN ROLE identity_app`);

  return {
    admin,
    urls: {
      phi: withUser(ADMIN_URL!, roles.phi, dbName),
      worker: withUser(ADMIN_URL!, roles.worker, dbName),
      identity: withUser(ADMIN_URL!, roles.identity, dbName),
    },
    async teardown() {
      await admin.end();
      await root.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
      for (const r of Object.values(roles)) await root.query(`DROP ROLE ${r}`);
      await root.end();
    },
  };
}

/** Start the real Python engine under uvicorn; resolves once /healthz answers. */
export async function startEngine(port: number, token: string): Promise<{ url: string; stop(): Promise<void> }> {
  const child: ChildProcess = spawn('python3', ['-m', 'uvicorn', 'app.asgi:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], {
    cwd: ENGINE_DIR,
    env: { ...process.env, ENGINE_TOKEN: token },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (i === 99) {
      child.kill();
      throw new Error('engine did not start');
    }
  }
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
