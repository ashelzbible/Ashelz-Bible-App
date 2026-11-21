import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Actor, Role } from './types.js';

const claims = z.object({ sub: z.string().uuid(), role: z.enum(['patient', 'clinician', 'admin']) });

/**
 * Register HS256 JWT verification. Tokens must carry exp, iss and aud; tokens
 * are issued by the identity service, not by this gateway.
 */
export async function registerAuth(app: FastifyInstance, cfg: Config): Promise<void> {
  await app.register(fastifyJwt, {
    secret: cfg.jwtSecret,
    verify: {
      algorithms: ['HS256'],
      allowedIss: cfg.jwtIssuer,
      allowedAud: cfg.jwtAudience,
      requiredClaims: ['exp'],
    },
  });
}

/** Verify the bearer token and return the actor, or null if absent/invalid. */
export async function authenticate(req: FastifyRequest): Promise<Actor | null> {
  try {
    await req.jwtVerify();
  } catch {
    return null;
  }
  const parsed = claims.safeParse(req.user);
  if (!parsed.success) return null;
  return { id: parsed.data.sub.toLowerCase(), role: parsed.data.role as Role };
}

export function sendUnauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
}

export function sendForbidden(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: 'forbidden' });
}

/** The RBAC matrix, in one place. */
export const POLICY = {
  'sync.push': ['patient'],
  'sync.pull': ['patient', 'clinician'],
  'consent.grant': ['patient'],
  'consent.revoke': ['patient'],
} as const satisfies Record<string, readonly Role[]>;

export type PolicyAction = keyof typeof POLICY;

export function isAllowed(role: Role, action: PolicyAction): boolean {
  return (POLICY[action] as readonly Role[]).includes(role);
}
