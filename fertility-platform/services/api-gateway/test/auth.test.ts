import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentityService } from '../src/identity-service.js';
import { PASSWORD_MAX, hashPassword, verifyPassword } from '../src/password.js';
import { buildApp } from '../src/server.js';
import type { PhiStore } from '../src/store.js';
import type { Role } from '../src/types.js';
import { IDS, testConfig } from './helpers.js';

describe('password hashing (scrypt)', () => {
  it('produces the DB-constrained format, a fresh salt each time, and verifies', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct');
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
  });

  it('treats missing or malformed stored hashes as a failed login, never an error', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
  });
});

class FakeIdentity implements IdentityService {
  users = new Map<string, { id: string; password: string; role: Role }>();
  registered: Array<{ email: string; name: string }> = [];
  async register(email: string, password: string, fullName: string) {
    if (this.users.has(email.toLowerCase())) return 'exists' as const;
    const id = IDS.patientA;
    this.users.set(email.toLowerCase(), { id, password, role: 'patient' });
    this.registered.push({ email, name: fullName });
    return { userId: id };
  }
  async authenticate(email: string, password: string) {
    const u = this.users.get(email.toLowerCase());
    return u && u.password === password ? { userId: u.id, role: u.role } : null;
  }
}

const store = { async pullEvents() { return { events: [], next_cursor: 0, has_more: false, server_lamport: 0, predictions: null }; }, async ping() {} } as unknown as PhiStore;
const cfg = testConfig();
let app: FastifyInstance;
let identity: FakeIdentity;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pwa-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dir, 'sw.js'), '// sw');
  identity = new FakeIdentity();
  app = await buildApp({ config: testConfig({ PWA_DIR: dir }), store, identity });
});
afterAll(async () => { await app.close(); });

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as never });
const good = { email: 'Ana@Example.com', password: 'a-long-enough-pass', full_name: 'Ana Test' };

describe('POST /api/v1/auth/register', () => {
  it('creates a patient, returns a working short-lived token, and cannot be told a role', async () => {
    const res = await post('/api/v1/auth/register', good);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ user_id: IDS.patientA, role: 'patient', expires_in: '1h' });
    const claims = app.jwt.decode<{ sub: string; role: string; iss: string; aud: string; exp: number; iat: number }>(body.token)!;
    expect(claims).toMatchObject({ sub: IDS.patientA, role: 'patient', iss: cfg.jwtIssuer, aud: cfg.jwtAudience });
    expect(claims.exp - claims.iat).toBe(3600);
    const pull = await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: { authorization: `Bearer ${body.token}` } });
    expect(pull.statusCode).toBe(200);

    const sneaky = await post('/api/v1/auth/register', { ...good, email: 'x@example.com', role: 'admin' });
    expect(sneaky.statusCode).toBe(400); // strict schema: clients cannot choose a role
  });

  it('rejects duplicates with 409, and weak or oversize passwords and bad e-mails with 400 (values never echoed)', async () => {
    expect((await post('/api/v1/auth/register', good)).statusCode).toBe(409);
    for (const bad of [
      { ...good, email: 'n1@example.com', password: 'short' },
      { ...good, email: 'n2@example.com', password: 'x'.repeat(PASSWORD_MAX + 1) },
      { ...good, email: 'not-an-email' },
      { ...good, email: 'n3@example.com', full_name: '' },
    ]) {
      const r = await post('/api/v1/auth/register', bad);
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain('short');
    }
  });
});

describe('POST /api/v1/auth/login', () => {
  it('signs in with the right password; wrong password and unknown e-mail look identical', async () => {
    const ok = await post('/api/v1/auth/login', { email: 'ana@example.com', password: good.password });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTruthy();
    const wrong = await post('/api/v1/auth/login', { email: 'ana@example.com', password: 'wrong-password-1' });
    const unknown = await post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'wrong-password-1' });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.body).toBe(unknown.body);
  });

  it('validates input', async () => {
    expect((await post('/api/v1/auth/login', { email: 'ana@example.com' })).statusCode).toBe(400);
    expect((await post('/api/v1/auth/login', { email: 'ana@example.com', password: 'x', extra: 1 })).statusCode).toBe(400);
  });
});

describe('rate limiting of credential endpoints', () => {
  it('allows 10 attempts per minute per client, then 429', async () => {
    const a2 = await buildApp({ config: testConfig(), store, identity });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await a2.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'ana@example.com', password: 'wrong-password-1' } })).statusCode);
    }
    await a2.close();
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

describe('static app files are not rate limited', () => {
  it('serves the shell any number of times even with a tiny API limit', async () => {
    const tiny = await buildApp({ config: testConfig({ PWA_DIR: dir, RATE_LIMIT_PER_MINUTE: '2' }), store });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await tiny.inject({ method: 'GET', url: '/' })).statusCode);
    const api: number[] = [];
    for (let i = 0; i < 4; i++) api.push((await tiny.inject({ method: 'GET', url: '/api/v1/sync/pull' })).statusCode);
    await tiny.close();
    expect(codes).toEqual([200, 200, 200, 200, 200, 200]);
    expect(api).toEqual([401, 401, 429, 429]); // the API is still limited
  });
});

describe('auth is absent without an identity service; static files are served', () => {
  it('returns 404 for auth routes when no identity service is configured', async () => {
    const bare = await buildApp({ config: testConfig(), store });
    expect((await bare.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} })).statusCode).toBe(404);
    await bare.close();
  });

  it('serves the app shell with revalidation headers and a strict CSP', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>app</title>');
    expect(root.headers['cache-control']).toBe('no-cache');
    expect(root.headers['content-security-policy']).toContain("script-src 'self'");
    expect(root.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(root.headers['content-security-policy']).not.toContain('upgrade-insecure-requests'); // NODE_ENV=test
    expect((await app.inject({ method: 'GET', url: '/sw.js' })).headers['cache-control']).toBe('no-cache');
    expect((await app.inject({ method: 'GET', url: '/missing.js' })).statusCode).toBe(404);
    // static files carry no CORS headers or `Vary: Origin` (that would defeat the service worker's cache matching)
    const withOrigin = await app.inject({ method: 'GET', url: '/', headers: { origin: 'http://localhost' } });
    expect(withOrigin.headers['access-control-allow-origin']).toBeUndefined();
    expect(String(withOrigin.headers.vary ?? '')).not.toMatch(/origin/i);
  });

  it('forces https subresources in production', async () => {
    const prod = await buildApp({ config: testConfig({ NODE_ENV: 'production' }), store });
    const csp = (await prod.inject({ method: 'GET', url: '/healthz' })).headers['content-security-policy'] as string;
    await prod.close();
    expect(csp).toContain('upgrade-insecure-requests');
  });
});
