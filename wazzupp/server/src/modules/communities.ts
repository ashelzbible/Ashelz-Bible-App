import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, pool, q, tx } from '../db/pool.ts';
import type { Tx } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { isStaffRole, requireMember } from '../lib/conv.ts';
import { rateLimit } from '../lib/ratelimit.ts';
import { createHash, randomBytes } from 'node:crypto';
import { systemMessage } from './conversations.ts';

const uuid = z.string().uuid();
const idp = z.object({ id: uuid });

async function memberRole(db: { query: typeof pool.query } | Tx, communityId: string, userId: string): Promise<string | null> {
  const sql = `select role from community_members where community_id = $1 and user_id = $2`;
  const r = 'one' in db ? await db.one(sql, [communityId, userId]) : (await (db as any).query(sql, [communityId, userId])).rows[0];
  return r?.role ?? null;
}

async function joinAnnouncement(t: Tx, announcementId: string, userId: string, role: 'owner' | 'admin' | 'member') {
  const seq = (await t.one('select last_seq from conversations where id = $1', [announcementId])).last_seq;
  await t.q(
    `insert into conversation_members(conversation_id, user_id, role, first_visible_seq, last_read_seq, last_delivered_seq) values ($1,$2,$3,$4,$4,$4)
     on conflict (conversation_id, user_id) do update set role = excluded.role, left_at = null, removed = false`, [announcementId, userId, role, seq]);
}

export async function communityRoutes(app: FastifyInstance) {
  app.post('/api/communities', { preHandler: authenticateVerified }, async (req, reply) => {
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).default(''), visibility: z.enum(['public', 'private']).default('private'), avatarMediaId: uuid.nullish() }), req.body);
    const me = req.auth.userId;
    await rateLimit(`newcommunity:${me}`, 10, 3600);
    const id = await tx(async (t) => {
      if (b.avatarMediaId) { const a = await t.one(`select owner_id from media_assets where id = $1`, [b.avatarMediaId]); if (!a || a.owner_id !== me) throw badRequest('invalid_media'); }
      const c = await t.one(`insert into communities(name, description, visibility, created_by, avatar_media_id) values ($1,$2,$3,$4,$5) returning id`, [b.name, b.description, b.visibility, me, b.avatarMediaId ?? null]);
      const ann = await t.one(`insert into conversations(kind, title, description, created_by, announce_only, community_id, avatar_media_id) values ('announcement',$1,$2,$3,true,$4,$5) returning id`, [`${b.name} · Announcements`, `Announcements for ${b.name}`, me, c.id, b.avatarMediaId ?? null]);
      await t.q(`update communities set announcement_conversation_id = $2 where id = $1`, [c.id, ann.id]);
      await t.q(`insert into community_members(community_id, user_id, role) values ($1,$2,'owner')`, [c.id, me]);
      await joinAnnouncement(t, ann.id, me, 'owner');
      await systemMessage(t, ann.id, me, 'community_created', { name: b.name });
      return c.id as string;
    });
    reply.code(201);
    return { community: await describe(id, me) };
  });

  async function describe(id: string, me: string) {
    const c = await one(`select c.*, (select count(*)::int from community_members m where m.community_id = c.id) members from communities c where c.id = $1`, [id]);
    if (!c) return null;
    const role = await memberRole(pool, id, me);
    if (!role && c.visibility !== 'public') return null; // private communities are invisible to non-members
    const groups = role ? (await q(
      `select g.id, g.title, g.avatar_media_id "avatarMediaId", g.kind, (select count(*)::int from conversation_members m where m.conversation_id = g.id and m.left_at is null and not m.removed) "memberCount",
              exists(select 1 from conversation_members m where m.conversation_id = g.id and m.user_id = $2 and m.left_at is null and not m.removed) joined
         from conversations g where g.community_id = $1 and g.kind in ('group','channel') order by g.title`, [id, me])).rows : [];
    return { id: c.id, name: c.name, description: c.description, visibility: c.visibility, avatarMediaId: c.avatar_media_id, members: c.members, role, announcementConversationId: role ? c.announcement_conversation_id : null, groups, createdAt: c.created_at };
  }

  app.get('/api/communities', { preHandler: authenticateVerified }, async (req) => {
    const ids = (await q(`select community_id from community_members where user_id = $1 order by joined_at desc`, [req.auth.userId])).rows.map((r) => r.community_id as string);
    return { communities: (await Promise.all(ids.map((id) => describe(id, req.auth.userId)))).filter(Boolean) };
  });
  app.get('/api/communities/discover', { preHandler: authenticateVerified }, async (req) => {
    const { q: term } = parse(z.object({ q: z.string().trim().max(100).default('') }), req.query);
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const { rows } = await q(
      `select c.id, c.name, c.description, c.avatar_media_id "avatarMediaId", (select count(*)::int from community_members m where m.community_id = c.id) members
         from communities c where c.visibility = 'public' and (c.name ilike $1 escape '\\') order by members desc limit 30`, [like]);
    const ch = await q(
      `select c.id, c.title, c.description, c.avatar_media_id "avatarMediaId", (select count(*)::int from conversation_members m where m.conversation_id = c.id and m.left_at is null and not m.removed) members
         from conversations c where c.kind = 'channel' and c.is_public and c.title ilike $1 escape '\\' order by members desc limit 30`, [like]);
    return { communities: rows, channels: ch.rows };
  });
  app.get('/api/communities/:id', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(idp, req.params);
    const d = await describe(id, req.auth.userId);
    if (!d) throw notFound('community_not_found');
    return { community: d };
  });
  app.post('/api/communities/:id/join', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(idp, req.params);
    await tx(async (t) => {
      const c = await t.one(`select visibility, announcement_conversation_id a from communities where id = $1`, [id]);
      if (!c || c.visibility !== 'public') throw notFound('community_not_found');
      await t.q(`insert into community_members(community_id, user_id) values ($1,$2) on conflict do nothing`, [id, req.auth.userId]);
      await joinAnnouncement(t, c.a, req.auth.userId, 'member');
    });
    return { community: await describe(id, req.auth.userId) };
  });
  app.post('/api/communities/:id/leave', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(idp, req.params);
    await tx(async (t) => {
      const role = await memberRole(t, id, req.auth.userId);
      if (!role) throw notFound('community_not_found');
      if (role === 'owner') throw conflict('owner_cannot_leave', 'Transfer ownership before leaving');
      const c = await t.one(`select announcement_conversation_id a from communities where id = $1`, [id]);
      await t.q(`delete from community_members where community_id = $1 and user_id = $2`, [id, req.auth.userId]);
      await t.q(`update conversation_members set left_at = now() where conversation_id = $1 and user_id = $2`, [c.a, req.auth.userId]);
    });
    reply.code(204);
  });
  app.patch('/api/communities/:id/members/:userId', { preHandler: authenticateVerified }, async (req) => {
    const { id, userId } = parse(z.object({ id: uuid, userId: uuid }), req.params);
    const { role } = parse(z.object({ role: z.enum(['admin', 'member']) }), req.body);
    await tx(async (t) => {
      if ((await memberRole(t, id, req.auth.userId)) !== 'owner') throw forbidden('owner_only');
      const target = await memberRole(t, id, userId);
      if (!target || target === 'owner') throw badRequest('invalid_target');
      await t.q(`update community_members set role = $3 where community_id = $1 and user_id = $2`, [id, userId, role]);
      const c = await t.one(`select announcement_conversation_id a from communities where id = $1`, [id]);
      await t.q(`update conversation_members set role = $3 where conversation_id = $1 and user_id = $2`, [c.a, userId, role]); // admins may post announcements
    });
    return { ok: true };
  });
  app.delete('/api/communities/:id/members/:userId', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id, userId } = parse(z.object({ id: uuid, userId: uuid }), req.params);
    await tx(async (t) => {
      const mine = await memberRole(t, id, req.auth.userId);
      if (!mine || mine === 'member') throw forbidden('admins_only');
      const target = await memberRole(t, id, userId);
      if (!target || target === 'owner' || (target === 'admin' && mine !== 'owner')) throw forbidden('cannot_remove');
      const c = await t.one(`select announcement_conversation_id a from communities where id = $1`, [id]);
      await t.q(`delete from community_members where community_id = $1 and user_id = $2`, [id, userId]);
      await t.q(`update conversation_members set left_at = now(), removed = true where conversation_id = $1 and user_id = $2`, [c.a, userId]);
    });
    reply.code(204);
  });
  app.get('/api/communities/:id/members', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(idp, req.params);
    if (!(await memberRole(pool, id, req.auth.userId))) throw notFound('community_not_found');
    const { rows } = await q(`select u.id, u.username, p.display_name "displayName", p.avatar_media_id "avatarMediaId", m.role from community_members m join users u on u.id = m.user_id join user_profiles p on p.user_id = m.user_id where m.community_id = $1 order by m.role, p.display_name limit 500`, [id]);
    return { members: rows };
  });

  // Link an existing group (requires admin in both) or create a new one inside the community.
  app.post('/api/communities/:id/groups', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(idp, req.params);
    const { conversationId } = parse(z.object({ conversationId: uuid }), req.body);
    await tx(async (t) => {
      const role = await memberRole(t, id, req.auth.userId);
      if (!role || role === 'member') throw forbidden('admins_only');
      const g = await requireMember(t, conversationId, req.auth.userId, true);
      if (!['group', 'channel'].includes(g.kind) || !isStaffRole(g.role)) throw forbidden('group_admin_required');
      if (g.community_id) throw conflict('already_linked');
      await t.q(`update conversations set community_id = $2 where id = $1`, [conversationId, id]);
      await systemMessage(t, conversationId, req.auth.userId, 'community_linked', { communityId: id });
    });
    reply.code(204);
  });
  app.delete('/api/communities/:id/groups/:conversationId', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id, conversationId } = parse(z.object({ id: uuid, conversationId: uuid }), req.params);
    const role = await memberRole(pool, id, req.auth.userId);
    if (!role || role === 'member') throw forbidden('admins_only');
    await q(`update conversations set community_id = null where id = $1 and community_id = $2 and kind in ('group','channel')`, [conversationId, id]);
    reply.code(204);
  });
  // Community members may join any group linked to the community.
  app.post('/api/communities/:id/groups/:conversationId/join', { preHandler: authenticateVerified }, async (req) => {
    const { id, conversationId } = parse(z.object({ id: uuid, conversationId: uuid }), req.params);
    await tx(async (t) => {
      if (!(await memberRole(t, id, req.auth.userId))) throw notFound('community_not_found');
      const g = await t.one(`select id, kind from conversations where id = $1 and community_id = $2 and kind in ('group','channel')`, [conversationId, id]);
      if (!g) throw notFound('group_not_found');
      const prior = await t.one(`select removed from conversation_members where conversation_id = $1 and user_id = $2`, [conversationId, req.auth.userId]);
      if (prior?.removed) throw forbidden('removed_from_group');
      const seq = (await t.one('select last_seq from conversations where id = $1', [conversationId])).last_seq;
      await t.q(`insert into conversation_members(conversation_id, user_id, role, first_visible_seq, last_read_seq, last_delivered_seq) values ($1,$2,$3,$4,$4,$4)
                 on conflict (conversation_id, user_id) do update set left_at = null`, [conversationId, req.auth.userId, g.kind === 'channel' ? 'subscriber' : 'member', seq]);
      await systemMessage(t, conversationId, req.auth.userId, 'member_joined', { viaCommunity: true });
    });
    return { conversationId };
  });
  app.post('/api/communities/:id/announce', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(idp, req.params);
    const { body, clientMsgId } = parse(z.object({ body: z.string().min(1).max(4000), clientMsgId: z.string().min(8).max(64) }), req.body);
    const { sendMessage } = await import('./messages.ts');
    const c = await one(`select announcement_conversation_id a from communities where id = $1`, [id]);
    if (!c) throw notFound('community_not_found');
    const r = await tx((t) => sendMessage(t, { conversationId: c.a, senderId: req.auth.userId, deviceId: req.auth.deviceId, clientMsgId, kind: 'text', body }));
    reply.code(r.created ? 201 : 200);
    return { message: r.message };
  });
  app.post('/api/communities/:id/invites', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(idp, req.params);
    const role = await memberRole(pool, id, req.auth.userId);
    if (!role || role === 'member') throw forbidden('admins_only');
    const code = randomBytes(18).toString('base64url');
    const r = await one(`insert into invite_links(community_id, code_hash, created_by, expires_at) values ($1,$2,$3, now() + interval '7 days') returning id, expires_at`, [id, createHash('sha256').update(code).digest(), req.auth.userId]);
    reply.code(201);
    return { id: r.id, code, link: `/join/${code}`, expiresAt: r.expires_at };
  });
  app.post('/api/channels/:id/subscribe', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(idp, req.params);
    await tx(async (t) => {
      const c = await t.one(`select id, last_seq from conversations where id = $1 and kind = 'channel' and is_public`, [id]);
      if (!c) throw notFound('channel_not_found');
      const prior = await t.one(`select removed from conversation_members where conversation_id = $1 and user_id = $2`, [id, req.auth.userId]);
      if (prior?.removed) throw forbidden('removed_from_channel');
      await t.q(`insert into conversation_members(conversation_id, user_id, role, first_visible_seq, last_read_seq, last_delivered_seq) values ($1,$2,'subscriber',$3,$3,$3) on conflict (conversation_id, user_id) do update set left_at = null`, [id, req.auth.userId, c.last_seq]);
    });
    return { conversationId: id };
  });
}
