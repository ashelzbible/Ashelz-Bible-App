import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { removeMediaIfUnreferenced } from './media.ts';
import { config } from '../config.ts';
import { rateLimit } from '../lib/ratelimit.ts';
import { HttpError } from '../lib/errors.ts';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { storage } from '../lib/storage.ts';
import { ALBUM_ROOT, analyse, cleanupAlbum, cutTrack, fileSize, ffmpegAvailable, saveUpload, sweepAlbums, trackStream, type AlbumInfo } from '../lib/album.ts';

interface AlbumJob { userId: string; file: string; info: AlbumInfo; at: number; state: 'ready' | 'splitting' | 'done' | 'failed'; done: number; total: number; error?: string }
const albums = new Map<string, AlbumJob>();
const ALBUM_MAX_BYTES = 300 * 1024 ** 2;

const uuid = z.string().uuid();
const MOODS = ['Happy', 'Sad', 'Romantic', 'Calm', 'Energetic', 'Worship', 'Focus', 'Party'];
const GENRES = ['Pop', 'Hip-Hop/Rap', 'Soul/R&B', 'Gospel', 'Rock', 'Afro', 'Dance', 'Classical', 'Jazz', 'Other'];

/**
 * A personal music library for status updates. Wazzupp has no licensed catalogue, so people add their own audio files
 * (that they have the right to use) and tag them with a mood and genre; those tags drive the Mood and Genre tabs.
 */
/** Hosts a catalogue track's audio and artwork may come from. Statuses only accept URLs on these. */
/** Songs shipped with the app (files in web/public/music). Only add music here that Wazzupp has the right to distribute. */
export const BUILTIN_TRACKS = [
  { id: 'wz-music-1', title: 'Music 1', artist: 'Wazzupp', album: '', artUrl: null as string | null, previewUrl: '/music/music-1.mp3', durationMs: 22750, license: null as string | null, shareUrl: null as string | null },
];
export const isBuiltinUrl = (u: string) => BUILTIN_TRACKS.some((t) => t.previewUrl === u);

export const CATALOG_HOST = /^https:\/\/([a-z0-9-]+\.)*jamendo\.com\//i;

const join2 = (file: string) => file.slice(0, file.lastIndexOf('/'));

export async function musicRoutes(app: FastifyInstance) {
  // ---- Album splitting: upload one long file, review the detected tracks, then cut them into separate songs ----
  app.post('/api/music/album', { preHandler: authenticateVerified }, async (req, reply) => {
    if (!(await ffmpegAvailable())) throw new HttpError(501, 'splitting_unavailable', 'Album splitting is not available on this server');
    await rateLimit(`album:${req.auth.userId}`, 6, 3600);
    if (!req.isMultipart()) throw badRequest('multipart_required');
    const part = await req.file({ limits: { fileSize: ALBUM_MAX_BYTES, files: 1 } });
    if (!part) throw badRequest('file_required');
    const id = randomUUID(); let file: string;
    try {
      file = await saveUpload(id, part.file);
      if (part.file.truncated) throw new HttpError(413, 'file_too_large', 'That file is over 300 MB. Split it into two parts first.');
      const name = (part.filename || 'Album').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 100) || 'Album';
      const info = await analyse(file, name);
      albums.set(id, { userId: req.auth.userId, file, info, at: Date.now(), state: 'ready', done: 0, total: 0 });
      reply.code(201);
      return { id, ...info };
    } catch (e: any) {
      await cleanupAlbum(id);
      if (e instanceof HttpError) throw e;
      if (e?.message === 'too_long') throw badRequest('too_long', 'That recording is longer than 4 hours');
      throw new HttpError(415, 'not_audio', 'That file could not be read as audio');
    }
  });

  app.get('/api/music/album/:id', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params); const a = albums.get(id);
    if (!a || a.userId !== req.auth.userId) throw notFound('album_not_found');
    return { state: a.state, done: a.done, total: a.total, error: a.error ?? null };
  });

  app.post('/api/music/album/:id/split', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params); const a = albums.get(id);
    if (!a || a.userId !== req.auth.userId) throw notFound('album_not_found', 'This upload expired. Add the album again.');
    if (a.state !== 'ready') throw badRequest('already_started');
    const b = parse(z.object({
      artist: z.string().trim().max(120).default(''), mood: z.string().trim().max(40).default(''), genre: z.string().trim().max(40).default(''),
      tracks: z.array(z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(1), title: z.string().trim().min(1).max(120) })).min(1).max(100),
    }), req.body);
    for (const t of b.tracks) if (t.endMs - t.startMs < 3000 || t.endMs > a.info.durationMs + 1000) throw badRequest('invalid_tracks', 'Each song must be at least 3 seconds and inside the recording');
    const have = await one(`select count(*)::int n from music_tracks where user_id = $1`, [req.auth.userId]);
    if (have.n + b.tracks.length > 300) throw badRequest('library_full', 'Your music library holds up to 300 songs');
    a.state = 'splitting'; a.total = b.tracks.length; a.done = 0; a.at = Date.now();
    void (async () => {
      try {
        const used = await one(`select coalesce(sum(size),0)::bigint n from media_assets where owner_id = $1 and deleted_at is null`, [a.userId]); let bytes = Number(used.n);
        for (const [i, t] of b.tracks.entries()) {
          const out = await cutTrack(a.file, a.info.codec, t, join2(a.file), i + 1);
          const size = await fileSize(out.path); bytes += size;
          if (bytes > config.storageQuotaBytes) throw new HttpError(413, 'quota_exceeded', 'Storage quota exceeded');
          const mediaId = randomUUID(); const key = `${a.userId.slice(0, 2)}/${a.userId}/${mediaId}`;
          const sha = createHash('sha256'); for await (const c of createReadStream(out.path)) sha.update(c);
          await storage.put(key, trackStream(out.path));
          await tx(async (tx2) => {
            await tx2.q(`insert into media_assets(id, owner_id, kind, mime, size, sha256, original_name, storage_key, duration_ms, scan_status) values ($1,$2,'audio',$3,$4,$5,$6,$7,$8,'clean')`,
              [mediaId, a.userId, out.mime, size, sha.digest('hex'), `${t.title}.${out.ext}`.slice(0, 200), key, t.endMs - t.startMs]);
            const x = await tx2.one(`insert into music_tracks(user_id, media_id, title, artist, mood, genre, duration_ms) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [a.userId, mediaId, t.title, b.artist, b.mood, b.genre, t.endMs - t.startMs]);
            tx2.emit([a.userId], 'music.changed', { id: x.id });
          });
          a.done = i + 1;
        }
        a.state = 'done';
      } catch (e: any) { a.state = 'failed'; a.error = e instanceof HttpError ? e.message : 'Splitting failed. Try a different file.'; console.error(JSON.stringify({ level: 'warn', msg: 'album split failed', err: String(e) })); }
      finally { await cleanupAlbum(id); setTimeout(() => albums.delete(id), 10 * 60_000).unref(); }
    })();
    reply.code(202);
    return { started: true, total: b.tracks.length };
  });
  setInterval(() => { void sweepAlbums(); for (const [k, v] of albums) if (v.state === 'ready' && Date.now() - v.at > 3600_000) { albums.delete(k); void cleanupAlbum(k); } }, 10 * 60_000).unref();
  void ALBUM_ROOT;

  // Search the licensed catalogue (Jamendo: Creative Commons music with a free API). The API key stays on the server.
  app.get('/api/music/catalog', { preHandler: authenticateVerified }, async (req) => {
    const f = parse(z.object({ q: z.string().trim().max(100).default('') }), req.query);
    const own = BUILTIN_TRACKS.filter((t) => !f.q || `${t.title} ${t.artist}`.toLowerCase().includes(f.q.toLowerCase()));
    if (!config.jamendoClientId) return { configured: own.length > 0 || BUILTIN_TRACKS.length > 0, results: own };
    await rateLimit(`catalog:${req.auth.userId}`, 60, 60);
    const u = new URL('https://api.jamendo.com/v3.0/tracks/');
    u.search = new URLSearchParams({ client_id: config.jamendoClientId, format: 'json', limit: '30', imagesize: '200', audioformat: 'mp32', ccnc: 'false', include: 'licenses',
      ...(f.q ? { search: f.q, order: 'relevance' } : { order: 'popularity_week' }) }).toString();
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!res || !res.ok) throw new HttpError(502, 'catalog_unavailable', 'The music catalogue is not reachable right now. Try again in a moment.');
    const j: any = await res.json();
    if (j.headers?.status && j.headers.status !== 'success') throw new HttpError(502, 'catalog_unavailable', 'The music catalogue is not reachable right now. Try again in a moment.');
    const results = (j.results ?? [])
      .filter((r: any) => typeof r.audio === 'string' && CATALOG_HOST.test(r.audio))
      .map((r: any) => ({ id: String(r.id), title: String(r.name), artist: String(r.artist_name), album: String(r.album_name ?? ''), artUrl: CATALOG_HOST.test(r.image ?? '') ? r.image : null,
        previewUrl: r.audio, durationMs: Math.round(Number(r.duration ?? 0) * 1000) || null, license: r.license_ccurl || null, shareUrl: r.shareurl || null }));
    return { configured: true, results: [...own, ...results] };
  });

  app.get('/api/music', { preHandler: authenticateVerified }, async (req) => {
    const f = parse(z.object({ q: z.string().max(100).default(''), tab: z.enum(['suggested', 'mood', 'genre', 'starred']).default('suggested') }), req.query);
    const term = `%${f.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const { rows } = await q(
      `select id, media_id, title, artist, mood, genre, starred, duration_ms, created_at from music_tracks
        where user_id = $1 and ($2 = '%%' or title ilike $2 or artist ilike $2 or mood ilike $2 or genre ilike $2) and ($3 <> 'starred' or starred)
        order by created_at desc limit 300`, [req.auth.userId, term, f.tab]);
    return { tracks: rows.map((r) => ({ id: r.id, mediaId: r.media_id, title: r.title, artist: r.artist, mood: r.mood, genre: r.genre, starred: r.starred, durationMs: r.duration_ms })), moods: MOODS, genres: GENRES };
  });
  app.post('/api/music', { preHandler: authenticateVerified }, async (req, reply) => {
    const b = parse(z.object({ mediaId: uuid, title: z.string().trim().min(1).max(120), artist: z.string().trim().max(120).default(''), mood: z.string().trim().max(40).default(''), genre: z.string().trim().max(40).default('') }), req.body);
    const a = await one(`select owner_id, kind, duration_ms from media_assets where id = $1 and deleted_at is null`, [b.mediaId]);
    if (!a || a.owner_id !== req.auth.userId || a.kind !== 'audio') throw badRequest('invalid_audio', 'Upload an audio file first');
    const n = await one(`select count(*)::int n from music_tracks where user_id = $1`, [req.auth.userId]);
    if (n.n >= 300) throw badRequest('library_full', 'Your music library is full. Remove a song first.');
    // Every change is announced to all of the person's devices, so their library stays in sync everywhere.
    const r = await tx(async (t) => { const x = await t.one(`insert into music_tracks(user_id, media_id, title, artist, mood, genre, duration_ms) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [req.auth.userId, b.mediaId, b.title, b.artist, b.mood, b.genre, a.duration_ms]); t.emit([req.auth.userId], 'music.changed', { id: x.id }); return x; });
    reply.code(201); return { id: r.id };
  });
  app.patch('/api/music/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ starred: z.boolean().optional(), title: z.string().trim().min(1).max(120).optional(), artist: z.string().trim().max(120).optional(), mood: z.string().trim().max(40).optional(), genre: z.string().trim().max(40).optional() }), req.body);
    const r = await tx(async (t) => { const x = await t.one(`update music_tracks set starred = coalesce($3, starred), title = coalesce($4, title), artist = coalesce($5, artist), mood = coalesce($6, mood), genre = coalesce($7, genre) where id = $1 and user_id = $2 returning id`,
      [id, req.auth.userId, b.starred ?? null, b.title ?? null, b.artist ?? null, b.mood ?? null, b.genre ?? null]); if (x) t.emit([req.auth.userId], 'music.changed', { id }); return x; });
    if (!r) throw notFound('track_not_found'); reply.code(204);
  });
  app.delete('/api/music/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await tx(async (t) => { const x = await t.one(`delete from music_tracks where id = $1 and user_id = $2 returning media_id`, [id, req.auth.userId]); if (x) t.emit([req.auth.userId], 'music.changed', { id }); return x; });
    if (!r) throw notFound('track_not_found');
    await removeMediaIfUnreferenced(r.media_id); reply.code(204);
  });
}
