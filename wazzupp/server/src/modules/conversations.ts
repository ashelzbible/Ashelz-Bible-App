import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { one, q, tx, pool } from '../db/pool.ts';
import type { Tx } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { activeMemberIds, isMasked, isStaffRole, MESSAGE_COLS, MESSAGE_JOINS, otherWatermarks, requireMember, statusFor, toMessage } from '../lib/conv.ts';
import { canSee } from '../lib/users.ts';
import { sendMessage } from './messages.ts';
import { randomUUID } from 'node:crypto';
import { rateLimit } from '../lib/ratelimit.ts';
import { withDefaults } from '../lib/settings.ts';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

export const directKey = (a: string, b: string) => [a, b].sort().join(':');
const codeHash = (c: string) => createHash('sha256').update(c).digest();

export async function systemMessage(t: Tx, conversationId: string, actorId: string, event: string, extra: Record<string, unknown> = {}) {
  await sendMessage(t, { conversationId, senderId: actorId, deviceId: null, clientMsgId: `sys-${randomUUID()}`, kind: 'system', body: '', meta: { event, actorId, ...extra }, system: true });
}

export async function conversationSummary(userId: string, onlyId?: string) {
  const { rows } = await q(
    `select c.id, c.kind, c.title, c.description, c.avatar_media_id, c.announce_only, c.members_can_edit_info, c.members_can_invite, c.disappearing_seconds, c.community_id, c.is_public, c.last_seq, c.last_message_at, c.created_at,
            m.role, m.muted_until, m.archived, m.pinned, m.favorite, m.marked_unread, m.folder, m.draft, m.state_version, m.last_read_seq, m.first_visible_seq,
            (select count(*)::int from conversation_members x where x.conversation_id = c.id and x.left_at is null and not x.removed) member_count,
            (select count(*)::int from messages u where u.conversation_id = c.id and u.seq > m.last_read_seq and u.seq > m.first_visible_seq and u.sender_id is distinct from $1
               and u.deleted_for_all_at is null and not u.undelivered and u.kind <> 'system' and (u.expires_at is null or u.expires_at > now())
               and not exists (select 1 from message_hidden h where h.message_id = u.id and h.user_id = $1)) unread,
            (select count(*)::int from messages u where u.conversation_id = c.id and u.seq > m.last_read_seq and $1 = any(u.mentions) and u.deleted_for_all_at is null) unread_mentions,
            o.id other_id, o.username other_username, op.display_name other_name, op.avatar_media_id other_avatar, op.status_text other_status, op.settings other_settings,
            exists(select 1 from contacts ct where ct.owner_id = o.id and ct.contact_id = $1) other_has_me,
            exists(select 1 from blocks b where b.blocker_id = o.id and b.blocked_id = $1) blocked_me,
            exists(select 1 from blocks b where b.blocker_id = $1 and b.blocked_id = o.id) i_blocked,
            (select max(d.last_seen_at) from devices d where d.user_id = o.id) other_last_seen
       from conversation_members m
       join conversations c on c.id = m.conversation_id
       left join lateral (select u.id, u.username from conversation_members om join users u on u.id = om.user_id where c.kind = 'direct' and om.conversation_id = c.id and om.user_id <> $1 limit 1) o on true
       left join user_profiles op on op.user_id = o.id
      where m.user_id = $1 and m.left_at is null and not m.removed ${onlyId ? 'and c.id = $2' : ''}
      order by m.pinned desc, c.last_message_at desc nulls last, c.created_at desc limit 500`,
    onlyId ? [userId, onlyId] : [userId]);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const last = await q(
    `select ${MESSAGE_COLS}, cm.conversation_id cid, sp.display_name sender_name
       from conversation_members cm
       join lateral (select mm.* from messages mm where mm.conversation_id = cm.conversation_id and mm.seq > cm.first_visible_seq and (not mm.undelivered or mm.sender_id = $1)
              and (mm.expires_at is null or mm.expires_at > now()) and not exists (select 1 from message_hidden h where h.message_id = mm.id and h.user_id = $1) order by mm.seq desc limit 1) m on true
       ${MESSAGE_JOINS} left join user_profiles sp on sp.user_id = m.sender_id
      where cm.user_id = $1 and cm.conversation_id = any($2::uuid[])`, [userId, ids]);
  const lastBy = new Map(last.rows.map((r) => [r.cid, { ...toMessage(r), senderName: r.sender_name as string | null }]));
  const wm = await q(
    `select conversation_id, min(last_delivered_seq)::bigint d, min(read_receipt_seq)::bigint r from conversation_members
      where conversation_id = any($2::uuid[]) and user_id <> $1 and left_at is null and not removed group by conversation_id`, [userId, ids]);
  const wmBy = new Map(wm.rows.map((r) => [r.conversation_id, { delivered: Number(r.d), read: Number(r.r) }]));
  return rows.map((r) => {
    const m = lastBy.get(r.id) ?? null;
    const lm = m ? { ...m, ...(m.senderId === userId ? { status: statusFor(m, wmBy.get(r.id) ?? null) } : {}) } : null;
    return mapSummary(r, userId, lm);
  });
}

function mapSummary(r: any, _me: string, lm: unknown) {
  const isDirect = r.kind === 'direct';
  const blocked = !!r.blocked_me;
  const other = isDirect && r.other_id ? {
    id: r.other_id, username: r.other_username, displayName: r.other_name,
    avatarMediaId: canSee(r.other_settings, 'profilePhoto', r.other_has_me, blocked) ? r.other_avatar : null,
    statusText: canSee(r.other_settings, 'about', r.other_has_me, blocked) ? r.other_status : null,
    lastSeenAt: canSee(r.other_settings, 'lastSeen', r.other_has_me, blocked) && r.other_last_seen ? new Date(r.other_last_seen).toISOString() : null,
    blockedByMe: r.i_blocked,
  } : null;
  const muted = !!(r.muted_until && new Date(r.muted_until) > new Date());
  return {
    id: r.id, kind: r.kind, title: r.title, description: r.description, avatarMediaId: r.avatar_media_id, announceOnly: r.announce_only, membersCanEditInfo: r.members_can_edit_info,
    membersCanInvite: r.members_can_invite, disappearingSeconds: r.disappearing_seconds, communityId: r.community_id, isPublic: r.is_public, lastSeq: r.last_seq, createdAt: r.created_at,
    memberCount: r.member_count, role: r.role, other, lastMessage: lm, lastMessageAt: r.last_message_at,
    unread: r.unread, unreadMentions: r.unread_mentions, markedUnread: r.marked_unread, muted, mutedUntil: muted ? r.muted_until : null, archived: r.archived, pinned: r.pinned, favorite: r.favorite,
    folder: r.folder, draft: r.draft, version: r.state_version, lastReadSeq: r.last_read_seq,
  };
}

async function addMembers(t: Tx, convId: string, actorId: string, userIds: string[], opts: { enforcePrivacy: boolean; role?: string } = { enforcePrivacy: true }) {
  const added: string[] = []; const skipped: Array<{ userId: string; reason: string }> = [];
  const lastSeq = (await t.one('select last_seq from conversations where id = $1', [convId])).last_seq;
  for (const uid of [...new Set(userIds)]) {
    const u = await t.one(`select u.status, p.settings from users u join user_profiles p on p.user_id = u.id where u.id = $1`, [uid]);
    if (!u || u.status !== 'active') { skipped.push({ userId: uid, reason: 'unavailable' }); continue; }
    const blk = await t.one(`select 1 from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`, [actorId, uid]);
    if (blk) { skipped.push({ userId: uid, reason: 'blocked' }); continue; }
    if (opts.enforcePrivacy && uid !== actorId) {
      const pref = withDefaults(u.settings).privacy.groupInvites;
      const isContact = !!(await t.one(`select 1 from contacts where owner_id = $1 and contact_id = $2`, [uid, actorId]));
      if (pref === 'nobody' || (pref === 'contacts' && !isContact)) { skipped.push({ userId: uid, reason: 'privacy' }); continue; }
    }
    const res = await t.one(
      `insert into conversation_members(conversation_id, user_id, role, first_visible_seq, last_read_seq, last_delivered_seq)
       values ($1,$2,$3,$4,$4,$4)
       on conflict (conversation_id, user_id) do update set left_at = null, removed = false, role = excluded.role, joined_at = now(), first_visible_seq = $4, last_read_seq = $4, state_version = conversation_members.state_version + 1
        where conversation_members.left_at is not null or conversation_members.removed
       returning user_id`, [convId, uid, opts.role ?? 'member', lastSeq]);
    if (res) added.push(uid);
  }
  return { added, skipped };
}

export async function conversationRoutes(app: FastifyInstance) {
  app.get('/api/conversations', { preHandler: authenticateVerified }, async (req) => ({ conversations: await conversationSummary(req.auth.userId) }));

  app.get('/api/conversations/:id', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(idParam, req.params);
    await requireMember(pool, id, req.auth.userId);
    return { conversation: (await conversationSummary(req.auth.userId, id))[0] };
  });

  app.post('/api/conversations/direct', { preHandler: authenticateVerified }, async (req) => {
    const { userId } = parse(z.object({ userId: uuid }), req.body);
    const me = req.auth.userId;
    if (userId === me) throw badRequest('cannot_message_self');
    await rateLimit(`newdm:${me}`, 60, 3600);
    const id = await tx(async (t) => {
      const other = await t.one(`select status from users where id = $1`, [userId]);
      if (!other || other.status !== 'active') throw notFound('user_not_found');
      const blk = await t.one(`select blocker_id from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`, [me, userId]);
      const key = directKey(me, userId);
      const existing = await t.one(`select id from conversations where direct_key = $1`, [key]);
      if (existing) {
        await t.q(`update conversation_members set left_at = null, removed = false where conversation_id = $1 and user_id = $2 and left_at is not null`, [existing.id, me]);
        return existing.id as string;
      }
      if (blk) throw notFound('user_not_found'); // identical to a missing user: no signal about blocks
      const c = await t.one(`insert into conversations(kind, direct_key, created_by) values ('direct',$1,$2) on conflict (direct_key) do update set direct_key = excluded.direct_key returning id`, [key, me]);
      await t.q(`insert into conversation_members(conversation_id, user_id, role) values ($1,$2,'member'),($1,$3,'member') on conflict do nothing`, [c.id, me, userId]);
      return c.id as string;
    });
    return { conversation: (await conversationSummary(me, id))[0] };
  });

  app.post('/api/groups', { preHandler: authenticateVerified }, async (req, reply) => {
    const b = parse(z.object({ title: z.string().trim().min(1).max(100), description: z.string().max(500).optional(), memberIds: z.array(uuid).max(1000).default([]), avatarMediaId: uuid.nullish(), kind: z.enum(['group', 'channel']).default('group'), isPublic: z.boolean().default(false) }), req.body);
    const me = req.auth.userId;
    await rateLimit(`newgroup:${me}`, 20, 3600);
    const out = await tx(async (t) => {
      if (b.avatarMediaId) { const a = await t.one(`select owner_id from media_assets where id = $1`, [b.avatarMediaId]); if (!a || a.owner_id !== me) throw badRequest('invalid_media'); }
      const c = await t.one(
        `insert into conversations(kind, title, description, created_by, avatar_media_id, is_public, announce_only) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [b.kind, b.title, b.description ?? '', me, b.avatarMediaId ?? null, b.kind === 'channel' ? b.isPublic : false, b.kind === 'channel']);
      await t.q(`insert into conversation_members(conversation_id, user_id, role) values ($1,$2,'owner')`, [c.id, me]);
      const res = await addMembers(t, c.id, me, b.memberIds.filter((x) => x !== me), { enforcePrivacy: true, role: b.kind === 'channel' ? 'subscriber' : 'member' });
      await systemMessage(t, c.id, me, b.kind === 'channel' ? 'channel_created' : 'group_created', { title: b.title });
      return { id: c.id as string, ...res };
    });
    reply.code(201);
    return { conversation: (await conversationSummary(me, out.id))[0], added: out.added, skipped: out.skipped };
  });

  app.patch('/api/conversations/:id', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      title: z.string().trim().min(1).max(100).optional(), description: z.string().max(500).optional(), avatarMediaId: uuid.nullable().optional(),
      announceOnly: z.boolean().optional(), membersCanEditInfo: z.boolean().optional(), membersCanInvite: z.boolean().optional(), disappearingSeconds: z.number().int().min(0).max(90 * 86400).nullable().optional(),
      isPublic: z.boolean().optional(),
    }).strict(), req.body);
    return tx(async (t) => {
      const c = await requireMember(t, id, req.auth.userId, true);
      const staff = isStaffRole(c.role);
      if (c.kind === 'direct') {
        if (Object.keys(b).some((k) => k !== 'disappearingSeconds')) throw forbidden('direct_chat_not_editable');
      } else {
        const info = b.title !== undefined || b.description !== undefined || b.avatarMediaId !== undefined;
        if (info && !staff && !c.members_can_edit_info) throw forbidden('admins_only');
        const settings = b.announceOnly !== undefined || b.membersCanEditInfo !== undefined || b.membersCanInvite !== undefined || b.disappearingSeconds !== undefined || b.isPublic !== undefined;
        if (settings && !staff) throw forbidden('admins_only');
      }
      if (b.avatarMediaId) { const a = await t.one(`select owner_id from media_assets where id = $1`, [b.avatarMediaId]); if (!a || a.owner_id !== req.auth.userId) throw badRequest('invalid_media'); }
      const sets: string[] = []; const vals: unknown[] = [id];
      const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (b.title !== undefined) add('title', b.title);
      if (b.description !== undefined) add('description', b.description);
      if (b.avatarMediaId !== undefined) add('avatar_media_id', b.avatarMediaId);
      if (b.announceOnly !== undefined) add('announce_only', b.announceOnly);
      if (b.membersCanEditInfo !== undefined) add('members_can_edit_info', b.membersCanEditInfo);
      if (b.membersCanInvite !== undefined) add('members_can_invite', b.membersCanInvite);
      if (b.disappearingSeconds !== undefined) add('disappearing_seconds', b.disappearingSeconds || null);
      if (b.isPublic !== undefined && c.kind === 'channel') add('is_public', b.isPublic);
      if (sets.length) await t.q(`update conversations set ${sets.join(', ')} where id = $1`, vals);
      if (b.title !== undefined && b.title !== c.title) await systemMessage(t, id, req.auth.userId, 'title_changed', { title: b.title });
      if (b.disappearingSeconds !== undefined) await systemMessage(t, id, req.auth.userId, 'disappearing_changed', { seconds: b.disappearingSeconds || null });
      const ids = await activeMemberIds(t, id);
      t.emit(ids, 'conversation.update', { conversationId: id });
      return { ok: true };
    });
  });

  // ---- per-user conversation state (multi-device synced, versioned) ----
  app.patch('/api/conversations/:id/state', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      mutedUntil: z.union([z.string().datetime(), z.literal('forever'), z.null()]).optional(), archived: z.boolean().optional(), pinned: z.boolean().optional(),
      favorite: z.boolean().optional(), markedUnread: z.boolean().optional(), folder: z.string().max(40).nullable().optional(), baseVersion: z.number().int().optional(),
    }).strict(), req.body);
    return tx(async (t) => {
      await requireMember(t, id, req.auth.userId);
      const cur = await t.one(`select state_version, pinned from conversation_members where conversation_id = $1 and user_id = $2 for update`, [id, req.auth.userId]);
      if (b.baseVersion !== undefined && b.baseVersion !== cur.state_version) throw conflict('version_conflict', 'Conversation state changed on another device');
      if (b.pinned && !cur.pinned) {
        const n = await t.one(`select count(*)::int n from conversation_members where user_id = $1 and pinned and left_at is null`, [req.auth.userId]);
        if (n.n >= 3) throw conflict('too_many_pins', 'You can pin up to 3 chats');
      }
      const sets: string[] = ['state_version = state_version + 1']; const vals: unknown[] = [id, req.auth.userId];
      const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (b.mutedUntil !== undefined) add('muted_until', b.mutedUntil === 'forever' ? '9999-12-31T00:00:00Z' : b.mutedUntil);
      if (b.archived !== undefined) add('archived', b.archived);
      if (b.pinned !== undefined) add('pinned', b.pinned);
      if (b.favorite !== undefined) add('favorite', b.favorite);
      if (b.markedUnread !== undefined) add('marked_unread', b.markedUnread);
      if (b.folder !== undefined) add('folder', b.folder);
      await t.q(`update conversation_members set ${sets.join(', ')} where conversation_id = $1 and user_id = $2`, vals);
      t.emit([req.auth.userId], 'conversation.state', { conversationId: id, resync: true });
      return { conversation: undefined, ok: true };
    }).then(async (r) => ({ ...r, conversation: (await conversationSummary(req.auth.userId, id))[0] }));
  });

  app.put('/api/conversations/:id/draft', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { draft } = parse(z.object({ draft: z.string().max(8000).nullable() }), req.body);
    await requireMember(pool, id, req.auth.userId);
    await q(`update conversation_members set draft = $3 where conversation_id = $1 and user_id = $2`, [id, req.auth.userId, draft || null]);
    reply.code(204);
  });

  app.post('/api/conversations/:id/clear', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await tx(async (t) => {
      const c = await requireMember(t, id, req.auth.userId, true);
      await t.q(`update conversation_members set first_visible_seq = $3, last_read_seq = $3, state_version = state_version + 1 where conversation_id = $1 and user_id = $2`, [id, req.auth.userId, c.last_seq]);
      t.emit([req.auth.userId], 'conversation.cleared', { conversationId: id, upToSeq: c.last_seq });
    });
    reply.code(204);
  });

  // ---- members ----
  app.get('/api/conversations/:id/members', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { limit, offset } = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    const mc = await requireMember(pool, id, req.auth.userId);
    if (isMasked(mc)) return { members: [] }; // channel subscribers do not get a member list
    const { rows } = await q(
      `select u.id, u.username, p.display_name, p.avatar_media_id, p.status_text, p.settings, m.role, m.joined_at,
              exists(select 1 from contacts c where c.owner_id = u.id and c.contact_id = $2) has_me,
              exists(select 1 from blocks b where b.blocker_id = u.id and b.blocked_id = $2) blocked_me
         from conversation_members m join users u on u.id = m.user_id join user_profiles p on p.user_id = u.id
        where m.conversation_id = $1 and m.left_at is null and not m.removed
        order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, p.display_name limit $3 offset $4`, [id, req.auth.userId, limit, offset]);
    return { members: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, role: r.role, joinedAt: r.joined_at,
      avatarMediaId: canSee(r.settings, 'profilePhoto', r.has_me, r.blocked_me) ? r.avatar_media_id : null, statusText: canSee(r.settings, 'about', r.has_me, r.blocked_me) ? r.status_text : null })) };
  });

  app.post('/api/conversations/:id/members', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { userIds } = parse(z.object({ userIds: z.array(uuid).min(1).max(200) }), req.body);
    return tx(async (t) => {
      const c = await requireMember(t, id, req.auth.userId, true);
      if (c.kind === 'direct') throw badRequest('direct_chat');
      if (!isStaffRole(c.role) && !c.members_can_invite) throw forbidden('admins_only');
      const res = await addMembers(t, id, req.auth.userId, userIds, { enforcePrivacy: true, role: c.kind === 'channel' ? 'subscriber' : 'member' });
      if (res.added.length) await systemMessage(t, id, req.auth.userId, 'members_added', { userIds: res.added });
      t.emit(await activeMemberIds(t, id), 'conversation.update', { conversationId: id });
      return res;
    });
  });

  app.delete('/api/conversations/:id/members/:userId', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id, userId } = parse(z.object({ id: uuid, userId: uuid }), req.params);
    await tx(async (t) => {
      const c = await requireMember(t, id, req.auth.userId, true);
      if (c.kind === 'direct') throw badRequest('direct_chat');
      if (!isStaffRole(c.role)) throw forbidden('admins_only');
      const target = await t.one(`select role from conversation_members where conversation_id = $1 and user_id = $2 and left_at is null and not removed`, [id, userId]);
      if (!target) throw notFound('member_not_found');
      if (target.role === 'owner') throw forbidden('cannot_remove_owner');
      if (target.role === 'admin' && c.role !== 'owner') throw forbidden('owner_only');
      const before = await activeMemberIds(t, id);
      await t.q(`update conversation_members set removed = true, left_at = now() where conversation_id = $1 and user_id = $2`, [id, userId]);
      await systemMessage(t, id, req.auth.userId, 'member_removed', { userId });
      t.emit(before, 'conversation.update', { conversationId: id, removedUserId: userId });
    });
    reply.code(204);
  });

  app.patch('/api/conversations/:id/members/:userId', { preHandler: authenticateVerified }, async (req) => {
    const { id, userId } = parse(z.object({ id: uuid, userId: uuid }), req.params);
    const { role } = parse(z.object({ role: z.enum(['admin', 'member']) }), req.body);
    return tx(async (t) => {
      const c = await requireMember(t, id, req.auth.userId, true);
      if (c.kind === 'direct') throw badRequest('direct_chat');
      if (c.role !== 'owner' && !(c.role === 'admin' && role === 'admin')) throw forbidden('owner_only');
      const target = await t.one(`select role from conversation_members where conversation_id = $1 and user_id = $2 and left_at is null and not removed`, [id, userId]);
      if (!target) throw notFound('member_not_found');
      if (target.role === 'owner') throw forbidden('cannot_change_owner');
      await t.q(`update conversation_members set role = $3 where conversation_id = $1 and user_id = $2`, [id, userId, role]);
      await systemMessage(t, id, req.auth.userId, 'role_changed', { userId, role });
      t.emit(await activeMemberIds(t, id), 'conversation.update', { conversationId: id });
      return { ok: true };
    });
  });

  app.post('/api/conversations/:id/leave', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await tx(async (t) => {
      const c = await requireMember(t, id, req.auth.userId, true);
      if (c.kind === 'direct') throw badRequest('direct_chat');
      const before = await activeMemberIds(t, id);
      if (before.length > 1) await systemMessage(t, id, req.auth.userId, 'member_left', {}); // posted while still a member
      await t.q(`update conversation_members set left_at = now() where conversation_id = $1 and user_id = $2`, [id, req.auth.userId]);
      if (c.role === 'owner') {
        const next = await t.one(`select user_id from conversation_members where conversation_id = $1 and left_at is null and not removed order by (role = 'admin') desc, joined_at limit 1`, [id]);
        if (next) await t.q(`update conversation_members set role = 'owner' where conversation_id = $1 and user_id = $2`, [id, next.user_id]);
      }
      t.emit(before, 'conversation.update', { conversationId: id, removedUserId: req.auth.userId });
    });
    reply.code(204);
  });

  // ---- invite links (hashed at rest, revocable, expiring) ----
  app.post('/api/conversations/:id/invites', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ expiresInHours: z.number().int().min(1).max(24 * 90).nullable().default(168), maxUses: z.number().int().min(1).max(10000).nullable().default(null) }), req.body ?? {});
    const c = await requireMember(pool, id, req.auth.userId);
    if (c.kind === 'direct') throw badRequest('direct_chat');
    if (!isStaffRole(c.role) && !c.members_can_invite) throw forbidden('admins_only');
    const code = randomBytes(18).toString('base64url');
    const row = await one(`insert into invite_links(conversation_id, code_hash, created_by, expires_at, max_uses) values ($1,$2,$3, ${b.expiresInHours ? `now() + ($4 || ' hours')::interval` : 'null'}, $5) returning id, expires_at`,
      b.expiresInHours ? [id, codeHash(code), req.auth.userId, String(b.expiresInHours), b.maxUses] : [id, codeHash(code), req.auth.userId, null, b.maxUses]);
    reply.code(201);
    return { id: row.id, code, expiresAt: row.expires_at, link: `/join/${code}` };
  });
  app.get('/api/conversations/:id/invites', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(idParam, req.params);
    const c = await requireMember(pool, id, req.auth.userId);
    if (!isStaffRole(c.role)) throw forbidden('admins_only');
    const { rows } = await q(`select id, created_by, expires_at, revoked_at, max_uses, uses, created_at from invite_links where conversation_id = $1 order by created_at desc limit 50`, [id]);
    return { invites: rows };
  });
  app.delete('/api/invites/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const inv = await one(`select conversation_id, community_id from invite_links where id = $1`, [id]);
    if (!inv) throw notFound('invite_not_found');
    if (inv.conversation_id) { const c = await requireMember(pool, inv.conversation_id, req.auth.userId); if (!isStaffRole(c.role)) throw forbidden('admins_only'); }
    else { const m = await one(`select role from community_members where community_id = $1 and user_id = $2`, [inv.community_id, req.auth.userId]); if (!m || m.role === 'member') throw forbidden('admins_only'); }
    await q(`update invite_links set revoked_at = now() where id = $1 and revoked_at is null`, [id]);
    reply.code(204);
  });
  app.get('/api/invites/:code', { preHandler: authenticateVerified }, async (req) => {
    const { code } = parse(z.object({ code: z.string().min(10).max(64) }), req.params);
    await rateLimit(`invite:${req.auth.userId}`, 30, 600);
    const inv = await one(
      `select i.id, c.title, c.kind, c.avatar_media_id, c.description, (select count(*)::int from conversation_members m where m.conversation_id = c.id and m.left_at is null and not m.removed) members, cm.name community_name
         from invite_links i left join conversations c on c.id = i.conversation_id left join communities cm on cm.id = i.community_id
        where i.code_hash = $1 and i.revoked_at is null and (i.expires_at is null or i.expires_at > now()) and (i.max_uses is null or i.uses < i.max_uses)`, [codeHash(code)]);
    if (!inv) throw notFound('invite_invalid');
    return { invite: { title: inv.title ?? inv.community_name, kind: inv.kind ?? 'community', description: inv.description, members: inv.members, avatarMediaId: inv.avatar_media_id } };
  });
  app.post('/api/invites/:code/join', { preHandler: authenticateVerified }, async (req) => {
    const { code } = parse(z.object({ code: z.string().min(10).max(64) }), req.params);
    await rateLimit(`invite:${req.auth.userId}`, 30, 600);
    return tx(async (t) => {
      const inv = await t.one(
        `select * from invite_links where code_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now()) and (max_uses is null or uses < max_uses) for update`, [codeHash(code)]);
      if (!inv) throw notFound('invite_invalid');
      if (inv.community_id) {
        await t.q(`insert into community_members(community_id, user_id) values ($1,$2) on conflict do nothing`, [inv.community_id, req.auth.userId]);
        const ann = await t.one(`select announcement_conversation_id a from communities where id = $1`, [inv.community_id]);
        if (ann?.a) await addMembers(t, ann.a, req.auth.userId, [req.auth.userId], { enforcePrivacy: false, role: 'member' });
        await t.q(`update invite_links set uses = uses + 1 where id = $1`, [inv.id]);
        return { communityId: inv.community_id };
      }
      const prior = await t.one(`select removed, left_at from conversation_members where conversation_id = $1 and user_id = $2`, [inv.conversation_id, req.auth.userId]);
      if (prior?.removed) throw forbidden('removed_from_group', 'An admin removed you from this group');
      if (prior && !prior.left_at) return { conversationId: inv.conversation_id, already: true };
      const kind = (await t.one(`select kind from conversations where id = $1`, [inv.conversation_id])).kind;
      const res = await addMembers(t, inv.conversation_id, req.auth.userId, [req.auth.userId], { enforcePrivacy: false, role: kind === 'channel' ? 'subscriber' : 'member' });
      if (!res.added.length) throw forbidden('cannot_join');
      await t.q(`update invite_links set uses = uses + 1 where id = $1`, [inv.id]);
      await systemMessage(t, inv.conversation_id, req.auth.userId, 'member_joined', { viaLink: true });
      t.emit(await activeMemberIds(t, inv.conversation_id), 'conversation.update', { conversationId: inv.conversation_id });
      return { conversationId: inv.conversation_id };
    });
  });

  // ---- folders ----
  app.get('/api/folders', { preHandler: authenticateVerified }, async (req) => ({ folders: (await q(`select id, name, position from chat_folders where user_id = $1 order by position, name`, [req.auth.userId])).rows }));
  app.post('/api/folders', { preHandler: authenticateVerified }, async (req, reply) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(40) }), req.body);
    const n = await one(`select count(*)::int n from chat_folders where user_id = $1`, [req.auth.userId]);
    if (n.n >= 20) throw conflict('too_many_folders');
    const r = await one(`insert into chat_folders(user_id, name, position) values ($1,$2,$3) on conflict (user_id, name) do update set name = excluded.name returning id, name, position`, [req.auth.userId, name, n.n]);
    reply.code(201);
    return { folder: r };
  });
  app.delete('/api/folders/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const f = await one(`delete from chat_folders where id = $1 and user_id = $2 returning name`, [id, req.auth.userId]);
    if (f) await q(`update conversation_members set folder = null, state_version = state_version + 1 where user_id = $1 and folder = $2`, [req.auth.userId, f.name]);
    reply.code(204);
  });
}
void otherWatermarks; void statusFor;
