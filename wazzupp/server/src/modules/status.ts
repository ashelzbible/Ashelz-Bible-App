import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { config } from '../config.ts';
import { rateLimit } from '../lib/ratelimit.ts';
import { withDefaults } from '../lib/settings.ts';
import { sendMessage } from './messages.ts';
import { randomUUID } from 'node:crypto';
import { removeMediaIfUnreferenced } from './media.ts';
import { CATALOG_HOST } from './music.ts';

const uuid = z.string().uuid();

/** Visibility predicate for a status row `s` viewed by `$1`. Expiry is enforced on every read, independent of the cleanup job. */
const VISIBLE = `s.expires_at > now() and (s.user_id = $1 or (
  not exists(select 1 from blocks b where b.blocker_id = s.user_id and b.blocked_id = $1) and not exists(select 1 from blocks b where b.blocker_id = $1 and b.blocked_id = s.user_id) and (
    (s.audience = 'contacts' and exists(select 1 from contacts c where c.owner_id = s.user_id and c.contact_id = $1))
 or (s.audience = 'except' and exists(select 1 from contacts c where c.owner_id = s.user_id and c.contact_id = $1) and $1 <> all(s.audience_ids))
 or (s.audience = 'only' and $1 = any(s.audience_ids)))))`;

export async function statusRoutes(app: FastifyInstance) {
  app.post('/api/status', { preHandler: authenticateVerified }, async (req, reply) => {
    const b = parse(z.object({
      kind: z.enum(['text', 'image', 'video', 'voice']), font: z.number().int().min(0).max(7).default(0), body: z.string().max(700).default(''), caption: z.string().max(700).default(''), background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      mediaId: uuid.nullish(), audioMediaId: uuid.nullish(), audioTitle: z.string().max(200).default(''), audioUrl: z.string().url().max(600).nullish(), audioArt: z.string().url().max(600).nullish(), audioCredit: z.string().url().max(600).nullish(), audience: z.enum(['contacts', 'except', 'only']).optional(), audienceIds: z.array(uuid).max(500).default([]),
    }), req.body);
    const me = req.auth.userId;
    await rateLimit(`status:${me}`, 30, 3600);
    const flag = await one(`select enabled from feature_flags where key = 'status_enabled'`);
    if (flag && !flag.enabled) throw forbidden('status_disabled');
    if (b.kind === 'text' && !b.body.trim()) throw badRequest('empty_status');
    const prof = await one(`select settings from user_profiles where user_id = $1`, [me]);
    const settings = withDefaults(prof.settings);
    const audience = b.audience ?? settings.privacy.statusAudience;
    const listFromSettings = audience === 'except' ? settings.privacy.statusExcept : audience === 'only' ? settings.privacy.statusOnly : [];
    const audienceIds = b.audienceIds.length ? b.audienceIds : (listFromSettings as string[]);
    if (audience === 'only' && !audienceIds.length) throw badRequest('audience_empty', 'Choose who to share this status with');
    if (b.kind !== 'text') {
      const a = b.mediaId ? await one(`select owner_id, kind from media_assets where id = $1 and deleted_at is null`, [b.mediaId]) : null;
      if (!a || a.owner_id !== me || a.kind !== b.kind) throw badRequest('invalid_media');
    }
    if (b.audioUrl) {
      if (b.kind !== 'image' && b.kind !== 'video') throw badRequest('audio_needs_media', 'Music can be added to photo and video updates');
      if (b.audioMediaId || !config.jamendoClientId || !CATALOG_HOST.test(b.audioUrl) || (b.audioArt && !CATALOG_HOST.test(b.audioArt)) || (b.audioCredit && !CATALOG_HOST.test(b.audioCredit))) throw badRequest('invalid_audio', 'That song is not available');
    }
    if (b.audioMediaId) {
      if (b.kind !== 'image' && b.kind !== 'video') throw badRequest('audio_needs_media', 'Music can be added to photo and video updates');
      const au = await one(`select owner_id, kind from media_assets where id = $1 and deleted_at is null`, [b.audioMediaId]);
      if (!au || au.owner_id !== me || au.kind !== 'audio') throw badRequest('invalid_audio');
    }
    const ttl = Math.min(config.statusTtlSeconds, (settings.statusTtlHours ?? 24) * 3600);
    const id = await tx(async (t) => {
      const r = await t.one(
        `insert into status_updates(user_id, kind, body, caption, background, font, audio_media_id, audio_title, audio_url, audio_art, audio_credit, media_id, audience, audience_ids, expires_at, allow_sharing)
         values ($1,$2,$3,$4,$5,$11,$12,$13,$14,$15,$16,$6,$7,$8, now() + ($9 || ' seconds')::interval, $10) returning id`,
        [me, b.kind, b.body, b.caption, b.background ?? null, b.kind === 'text' ? null : b.mediaId, audience, audienceIds, String(ttl), settings.privacy.statusSharing !== false, b.font, b.audioMediaId ?? null, b.audioTitle, b.audioUrl ?? null, b.audioArt ?? null, b.audioCredit ?? null]);
      const viewers = (await t.q(`select c.contact_id id from contacts c where c.owner_id = $1 and not exists(select 1 from blocks b where (b.blocker_id = $1 and b.blocked_id = c.contact_id) or (b.blocker_id = c.contact_id and b.blocked_id = $1))`, [me])).rows.map((x) => x.id as string);
      const aud = audience === 'only' ? audienceIds : audience === 'except' ? viewers.filter((v) => !audienceIds.includes(v)) : viewers;
      t.emit([me, ...aud], 'status.new', { statusId: r.id, userId: me });
      return r.id as string;
    });
    reply.code(201);
    return { id };
  });

  // Feed: active statuses from others that I am allowed to see, grouped by author, with whether I viewed each.
  app.get('/api/status', { preHandler: authenticateVerified }, async (req) => {
    const me = req.auth.userId;
    const { rows } = await q(
      `select s.id, s.user_id, s.kind, s.body, s.caption, s.background, s.font, s.media_id, s.audio_media_id, s.audio_title, s.audio_url, s.audio_art, s.audio_credit, s.allow_sharing, s.created_at, s.expires_at, u.username, p.display_name, p.avatar_media_id,
              v.viewed_at is not null viewed, v.reaction, exists(select 1 from status_mutes sm where sm.user_id = $1 and sm.muted_id = s.user_id) muted
         from status_updates s join users u on u.id = s.user_id and u.status = 'active' join user_profiles p on p.user_id = s.user_id
         left join status_views v on v.status_id = s.id and v.viewer_id = $1
        where s.user_id <> $1 and ${VISIBLE} order by s.created_at asc limit 500`, [me]);
    const groups = new Map<string, any>();
    for (const r of rows) {
      let g = groups.get(r.user_id);
      if (!g) groups.set(r.user_id, (g = { userId: r.user_id, username: r.username, displayName: r.display_name, avatarMediaId: r.avatar_media_id, muted: r.muted, allViewed: true, latestAt: r.created_at, items: [] }));
      g.items.push({ id: r.id, kind: r.kind, body: r.body, caption: r.caption, background: r.background, font: r.font, mediaId: r.media_id, audioMediaId: r.audio_media_id, audioTitle: r.audio_title, audioUrl: r.audio_url, audioArt: r.audio_art, audioCredit: r.audio_credit, createdAt: r.created_at, expiresAt: r.expires_at, viewed: r.viewed, reaction: r.reaction, allowSharing: r.allow_sharing });
      if (!r.viewed) g.allViewed = false;
      g.latestAt = r.created_at;
    }
    const list = [...groups.values()].sort((a, b) => (a.allViewed === b.allViewed ? +new Date(b.latestAt) - +new Date(a.latestAt) : a.allViewed ? 1 : -1));
    return { feed: list };
  });

  app.get('/api/status/mine', { preHandler: authenticateVerified }, async (req) => {
    const { rows } = await q(
      `select s.id, s.kind, s.body, s.caption, s.background, s.font, s.media_id, s.audio_media_id, s.audio_title, s.audio_url, s.audio_art, s.audio_credit, s.created_at, s.expires_at, s.audience,
              coalesce((select json_agg(json_build_object('userId', v.viewer_id, 'displayName', p.display_name, 'viewedAt', v.viewed_at, 'reaction', v.reaction) order by v.viewed_at desc)
                          from status_views v join user_profiles p on p.user_id = v.viewer_id where v.status_id = s.id), '[]') viewers
         from status_updates s where s.user_id = $1 and s.expires_at > now() order by s.created_at asc`, [req.auth.userId]);
    return { items: rows.map((r) => ({ id: r.id, kind: r.kind, body: r.body, caption: r.caption, background: r.background, font: r.font, mediaId: r.media_id, audioMediaId: r.audio_media_id, audioTitle: r.audio_title, audioUrl: r.audio_url, audioArt: r.audio_art, audioCredit: r.audio_credit, createdAt: r.created_at, expiresAt: r.expires_at, audience: r.audience, viewers: r.viewers })) };
  });

  app.post('/api/status/:id/view', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const me = req.auth.userId;
    await tx(async (t) => {
      const s = await t.one(`select s.id, s.user_id from status_updates s where s.id = $2 and ${VISIBLE}`, [me, id]);
      if (!s) throw notFound('status_not_found');
      if (s.user_id === me) return;
      const viewer = await t.one(`select settings from user_profiles where user_id = $1`, [me]);
      const ins = await t.one(`insert into status_views(status_id, viewer_id) values ($1,$2) on conflict do nothing returning viewed_at`, [id, me]);
      // Viewing receipts follow the viewer's "read receipts" privacy setting: when off, the owner never learns of the view.
      if (!ins) return;
      if (withDefaults(viewer.settings).privacy.readReceipts === false) await t.q(`update status_views set viewed_at = 'epoch' where status_id = $1 and viewer_id = $2`, [id, me]);
      else t.emit([s.user_id], 'status.viewed', { statusId: id, viewerId: me });
    });
    reply.code(204);
  });

  app.post('/api/status/:id/react', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { emoji } = parse(z.object({ emoji: z.string().min(1).max(16) }), req.body);
    const me = req.auth.userId;
    await tx(async (t) => {
      const s = await t.one(`select s.id, s.user_id from status_updates s where s.id = $2 and ${VISIBLE}`, [me, id]);
      if (!s || s.user_id === me) throw notFound('status_not_found');
      await t.q(`insert into status_views(status_id, viewer_id, reaction) values ($1,$2,$3) on conflict (status_id, viewer_id) do update set reaction = excluded.reaction`, [id, me, emoji]);
      t.emit([s.user_id], 'status.reaction', { statusId: id, viewerId: me, emoji });
    });
    reply.code(204);
  });

  // Replying to a status opens (or reuses) the direct chat and posts a quoted message.
  app.post('/api/status/:id/reply', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { body } = parse(z.object({ body: z.string().min(1).max(2000) }), req.body);
    const me = req.auth.userId;
    return tx(async (t) => {
      const s = await t.one(`select s.id, s.user_id, s.kind, s.body, s.caption, s.media_id from status_updates s where s.id = $2 and ${VISIBLE}`, [me, id]);
      if (!s || s.user_id === me) throw notFound('status_not_found');
      const key = [me, s.user_id].sort().join(':');
      let conv = await t.one(`select id from conversations where direct_key = $1`, [key]);
      if (!conv) {
        conv = await t.one(`insert into conversations(kind, direct_key, created_by) values ('direct',$1,$2) returning id`, [key, me]);
        await t.q(`insert into conversation_members(conversation_id, user_id) values ($1,$2),($1,$3)`, [conv.id, me, s.user_id]);
      }
      const quote = s.kind === 'text' ? s.body : s.caption || (s.kind === 'image' ? 'Photo' : s.kind === 'voice' ? 'Voice status' : 'Video');
      const r = await sendMessage(t, { conversationId: conv.id, senderId: me, deviceId: req.auth.deviceId, clientMsgId: `status-${randomUUID()}`, kind: 'text', body, meta: { statusReply: { ownerId: s.user_id, kind: s.kind, text: quote.slice(0, 80), mediaId: s.media_id ?? null } } });
      return { conversationId: conv.id, message: r.message };
    });
  });

  // Forward someone's status into chats. Allowed only when its owner left "Allow sharing" on; the viewer must be able to see it.
  app.post('/api/status/:id/forward', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { conversationIds } = parse(z.object({ conversationIds: z.array(uuid).min(1).max(10) }), req.body);
    const me = req.auth.userId;
    await rateLimit(`forward:${me}`, 30, 60);
    const out: unknown[] = [];
    for (const target of conversationIds) {
      const r = await tx(async (t) => {
        const s = await t.one(`select s.* from status_updates s where s.id = $2 and ${VISIBLE}`, [me, id]);
        if (!s) throw notFound('status_not_found');
        if (s.user_id !== me && !s.allow_sharing) throw forbidden('sharing_disabled', 'This person turned off sharing for their status');
        const text = s.kind === 'text' ? s.body : s.caption;
        return sendMessage(t, { conversationId: target, senderId: me, deviceId: req.auth.deviceId, clientMsgId: `stfwd-${randomUUID()}`, kind: s.kind === 'text' ? 'text' : s.kind, body: text, mediaId: s.media_id, forwarded: true, trustedMedia: true });
      });
      out.push(r.message);
    }
    return { messages: out };
  });

  app.put('/api/status/mute/:userId', { preHandler: authenticateVerified }, async (req, reply) => {
    const { userId } = parse(z.object({ userId: uuid }), req.params);
    const { muted } = parse(z.object({ muted: z.boolean() }), req.body);
    if (muted) await q(`insert into status_mutes(user_id, muted_id) values ($1,$2) on conflict do nothing`, [req.auth.userId, userId]);
    else await q(`delete from status_mutes where user_id = $1 and muted_id = $2`, [req.auth.userId, userId]);
    reply.code(204);
  });

  app.delete('/api/status/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const s = await one(`delete from status_updates where id = $1 and user_id = $2 returning media_id`, [id, req.auth.userId]);
    if (!s) throw notFound('status_not_found');
    if (s.media_id) await removeMediaIfUnreferenced(s.media_id);
    reply.code(204);
  });
}

/** Background cleanup: drop expired statuses and their media. Reads already hide them the instant they expire. */
export async function purgeExpiredStatuses() {
  const { rows } = await q(`delete from status_updates where expires_at < now() returning media_id`);
  for (const r of rows) if (r.media_id) await removeMediaIfUnreferenced(r.media_id);
  return rows.length;
}
