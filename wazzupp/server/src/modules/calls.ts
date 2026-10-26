import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { one, q, tx } from '../db/pool.ts';
import type { Tx } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { config } from '../config.ts';
import { hub } from '../lib/hub.ts';
import { activeMemberIds, requireMember } from '../lib/conv.ts';
import { sendMessage } from './messages.ts';
import { randomUUID } from 'node:crypto';
import { pushToUser } from './notify.ts';
import { enqueue } from './jobs.ts';
import { rateLimit } from '../lib/ratelimit.ts';

/**
 * 1:1 call state machine. Valid transitions only; "connected" is set exclusively when a participant
 * reports that its ICE/DTLS transport reached the connected state, and only once both sides have.
 *
 *   ringing -> connecting (callee accepted) -> connected (both peers report media up) -> ended
 *   ringing -> declined | missed | cancelled | failed
 *   connecting/connected -> ended | failed
 */
const TERMINAL = new Set(['declined', 'missed', 'ended', 'failed', 'cancelled']);

export function iceServers(userId: string) {
  const servers: Array<{ urls: string[]; username?: string; credential?: string }> = [];
  if (config.ice.stun.length) servers.push({ urls: config.ice.stun });
  if (config.ice.turn.length && config.ice.turnSecret) {
    // coturn "use-auth-secret" REST credentials: username = expiry:user, password = HMAC-SHA1(secret, username). Valid for 1 hour.
    const username = `${Math.floor(Date.now() / 1000) + 3600}:${userId}`;
    servers.push({ urls: config.ice.turn, username, credential: createHmac('sha1', config.ice.turnSecret).update(username).digest('base64') });
  }
  return servers;
}

async function loadCall(t: Tx, callId: string) {
  const c = await t.one(`select * from calls where id = $1 for update`, [callId]);
  if (!c) throw notFound('call_not_found');
  return c;
}
async function participants(t: Tx, callId: string) {
  return (await t.q(`select user_id, state from call_participants where call_id = $1`, [callId])).rows as Array<{ user_id: string; state: string }>;
}
const callDto = (c: any) => ({ id: c.id, conversationId: c.conversation_id, initiatorId: c.initiator_id, kind: c.kind, state: c.state, createdAt: c.created_at, answeredAt: c.answered_at, connectedAt: c.connected_at, endedAt: c.ended_at, endReason: c.end_reason });

async function finish(t: Tx, call: any, state: 'declined' | 'missed' | 'ended' | 'failed' | 'cancelled', reason: string) {
  await t.q(`update calls set state = $2, ended_at = now(), end_reason = $3 where id = $1`, [call.id, state, reason]);
  await t.q(`update call_participants set state = case when state in ('invited') then (case when $2 = 'missed' then 'missed' when $2 = 'declined' then 'declined' else 'left' end) else 'left' end, left_at = coalesce(left_at, now()) where call_id = $1`, [call.id, state]);
  const ps = await participants(t, call.id);
  const updated = { ...call, state, ended_at: new Date(), end_reason: reason };
  t.emit(ps.map((p) => p.user_id), 'call.state', { call: callDto(updated) });
  // Call log entry in the conversation (system message), including missed-call notices.
  const dur = call.connected_at ? Math.round((Date.now() - new Date(call.connected_at).getTime()) / 1000) : 0;
  await sendMessage(t, { conversationId: call.conversation_id, senderId: call.initiator_id, deviceId: null, clientMsgId: `call-${call.id}`, kind: 'system', body: '', meta: { event: 'call', callId: call.id, callKind: call.kind, state, durationSec: dur }, system: true });
  if (state === 'missed') {
    for (const p of ps) if (p.user_id !== call.initiator_id) {
      await t.q(`insert into notifications(user_id, kind, conversation_id, payload) values ($1,'missed_call',$2,$3)`, [p.user_id, call.conversation_id, JSON.stringify({ callId: call.id, from: call.initiator_id })]);
      t.afterCommit.push(async () => { if (!(await hub.isOnline(p.user_id))) await pushToUser(p.user_id, null, { title: 'Missed call', body: 'You missed a call', tag: `call:${call.id}`, data: { conversationId: call.conversation_id } }); });
    }
  }
}

export async function startCall(userId: string, conversationId: string, kind: 'audio' | 'video') {
  await rateLimit(`call:${userId}`, 20, 300);
  const flag = await one(`select enabled from feature_flags where key = 'calls_enabled'`);
  if (flag && !flag.enabled) throw forbidden('calls_disabled');
  const call = await tx(async (t) => {
    const conv = await requireMember(t, conversationId, userId, true);
    if (conv.kind !== 'direct') throw badRequest('group_calls_unsupported', 'Group calls need the SFU integration (see docs/CALLS.md)');
    const others = (await activeMemberIds(t, conversationId)).filter((u) => u !== userId);
    const other = others[0];
    const blk = await t.one(`select 1 from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`, [userId, other]);
    if (blk) throw forbidden('cannot_call');
    const busy = await t.one(`select c.id from calls c join call_participants p on p.call_id = c.id where p.user_id = any($1::uuid[]) and c.state in ('ringing','connecting','connected') limit 1`, [[userId, other]]);
    if (busy) throw conflict('busy', 'A call is already in progress');
    const c = await t.one(`insert into calls(conversation_id, initiator_id, kind) values ($1,$2,$3) returning *`, [conversationId, userId, kind]);
    await t.q(`insert into call_participants(call_id, user_id, state, joined_at) values ($1,$2,'joined',now()),($1,$3,'invited',null)`, [c.id, userId, other]);
    t.emit([userId, other], 'call.incoming', { call: callDto(c), from: userId, ice: undefined });
    const caller = await t.one(`select display_name from user_profiles where user_id = $1`, [userId]);
    t.afterCommit.push(async () => {
      await enqueue('call_timeout', { callId: c.id }, config.ringTimeoutSeconds);
      if (!(await hub.isOnline(other))) {
        await pushToUser(other, null, { title: `${caller.display_name}`, body: kind === 'video' ? 'Incoming video call' : 'Incoming voice call', tag: `call:${c.id}`, data: { conversationId, callId: c.id, type: 'call' } });
      }
    });
    return c;
  });
  return callDto(call);
}

export async function ringTimeout(callId: string) {
  await tx(async (t) => {
    const c = await t.one(`select * from calls where id = $1 for update`, [callId]);
    if (c && c.state === 'ringing') await finish(t, c, 'missed', 'no_answer');
  });
}

/** Validated actions from either HTTP or the WebSocket. */
export async function callAction(userId: string, callId: string, action: 'accept' | 'decline' | 'cancel' | 'end' | 'media_up' | 'failed') {
  return tx(async (t) => {
    const call = await loadCall(t, callId);
    const ps = await participants(t, callId);
    const me = ps.find((p) => p.user_id === userId);
    if (!me) throw notFound('call_not_found'); // not a participant: indistinguishable from nonexistent
    if (TERMINAL.has(call.state)) return callDto(call);
    const isCaller = call.initiator_id === userId;
    switch (action) {
      case 'accept': {
        if (isCaller || call.state !== 'ringing') throw conflict('invalid_state');
        await t.q(`update calls set state = 'connecting', answered_at = now() where id = $1`, [callId]);
        await t.q(`update call_participants set state = 'joined', joined_at = now() where call_id = $1 and user_id = $2`, [callId, userId]);
        const c2 = { ...call, state: 'connecting', answered_at: new Date() };
        t.emit(ps.map((p) => p.user_id), 'call.state', { call: callDto(c2), acceptedBy: userId });
        return callDto(c2);
      }
      case 'decline': if (isCaller || call.state !== 'ringing') throw conflict('invalid_state'); await finish(t, call, 'declined', 'declined'); return callDto({ ...call, state: 'declined' });
      case 'cancel': if (!isCaller || call.state !== 'ringing') throw conflict('invalid_state'); await finish(t, call, 'cancelled', 'cancelled'); return callDto({ ...call, state: 'cancelled' });
      case 'end': await finish(t, call, 'ended', 'hangup'); return callDto({ ...call, state: 'ended' });
      case 'failed': await finish(t, call, 'failed', 'connection_failed'); return callDto({ ...call, state: 'failed' });
      case 'media_up': {
        if (call.state !== 'connecting' && call.state !== 'connected') throw conflict('invalid_state');
        await t.q(`update call_participants set media_up_at = coalesce(media_up_at, now()) where call_id = $1 and user_id = $2`, [callId, userId]);
        const up = await t.one(`select count(*) filter (where media_up_at is not null)::int n, count(*)::int total from call_participants where call_id = $1`, [callId]);
        if (call.state === 'connecting' && up.n === up.total) {
          await t.q(`update calls set state = 'connected', connected_at = now() where id = $1`, [callId]);
          const c2 = { ...call, state: 'connected', connected_at: new Date() };
          t.emit(ps.map((p) => p.user_id), 'call.state', { call: callDto(c2) });
          return callDto(c2);
        }
        return callDto(call);
      }
    }
  });
}

/** Relay SDP/ICE only between participants of a live call. */
export async function relaySignal(userId: string, callId: string, signal: unknown) {
  const call = await one(`select c.state from calls c join call_participants p on p.call_id = c.id and p.user_id = $2 where c.id = $1`, [callId, userId]);
  if (!call || TERMINAL.has(call.state)) throw notFound('call_not_found');
  const others = (await q(`select user_id from call_participants where call_id = $1 and user_id <> $2`, [callId, userId])).rows.map((r) => r.user_id as string);
  hub.toUsers(others, { t: 'call.signal', callId, from: userId, signal });
}

export async function callRoutes(app: FastifyInstance) {
  app.get('/api/calls/ice', { preHandler: authenticateVerified }, async (req) => ({ iceServers: iceServers(req.auth.userId), ttlSeconds: 3600, turnConfigured: !!(config.ice.turn.length && config.ice.turnSecret) }));
  app.post('/api/calls', { preHandler: authenticateVerified }, async (req, reply) => {
    const b = parse(z.object({ conversationId: z.string().uuid(), kind: z.enum(['audio', 'video']) }), req.body);
    const call = await startCall(req.auth.userId, b.conversationId, b.kind);
    reply.code(201);
    return { call, iceServers: iceServers(req.auth.userId) };
  });
  app.post('/api/calls/:id/:action', { preHandler: authenticateVerified }, async (req) => {
    const { id, action } = parse(z.object({ id: z.string().uuid(), action: z.enum(['accept', 'decline', 'cancel', 'end', 'media_up', 'failed']) }), req.params);
    const call = await callAction(req.auth.userId, id, action);
    return { call, iceServers: action === 'accept' ? iceServers(req.auth.userId) : undefined };
  });
  app.get('/api/calls', { preHandler: authenticateVerified }, async (req) => {
    const { rows } = await q(
      `select c.*, o.user_id other_id, op.display_name other_name, op.avatar_media_id other_avatar, ou.username other_username
         from calls c join call_participants me on me.call_id = c.id and me.user_id = $1
         join call_participants o on o.call_id = c.id and o.user_id <> $1 join users ou on ou.id = o.user_id join user_profiles op on op.user_id = o.user_id
        order by c.created_at desc limit 100`, [req.auth.userId]);
    return { calls: rows.map((r) => ({ ...callDto(r), direction: r.initiator_id === req.auth.userId ? 'outgoing' : 'incoming', other: { id: r.other_id, displayName: r.other_name, username: r.other_username, avatarMediaId: r.other_avatar },
      durationSec: r.connected_at && r.ended_at ? Math.round((+new Date(r.ended_at) - +new Date(r.connected_at)) / 1000) : 0 })) };
  });
  app.get('/api/calls/active', { preHandler: authenticateVerified }, async (req) => {
    const r = await one(`select c.* from calls c join call_participants p on p.call_id = c.id and p.user_id = $1 where c.state in ('ringing','connecting','connected') order by c.created_at desc limit 1`, [req.auth.userId]);
    return { call: r ? callDto(r) : null, iceServers: r ? iceServers(req.auth.userId) : undefined };
  });
}
void randomUUID;
