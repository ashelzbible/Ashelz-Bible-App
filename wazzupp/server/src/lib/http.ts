import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { one } from '../db/pool.ts';
import { config } from '../config.ts';
import { badRequest, forbidden, unauthorized } from './errors.ts';
import { sha256 } from './crypto.ts';
import { q } from '../db/pool.ts';

export interface Auth { userId: string; sessionId: string; deviceId: string; role: 'user' | 'moderator' | 'admin'; verified: boolean; }
declare module 'fastify' { interface FastifyRequest { auth: Auth; } }

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('validation_failed', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export async function resolveToken(raw: string): Promise<Auth | null> {
  if (!raw || raw.length < 20 || raw.length > 200) return null;
  const row = await one<{ sid: string; uid: string; did: string; role: Auth['role']; status: string; ev: Date | null; pv: Date | null; last: Date }>(
    `select s.id sid, u.id uid, s.device_id did, u.role, u.status, u.email_verified_at ev, u.phone_verified_at pv, s.last_used_at last
       from sessions s join users u on u.id = s.user_id join devices d on d.id = s.device_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and d.revoked_at is null`,
    [sha256(raw)],
  );
  if (!row) return null;
  if (row.status !== 'active') return null;
  if (Date.now() - row.last.getTime() > 60_000) {
    // Sliding expiry, written at most once a minute per session.
    q(`update sessions set last_used_at = now(), expires_at = now() + ($2 || ' days')::interval where id = $1`, [row.sid, String(config.sessionDays)]).catch(() => {});
    q('update devices set last_seen_at = now() where id = $1', [row.did]).catch(() => {});
  }
  return { userId: row.uid, sessionId: row.sid, deviceId: row.did, role: row.role, verified: !!(row.ev || row.pv) };
}

export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) throw unauthorized();
  const a = await resolveToken(h.slice(7));
  if (!a) throw unauthorized('invalid_session');
  req.auth = a;
}

/** Like authenticate, but also requires a verified email/phone when verification is enforced. */
export async function authenticateVerified(req: FastifyRequest, reply: FastifyReply) {
  await authenticate(req, reply);
  if (config.requireVerification && !req.auth.verified) throw forbidden('verification_required', 'Verify your email or phone first');
}

export async function requireStaff(req: FastifyRequest, reply: FastifyReply) {
  await authenticate(req, reply);
  if (req.auth.role === 'user') throw forbidden('staff_only');
}
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await authenticate(req, reply);
  if (req.auth.role !== 'admin') throw forbidden('admin_only');
}

export const clientIp = (req: FastifyRequest) => req.ip;
