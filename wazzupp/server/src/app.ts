import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.ts';
import { one } from './db/pool.ts';
import { HttpError } from './lib/errors.ts';
import { rateLimit } from './lib/ratelimit.ts';
import { authRoutes } from './modules/auth.ts';
import { userRoutes } from './modules/users.ts';
import { conversationRoutes } from './modules/conversations.ts';
import { messageRoutes } from './modules/messages.ts';
import { mediaRoutes } from './modules/media.ts';
import { statusRoutes } from './modules/status.ts';
import { callRoutes } from './modules/calls.ts';
import { searchRoutes } from './modules/search.ts';
import { communityRoutes } from './modules/communities.ts';
import { adminRoutes } from './modules/admin.ts';
import { keyRoutes } from './modules/keys.ts';
import { jobRoutes } from './modules/jobs.ts';
import { aiRoutes } from './modules/ai.ts';
import { gifRoutes } from './modules/gifs.ts';
import { musicRoutes } from './modules/music.ts';
import { hub } from './lib/hub.ts';

const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isTest ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'], serializers: { req: (r) => ({ method: r.method, url: String(r.url).split('?')[0], id: r.id }) } },
    trustProxy: process.env.TRUST_PROXY === 'true',
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", ...(config.googleClientId ? ['https://accounts.google.com/gsi/client'] : [])], styleSrc: ["'self'", "'unsafe-inline'", ...(config.googleClientId ? ['https://accounts.google.com/gsi/style'] : [])], frameSrc: config.googleClientId ? ["'self'", 'https://accounts.google.com/gsi/'] : ["'none'"], imgSrc: ["'self'", 'data:', 'blob:', ...(config.jamendoClientId ? ['https://*.jamendo.com'] : []), ...(config.tenorApiKey ? ['https://media.tenor.com', 'https://c.tenor.com'] : [])], mediaSrc: ["'self'", 'blob:', ...(config.jamendoClientId ? ['https://*.jamendo.com'] : [])], connectSrc: ["'self'", 'ws:', 'wss:', ...(config.googleClientId ? ['https://accounts.google.com/gsi/'] : [])], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(cors, { origin: config.corsOrigins.length ? config.corsOrigins : false, credentials: false });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 ** 2 + 1, files: 1 } });

  // Coarse per-IP limit on every API call; sensitive routes add their own tighter limits.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      await rateLimit(`api:${req.ip}`, 1200, 60);
      reply.header('Cache-Control', 'no-store');
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }, requestId: req.id });
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'validation_failed', message: err.issues.map((i) => i.message).join('; ') } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    if (process.env.TEST_DEBUG) console.error(err);
    req.log.error({ err: { message: err.message, stack: err.stack, code: err.code } }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' }, requestId: req.id });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try { await one('select 1 ok'); return { ok: true, db: 'up', redis: hub.redis ? ((await hub.redis.ping().catch(() => null)) === 'PONG' ? 'up' : 'down') : 'not_configured' }; }
    catch { return reply.code(503).send({ ok: false, db: 'down' }); }
  });

  for (const r of [authRoutes, userRoutes, conversationRoutes, messageRoutes, mediaRoutes, statusRoutes, callRoutes, searchRoutes, communityRoutes, adminRoutes, keyRoutes, jobRoutes, aiRoutes, gifRoutes, musicRoutes]) await app.register(r);

  app.all('/api/*', async (_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint' } }));

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, setHeaders: (res, p) => { if (p.endsWith('index.html') || p.endsWith('sw.js')) res.header('Cache-Control', 'no-cache'); } });
    app.setNotFoundHandler((req, reply) => (req.method === 'GET' && !req.url.startsWith('/api/') ? reply.type('text/html').sendFile('index.html') : reply.code(404).send({ error: { code: 'not_found' } })));
  }
  return app;
}
