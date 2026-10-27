import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import { one, q, tx } from '../db/pool.ts';
import { config } from '../config.ts';
import { authenticate, clientIp, parse, type Auth } from '../lib/http.ts';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.ts';
import { hashPassword, numericCode, seal, sha256, token, unseal, verifyPassword } from '../lib/crypto.ts';
import { rateLimit } from '../lib/ratelimit.ts';
import { sendMessage } from '../lib/mailer.ts';
import { audit } from '../lib/audit.ts';
import { loadSelf } from '../lib/users.ts';
import { hub } from '../lib/hub.ts';

const password = z.string().min(config.relaxedPasswords ? 4 : 10, `at least ${config.relaxedPasswords ? 4 : 10} characters`).max(200);
const username = z.string().regex(/^[a-zA-Z0-9_.]{3,32}$/, '3-32 letters, digits, dot or underscore');
const email = z.string().email().max(254).transform((s) => s.toLowerCase());
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, 'use international format, e.g. +14155550123');
const deviceInfo = { deviceName: z.string().min(1).max(80).default('Web browser'), platform: z.enum(['web', 'android', 'ios', 'windows', 'macos', 'linux']).default('web') };

const COMMON = new Set(['password123', '1234567890', 'qwertyuiop', 'wazzupp123', 'password1234', '0123456789']);

async function issueCode(userId: string, kind: 'verify_email' | 'verify_phone' | 'reset_password', to: string, channel: 'email' | 'sms', subject: string) {
  const code = numericCode(6);
  await q(`update auth_tokens set used_at = now() where user_id = $1 and kind = $2 and used_at is null`, [userId, kind]);
  await q(`insert into auth_tokens(user_id, kind, token_hash, expires_at) values ($1,$2,$3, now() + interval '15 minutes')`, [userId, kind, sha256(`${userId}:${kind}:${code}`)]);
  await sendMessage({ userId, channel, to, subject, body: `Your Wazzupp code is ${code}. It expires in 15 minutes. If you did not request it, ignore this message.` });
}

async function consumeCode(userId: string, kind: string, code: string): Promise<boolean> {
  const row = await one(`select id, attempts, token_hash from auth_tokens where user_id = $1 and kind = $2 and used_at is null and expires_at > now() order by created_at desc limit 1`, [userId, kind]);
  if (!row) return false;
  if (row.attempts >= 5) return false;
  const ok = Buffer.compare(row.token_hash, sha256(`${userId}:${kind}:${code}`)) === 0;
  if (!ok) { await q('update auth_tokens set attempts = attempts + 1 where id = $1', [row.id]); return false; }
  await q('update auth_tokens set used_at = now() where id = $1', [row.id]);
  return true;
}

export async function createSession(userId: string, info: { deviceName: string; platform: string }, req: { ip: string; headers: Record<string, any> }, existingDeviceId?: string) {
  const raw = token(32);
  const out = await tx(async (t) => {
    let deviceId = existingDeviceId;
    if (!deviceId) deviceId = (await t.one(`insert into devices(user_id, name, platform) values ($1,$2,$3) returning id`, [userId, info.deviceName, info.platform])).id;
    const s = await t.one(
      `insert into sessions(user_id, device_id, token_hash, ip, user_agent, expires_at)
       values ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval) returning id`,
      [userId, deviceId, sha256(raw), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), String(config.sessionDays)]);
    return { sessionId: s.id as string, deviceId: deviceId as string };
  });
  return { token: raw, ...out };
}

async function newLoginAlert(userId: string, deviceId: string, ip: string, deviceName: string) {
  const prev = await one(`select count(*)::int n, count(*) filter (where ip = $2)::int same_ip from sessions where user_id = $1 and device_id <> $3 and revoked_at is null`, [userId, ip, deviceId]);
  if (!prev || prev.n === 0) return;
  const suspicious = prev.same_ip === 0;
  await tx(async (t) => {
    await t.q(`insert into notifications(user_id, kind, payload) values ($1,'new_login',$2)`, [userId, JSON.stringify({ deviceName, ip, suspicious })]);
    t.emit([userId], 'security.new_login', { deviceId, deviceName, suspicious });
  });
  const u = await one('select email from users where id = $1', [userId]);
  if (u?.email) await sendMessage({ userId, channel: 'email', to: u.email, subject: suspicious ? 'New sign-in from an unfamiliar location' : 'New sign-in to Wazzupp', body: `A new device (${deviceName}) signed in to your account. If this was not you, open Settings > Devices and sign it out, then change your password.` });
}

export function totp(secret: string) {
  return new OTPAuth.TOTP({ issuer: 'Wazzupp', algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}

async function checkTotp(userId: string, secretSealed: string, code: string): Promise<boolean> {
  const tp = totp(unseal(secretSealed));
  const delta = tp.validate({ token: code, window: 1 });
  if (delta === null) return false;
  const step = Math.floor(Date.now() / 30000) + delta;
  // Reject replay of an already used step.
  const r = await q('update users set mfa_last_step = $2 where id = $1 and mfa_last_step < $2', [userId, step]);
  return r.rowCount === 1;
}

/** Verifies a Google Identity Services ID token with Google and checks it was issued for this app. */
async function verifyGoogleToken(credential: string): Promise<{ email: string; name: string }> {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res || !res.ok) throw unauthorized('invalid_google_token', 'Google could not verify that sign-in. Try again.');
  const t: any = await res.json();
  const okIss = t.iss === 'https://accounts.google.com' || t.iss === 'accounts.google.com';
  if (t.aud !== config.googleClientId || !okIss || String(t.email_verified) !== 'true' || !t.email || Number(t.exp) * 1000 < Date.now()) throw unauthorized('invalid_google_token', 'Google could not verify that sign-in. Try again.');
  return { email: String(t.email).toLowerCase(), name: String(t.name || t.given_name || String(t.email).split('@')[0]).slice(0, 60) };
}

export async function authRoutes(app: FastifyInstance) {
  // What the sign-in screen needs to know before anyone is signed in.
  app.get('/api/auth/config', async () => ({ googleClientId: config.googleClientId || null, requireVerification: config.requireVerification }));

  app.post('/api/auth/google', async (req, reply) => {
    if (!config.googleClientId) throw badRequest('google_not_configured', 'Sign in with Google is not set up on this server');
    const body = parse(z.object({ credential: z.string().min(20).max(5000), ...deviceInfo }), req.body);
    await rateLimit(`google-ip:${clientIp(req)}`, 30, 600);
    const g = await verifyGoogleToken(body.credential);
    let u = await one(`select id, status, mfa_enabled from users where email = $1`, [g.email]);
    let created = false;
    if (u) {
      if (u.status === 'deleted') throw unauthorized('invalid_credentials', 'Incorrect login details');
      if (u.status === 'suspended') throw forbidden('account_suspended', 'This account is suspended. You can submit an appeal.');
      if (u.mfa_enabled) throw unauthorized('use_password', 'This account uses two-step verification. Sign in with your password and code.');
      await q(`update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1`, [u.id]);
    } else {
      const open = await one(`select enabled from feature_flags where key = 'registration_open'`);
      if (open && !open.enabled) throw forbidden('registration_closed');
      await rateLimit(`reg:${clientIp(req)}`, 10, 3600);
      const base = (g.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._]/g, '') || 'user').slice(0, 24).padEnd(3, '0');
      const hash = await hashPassword(token(32)); // nobody knows this password; the account is entered through Google or a password reset
      for (let i = 0; i < 8 && !u; i++) {
        const name = i === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`;
        try {
          u = await tx(async (t) => {
            const r = await t.one(`insert into users(email, username, password_hash, email_verified_at) values ($1,$2,$3, now()) returning id`, [g.email, name, hash]);
            await t.q(`insert into user_profiles(user_id, display_name) values ($1,$2)`, [r.id, g.name]);
            return { id: r.id as string, status: 'active', mfa_enabled: false };
          });
        } catch (e: any) { if (e.code !== '23505' || !String(e.constraint).includes('username')) throw e; }
      }
      if (!u) throw conflict('username_taken', 'Could not create an account. Try again.');
      created = true;
      if (config.adminEmails.includes(g.email)) await q(`update users set role = 'admin' where id = $1`, [u.id]);
    }
    const sess = await createSession(u.id, body, req);
    if (!created) await newLoginAlert(u.id, sess.deviceId, req.ip, body.deviceName);
    reply.code(created ? 201 : 200);
    return { token: sess.token, deviceId: sess.deviceId, user: await loadSelf(u.id) };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const body = parse(z.object({
      username, password, displayName: z.string().trim().min(1).max(60),
      email: email.optional(), phone: phone.optional(), ...deviceInfo,
    }), req.body);
    if (!body.email && !body.phone) throw badRequest('validation_failed', 'email or phone required');
    if (config.requireVerification && !body.email) throw badRequest('email_required', 'An email address is required so we can verify your account');
    await rateLimit(`reg:${clientIp(req)}`, 10, 3600);
    const open = await one(`select enabled from feature_flags where key = 'registration_open'`);
    if (open && !open.enabled) throw forbidden('registration_closed');
    if (!config.relaxedPasswords && (COMMON.has(body.password.toLowerCase()) || body.password.toLowerCase().includes(body.username.toLowerCase()))) throw badRequest('weak_password', 'Choose a less guessable password');

    const hash = await hashPassword(body.password);
    let userId: string;
    try {
      userId = await tx(async (t) => {
        const u = await t.one(`insert into users(email, phone, username, password_hash) values ($1,$2,$3,$4) returning id`, [body.email ?? null, body.phone ?? null, body.username, hash]);
        await t.q(`insert into user_profiles(user_id, display_name) values ($1,$2)`, [u.id, body.displayName]);
        return u.id as string;
      });
    } catch (e: any) {
      if (e.code === '23505') {
        if (String(e.constraint).includes('username')) throw conflict('username_taken', 'That username is taken');
        throw conflict('account_exists', 'An account with those details already exists');
      }
      throw e;
    }
    if (config.adminEmails.includes(body.email ?? '')) await q(`update users set role = 'admin' where id = $1`, [userId]);
    if (body.email) await issueCode(userId, 'verify_email', body.email, 'email', 'Verify your Wazzupp email');
    // Phone numbers are stored as an unverified contact detail: sending SMS codes needs a paid provider, so none is sent.
    const sess = await createSession(userId, body, req);
    reply.code(201);
    return { token: sess.token, deviceId: sess.deviceId, user: await loadSelf(userId) };
  });

  app.post('/api/auth/verify', { preHandler: authenticate }, async (req) => {
    const body = parse(z.object({ kind: z.enum(['email', 'phone']), code: z.string().regex(/^\d{6}$/) }), req.body);
    await rateLimit(`verify:${req.auth.userId}`, 10, 900);
    const kind = body.kind === 'email' ? 'verify_email' : 'verify_phone';
    if (!(await consumeCode(req.auth.userId, kind, body.code))) throw badRequest('invalid_code', 'Invalid or expired code');
    await q(`update users set ${body.kind}_verified_at = now() where id = $1`, [req.auth.userId]);
    return { user: await loadSelf(req.auth.userId) };
  });

  app.post('/api/auth/verify/resend', { preHandler: authenticate }, async (req, reply) => {
    const body = parse(z.object({ kind: z.enum(['email', 'phone']) }), req.body);
    await rateLimit(`resend:${req.auth.userId}`, 5, 3600);
    const u = await one('select email, phone from users where id = $1', [req.auth.userId]);
    const to = body.kind === 'email' ? u.email : u.phone;
    if (!to) throw badRequest('no_contact_method');
    await issueCode(req.auth.userId, body.kind === 'email' ? 'verify_email' : 'verify_phone', to, body.kind === 'email' ? 'email' : 'sms', 'Verify your Wazzupp account');
    reply.code(204);
  });

  app.post('/api/auth/login', async (req) => {
    const body = parse(z.object({ identifier: z.string().min(3).max(254), password: z.string().min(1).max(200), mfaCode: z.string().regex(/^\d{6}$/).optional(), ...deviceInfo }), req.body);
    const id = body.identifier.trim().toLowerCase();
    await rateLimit(`login-ip:${clientIp(req)}`, 30, 600);
    await rateLimit(`login-id:${id}`, 10, 600);
    const u = await one(
      `select id, password_hash, status, failed_logins, locked_until, mfa_enabled, mfa_secret from users where email = $1 or lower(username) = $1 or (phone = $2 and phone_verified_at is not null)`,
      [id, body.identifier.trim()]);
    // Always run a hash verification so timing does not reveal whether the account exists.
    const ok = await verifyPassword(u?.password_hash ?? '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE', body.password);
    if (!u || u.status === 'deleted') throw unauthorized('invalid_credentials', 'Incorrect login details. Check your username, email or password.');
    if (u.locked_until && u.locked_until > new Date()) throw unauthorized('account_locked', 'Too many failed attempts. Try again later.');
    if (!ok) {
      await q(`update users set failed_logins = failed_logins + 1, locked_until = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' else locked_until end where id = $1`, [u.id]);
      throw unauthorized('invalid_credentials', 'Incorrect login details. Check your username, email or password.');
    }
    if (u.status === 'suspended') throw forbidden('account_suspended', 'This account is suspended. You can submit an appeal.');
    if (u.mfa_enabled) {
      if (!body.mfaCode) throw unauthorized('mfa_required', 'Enter your authenticator code');
      if (!(await checkTotp(u.id, u.mfa_secret, body.mfaCode))) throw unauthorized('invalid_mfa', 'Invalid authenticator code');
    }
    await q('update users set failed_logins = 0, locked_until = null where id = $1', [u.id]);
    const sess = await createSession(u.id, body, req);
    await newLoginAlert(u.id, sess.deviceId, req.ip, body.deviceName);
    return { token: sess.token, deviceId: sess.deviceId, user: await loadSelf(u.id) };
  });

  // Suspended users may still file an appeal with valid credentials.
  app.post('/api/auth/appeal', async (req, reply) => {
    const body = parse(z.object({ identifier: z.string().min(3), password: z.string().min(1), message: z.string().min(10).max(2000) }), req.body);
    await rateLimit(`appeal:${clientIp(req)}`, 5, 3600);
    const id = body.identifier.trim().toLowerCase();
    const u = await one(`select id, password_hash, status from users where email = $1 or lower(username) = $1`, [id]);
    if (!u || u.status !== 'suspended' || !(await verifyPassword(u.password_hash, body.password))) throw unauthorized('invalid_credentials');
    await q(`insert into appeals(user_id, message) values ($1,$2)`, [u.id, body.message]);
    reply.code(204);
  });

  app.post('/api/auth/logout', { preHandler: authenticate }, async (req, reply) => {
    await q('update sessions set revoked_at = now() where id = $1', [req.auth.sessionId]);
    closeSessions(req.auth.userId, req.auth.sessionId);
    reply.code(204);
  });

  app.post('/api/auth/password/forgot', async (req, reply) => {
    const body = parse(z.object({ email }), req.body);
    await rateLimit(`forgot-ip:${clientIp(req)}`, 10, 3600);
    await rateLimit(`forgot:${body.email}`, 3, 3600);
    const u = await one(`select id from users where email = $1 and status = 'active'`, [body.email]);
    if (u) await issueCode(u.id, 'reset_password', body.email, 'email', 'Reset your Wazzupp password');
    reply.code(204); // identical response whether or not the account exists
  });

  app.post('/api/auth/password/reset', async (req, reply) => {
    const body = parse(z.object({ email, code: z.string().regex(/^\d{6}$/), newPassword: password }), req.body);
    await rateLimit(`reset:${body.email}`, 10, 900);
    const u = await one(`select id from users where email = $1 and status = 'active'`, [body.email]);
    if (!u || !(await consumeCode(u.id, 'reset_password', body.code))) throw badRequest('invalid_code', 'Invalid or expired code');
    await q('update users set password_hash = $2, failed_logins = 0, locked_until = null where id = $1', [u.id, await hashPassword(body.newPassword)]);
    await q('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [u.id]);
    closeSessions(u.id);
    await audit(u.id, 'password.reset', u.id, {}, req.ip);
    reply.code(204);
  });

  app.post('/api/me/password', { preHandler: authenticate }, async (req, reply) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: password }), req.body);
    const u = await one('select password_hash from users where id = $1', [req.auth.userId]);
    if (!(await verifyPassword(u.password_hash, body.currentPassword))) throw unauthorized('invalid_credentials');
    await q('update users set password_hash = $2 where id = $1', [req.auth.userId, await hashPassword(body.newPassword)]);
    await q('update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null', [req.auth.userId, req.auth.sessionId]);
    closeSessions(req.auth.userId, undefined, req.auth.sessionId);
    reply.code(204);
  });

  // ---- MFA (TOTP) ----
  app.post('/api/me/mfa/setup', { preHandler: authenticate }, async (req) => {
    const u = await one('select mfa_enabled, username from users where id = $1', [req.auth.userId]);
    if (u.mfa_enabled) throw conflict('mfa_already_enabled');
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await q('update users set mfa_secret = $2 where id = $1', [req.auth.userId, seal(secret)]);
    return { secret, otpauthUri: totp(secret).toString() };
  });
  app.post('/api/me/mfa/enable', { preHandler: authenticate }, async (req) => {
    const body = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    const u = await one('select mfa_secret, mfa_enabled from users where id = $1', [req.auth.userId]);
    if (!u.mfa_secret || u.mfa_enabled) throw badRequest('mfa_not_pending');
    if (!(await checkTotp(req.auth.userId, u.mfa_secret, body.code))) throw badRequest('invalid_mfa');
    await q('update users set mfa_enabled = true where id = $1', [req.auth.userId]);
    await audit(req.auth.userId, 'mfa.enabled', req.auth.userId, {}, req.ip);
    return { user: await loadSelf(req.auth.userId) };
  });
  app.post('/api/me/mfa/disable', { preHandler: authenticate }, async (req) => {
    const body = parse(z.object({ password: z.string(), code: z.string().regex(/^\d{6}$/) }), req.body);
    const u = await one('select password_hash, mfa_secret, mfa_enabled from users where id = $1', [req.auth.userId]);
    if (!u.mfa_enabled) throw badRequest('mfa_not_enabled');
    if (!(await verifyPassword(u.password_hash, body.password))) throw unauthorized('invalid_credentials');
    if (!(await checkTotp(req.auth.userId, u.mfa_secret, body.code))) throw badRequest('invalid_mfa');
    await q('update users set mfa_enabled = false, mfa_secret = null where id = $1', [req.auth.userId]);
    await audit(req.auth.userId, 'mfa.disabled', req.auth.userId, {}, req.ip);
    return { user: await loadSelf(req.auth.userId) };
  });

  // Development convenience only: lets the demo UI show verification codes without an SMTP server.
  if (!config.isProd) {
    app.get('/api/dev/outbox', { preHandler: authenticate }, async (req) => {
      const rows = await q(`select channel, recipient, subject, body, created_at from outbox where user_id = $1 order by id desc limit 10`, [req.auth.userId]);
      return { messages: rows.rows };
    });
  }
}

/** Disconnect realtime sockets for revoked sessions. */
export function closeSessions(userId: string, sessionId?: string, exceptSessionId?: string) {
  for (const c of hub.connectionsOf(userId)) {
    if (sessionId ? c.sessionId === sessionId : c.sessionId !== exceptSessionId) c.ws.close(4001, 'session revoked');
  }
}
export type { Auth };
