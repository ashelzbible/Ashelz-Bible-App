import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { one, pool, q, tx } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { config } from '../config.ts';
import { activeMemberIds, requireMember } from '../lib/conv.ts';
import { removeMediaIfUnreferenced } from './media.ts';
import { purgeExpiredStatuses } from './status.ts';
import { remindDueCalls, ringTimeout } from './calls.ts';
import { sendMessage } from './messages.ts';

/** Durable job queue on Postgres: SKIP LOCKED claiming, retry with exponential backoff, dead-letter state after max attempts. */
export async function enqueue(kind: string, payload: Record<string, unknown> = {}, delaySec = 0) {
  await q(`insert into background_jobs(kind, payload, run_at) values ($1,$2, now() + ($3 || ' seconds')::interval)`, [kind, JSON.stringify(payload), String(delaySec)]);
}

type Handler = (payload: any) => Promise<void>;
const handlers: Record<string, Handler> = {
  call_timeout: async (p) => ringTimeout(p.callId),
  expire_messages: async () => { await sweepExpiredMessages(); },
  expire_status: async () => { await purgeExpiredStatuses(); },
  prune_events: async () => {
    await q(`delete from user_events where created_at < now() - ($1 || ' days')::interval`, [String(config.eventRetentionDays)]);
    await q(`delete from auth_tokens where expires_at < now() - interval '1 day'`);
    await q(`delete from sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '30 days'`);
    await q(`delete from background_jobs where state = 'done' and created_at < now() - interval '2 days'`);
    await q(`delete from outbox where created_at < now() - interval '30 days'`);
  },
  send_scheduled: async () => { await sendDueScheduled(); await remindDueCalls(); },
};

export async function sweepExpiredMessages() {
  const rows = (await q(
    `update messages set deleted_for_all_at = now(), body = '', meta = '{}', pinned_at = null
      where id in (select id from messages where expires_at <= now() and deleted_for_all_at is null limit 500) returning id, conversation_id, media_id`)).rows;
  const byConv = new Map<string, string[]>();
  for (const r of rows) { byConv.set(r.conversation_id, [...(byConv.get(r.conversation_id) ?? []), r.id]); if (r.media_id) await removeMediaIfUnreferenced(r.media_id); }
  for (const [conv, ids] of byConv) {
    const members = (await q(`select user_id from conversation_members where conversation_id = $1 and left_at is null`, [conv])).rows.map((r) => r.user_id);
    await tx(async (t) => { for (const id of ids) t.emit(members, 'message.delete', { conversationId: conv, messageId: id, expired: true }); });
  }
  return rows.length;
}

export async function sendDueScheduled() {
  const due = (await q(`update scheduled_messages set state = 'sent' where id in (select id from scheduled_messages where state = 'pending' and send_at <= now() order by send_at limit 100 for update skip locked) returning *`)).rows;
  for (const s of due) {
    try {
      await tx((t) => sendMessage(t, { conversationId: s.conversation_id, senderId: s.sender_id, deviceId: null, clientMsgId: `sched-${s.id}`, kind: 'text', body: s.body }));
    } catch (e) {
      await q(`update scheduled_messages set state = 'failed' where id = $1`, [s.id]);
      console.error(JSON.stringify({ level: 'warn', msg: 'scheduled send failed', id: s.id, err: String(e) }));
    }
  }
}

export async function runDueJobs(limit = 10): Promise<number> {
  const client = await pool.connect();
  let jobs: any[] = [];
  try {
    await client.query('begin');
    jobs = (await client.query(
      `update background_jobs set state = 'running', locked_at = now(), attempts = attempts + 1
        where id in (select id from background_jobs where state = 'queued' and run_at <= now() order by run_at limit $1 for update skip locked) returning *`, [limit])).rows;
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  for (const j of jobs) {
    try {
      const h = handlers[j.kind];
      if (!h) throw new Error(`no handler for ${j.kind}`);
      await h(j.payload);
      await q(`update background_jobs set state = 'done', last_error = null where id = $1`, [j.id]);
    } catch (e) {
      const dead = j.attempts >= j.max_attempts;
      await q(`update background_jobs set state = $2, last_error = $3, run_at = now() + ($4 || ' seconds')::interval where id = $1`, [j.id, dead ? 'failed' : 'queued', String(e).slice(0, 500), String(Math.min(3600, 5 * 2 ** j.attempts))]);
      console.error(JSON.stringify({ level: 'error', msg: 'job failed', kind: j.kind, attempt: j.attempts, err: String(e) }));
    }
  }
  return jobs.length;
}

let timers: NodeJS.Timeout[] = [];
export function startWorker() {
  const tick = () => runDueJobs().catch((e) => console.error('worker', e));
  timers.push(setInterval(tick, 1000));
  // Recurring maintenance; each runs through the same queue so it is retried and observable.
  const recurring: Array<[string, number]> = [['expire_messages', 20], ['expire_status', 60], ['send_scheduled', 10], ['prune_events', 3600]];
  for (const [kind, every] of recurring) {
    const ensure = async () => {
      const exists = await one(`select 1 from background_jobs where kind = $1 and state in ('queued','running')`, [kind]);
      if (!exists) await enqueue(kind, {}, 0);
    };
    timers.push(setInterval(() => ensure().catch(() => {}), every * 1000));
  }
}
export function stopWorker() { for (const t of timers) clearInterval(t); timers = []; }

export async function jobRoutes(app: FastifyInstance) {
  app.post('/api/conversations/:id/scheduled', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ body: z.string().min(1).max(8000), sendAt: z.string().datetime() }), req.body);
    const when = new Date(b.sendAt);
    if (when.getTime() < Date.now() + 5000 || when.getTime() > Date.now() + 365 * 86400_000) throw badRequest('invalid_send_time');
    await requireMember(pool, id, req.auth.userId);
    const n = await one(`select count(*)::int n from scheduled_messages where sender_id = $1 and state = 'pending'`, [req.auth.userId]);
    if (n.n >= 50) throw badRequest('too_many_scheduled');
    const r = await one(`insert into scheduled_messages(conversation_id, sender_id, body, send_at) values ($1,$2,$3,$4) returning id`, [id, req.auth.userId, b.body, when]);
    reply.code(201);
    return { id: r.id };
  });
  app.get('/api/scheduled', { preHandler: authenticateVerified }, async (req) => ({
    scheduled: (await q(`select id, conversation_id "conversationId", body, send_at "sendAt", state from scheduled_messages where sender_id = $1 and state = 'pending' order by send_at`, [req.auth.userId])).rows,
  }));
  app.delete('/api/scheduled/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await one(`update scheduled_messages set state = 'cancelled' where id = $1 and sender_id = $2 and state = 'pending' returning id`, [id, req.auth.userId]);
    if (!r) throw notFound('scheduled_not_found');
    reply.code(204);
  });
}
void activeMemberIds; void randomUUID;
