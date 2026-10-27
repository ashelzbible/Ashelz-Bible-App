import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db/pool.ts';
import { parse, requireAdmin, requireStaff } from '../lib/http.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { audit } from '../lib/audit.ts';
import { hub } from '../lib/hub.ts';
import { closeSessions } from './auth.ts';
import { activeMemberIds } from '../lib/conv.ts';
import { removeMediaIfUnreferenced } from './media.ts';

const uuid = z.string().uuid();

/**
 * Trust & safety console. By design there is NO endpoint that lists or reads conversations or message bodies:
 * moderators see only content that a participant explicitly reported (a snapshot taken at report time) plus account metadata.
 */
export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/stats', { preHandler: requireStaff }, async () => {
    const [users, msgs, media, reports, jobs, appeals] = await Promise.all([
      one(`select count(*)::int total, count(*) filter (where status = 'active')::int active, count(*) filter (where status = 'suspended')::int suspended, count(*) filter (where created_at > now() - interval '24 hours')::int new24h from users`),
      one(`select count(*) filter (where created_at > now() - interval '24 hours')::int last24h, count(*)::int total from messages`),
      one(`select count(*)::int files, coalesce(sum(size),0)::bigint bytes from media_assets where deleted_at is null`),
      one(`select count(*) filter (where status = 'open')::int open, count(*)::int total from reports`),
      q(`select state, count(*)::int n from background_jobs group by state`),
      one(`select count(*) filter (where status = 'open')::int open from appeals`),
    ]);
    return { users, messages: msgs, media: { files: media.files, bytes: Number(media.bytes) }, reports, appeals, jobs: Object.fromEntries(jobs.rows.map((r) => [r.state, r.n])), realtime: { onlineUsers: hub.online }, uptimeSec: Math.round(process.uptime()) };
  });

  app.get('/api/admin/users', { preHandler: requireStaff }, async (req) => {
    const { q: term, status, limit } = parse(z.object({ q: z.string().max(100).default(''), status: z.enum(['active', 'suspended', 'deleted']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const { rows } = await q(
      `select u.id, u.username, u.email, u.status, u.role, u.created_at, p.display_name, u.suspended_reason,
              (select count(*)::int from reports r where r.target_user_id = u.id) reports
         from users u join user_profiles p on p.user_id = u.id
        where ($1 = '%%' or u.username ilike $1 escape '\\' or u.email ilike $1 escape '\\' or p.display_name ilike $1 escape '\\') and ($2::text is null or u.status = $2)
        order by u.created_at desc limit $3`, [like, status ?? null, limit]);
    return { users: rows };
  });

  app.post('/api/admin/users/:id/suspend', { preHandler: requireStaff }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { reason } = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    const target = await one(`select role, status from users where id = $1`, [id]);
    if (!target) throw notFound('user_not_found');
    if (target.role !== 'user' || id === req.auth.userId) throw forbidden('cannot_suspend_staff');
    await tx(async (t) => {
      await t.q(`update users set status = 'suspended', suspended_reason = $2 where id = $1 and status = 'active'`, [id, reason]);
      await t.q(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [id]);
      await t.q(`insert into moderation_actions(actor_id, target_user_id, action, reason) values ($1,$2,'suspend',$3)`, [req.auth.userId, id, reason]);
      await audit(req.auth.userId, 'user.suspend', id, { reason }, req.ip, t);
    });
    closeSessions(id);
    return { ok: true };
  });
  app.post('/api/admin/users/:id/unsuspend', { preHandler: requireStaff }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await one(`update users set status = 'active', suspended_reason = null where id = $1 and status = 'suspended' returning id`, [id]);
    if (!r) throw notFound('user_not_found');
    await q(`insert into moderation_actions(actor_id, target_user_id, action) values ($1,$2,'unsuspend')`, [req.auth.userId, id]);
    await audit(req.auth.userId, 'user.unsuspend', id, {}, req.ip);
    return { ok: true };
  });
  app.post('/api/admin/users/:id/role', { preHandler: requireAdmin }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { role } = parse(z.object({ role: z.enum(['user', 'moderator', 'admin']) }), req.body);
    if (id === req.auth.userId) throw badRequest('cannot_change_own_role');
    const r = await one(`update users set role = $2 where id = $1 and status = 'active' returning id`, [id, role]);
    if (!r) throw notFound('user_not_found');
    await audit(req.auth.userId, 'user.role', id, { role }, req.ip);
    return { ok: true };
  });

  app.get('/api/admin/reports', { preHandler: requireStaff }, async (req) => {
    const { status } = parse(z.object({ status: z.enum(['open', 'reviewing', 'actioned', 'dismissed']).default('open') }), req.query);
    const { rows } = await q(
      `select r.id, r.reason, r.details, r.snapshot, r.status, r.created_at, r.message_id, r.conversation_id, r.target_user_id, tu.username target_username, ru.username reporter_username
         from reports r left join users tu on tu.id = r.target_user_id join users ru on ru.id = r.reporter_id where r.status = $1 order by r.created_at desc limit 100`, [status]);
    return { reports: rows };
  });
  app.post('/api/admin/reports/:id/action', { preHandler: requireStaff }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ action: z.enum(['dismiss', 'warn', 'delete_message', 'suspend']), reason: z.string().max(500).default('') }), req.body);
    const rep = await one(`select * from reports where id = $1`, [id]);
    if (!rep) throw notFound('report_not_found');
    await tx(async (t) => {
      if (b.action === 'delete_message' && rep.message_id) {
        const m = await t.one(`update messages set deleted_for_all_at = now(), body = '', meta = '{}', pinned_at = null where id = $1 and deleted_for_all_at is null returning conversation_id, media_id`, [rep.message_id]);
        if (m) { t.emit(await activeMemberIds(t, m.conversation_id), 'message.delete', { conversationId: m.conversation_id, messageId: rep.message_id, moderated: true }); if (m.media_id) t.afterCommit.push(() => removeMediaIfUnreferenced(m.media_id)); }
      }
      if (b.action === 'suspend' && rep.target_user_id) {
        const tu = await t.one(`select role from users where id = $1`, [rep.target_user_id]);
        if (tu?.role !== 'user') throw forbidden('cannot_suspend_staff');
        await t.q(`update users set status = 'suspended', suspended_reason = $2 where id = $1`, [rep.target_user_id, b.reason || 'Reported content']);
        await t.q(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [rep.target_user_id]);
        t.afterCommit.push(() => closeSessions(rep.target_user_id));
      }
      if (b.action === 'warn' && rep.target_user_id) {
        await t.q(`insert into notifications(user_id, kind, payload) values ($1,'warning',$2)`, [rep.target_user_id, JSON.stringify({ reason: b.reason || 'Your content violated our guidelines' })]);
      }
      await t.q(`update reports set status = $2 where id = $1`, [id, b.action === 'dismiss' ? 'dismissed' : 'actioned']);
      await t.q(`insert into moderation_actions(report_id, actor_id, target_user_id, action, reason) values ($1,$2,$3,$4,$5)`, [id, req.auth.userId, rep.target_user_id, b.action === 'dismiss' ? 'dismiss' : b.action, b.reason]);
      await audit(req.auth.userId, `report.${b.action}`, id, { reason: b.reason }, req.ip, t);
    });
    return { ok: true };
  });

  app.get('/api/admin/appeals', { preHandler: requireStaff }, async () => ({ appeals: (await q(`select a.id, a.message, a.status, a.created_at, u.username, u.suspended_reason from appeals a join users u on u.id = a.user_id where a.status = 'open' order by a.created_at`)).rows }));
  app.post('/api/admin/appeals/:id/resolve', { preHandler: requireStaff }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { accept } = parse(z.object({ accept: z.boolean() }), req.body);
    const a = await one(`update appeals set status = $2 where id = $1 and status = 'open' returning user_id`, [id, accept ? 'accepted' : 'rejected']);
    if (!a) throw notFound('appeal_not_found');
    if (accept) await q(`update users set status = 'active', suspended_reason = null where id = $1 and status = 'suspended'`, [a.user_id]);
    await audit(req.auth.userId, accept ? 'appeal.accept' : 'appeal.reject', a.user_id, {}, req.ip);
    return { ok: true };
  });

  app.get('/api/admin/audit', { preHandler: requireAdmin }, async () => ({ events: (await q(`select a.id, a.action, a.target, a.detail, a.created_at, u.username actor from audit_events a left join users u on u.id = a.actor_id where a.action not like 'call:%' order by a.id desc limit 200`)).rows }));
  app.get('/api/admin/flags', { preHandler: requireAdmin }, async () => ({ flags: (await q(`select key, enabled, description from feature_flags order by key`)).rows }));
  app.put('/api/admin/flags/:key', { preHandler: requireAdmin }, async (req) => {
    const { key } = parse(z.object({ key: z.string().max(60) }), req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const r = await one(`update feature_flags set enabled = $2, updated_at = now() where key = $1 returning key`, [key, enabled]);
    if (!r) throw notFound('flag_not_found');
    await audit(req.auth.userId, 'flag.set', key, { enabled }, req.ip);
    return { ok: true };
  });
  app.get('/api/admin/jobs', { preHandler: requireAdmin }, async () => ({ failed: (await q(`select id, kind, attempts, last_error, run_at from background_jobs where state = 'failed' order by id desc limit 50`)).rows, queued: (await one(`select count(*)::int n from background_jobs where state = 'queued'`)).n }));
  app.get('/api/admin/security-events', { preHandler: requireAdmin }, async () => ({
    events: (await q(`select n.created_at, n.payload, u.username from notifications n join users u on u.id = n.user_id where n.kind = 'new_login' and (n.payload->>'suspicious')::boolean order by n.created_at desc limit 100`)).rows,
    lockedAccounts: (await one(`select count(*)::int n from users where locked_until > now()`)).n,
  }));
}
