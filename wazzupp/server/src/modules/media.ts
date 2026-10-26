import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { z } from 'zod';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { one, q } from '../db/pool.ts';
import { authenticate, authenticateVerified, parse } from '../lib/http.ts';
import { badRequest, forbidden, notFound, HttpError } from '../lib/errors.ts';
import { signMediaUrl, storage, verifyMediaSig } from '../lib/storage.ts';
import { config } from '../config.ts';
import { rateLimit } from '../lib/ratelimit.ts';

// Allowed content by logical kind. Types are determined by sniffing bytes, never by client-supplied mime/extension.
const IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const AUDIO = new Set(['audio/mpeg', 'audio/ogg', 'audio/opus', 'audio/flac', 'audio/x-flac', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/aac', 'video/webm', 'audio/x-wav']);
const DOC = new Set(['application/pdf', 'application/zip', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint', 'application/x-cfb', 'text/plain', 'text/csv']);
const DANGEROUS_EXT = /\.(exe|bat|cmd|com|scr|msi|js|jse|vbs|ps1|sh|jar|apk|dll|html?|svg|hta|lnk)$/i;

export interface ScanHook { (buf: Buffer, name: string): Promise<'clean' | 'infected' | 'unscanned'> }
let scanner: ScanHook = async () => 'unscanned';
/** Plug a ClamAV (clamd) or cloud scanner here. Until one is configured assets stay `unscanned` and the UI must not claim a scan happened. */
export function setScanner(s: ScanHook) { scanner = s; }

async function readLimited(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of stream) {
    n += c.length;
    if (n > limit) throw new HttpError(413, 'file_too_large', `File exceeds ${Math.round(limit / 1048576)} MB`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function classify(kind: string, mime: string, name: string): string | null {
  if (kind === 'sticker' || kind === 'avatar') return IMAGE.has(mime) ? 'image' : null;
  if (kind === 'image') return IMAGE.has(mime) ? 'image' : null;
  if (kind === 'video') return VIDEO.has(mime) ? 'video' : null;
  if (kind === 'voice') return AUDIO.has(mime) ? 'voice' : null;
  if (kind === 'audio') return AUDIO.has(mime) ? 'audio' : null;
  if (kind === 'document') return DOC.has(mime) && !DANGEROUS_EXT.test(name) ? 'document' : null;
  return null;
}

export async function removeMediaIfUnreferenced(mediaId: string) {
  const ref = await one(`select (select count(*) from messages where media_id = $1 and deleted_for_all_at is null)::int
      + (select count(*) from status_updates where media_id = $1)::int + (select count(*) from user_profiles where avatar_media_id = $1)::int
      + (select count(*) from conversations where avatar_media_id = $1)::int n`, [mediaId]);
  if (ref.n > 0) return;
  const a = await one(`update media_assets set deleted_at = now() where id = $1 and deleted_at is null returning storage_key, thumb_key`, [mediaId]);
  if (a) { await storage.remove(a.storage_key); if (a.thumb_key) await storage.remove(a.thumb_key); }
}

/** Can `userId` read this asset? Owner, a member of a conversation that has a message using it, a viewer of a visible status, or anyone for visible avatars. */
export async function canAccessMedia(mediaId: string, userId: string): Promise<boolean> {
  const r = await one(
    `select exists(select 1 from media_assets a where a.id = $1 and a.owner_id = $2)
         or exists(select 1 from messages m join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = $2 and cm.left_at is null and not cm.removed
                    where m.media_id = $1 and m.deleted_for_all_at is null and m.seq > cm.first_visible_seq and (not m.undelivered or m.sender_id = $2))
         or exists(select 1 from status_updates s where s.media_id = $1 and s.expires_at > now() and (s.user_id = $2 or (
              not exists(select 1 from blocks b where b.blocker_id = s.user_id and b.blocked_id = $2) and (
                (s.audience = 'contacts' and exists(select 1 from contacts c where c.owner_id = s.user_id and c.contact_id = $2))
             or (s.audience = 'except' and exists(select 1 from contacts c where c.owner_id = s.user_id and c.contact_id = $2) and $2 <> all(s.audience_ids))
             or (s.audience = 'only' and $2 = any(s.audience_ids))))))
         or exists(select 1 from user_profiles p where p.avatar_media_id = $1 and not exists(select 1 from blocks b where b.blocker_id = p.user_id and b.blocked_id = $2))
         or exists(select 1 from conversations c join conversation_members cm on cm.conversation_id = c.id and cm.user_id = $2 and cm.left_at is null and not cm.removed where c.avatar_media_id = $1)
         or exists(select 1 from conversations c where c.avatar_media_id = $1 and c.is_public)
         or exists(select 1 from communities c where c.avatar_media_id = $1 and (c.visibility = 'public' or exists(select 1 from community_members cm where cm.community_id = c.id and cm.user_id = $2))) ok`,
    [mediaId, userId]);
  return !!r?.ok;
}

export async function mediaRoutes(app: FastifyInstance) {
  app.post('/api/media', { preHandler: authenticateVerified }, async (req, reply) => {
    await rateLimit(`upload:${req.auth.userId}`, 60, 600);
    if (!req.isMultipart()) throw badRequest('multipart_required');
    const used = await one(`select coalesce(sum(size),0)::bigint n from media_assets where owner_id = $1 and deleted_at is null`, [req.auth.userId]);
    const part = await req.file({ limits: { fileSize: Math.max(...Object.values(config.maxUploadBytes)) + 1, files: 1, fields: 8 } });
    if (!part) throw badRequest('file_required');
    const fields = part.fields as Record<string, any>;
    const kindField = parse(z.enum(['image', 'video', 'voice', 'audio', 'document', 'sticker', 'avatar']), fields.kind?.value ?? 'document');
    const limit = config.maxUploadBytes[kindField];
    const buf = await readLimited(part.file, limit);
    if (part.file.truncated) throw new HttpError(413, 'file_too_large');
    if (!buf.length) throw badRequest('empty_file');
    if (used.n + buf.length > config.storageQuotaBytes) throw new HttpError(413, 'quota_exceeded', 'Storage quota exceeded');

    // eslint-disable-next-line no-control-regex
    const name = (part.filename || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200);
    const sniff = await fileTypeFromBuffer(buf);
    let mime = (sniff?.mime ?? '').split(';')[0].trim();
    if (!mime && kindField === 'document' && !buf.subarray(0, 4096).includes(0)) mime = 'text/plain'; // plain text has no magic bytes
    if (mime === 'video/webm' && (kindField === 'voice' || kindField === 'audio')) mime = 'audio/webm';
    if (mime === 'video/mp4' && (kindField === 'voice' || kindField === 'audio') && /\.(m4a|aac)$/i.test(name)) mime = 'audio/mp4';
    const logical = classify(kindField, mime, name);
    if (!logical) throw new HttpError(415, 'unsupported_type', `File type ${mime || 'unknown'} is not allowed for ${kindField}`);

    const id = randomUUID();
    const key = `${req.auth.userId.slice(0, 2)}/${req.auth.userId}/${id}`;
    let width: number | null = null, height: number | null = null, thumbKey: string | null = null;
    let payload = buf; const finalMime = mime;
    if (IMAGE.has(mime)) {
      try {
        const img = sharp(buf, { limitInputPixels: 80_000_000, animated: false });
        const meta = await img.metadata();
        width = meta.width ?? null; height = meta.height ?? null;
        // Re-encode raster images: strips EXIF/GPS metadata and any embedded payloads.
        if (mime !== 'image/gif') payload = await sharp(buf, { limitInputPixels: 80_000_000 }).rotate().toBuffer();
        const th = await sharp(buf, { limitInputPixels: 80_000_000 }).rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
        thumbKey = key + '.thumb'; await storage.put(thumbKey, th);
        if (mime !== 'image/gif') { const m2 = await sharp(payload).metadata(); width = m2.width ?? width; height = m2.height ?? height; }
      } catch { throw new HttpError(415, 'invalid_image', 'Image could not be processed'); }
    }
    const scan = await scanner(buf, name);
    if (scan === 'infected') throw new HttpError(422, 'malware_detected', 'File rejected by malware scan');
    await storage.put(key, payload);
    const sha = createHash('sha256').update(payload).digest('hex');
    const dur = fields.durationMs?.value ? Math.min(Number(fields.durationMs.value) || 0, 6 * 3600_000) : null;
    let waveform: number[] | null = null;
    try { const w = JSON.parse(fields.waveform?.value ?? 'null'); if (Array.isArray(w) && w.length <= 128 && w.every((x) => typeof x === 'number' && x >= 0 && x <= 1)) waveform = w; } catch { /* ignore */ }
    await q(
      `insert into media_assets(id, owner_id, kind, mime, size, sha256, original_name, storage_key, thumb_key, width, height, duration_ms, waveform, scan_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, req.auth.userId, logical === 'image' && kindField === 'sticker' ? 'sticker' : kindField === 'avatar' ? 'avatar' : logical, finalMime, payload.length, sha, name, key, thumbKey, width, height, dur, waveform ? JSON.stringify(waveform) : null, scan]);
    reply.code(201);
    return { media: { id, kind: logical, mime: finalMime, size: payload.length, name, width, height, durationMs: dur, waveform, hasThumb: !!thumbKey, scanStatus: scan } };
  });

  // Batch: signed, short-lived URLs for assets the caller may access. Unauthorized ids are silently omitted.
  app.post('/api/media/urls', { preHandler: authenticate }, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }), req.body);
    const out: Record<string, { url: string; thumbUrl: string | null; expiresAt: number }> = {};
    const rows = await q(`select id, thumb_key is not null has_thumb from media_assets where id = any($1::uuid[]) and deleted_at is null`, [ids]);
    for (const r of rows.rows) {
      if (!(await canAccessMedia(r.id, req.auth.userId))) continue;
      const u = signMediaUrl(r.id, req.auth.userId);
      out[r.id] = { url: u.url, thumbUrl: r.has_thumb ? signMediaUrl(r.id, req.auth.userId, true).url : null, expiresAt: u.expiresAt };
    }
    return { urls: out };
  });

  // Authorization is the signature (bound to asset, user and expiry) plus a live access re-check, so revoked members lose access immediately.
  app.get('/api/media/:id/content', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const qs = parse(z.object({ u: z.string().uuid(), e: z.coerce.number(), t: z.coerce.number().int().min(0).max(1), s: z.string().max(100), dl: z.coerce.number().optional() }), req.query);
    if (!verifyMediaSig(id, qs.u, qs.e, qs.t, qs.s)) throw forbidden('invalid_signature');
    if (!(await canAccessMedia(id, qs.u))) throw notFound('media_not_found');
    const a = await one(`select mime, size, storage_key, thumb_key, original_name, kind from media_assets where id = $1 and deleted_at is null`, [id]);
    if (!a) throw notFound('media_not_found');
    const thumb = qs.t === 1 && a.thumb_key;
    const key = thumb ? a.thumb_key : a.storage_key;
    const mime = thumb ? 'image/webp' : a.mime;
    const total = await storage.size(key);
    reply.header('Cache-Control', 'private, max-age=300').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox").header('Accept-Ranges', 'bytes');
    const inline = IMAGE.has(mime) || VIDEO.has(mime) || mime.startsWith('audio/') || mime === 'application/pdf';
    reply.header('Content-Disposition', `${inline && !qs.dl ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.original_name ?? 'file')}`);
    reply.header('Content-Type', mime);
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : total - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : total - 1;
      start = Math.max(0, start); end = Math.min(end, total - 1);
      if (start > end) { reply.code(416).header('Content-Range', `bytes */${total}`); return reply.send(); }
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${total}`).header('Content-Length', end - start + 1);
      return reply.send(storage.open(key, { start, end }));
    }
    reply.header('Content-Length', total);
    return reply.send(storage.open(key));
  });

  app.delete('/api/media/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const a = await one(`select owner_id from media_assets where id = $1 and deleted_at is null`, [id]);
    if (!a || a.owner_id !== req.auth.userId) throw notFound('media_not_found');
    await removeMediaIfUnreferenced(id);
    reply.code(204);
  });

  app.get('/api/media', { preHandler: authenticate }, async (req) => {
    const qs = parse(z.object({ conversationId: z.string().uuid(), kind: z.enum(['image', 'video', 'document', 'audio', 'voice', 'links']).default('image'), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(60) }), req.query);
    const mem = await one(`select first_visible_seq from conversation_members where conversation_id = $1 and user_id = $2 and left_at is null and not removed`, [qs.conversationId, req.auth.userId]);
    if (!mem) throw notFound('conversation_not_found');
    if (qs.kind === 'links') {
      const { rows } = await q(`select m.id, m.seq, m.body, m.created_at from messages m where m.conversation_id = $1 and m.seq > $2 and m.deleted_for_all_at is null and (not m.undelivered or m.sender_id = $3) and m.body ~* 'https?://' ${qs.before ? 'and m.seq < $5' : ''} order by m.seq desc limit $4`, qs.before ? [qs.conversationId, mem.first_visible_seq, req.auth.userId, qs.limit, qs.before] : [qs.conversationId, mem.first_visible_seq, req.auth.userId, qs.limit]);
      return { items: rows.map((r) => ({ messageId: r.id, seq: r.seq, urls: (r.body.match(/https?:\/\/[^\s<>"']+/gi) ?? []).slice(0, 5), createdAt: r.created_at })) };
    }
    const kinds = qs.kind === 'audio' ? ['audio', 'voice'] : [qs.kind];
    const { rows } = await q(
      `select m.id message_id, m.seq, m.created_at, a.id, a.kind, a.mime, a.size, a.original_name, a.width, a.height, a.duration_ms, (a.thumb_key is not null) has_thumb
         from messages m join media_assets a on a.id = m.media_id and a.deleted_at is null
        where m.conversation_id = $1 and m.seq > $2 and m.kind = any($3::text[]) and m.deleted_for_all_at is null and (not m.undelivered or m.sender_id = $4) ${qs.before ? 'and m.seq < $6' : ''}
        order by m.seq desc limit $5`, qs.before ? [qs.conversationId, mem.first_visible_seq, kinds, req.auth.userId, qs.limit, qs.before] : [qs.conversationId, mem.first_visible_seq, kinds, req.auth.userId, qs.limit]);
    return { items: rows.map((r) => ({ messageId: r.message_id, seq: r.seq, createdAt: r.created_at, media: { id: r.id, kind: r.kind, mime: r.mime, size: r.size, name: r.original_name, width: r.width, height: r.height, durationMs: r.duration_ms, hasThumb: r.has_thumb } })) };
  });

  app.get('/api/storage/usage', { preHandler: authenticate }, async (req) => {
    const { rows } = await q(`select kind, count(*)::int count, coalesce(sum(size),0)::bigint bytes from media_assets where owner_id = $1 and deleted_at is null group by kind`, [req.auth.userId]);
    return { quotaBytes: config.storageQuotaBytes, usedBytes: rows.reduce((s, r) => s + Number(r.bytes), 0), byKind: rows };
  });
}
void Transform;
