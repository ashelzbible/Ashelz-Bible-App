import pg from 'pg';
import { config } from '../config.ts';

// Return bigint columns as numbers (sequence numbers stay far below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
pool.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', err: String(err) })));

export type Db = pg.Pool | pg.PoolClient;

export interface PendingEvent {
  userIds: string[];
  type: string;
  payload: Record<string, unknown>;
  durable?: boolean;
}

/** Collects realtime events during a transaction; they are persisted inside it and published after commit. */
export class Tx {
  client: pg.PoolClient;
  events: PendingEvent[] = [];
  afterCommit: Array<() => void | Promise<void>> = [];
  constructor(client: pg.PoolClient) { this.client = client; }

  async q<R extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    return this.client.query<R>(text, params as any[]);
  }
  async one<R extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<R | undefined> {
    return (await this.q<R>(text, params)).rows[0];
  }
  emit(userIds: string[], type: string, payload: Record<string, unknown>) {
    const ids = [...new Set(userIds)];
    if (ids.length) this.events.push({ userIds: ids, type, payload, durable: true });
  }
}

export type Publisher = (events: Array<{ userId: string; id: number; type: string; payload: unknown; createdAt: string }>) => void | Promise<void>;
let publisher: Publisher = () => {};
export function setPublisher(p: Publisher) { publisher = p; }

export async function tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const t = new Tx(client);
  try {
    await client.query('begin');
    const result = await fn(t);
    const out: Array<{ userId: string; id: number; type: string; payload: unknown; createdAt: string }> = [];
    for (const ev of t.events) {
      if (!ev.durable) continue;
      const { rows } = await client.query(
        `insert into user_events(user_id, type, payload)
         select u, $2, $3::jsonb from unnest($1::uuid[]) u returning id, user_id, created_at`,
        [ev.userIds, ev.type, JSON.stringify(ev.payload)],
      );
      for (const r of rows) out.push({ userId: r.user_id, id: r.id, type: ev.type, payload: ev.payload, createdAt: r.created_at.toISOString() });
    }
    await client.query('commit');
    client.release();
    try { await publisher(out); } catch (e) { console.error('publish failed', e); }
    for (const fn2 of t.afterCommit) { try { await fn2(); } catch (e) { console.error('afterCommit failed', e); } }
    return result;
  } catch (e) {
    try { await client.query('rollback'); } catch { /* ignore */ }
    client.release();
    throw e;
  }
}

export async function q<R extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  return pool.query<R>(text, params as any[]);
}
export async function one<R extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  return (await pool.query<R>(text, params as any[])).rows[0];
}
