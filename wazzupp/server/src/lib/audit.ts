import { q } from '../db/pool.ts';
import type { Tx } from '../db/pool.ts';

export async function audit(actorId: string | null, action: string, target: string | null, detail: Record<string, unknown> = {}, ip?: string, t?: Tx) {
  const sql = `insert into audit_events(actor_id, action, target, detail, ip) values ($1,$2,$3,$4,$5)`;
  const params = [actorId, action, target, JSON.stringify(detail), ip ?? null];
  if (t) await t.q(sql, params); else await q(sql, params);
}
