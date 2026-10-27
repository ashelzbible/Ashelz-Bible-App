import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateVerified, parse } from '../lib/http.ts';
import { HttpError } from '../lib/errors.ts';
import { rateLimit } from '../lib/ratelimit.ts';
import { config } from '../config.ts';

/**
 * GIF search through Tenor, proxied so the API key stays on the server and users' IPs are not sent to Tenor.
 * Off unless TENOR_API_KEY is set; the client then explains that and offers GIF upload instead. Only the search text is sent.
 */
export async function gifRoutes(app: FastifyInstance) {
  app.get('/api/gifs', { preHandler: authenticateVerified }, async (req) => {
    const q = parse(z.object({ q: z.string().max(80).default(''), pos: z.string().max(100).optional() }), req.query);
    if (!config.tenorApiKey) return { configured: false, results: [], next: null };
    await rateLimit(`gifs:${req.auth.userId}`, 60, 60);
    const u = new URL(`https://tenor.googleapis.com/v2/${q.q.trim() ? 'search' : 'featured'}`);
    u.search = new URLSearchParams({ key: config.tenorApiKey, client_key: 'wazzupp', limit: '24', media_filter: 'tinygif,gif', contentfilter: 'medium', ...(q.q.trim() ? { q: q.q.trim() } : {}), ...(q.pos ? { pos: q.pos } : {}) }).toString();
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new HttpError(502, 'gif_provider_failed', 'GIF search is unavailable right now');
    const j: any = await res.json();
    const results = (j.results ?? []).map((r: any) => ({ id: String(r.id), url: r.media_formats?.gif?.url, preview: r.media_formats?.tinygif?.url, width: r.media_formats?.tinygif?.dims?.[0] ?? 200, height: r.media_formats?.tinygif?.dims?.[1] ?? 200 }))
      .filter((r: any) => typeof r.url === 'string' && typeof r.preview === 'string' && /^https:\/\/(media|c)\.tenor\.com\//.test(r.url));
    return { configured: true, results, next: j.next || null };
  });
}
