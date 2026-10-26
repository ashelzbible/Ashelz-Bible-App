import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { one, q, tx } from '../db/pool.ts';
import { authenticate, authenticateVerified, parse } from '../lib/http.ts';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.ts';
import { hashPassword, token, verifyPassword } from '../lib/crypto.ts';
import { loadSelf, publicUser } from '../lib/users.ts';
import { DEFAULT_SETTINGS, deepMerge, settingsSchema, withDefaults } from '../lib/settings.ts';
import { rateLimit } from '../lib/ratelimit.ts';
import { audit } from '../lib/audit.ts';
import { closeSessions } from './auth.ts';
import { removeMediaIfUnreferenced } from './media.ts';
import { hub } from '../lib/hub.ts';
import { pushConfigured } from './notify.ts';
import { config } from '../config.ts';

const uuid = z.string().uuid();

export async function userRoutes(app: FastifyInstance) {
  app.get('/api/me', { preHandler: authenticate }, async (req) => ({ user: await loadSelf(req.auth.userId) }));

  app.patch('/api/me', { preHandler: authenticateVerified }, async (req) => {
    const b = parse(z.object({
      displayName: z.string().trim().min(1).max(60).optional(), bio: z.string().max(300).optional(), statusText: z.string().max(140).optional(),
      avatarMediaId: uuid.nullable().optional(), username: z.string().regex(/^[a-zA-Z0-9_.]{3,32}$/).optional(),
    }).strict(), req.body);
    await tx(async (t) => {
      if (b.avatarMediaId) { const a = await t.one(`select owner_id, kind from media_assets where id = $1 and deleted_at is null`, [b.avatarMediaId]); if (!a || a.owner_id !== req.auth.userId || !['avatar', 'image'].includes(a.kind)) throw badRequest('invalid_media'); }
      if (b.username) {
        try { await t.q(`update users set username = $2 where id = $1`, [req.auth.userId, b.username]); }
        catch (e: any) { if (e.code === '23505') throw conflict('username_taken'); throw e; }
      }
      const prev = await t.one(`select avatar_media_id from user_profiles where user_id = $1`, [req.auth.userId]);
      await t.q(
        `update user_profiles set display_name = coalesce($2, display_name), bio = coalesce($3, bio), status_text = coalesce($4, status_text),
                avatar_media_id = case when $5 then $6::uuid else avatar_media_id end, updated_at = now() where user_id = $1`,
        [req.auth.userId, b.displayName ?? null, b.bio ?? null, b.statusText ?? null, b.avatarMediaId !== undefined, b.avatarMediaId ?? null]);
      if (b.avatarMediaId !== undefined && prev.avatar_media_id && prev.avatar_media_id !== b.avatarMediaId) t.afterCommit.push(() => removeMediaIfUnreferenced(prev.avatar_media_id));
      t.emit([req.auth.userId], 'profile.update', {});
    });
    return { user: await loadSelf(req.auth.userId) };
  });

  // Settings are versioned: a stale baseVersion yields 409 with the current settings so devices converge without silently overwriting each other.
  app.get('/api/me/settings', { preHandler: authenticate }, async (req) => {
    const u = await loadSelf(req.auth.userId);
    return { settings: u.settings, version: u.settingsVersion };
  });
  app.patch('/api/me/settings', { preHandler: authenticate }, async (req) => {
    const b = parse(z.object({ baseVersion: z.number().int().optional(), patch: settingsSchema }), req.body);
    return tx(async (t) => {
      const cur = await t.one(`select settings, settings_version from user_profiles where user_id = $1 for update`, [req.auth.userId]);
      if (b.baseVersion !== undefined && b.baseVersion !== cur.settings_version) {
        throw Object.assign(conflict('version_conflict', 'Settings changed on another device'), { details: { settings: withDefaults(cur.settings), version: cur.settings_version } });
      }
      const merged = deepMerge(cur.settings ?? {}, b.patch as Record<string, any>);
      const row = await t.one(`update user_profiles set settings = $2, settings_version = settings_version + 1 where user_id = $1 returning settings_version`, [req.auth.userId, JSON.stringify(merged)]);
      t.emit([req.auth.userId], 'settings.update', { version: row.settings_version });
      return { settings: withDefaults(merged), version: row.settings_version };
    });
  });

  app.get('/api/users/:id', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const u = await publicUser(id, req.auth.userId);
    const blk = await one(`select 1 from blocks where blocker_id = $1 and blocked_id = $2`, [id, req.auth.userId]);
    if (!u || blk) throw notFound('user_not_found');
    const mine = await one(`select exists(select 1 from contacts where owner_id = $1 and contact_id = $2) is_contact, exists(select 1 from blocks where blocker_id = $1 and blocked_id = $2) blocked`, [req.auth.userId, id]);
    return { user: u, isContact: mine.is_contact, blockedByMe: mine.blocked };
  });

  // ---- discovery ----
  app.get('/api/users/search', { preHandler: authenticateVerified }, async (req) => {
    const { q: term } = parse(z.object({ q: z.string().trim().min(3).max(100) }), req.query);
    await rateLimit(`usersearch:${req.auth.userId}`, 40, 600);
    const me = req.auth.userId;
    const lower = term.toLowerCase();
    const isEmail = lower.includes('@'); const isPhone = /^\+[1-9]\d{6,14}$/.test(term);
    let rows;
    if (isEmail || isPhone) {
      // Exact match only, and only for accounts that opted in to being found this way.
      rows = (await q(
        `select u.id from users u join user_profiles p on p.user_id = u.id
          where u.status = 'active' and ${isEmail ? 'u.email = $1' : 'u.phone = $1'} and (p.settings->'privacy'->>'discoverable')::boolean is true and u.id <> $2
            and not exists(select 1 from blocks b where b.blocker_id = u.id and b.blocked_id = $2)`, [isEmail ? lower : term, me])).rows;
    } else {
      rows = (await q(
        `select u.id from users u where u.status = 'active' and lower(u.username::text) like $1 || '%' escape '\\' and u.id <> $2
            and not exists(select 1 from blocks b where b.blocker_id = u.id and b.blocked_id = $2) order by u.username limit 20`, [lower.replace(/[%_\\]/g, (c) => '\\' + c), me])).rows;
    }
    const users = (await Promise.all(rows.map((r) => publicUser(r.id, me)))).filter(Boolean);
    return { users: users.map((u) => ({ id: u!.id, username: u!.username, displayName: u!.displayName, avatarMediaId: u!.avatarMediaId })) };
  });

  // Contact sync requires an explicit client-side opt-in and only reveals users who set "discoverable".
  app.post('/api/contacts/sync', { preHandler: authenticateVerified }, async (req) => {
    const { phones } = parse(z.object({ phones: z.array(z.string().regex(/^\+[1-9]\d{6,14}$/)).min(1).max(500) }), req.body);
    await rateLimit(`sync:${req.auth.userId}`, 5, 3600);
    const { rows } = await q(
      `select u.id from users u join user_profiles p on p.user_id = u.id where u.phone = any($1::text[]) and u.status = 'active' and (p.settings->'privacy'->>'discoverable')::boolean is true and u.id <> $2
          and not exists(select 1 from blocks b where b.blocker_id = u.id and b.blocked_id = $2)`, [phones, req.auth.userId]);
    const users = (await Promise.all(rows.map((r) => publicUser(r.id, req.auth.userId)))).filter(Boolean);
    return { matches: users.map((u) => ({ id: u!.id, username: u!.username, displayName: u!.displayName })) };
  });

  app.get('/api/contacts', { preHandler: authenticateVerified }, async (req) => {
    const { rows } = await q(
      `select c.contact_id id, c.alias, c.favorite, u.username, p.display_name, p.avatar_media_id, p.status_text, p.settings,
              exists(select 1 from contacts x where x.owner_id = c.contact_id and x.contact_id = $1) has_me, exists(select 1 from blocks b where b.blocker_id = c.contact_id and b.blocked_id = $1) blocked_me
         from contacts c join users u on u.id = c.contact_id and u.status = 'active' join user_profiles p on p.user_id = c.contact_id where c.owner_id = $1 order by lower(coalesce(c.alias, p.display_name))`, [req.auth.userId]);
    const { canSee } = await import('../lib/users.ts');
    return { contacts: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.alias || r.display_name, alias: r.alias, favorite: r.favorite,
      avatarMediaId: canSee(r.settings, 'profilePhoto', r.has_me, r.blocked_me) ? r.avatar_media_id : null, statusText: canSee(r.settings, 'about', r.has_me, r.blocked_me) ? r.status_text : null })) };
  });
  app.put('/api/contacts/:id', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ alias: z.string().max(60).nullable().optional(), favorite: z.boolean().optional() }), req.body ?? {});
    if (id === req.auth.userId) throw badRequest('cannot_add_self');
    const target = await one(`select status from users where id = $1`, [id]);
    const blk = await one(`select 1 from blocks where blocker_id = $1 and blocked_id = $2`, [id, req.auth.userId]);
    if (!target || target.status !== 'active' || blk) throw notFound('user_not_found');
    await q(`insert into contacts(owner_id, contact_id, alias, favorite) values ($1,$2,$3,coalesce($4,false))
             on conflict (owner_id, contact_id) do update set alias = case when $5 then excluded.alias else contacts.alias end, favorite = coalesce($4, contacts.favorite)`,
      [req.auth.userId, id, b.alias ?? null, b.favorite ?? null, b.alias !== undefined]);
    return { ok: true };
  });
  app.delete('/api/contacts/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await q(`delete from contacts where owner_id = $1 and contact_id = $2`, [req.auth.userId, id]);
    reply.code(204);
  });

  // ---- blocking ----
  app.get('/api/blocks', { preHandler: authenticateVerified }, async (req) => {
    const { rows } = await q(`select b.blocked_id id, u.username, p.display_name "displayName" from blocks b join users u on u.id = b.blocked_id join user_profiles p on p.user_id = b.blocked_id where b.blocker_id = $1 order by b.created_at desc`, [req.auth.userId]);
    return { blocked: rows };
  });
  app.put('/api/blocks/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    if (id === req.auth.userId) throw badRequest('cannot_block_self');
    const exists = await one(`select 1 from users where id = $1 and status = 'active'`, [id]);
    if (!exists) throw notFound('user_not_found');
    await tx(async (t) => {
      await t.q(`insert into blocks(blocker_id, blocked_id) values ($1,$2) on conflict do nothing`, [req.auth.userId, id]);
      await t.q(`delete from status_mutes where user_id = $1 and muted_id = $2`, [req.auth.userId, id]);
      t.emit([req.auth.userId], 'blocks.update', { userId: id, blocked: true });
    });
    reply.code(204);
  });
  app.delete('/api/blocks/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await tx(async (t) => { await t.q(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [req.auth.userId, id]); t.emit([req.auth.userId], 'blocks.update', { userId: id, blocked: false }); });
    reply.code(204);
  });

  // ---- devices & sessions ----
  app.get('/api/devices', { preHandler: authenticate }, async (req) => {
    const { rows } = await q(
      `select d.id, d.name, d.platform, d.created_at, d.last_seen_at, max(s.ip) ip, (d.id = $2) current
         from devices d left join sessions s on s.device_id = d.id and s.revoked_at is null where d.user_id = $1 and d.revoked_at is null group by d.id order by d.last_seen_at desc`, [req.auth.userId, req.auth.deviceId]);
    return { devices: rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform, createdAt: r.created_at, lastSeenAt: r.last_seen_at, ip: r.ip, current: r.current, online: hub.localCount(req.auth.userId) > 0 && hub.connectionsOf(req.auth.userId).some((c) => c.deviceId === r.id) })) };
  });
  app.delete('/api/devices/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const d = await one(`update devices set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null returning id`, [id, req.auth.userId]);
    if (!d) throw notFound('device_not_found');
    await q(`update sessions set revoked_at = now() where device_id = $1 and revoked_at is null`, [id]);
    await q(`delete from push_subscriptions where device_id = $1`, [id]);
    await q(`delete from encryption_devices where device_id = $1`, [id]);
    for (const c of hub.connectionsOf(req.auth.userId)) if (c.deviceId === id) c.ws.close(4001, 'device revoked');
    await tx(async (t) => t.emit([req.auth.userId], 'devices.update', { revokedDeviceId: id }));
    await audit(req.auth.userId, 'device.revoked', id, {}, req.ip);
    reply.code(204);
  });

  // ---- notifications & push ----
  app.get('/api/notifications', { preHandler: authenticateVerified }, async (req) => {
    const { rows } = await q(`select id, kind, conversation_id, payload, created_at, read_at, push_state from notifications where user_id = $1 order by created_at desc limit 100`, [req.auth.userId]);
    return { notifications: rows.map((r) => ({ id: r.id, kind: r.kind, conversationId: r.conversation_id, payload: r.payload, createdAt: r.created_at, read: !!r.read_at, pushState: r.push_state })) };
  });
  app.post('/api/notifications/read', { preHandler: authenticateVerified }, async (req, reply) => {
    await q(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [req.auth.userId]);
    reply.code(204);
  });
  app.get('/api/push/config', { preHandler: authenticate }, async () => ({ webPush: pushConfigured, vapidPublicKey: pushConfigured ? config.vapid.publicKey : null, fcm: false, apns: false }));
  app.post('/api/push/subscribe', { preHandler: authenticateVerified }, async (req, reply) => {
    const b = parse(z.object({ endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'https only'), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }), req.body);
    await q(`insert into push_subscriptions(user_id, device_id, endpoint, p256dh, auth) values ($1,$2,$3,$4,$5)
             on conflict (endpoint) do update set user_id = excluded.user_id, device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth`, [req.auth.userId, req.auth.deviceId, b.endpoint, b.keys.p256dh, b.keys.auth]);
    reply.code(204);
  });
  app.post('/api/push/unsubscribe', { preHandler: authenticate }, async (req, reply) => {
    const { endpoint } = parse(z.object({ endpoint: z.string() }), req.body);
    await q(`delete from push_subscriptions where endpoint = $1 and user_id = $2`, [endpoint, req.auth.userId]);
    reply.code(204);
  });

  // ---- reports ----
  app.post('/api/reports', { preHandler: authenticateVerified }, async (req, reply) => {
    const b = parse(z.object({ userId: uuid.optional(), conversationId: uuid.optional(), messageId: uuid.optional(), reason: z.enum(['spam', 'abuse', 'harassment', 'illegal', 'impersonation', 'other']), details: z.string().max(1000).default('') }), req.body);
    if (!b.userId && !b.conversationId && !b.messageId) throw badRequest('target_required');
    await rateLimit(`report:${req.auth.userId}`, 20, 3600);
    let snapshot: unknown = null; let targetUser = b.userId ?? null; let conv = b.conversationId ?? null;
    if (b.messageId) {
      // Only a message the reporter can see may be reported; the reported message text is preserved for moderators.
      const m = await one(`select m.id, m.body, m.kind, m.sender_id, m.conversation_id, m.created_at from messages m join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = $2 and cm.left_at is null and not cm.removed
                            where m.id = $1 and (not m.undelivered or m.sender_id = $2)`, [b.messageId, req.auth.userId]);
      if (!m) throw notFound('message_not_found');
      snapshot = { body: m.body, kind: m.kind, createdAt: m.created_at };
      targetUser = m.sender_id; conv = m.conversation_id;
    } else if (b.conversationId) {
      const m = await one(`select 1 from conversation_members where conversation_id = $1 and user_id = $2 and left_at is null and not removed`, [b.conversationId, req.auth.userId]);
      if (!m) throw notFound('conversation_not_found');
    }
    await q(`insert into reports(reporter_id, target_user_id, conversation_id, message_id, reason, details, snapshot) values ($1,$2,$3,$4,$5,$6,$7)`, [req.auth.userId, targetUser, conv, b.messageId ?? null, b.reason, b.details, snapshot ? JSON.stringify(snapshot) : null]);
    reply.code(201);
    return { ok: true };
  });

  // ---- data export & deletion ----
  app.get('/api/me/export', { preHandler: authenticate }, async (req, reply) => {
    await rateLimit(`export:${req.auth.userId}`, 3, 3600);
    const me = req.auth.userId;
    const [user, contacts, convs, sent, devices, statuses] = await Promise.all([
      loadSelf(me),
      q(`select contact_id, alias, favorite from contacts where owner_id = $1`, [me]),
      q(`select c.id, c.kind, c.title, m.role, m.joined_at from conversation_members m join conversations c on c.id = m.conversation_id where m.user_id = $1 and m.left_at is null`, [me]),
      q(`select id, conversation_id, kind, body, meta, created_at, edited_at from messages where sender_id = $1 and deleted_for_all_at is null order by created_at`, [me]),
      q(`select name, platform, created_at, last_seen_at from devices where user_id = $1 and revoked_at is null`, [me]),
      q(`select kind, body, caption, created_at from status_updates where user_id = $1`, [me]),
    ]);
    reply.header('Content-Disposition', 'attachment; filename="wazzupp-export.json"');
    return { exportedAt: new Date().toISOString(), account: user, contacts: contacts.rows, conversations: convs.rows, messagesSent: sent.rows, devices: devices.rows, statuses: statuses.rows,
      note: 'Contains your account data and messages you sent. Messages from other people belong to them and are not included.' };
  });

  app.delete('/api/me', { preHandler: authenticate }, async (req, reply) => {
    const b = parse(z.object({ password: z.string(), confirm: z.literal('DELETE') }), req.body);
    const me = req.auth.userId;
    const u = await one('select password_hash, role from users where id = $1', [me]);
    if (!(await verifyPassword(u.password_hash, b.password))) throw unauthorized('invalid_credentials');
    await deleteAccount(me);
    await audit(me, 'account.deleted', me, {}, req.ip);
    reply.code(204);
  });
}

/** Irreversibly anonymizes the account: credentials, profile, contacts, memberships and everything the user authored are removed. */
export async function deleteAccount(userId: string) {
  const mediaIds = await tx(async (t) => {
    const media = (await t.q(`select id from media_assets where owner_id = $1 and deleted_at is null`, [userId])).rows.map((r) => r.id as string);
    const convs = (await t.q(`select conversation_id from conversation_members where user_id = $1 and left_at is null`, [userId])).rows.map((r) => r.conversation_id as string);
    await t.q(`update messages set deleted_for_all_at = now(), body = '', meta = '{}', media_id = null, pinned_at = null where sender_id = $1 and deleted_for_all_at is null`, [userId]);
    await t.q(`update conversation_members set left_at = now() where user_id = $1 and left_at is null`, [userId]);
    await t.q(`delete from message_reactions where user_id = $1`, [userId]);
    await t.q(`delete from status_updates where user_id = $1`, [userId]);
    await t.q(`delete from contacts where owner_id = $1 or contact_id = $1`, [userId]);
    await t.q(`delete from blocks where blocker_id = $1 or blocked_id = $1`, [userId]);
    await t.q(`delete from push_subscriptions where user_id = $1`, [userId]);
    await t.q(`delete from notifications where user_id = $1`, [userId]);
    await t.q(`delete from outbox where user_id = $1`, [userId]);
    await t.q(`update sessions set revoked_at = now() where user_id = $1`, [userId]);
    await t.q(`update devices set revoked_at = now() where user_id = $1`, [userId]);
    await t.q(`delete from encryption_devices where user_id = $1`, [userId]);
    await t.q(`delete from user_events where user_id = $1`, [userId]);
    await t.q(`update users set status = 'deleted', deleted_at = now(), email = null, phone = null, username = 'deleted_' || left(replace(id::text, '-', ''), 20), password_hash = $2, mfa_secret = null, mfa_enabled = false where id = $1`, [userId, await hashPassword(token(24))]);
    await t.q(`update user_profiles set display_name = 'Deleted account', bio = '', status_text = '', avatar_media_id = null, settings = '{}' where user_id = $1`, [userId]);
    return { media, convs };
  });
  closeSessions(userId);
  for (const id of mediaIds.media) await removeMediaIfUnreferenced(id);
  // Tell the remaining members that this user left.
  for (const c of mediaIds.convs) {
    const members = (await q(`select user_id from conversation_members where conversation_id = $1 and left_at is null`, [c])).rows.map((r) => r.user_id);
    if (members.length) await tx(async (t) => t.emit(members, 'conversation.update', { conversationId: c, removedUserId: userId }));
  }
}
void forbidden; void createHash; void DEFAULT_SETTINGS;
