import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, statement_timeout: 30_000 });
  // An idle-client error must not crash the process; the pool replaces the client.
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Run `fn` in a transaction with the session settings that Row-Level Security
 * policies read. Settings are transaction-local (set_config(..., true)), so
 * they cannot leak to the next request that reuses the pooled connection.
 */
export async function withTx<T>(pool: pg.Pool, settings: Record<string, string>, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [k, v] of Object.entries(settings)) {
      await client.query('SELECT set_config($1, $2, true)', [k, v]);
    }
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection is already broken; release below discards it */
    }
    throw err;
  } finally {
    client.release();
  }
}
