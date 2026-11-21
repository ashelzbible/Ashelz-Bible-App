import { pullQuerySchema, pushRequestSchema, uuid } from '@fertility/sync-protocol';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, type ZodError } from 'zod';
import { authenticate, isAllowed, registerAuth, sendForbidden, sendUnauthorized, type PolicyAction } from './auth.js';
import type { Config } from './config.js';
import { hashIp, pseudonymize } from './crypto.js';
import type { IdentityService } from './identity-service.js';
import { PASSWORD_MAX, PASSWORD_MIN } from './password.js';
import type { PhiStore } from './store.js';
import type { AccessContext, Actor } from './types.js';

export interface AppDeps {
  config: Config;
  store: PhiStore;
  /** Enables /api/v1/auth/* when provided. */
  identity?: IdentityService;
  logger?: FastifyBaseLogger | boolean;
}

/** Report which fields failed and why, never the submitted values (they may be PHI). */
function issues(err: ZodError): Array<{ path: string; code: string }> {
  return err.issues.map((i) => ({ path: i.path.join('.'), code: i.code }));
}

export async function buildApp({ config, store, identity, logger = false }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      logger === true
        ? {
            level: 'info',
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            // Log the path only: query strings can carry patient identifiers.
            serializers: { req: (r: FastifyRequest) => ({ method: r.method, url: r.url.split('?')[0], id: r.id }) },
          }
        : logger,
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'frame-ancestors': ["'none'"],
        // Only force https for subresources in production; plain-http local development must keep working.
        'upgrade-insecure-requests': config.nodeEnv === 'production' ? [] : null,
      },
    },
  });
  await app.register(rateLimit, {
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    // Limit the API, not the static app files (a single page load fetches ~15 of them).
    allowList: (req) => !(req.url.startsWith('/api/') || req.url === '/readyz'),
  });
  await registerAuth(app, config);

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err: err.name }, 'unhandled error'); // no message: could contain PHI
    void reply.code(status).send(status === 500 ? { error: 'internal_error', request_id: req.id } : { error: status === 429 ? 'rate_limited' : 'bad_request' });
  });

  const ctxFor = (req: FastifyRequest, actor: Actor): AccessContext => ({
    actor,
    meta: { ipHash: req.ip ? hashIp(req.ip, config.ipHashKey) : null, requestId: req.id },
  });

  /** Authenticate, then authorise against the RBAC matrix. Denials are audited. */
  async function guard(req: FastifyRequest, reply: FastifyReply, action: PolicyAction, resource: string, subject: string | null = null): Promise<AccessContext | null> {
    const actor = await authenticate(req);
    if (!actor) {
      sendUnauthorized(reply);
      return null;
    }
    const ctx = ctxFor(req, actor);
    if (!isAllowed(actor.role, action)) {
      await store.recordDenied(ctx, action, resource, subject);
      sendForbidden(reply);
      return null;
    }
    return ctx;
  }

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await store.ping();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  // ---- Auth: register and sign in (only when an identity service is configured) -------
  if (identity) {
    const email = z.string().trim().email().max(254);
    const password = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);
    const registerSchema = z.object({ email, password, full_name: z.string().trim().min(1).max(120) }).strict();
    const loginSchema = z.object({ email, password: z.string().min(1).max(PASSWORD_MAX) }).strict();
    // Credential endpoints get a much tighter limit than the rest of the API.
    const authLimit = { config: { rateLimit: { max: Math.min(10, config.rateLimitPerMinute), timeWindow: '1 minute' } } };

    const session = (userId: string, role: string) => ({
      token: app.jwt.sign({ sub: userId, role } as never, { iss: config.jwtIssuer, aud: config.jwtAudience, expiresIn: config.tokenTtl } as never),
      user_id: userId,
      role,
      expires_in: config.tokenTtl,
    });

    app.post('/api/v1/auth/register', authLimit, async (req, reply) => {
      const body = registerSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'validation_failed', issues: issues(body.error) });
      const res = await identity.register(body.data.email, body.data.password, body.data.full_name);
      if (res === 'exists') return reply.code(409).send({ error: 'account_exists' });
      return reply.code(201).send(session(res.userId, 'patient'));
    });

    app.post('/api/v1/auth/login', authLimit, async (req, reply) => {
      const body = loginSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'validation_failed', issues: issues(body.error) });
      const user = await identity.authenticate(body.data.email, body.data.password);
      if (!user) return reply.code(401).send({ error: 'invalid_credentials' }); // same answer for unknown e-mail and wrong password
      return session(user.userId, user.role);
    });
  }

  // ---- POST /api/v1/sync/push -------------------------------------------------
  app.post('/api/v1/sync/push', async (req, reply) => {
    const ctx = await guard(req, reply, 'sync.push', 'biomarker_events');
    if (!ctx) return reply;
    const body = pushRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation_failed', issues: issues(body.error) });
    const subject = pseudonymize(ctx.actor.id, config.pseudonymKey);
    return store.pushEvents(ctx, subject, body.data.events);
  });

  // ---- GET /api/v1/sync/pull --------------------------------------------------
  app.get('/api/v1/sync/pull', async (req, reply) => {
    const ctx = await guard(req, reply, 'sync.pull', 'biomarker_events');
    if (!ctx) return reply;
    const q = pullQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'validation_failed', issues: issues(q.error) });

    let patientUserId: string;
    if (ctx.actor.role === 'patient') {
      const asked = q.data.patient_id?.toLowerCase();
      if (asked !== undefined && asked !== ctx.actor.id) {
        await store.recordDenied(ctx, 'sync.pull', 'biomarker_events', pseudonymize(asked, config.pseudonymKey));
        return sendForbidden(reply);
      }
      patientUserId = ctx.actor.id;
    } else {
      if (!q.data.patient_id) return reply.code(400).send({ error: 'validation_failed', issues: [{ path: 'patient_id', code: 'required' }] });
      patientUserId = q.data.patient_id.toLowerCase();
    }

    const result = await store.pullEvents(ctx, pseudonymize(patientUserId, config.pseudonymKey), q.data.cursor, q.data.limit);
    if (!result) return sendForbidden(reply); // clinician without active consent (already audited)
    return result;
  });

  // ---- Consent: a patient grants/revokes a clinician's read access --------------
  app.post('/api/v1/consents', async (req, reply) => {
    const ctx = await guard(req, reply, 'consent.grant', 'care_relationships');
    if (!ctx) return reply;
    const id = uuid.safeParse((req.body as { clinician_id?: unknown } | null)?.clinician_id);
    if (!id.success) return reply.code(400).send({ error: 'validation_failed', issues: [{ path: 'clinician_id', code: 'invalid_string' }] });
    const result = await store.grantConsent(ctx, pseudonymize(ctx.actor.id, config.pseudonymKey), id.data.toLowerCase());
    return reply.code(result === 'granted' ? 201 : 200).send({ status: result });
  });

  app.delete('/api/v1/consents/:clinicianId', async (req, reply) => {
    const ctx = await guard(req, reply, 'consent.revoke', 'care_relationships');
    if (!ctx) return reply;
    const id = uuid.safeParse((req.params as { clinicianId: string }).clinicianId);
    if (!id.success) return reply.code(400).send({ error: 'validation_failed', issues: [{ path: 'clinicianId', code: 'invalid_string' }] });
    const result = await store.revokeConsent(ctx, pseudonymize(ctx.actor.id, config.pseudonymKey), id.data.toLowerCase());
    return result === 'revoked' ? { status: 'revoked' } : reply.code(404).send({ error: 'not_found' });
  });

  // ---- Installable web app (static files) ------------------------------------------------
  if (config.pwaDir) {
    await app.register(fastifyStatic, {
      root: config.pwaDir,
      prefix: '/',
      index: 'index.html',
      // Always revalidate (ETag makes that cheap) so a new deploy of the app shell and
      // service worker is picked up straight away.
      cacheControl: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    });
  }

  return app;
}
