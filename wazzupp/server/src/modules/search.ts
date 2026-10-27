import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { rateLimit } from '../lib/ratelimit.ts';
import { fetchPreview } from '../lib/ssrf.ts';
import { badRequest } from '../lib/errors.ts';
import { MESSAGE_COLS, MESSAGE_JOINS, toMessage } from '../lib/conv.ts';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export async function searchRoutes(app: FastifyInstance) {
  app.get('/api/search', { preHandler: authenticateVerified }, async (req) => {
    const b = parse(z.object({
      q: z.string().trim().min(2).max(100), type: z.enum(['all', 'messages', 'chats', 'media']).default('all'), conversationId: z.string().uuid().optional(),
      kind: z.enum(['text', 'image', 'video', 'document', 'audio', 'voice', 'link']).optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
    }), req.query);
    const me = req.auth.userId;
    await rateLimit(`search:${me}`, 60, 60);
    const like = `%${escapeLike(b.q)}%`;
    const out: Record<string, unknown> = {};
    if (b.type === 'all' || b.type === 'chats') {
      out.chats = (await q(
        `select c.id, c.kind, coalesce(c.title, op.display_name) title, c.avatar_media_id, case when c.kind = 'direct' then op.avatar_media_id end other_avatar, o.user_id other_id
           from conversation_members m join conversations c on c.id = m.conversation_id
           left join conversation_members o on o.conversation_id = c.id and c.kind = 'direct' and o.user_id <> $1
           left join user_profiles op on op.user_id = o.user_id
          where m.user_id = $1 and m.left_at is null and not m.removed and (c.title ilike $2 escape '\\' or op.display_name ilike $2 escape '\\')
          order by c.last_message_at desc nulls last limit $3`, [me, like, b.limit])).rows;
    }
    if (b.type === 'all' || b.type === 'messages' || b.type === 'media') {
      const params: unknown[] = [me, like, b.limit];
      let extra = '';
      if (b.conversationId) { params.push(b.conversationId); extra += ` and m.conversation_id = $${params.length}`; }
      if (b.type === 'media') extra += ` and m.media_id is not null`;
      if (b.kind === 'link') extra += ` and m.body ~* 'https?://'`;
      else if (b.kind) { params.push(b.kind); extra += ` and m.kind = $${params.length}`; }
      const { rows } = await q(
        `select ${MESSAGE_COLS} from messages m ${MESSAGE_JOINS}
           join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = $1 and cm.left_at is null and not cm.removed
          where m.body ilike $2 escape '\\' and m.seq > cm.first_visible_seq and m.deleted_for_all_at is null and m.kind <> 'system' and (not m.undelivered or m.sender_id = $1)
            and (m.expires_at is null or m.expires_at > now()) and not exists (select 1 from message_hidden h where h.message_id = m.id and h.user_id = $1) ${extra}
          order by m.created_at desc limit $3`, params);
      out.messages = rows.map(toMessage);
    }
    await q(`insert into recent_searches(user_id, term) values ($1,$2) on conflict (user_id, term) do update set created_at = now()`, [me, b.q.toLowerCase()]);
    await q(`delete from recent_searches where user_id = $1 and term not in (select term from recent_searches where user_id = $1 order by created_at desc limit 10)`, [me]);
    return out;
  });
  app.get('/api/search/recent', { preHandler: authenticateVerified }, async (req) => ({ terms: (await q(`select term from recent_searches where user_id = $1 order by created_at desc limit 10`, [req.auth.userId])).rows.map((r) => r.term) }));
  app.delete('/api/search/recent', { preHandler: authenticateVerified }, async (req, reply) => { await q(`delete from recent_searches where user_id = $1`, [req.auth.userId]); reply.code(204); });

  // Server-side fetch of untrusted URLs: SSRF-guarded (no private ranges, re-validated on every redirect), size and time limited.
  app.get('/api/link-preview', { preHandler: authenticateVerified }, async (req) => {
    const { url } = parse(z.object({ url: z.string().url().max(2000) }), req.query);
    await rateLimit(`preview:${req.auth.userId}`, 30, 60);
    try { return { preview: await fetchPreview(url) }; }
    catch { throw badRequest('preview_unavailable'); }
  });
}
