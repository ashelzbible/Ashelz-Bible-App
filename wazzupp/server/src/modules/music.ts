import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { removeMediaIfUnreferenced } from './media.ts';

const uuid = z.string().uuid();
const MOODS = ['Happy', 'Sad', 'Romantic', 'Calm', 'Energetic', 'Worship', 'Focus', 'Party'];
const GENRES = ['Pop', 'Hip-Hop/Rap', 'Soul/R&B', 'Gospel', 'Rock', 'Afro', 'Dance', 'Classical', 'Jazz', 'Other'];

/**
 * A personal music library for status updates. Wazzupp has no licensed catalogue, so people add their own audio files
 * (that they have the right to use) and tag them with a mood and genre; those tags drive the Mood and Genre tabs.
 */
export async function musicRoutes(app: FastifyInstance) {
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
    const r = await one(`insert into music_tracks(user_id, media_id, title, artist, mood, genre, duration_ms) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [req.auth.userId, b.mediaId, b.title, b.artist, b.mood, b.genre, a.duration_ms]);
    reply.code(201); return { id: r.id };
  });
  app.patch('/api/music/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ starred: z.boolean().optional(), title: z.string().trim().min(1).max(120).optional(), artist: z.string().trim().max(120).optional(), mood: z.string().trim().max(40).optional(), genre: z.string().trim().max(40).optional() }), req.body);
    const r = await one(`update music_tracks set starred = coalesce($3, starred), title = coalesce($4, title), artist = coalesce($5, artist), mood = coalesce($6, mood), genre = coalesce($7, genre) where id = $1 and user_id = $2 returning id`,
      [id, req.auth.userId, b.starred ?? null, b.title ?? null, b.artist ?? null, b.mood ?? null, b.genre ?? null]);
    if (!r) throw notFound('track_not_found'); reply.code(204);
  });
  app.delete('/api/music/:id', { preHandler: authenticateVerified }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await one(`delete from music_tracks where id = $1 and user_id = $2 returning media_id`, [id, req.auth.userId]);
    if (!r) throw notFound('track_not_found');
    await removeMediaIfUnreferenced(r.media_id); reply.code(204);
  });
}
