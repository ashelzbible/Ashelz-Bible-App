import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, q, tx, pool } from '../db/pool.ts';
import type { Tx } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { rateLimit } from '../lib/ratelimit.ts';
import { activeMemberIds, canPost, isStaffRole, loadMessage, MESSAGE_COLS, MESSAGE_JOINS, otherWatermarks, requireMember, statusFor, toMessage } from '../lib/conv.ts';
import type { MessageDTO } from '../lib/conv.ts';
import { config } from '../config.ts';
import { notifyNewMessage } from './notify.ts';
import { removeMediaIfUnreferenced } from './media.ts';
import { withDefaults } from '../lib/settings.ts';

const KINDS = ['text', 'image', 'video', 'voice', 'audio', 'document', 'location', 'contact', 'sticker', 'gif', 'poll', 'event'] as const;
const MEDIA_KINDS = new Set(['image', 'video', 'voice', 'audio', 'document', 'sticker']);

const metaSchemas: Record<string, z.ZodType<any>> = {
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().max(200).optional(), live: z.boolean().optional(), liveUntil: z.string().optional() }).strict(),
  contact: z.object({ name: z.string().min(1).max(100), phone: z.string().max(32).optional(), email: z.string().max(254).optional(), userId: z.string().uuid().optional() }).strict(),
  poll: z.object({ question: z.string().min(1).max(300), options: z.array(z.string().min(1).max(100)).min(2).max(12), multi: z.boolean().default(false) }).strict(),
  event: z.object({ title: z.string().min(1).max(200), startsAt: z.string().datetime(), location: z.string().max(200).optional(), description: z.string().max(1000).optional() }).strict(),
  gif: z.object({ url: z.string().url().refine((u) => u.startsWith('https://'), 'must be https'), width: z.number().optional(), height: z.number().optional() }).strict(),
};

export interface SendInput {
  conversationId: string; senderId: string; deviceId: string | null; clientMsgId: string; kind: (typeof KINDS)[number] | 'system';
  body?: string; meta?: Record<string, any>; mediaId?: string | null; replyToId?: string | null; mentions?: string[]; forwarded?: boolean; trustedMedia?: boolean; system?: boolean;
}

/**
 * Single write path for messages. Idempotent on (conversation, sender, clientMsgId). The conversation row lock
 * serializes concurrent senders, so `seq` is a gap-free, server-authoritative order.
 */
export async function sendMessage(t: Tx, input: SendInput): Promise<{ message: MessageDTO; created: boolean }> {
  const conv = await requireMember(t, input.conversationId, input.senderId, true);
  if (!input.system && !canPost(conv)) throw forbidden('posting_restricted', 'Only admins can post here');

  const existing = await t.one(`select m.id from messages m where m.conversation_id = $1 and m.sender_id = $2 and m.client_msg_id = $3`, [input.conversationId, input.senderId, input.clientMsgId]);
  if (existing) return { message: (await loadMessage(t, existing.id))!, created: false };

  let undelivered = false;
  let others: string[] = [];
  if (conv.kind === 'direct') {
    const other = (await activeMemberIds(t, conv.id)).find((id) => id !== input.senderId);
    others = other ? [other] : [];
    if (other) {
      const blk = await t.one(`select blocker_id from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`, [input.senderId, other]);
      if (blk?.blocker_id === input.senderId) throw forbidden('unblock_to_send', 'Unblock this contact to send messages');
      if (blk) undelivered = true; // recipient blocked sender: stored for the sender, never shown to the recipient, no signal either way
      const st = await t.one(`select status from users where id = $1`, [other]);
      if (st?.status === 'deleted') throw forbidden('user_unavailable');
    }
  }

  const body = (input.body ?? '').normalize('NFC');
  if (input.kind === 'text' && !body.trim()) throw badRequest('empty_message');
  if (body.length > 8000) throw badRequest('message_too_long');
  let meta = input.meta ?? {};
  const ms = metaSchemas[input.kind];
  if (ms) { const r = ms.safeParse(meta); if (!r.success) throw badRequest('invalid_meta', r.error.issues.map((i) => i.message).join('; ')); meta = r.data; }
  else if (!input.system && Object.keys(meta).length) meta = {};

  let mediaId: string | null = null;
  if (MEDIA_KINDS.has(input.kind)) {
    if (!input.mediaId) throw badRequest('media_required');
    const a = await t.one(`select owner_id, kind from media_assets where id = $1 and deleted_at is null`, [input.mediaId]);
    if (!a || (!input.trustedMedia && a.owner_id !== input.senderId)) throw badRequest('invalid_media');
    const okKind = input.kind === a.kind || (input.kind === 'audio' && a.kind === 'voice') || (input.kind === 'sticker' && a.kind === 'image') || (input.kind === 'document' && a.kind !== 'avatar');
    if (!okKind) throw badRequest('media_kind_mismatch');
    mediaId = input.mediaId;
  }

  let replyTo: string | null = null;
  if (input.replyToId) {
    const r = await t.one(`select id from messages where id = $1 and conversation_id = $2`, [input.replyToId, input.conversationId]);
    if (!r) throw badRequest('invalid_reply');
    replyTo = r.id;
  }
  let mentions: string[] = [];
  if (input.mentions?.length) {
    const members = new Set(await activeMemberIds(t, conv.id));
    mentions = [...new Set(input.mentions)].filter((id) => members.has(id) && id !== input.senderId);
  }

  const seq = (await t.one(`update conversations set last_seq = last_seq + 1, last_message_at = now() where id = $1 returning last_seq`, [conv.id])).last_seq as number;
  const expires = conv.disappearing_seconds ? new Date(Date.now() + conv.disappearing_seconds * 1000) : null;
  const ins = await t.one(
    `insert into messages(conversation_id, seq, sender_id, sender_device_id, client_msg_id, kind, body, meta, media_id, reply_to_id, forwarded, mentions, expires_at, undelivered)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [conv.id, seq, input.system ? null : input.senderId, input.deviceId, input.clientMsgId, input.kind, body, JSON.stringify(meta), mediaId, replyTo, !!input.forwarded, mentions, expires, undelivered]);

  const memberIds = await activeMemberIds(t, conv.id);
  // Sender has read everything they just sent; new messages un-archive the chat for recipients that are not muting it.
  await t.q(`update conversation_members set last_read_seq = $3, last_delivered_seq = greatest(last_delivered_seq, $3) where conversation_id = $1 and user_id = $2`, [conv.id, input.senderId, seq]);
  await t.q(`update conversation_members set archived = false, state_version = state_version + 1 where conversation_id = $1 and user_id <> $2 and archived and (muted_until is null or muted_until < now())`, [conv.id, input.senderId]);

  const message = (await loadMessage(t, ins.id))!;
  const audience = undelivered ? [input.senderId] : memberIds;
  t.emit(audience, 'message.new', { message });

  if (!undelivered) {
    const recipients = memberIds.filter((id) => id !== input.senderId);
    const senderRow = await t.one(`select display_name from user_profiles where user_id = $1`, [input.senderId]);
    t.afterCommit.push(() => notifyNewMessage({
      conversationId: conv.id, kind: input.kind, title: conv.title, convKind: conv.kind, messageId: message.id, senderId: input.senderId,
      senderName: senderRow?.display_name ?? 'Someone', text: body, msgKind: input.kind, mentions, recipients,
    }));
  }
  return { message, created: true };
}

const sendSchema = z.object({
  clientMsgId: z.string().min(8).max(64),
  kind: z.enum(KINDS),
  body: z.string().max(8000).optional(),
  meta: z.record(z.string(), z.any()).optional(),
  mediaId: z.string().uuid().nullish(),
  replyToId: z.string().uuid().nullish(),
  mentions: z.array(z.string().uuid()).max(50).optional(),
});

async function loadForAction(t: Tx, messageId: string, userId: string) {
  const m = await t.one(`select m.*, c.kind conv_kind from messages m join conversations c on c.id = m.conversation_id where m.id = $1`, [messageId]);
  if (!m) throw notFound('message_not_found');
  const conv = await requireMember(t, m.conversation_id, userId); // 404 if not a member: ids cannot be probed
  return { m, conv };
}

export async function messageRoutes(app: FastifyInstance) {
  app.post('/api/conversations/:id/messages', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(sendSchema, req.body);
    await rateLimit(`send:${req.auth.userId}`, 120, 60);
    const { message, created } = await tx((t) => sendMessage(t, { ...b, conversationId: id, senderId: req.auth.userId, deviceId: req.auth.deviceId, kind: b.kind }));
    reply.code(created ? 201 : 200);
    return { message: { ...message, status: 'sent' }, duplicate: !created };
  });

  app.get('/api/conversations/:id/messages', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const qs = parse(z.object({ before: z.coerce.number().int().optional(), after: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }), req.query);
    const me = req.auth.userId;
    const conv = await requireMember(pool, id, me);
    const params: unknown[] = [id, me, conv.first_visible_seq, qs.limit + 1];
    let range = '';
    if (qs.before !== undefined) { params.push(qs.before); range = `and m.seq < $${params.length}`; }
    else if (qs.after !== undefined) { params.push(qs.after); range = `and m.seq > $${params.length}`; }
    const order = qs.after !== undefined ? 'asc' : 'desc';
    const { rows } = await q(
      `select ${MESSAGE_COLS},
              coalesce((select json_agg(json_build_object('userId', x.user_id, 'emoji', x.emoji)) from message_reactions x where x.message_id = m.id), '[]') reactions,
              exists(select 1 from message_stars s where s.message_id = m.id and s.user_id = $2) starred,
              case when m.kind = 'poll' then coalesce((select json_agg(json_build_object('userId', v.user_id, 'option', v.option_idx)) from poll_votes v where v.message_id = m.id), '[]') end votes
         from messages m ${MESSAGE_JOINS}
        where m.conversation_id = $1 and m.seq > $3 ${range}
          and (not m.undelivered or m.sender_id = $2)
          and (m.expires_at is null or m.expires_at > now())
          and not exists (select 1 from message_hidden h where h.message_id = m.id and h.user_id = $2)
        order by m.seq ${order} limit $4`, params);
    const hasMore = rows.length > qs.limit;
    const page = rows.slice(0, qs.limit);
    if (order === 'desc') page.reverse();
    const w = await otherWatermarks(pool, id, me);
    const messages = page.map((r) => {
      const dto = toMessage(r);
      return { ...dto, reactions: r.reactions, starred: r.starred, votes: r.votes ?? undefined, ...(dto.senderId === me ? { status: statusFor(dto, w) } : {}) };
    });
    return { messages, hasMore, watermarks: w };
  });

  // Edit (with history)
  app.patch('/api/messages/:id', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { body } = parse(z.object({ body: z.string().min(1).max(8000) }), req.body);
    return tx(async (t) => {
      const { m, conv } = await loadForAction(t, id, req.auth.userId);
      if (m.sender_id !== req.auth.userId) throw forbidden('not_sender');
      if (m.deleted_for_all_at) throw conflict('message_deleted');
      if (!['text', 'image', 'video', 'document'].includes(m.kind)) throw badRequest('not_editable');
      if (Date.now() - m.created_at.getTime() > config.editWindowSeconds * 1000) throw forbidden('edit_window_closed');
      if (m.body === body) return { message: await loadMessage(t, id) };
      await t.q(`insert into message_edits(message_id, old_body) values ($1,$2)`, [id, m.body]);
      await t.q(`update messages set body = $2, edited_at = now() where id = $1`, [id, body]);
      const message = (await loadMessage(t, id))!;
      t.emit(await activeMemberIds(t, conv.id), 'message.update', { message });
      return { message };
    });
  });

  app.get('/api/messages/:id/edits', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const c = await tx(async (t) => (await loadForAction(t, id, req.auth.userId)).m);
    const { rows } = await q(`select old_body, edited_at from message_edits where message_id = $1 order by id`, [id]);
    return { current: c.deleted_for_all_at ? '' : c.body, edits: rows.map((r) => ({ body: r.old_body, editedAt: r.edited_at })) };
  });

  // Delete for me / for everyone
  app.delete('/api/messages/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { scope } = parse(z.object({ scope: z.enum(['me', 'all']).default('me') }), req.query);
    await tx(async (t) => {
      const { m, conv } = await loadForAction(t, id, req.auth.userId);
      if (scope === 'me') {
        await t.q(`insert into message_hidden(message_id, user_id) values ($1,$2) on conflict do nothing`, [id, req.auth.userId]);
        t.emit([req.auth.userId], 'message.hide', { conversationId: conv.id, messageId: id });
        return;
      }
      const isSender = m.sender_id === req.auth.userId;
      const adminOverride = conv.kind !== 'direct' && isStaffRole(conv.role);
      if (!isSender && !adminOverride) throw forbidden('cannot_delete_for_all');
      if (isSender && !adminOverride && Date.now() - m.created_at.getTime() > config.deleteForAllWindowSeconds * 1000) throw forbidden('delete_window_closed');
      if (m.deleted_for_all_at) return;
      await t.q(`update messages set deleted_for_all_at = now(), body = '', meta = '{}', pinned_at = null where id = $1`, [id]);
      await t.q(`delete from message_reactions where message_id = $1`, [id]);
      await t.q(`delete from message_stars where message_id = $1`, [id]);
      if (m.media_id) t.afterCommit.push(() => removeMediaIfUnreferenced(m.media_id));
      t.emit(await activeMemberIds(t, conv.id), 'message.delete', { conversationId: conv.id, messageId: id, byUserId: req.auth.userId });
    });
    reply.code(204);
  });

  app.put('/api/messages/:id/reaction', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { emoji } = parse(z.object({ emoji: z.string().min(1).max(16).nullable() }), req.body);
    await rateLimit(`react:${req.auth.userId}`, 120, 60);
    return tx(async (t) => {
      const { m, conv } = await loadForAction(t, id, req.auth.userId);
      if (m.deleted_for_all_at) throw conflict('message_deleted');
      if (m.undelivered && m.sender_id !== req.auth.userId) throw notFound('message_not_found');
      if (emoji) await t.q(`insert into message_reactions(message_id, user_id, emoji) values ($1,$2,$3) on conflict (message_id, user_id) do update set emoji = excluded.emoji, created_at = now()`, [id, req.auth.userId, emoji]);
      else await t.q(`delete from message_reactions where message_id = $1 and user_id = $2`, [id, req.auth.userId]);
      const reactions = (await t.q(`select user_id "userId", emoji from message_reactions where message_id = $1`, [id])).rows;
      t.emit(await activeMemberIds(t, conv.id), 'message.reactions', { conversationId: conv.id, messageId: id, reactions });
      return { reactions };
    });
  });

  app.put('/api/messages/:id/star', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { starred } = parse(z.object({ starred: z.boolean() }), req.body);
    return tx(async (t) => {
      const { conv } = await loadForAction(t, id, req.auth.userId);
      if (starred) await t.q(`insert into message_stars(message_id, user_id) values ($1,$2) on conflict do nothing`, [id, req.auth.userId]);
      else await t.q(`delete from message_stars where message_id = $1 and user_id = $2`, [id, req.auth.userId]);
      t.emit([req.auth.userId], 'message.star', { conversationId: conv.id, messageId: id, starred });
      return { starred };
    });
  });

  app.get('/api/starred', { preHandler: authenticateVerified }, async (req) => {
    const { rows } = await q(
      `select ${MESSAGE_COLS} from message_stars s join messages m on m.id = s.message_id ${MESSAGE_JOINS}
        join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = $1 and cm.left_at is null and not cm.removed
       where s.user_id = $1 and m.deleted_for_all_at is null and m.seq > cm.first_visible_seq order by s.created_at desc limit 200`, [req.auth.userId]);
    return { messages: rows.map(toMessage) };
  });

  app.put('/api/messages/:id/pin', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { pinned } = parse(z.object({ pinned: z.boolean() }), req.body);
    return tx(async (t) => {
      const { m, conv } = await loadForAction(t, id, req.auth.userId);
      if (conv.kind !== 'direct' && !isStaffRole(conv.role)) throw forbidden('admins_only');
      if (m.deleted_for_all_at) throw conflict('message_deleted');
      if (pinned) {
        const n = await t.one(`select count(*)::int n from messages where conversation_id = $1 and pinned_at is not null`, [conv.id]);
        if (n.n >= 3 && !m.pinned_at) throw conflict('too_many_pins', 'Unpin a message first (max 3)');
      }
      await t.q(`update messages set pinned_at = $2, pinned_by = $3 where id = $1`, [id, pinned ? new Date() : null, pinned ? req.auth.userId : null]);
      const message = (await loadMessage(t, id))!;
      t.emit(await activeMemberIds(t, conv.id), 'message.update', { message });
      return { message };
    });
  });

  app.get('/api/conversations/:id/pinned', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await requireMember(pool, id, req.auth.userId);
    const { rows } = await q(`select ${MESSAGE_COLS} from messages m ${MESSAGE_JOINS} where m.conversation_id = $1 and m.pinned_at is not null and m.deleted_for_all_at is null order by m.pinned_at desc`, [id]);
    return { messages: rows.map(toMessage) };
  });

  app.post('/api/messages/:id/forward', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { conversationIds } = parse(z.object({ conversationIds: z.array(z.string().uuid()).min(1).max(10) }), req.body);
    await rateLimit(`forward:${req.auth.userId}`, 30, 60);
    const results: MessageDTO[] = [];
    for (const target of conversationIds) {
      const r = await tx(async (t) => {
        const { m } = await loadForAction(t, id, req.auth.userId);
        if (m.deleted_for_all_at || ['system', 'poll'].includes(m.kind)) throw badRequest('not_forwardable');
        if (m.undelivered && m.sender_id !== req.auth.userId) throw notFound('message_not_found');
        return sendMessage(t, {
          conversationId: target, senderId: req.auth.userId, deviceId: req.auth.deviceId, clientMsgId: `fwd-${randomUUID()}`, kind: m.kind,
          body: m.body, meta: m.meta, mediaId: m.media_id, forwarded: true, trustedMedia: true,
        });
      });
      results.push(r.message);
    }
    return { messages: results };
  });

  app.post('/api/messages/:id/vote', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { options } = parse(z.object({ options: z.array(z.number().int().min(0)).max(12) }), req.body);
    return tx(async (t) => {
      const { m, conv } = await loadForAction(t, id, req.auth.userId);
      if (m.kind !== 'poll' || m.deleted_for_all_at) throw badRequest('not_a_poll');
      const opts = (m.meta.options as string[]).length;
      const uniq = [...new Set(options)];
      if (uniq.some((o) => o >= opts)) throw badRequest('invalid_option');
      if (!m.meta.multi && uniq.length > 1) throw badRequest('single_choice_poll');
      await t.q(`delete from poll_votes where message_id = $1 and user_id = $2`, [id, req.auth.userId]);
      for (const o of uniq) await t.q(`insert into poll_votes(message_id, user_id, option_idx) values ($1,$2,$3)`, [id, req.auth.userId, o]);
      const votes = (await t.q(`select user_id "userId", option_idx "option" from poll_votes where message_id = $1`, [id])).rows;
      t.emit(await activeMemberIds(t, conv.id), 'poll.votes', { conversationId: conv.id, messageId: id, votes });
      return { votes };
    });
  });

  // ---- receipts ----
  app.post('/api/conversations/:id/read', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { seq } = parse(z.object({ seq: z.number().int().min(0) }), req.body);
    return tx(async (t) => {
      const conv = await requireMember(t, id, req.auth.userId, true);
      const target = Math.min(seq, conv.last_seq);
      const prof = await t.one(`select settings from user_profiles where user_id = $1`, [req.auth.userId]);
      const shares = withDefaults(prof.settings).privacy.readReceipts !== false;
      const row = await t.one(
        `update conversation_members set last_read_seq = greatest(last_read_seq, $3), last_delivered_seq = greatest(last_delivered_seq, $3),
                read_receipt_seq = case when $4 then greatest(read_receipt_seq, $3) else read_receipt_seq end, marked_unread = false, state_version = state_version + 1
          where conversation_id = $1 and user_id = $2 returning last_read_seq, last_delivered_seq, read_receipt_seq, state_version`, [id, req.auth.userId, target, shares]);
      const ids = await activeMemberIds(t, id);
      t.emit(ids.filter((u) => u !== req.auth.userId), 'receipt', { conversationId: id, userId: req.auth.userId, deliveredSeq: row.last_delivered_seq, readSeq: shares ? row.read_receipt_seq : undefined });
      t.emit([req.auth.userId], 'conversation.state', { conversationId: id, lastReadSeq: row.last_read_seq, markedUnread: false, version: row.state_version });
      return { lastReadSeq: row.last_read_seq };
    });
  });

  app.post('/api/conversations/:id/delivered', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { seq } = parse(z.object({ seq: z.number().int().min(0) }), req.body);
    await tx(async (t) => {
      const conv = await requireMember(t, id, req.auth.userId);
      const target = Math.min(seq, conv.last_seq);
      const row = await t.one(`update conversation_members set last_delivered_seq = greatest(last_delivered_seq, $3) where conversation_id = $1 and user_id = $2 and last_delivered_seq < $3 returning last_delivered_seq`, [id, req.auth.userId, target]);
      if (row) t.emit((await activeMemberIds(t, id)).filter((u) => u !== req.auth.userId), 'receipt', { conversationId: id, userId: req.auth.userId, deliveredSeq: row.last_delivered_seq });
    });
    reply.code(204);
  });
}

/** Mark everything currently stored as delivered for a user that just came online (any device). */
export async function markAllDelivered(userId: string) {
  await tx(async (t) => {
    const rows = (await t.q(
      `update conversation_members m set last_delivered_seq = c.last_seq
         from conversations c where c.id = m.conversation_id and m.user_id = $1 and m.left_at is null and not m.removed and m.last_delivered_seq < c.last_seq
       returning m.conversation_id, m.last_delivered_seq`, [userId])).rows;
    for (const r of rows) {
      const ids = (await activeMemberIds(t, r.conversation_id)).filter((u) => u !== userId);
      t.emit(ids, 'receipt', { conversationId: r.conversation_id, userId, deliveredSeq: r.last_delivered_seq });
    }
  });
}
void one;
