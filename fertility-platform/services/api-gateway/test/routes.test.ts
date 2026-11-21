import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pseudonymize } from '../src/crypto.js';
import { buildApp } from '../src/server.js';
import type { ConsentResult, PhiStore, RevokeResult } from '../src/store.js';
import type { AccessContext, Role } from '../src/types.js';
import { IDS, bbtEvent, testConfig } from './helpers.js';

class FakeStore implements PhiStore {
  calls: Array<{ fn: string; args: unknown[] }> = [];
  denied: Array<{ action: string; resourceType: string; subjectId: string | null; role: Role }> = [];
  pullResult: unknown = { events: [], next_cursor: 0, has_more: false, server_lamport: 0, predictions: null };
  consent: ConsentResult = 'granted';
  revoke: RevokeResult = 'revoked';
  fail = false;
  private rec(fn: string, ...args: unknown[]) { this.calls.push({ fn, args }); if (this.fail) throw new Error('db exploded with PHI 36.5'); }
  async pushEvents(ctx: AccessContext, subject: string, events: unknown[]) { this.rec('push', ctx, subject, events); return { accepted: ['x'], duplicates: [], conflicts: [], server_lamport: 7, recalculation: 'queued' as const }; }
  async pullEvents(ctx: AccessContext, subject: string, cursor: number, limit: number) { this.rec('pull', ctx, subject, cursor, limit); return this.pullResult as never; }
  async grantConsent(ctx: AccessContext, subject: string, clinician: string) { this.rec('grant', ctx, subject, clinician); return this.consent; }
  async revokeConsent(ctx: AccessContext, subject: string, clinician: string) { this.rec('revoke', ctx, subject, clinician); return this.revoke; }
  async recordDenied(ctx: AccessContext, action: string, resourceType: string, subjectId: string | null) { this.denied.push({ action, resourceType, subjectId, role: ctx.actor.role }); }
  async ping() { if (this.fail) throw new Error('down'); }
}

const cfg = testConfig();
let app: FastifyInstance;
let store: FakeStore;

const token = (sub: string, role: Role, over: Record<string, unknown> = {}) =>
  app.jwt.sign({ sub, role }, { iss: cfg.jwtIssuer, aud: cfg.jwtAudience, expiresIn: '5m', ...over } as never);
const auth = (sub: string, role: Role) => ({ authorization: `Bearer ${token(sub, role)}` });

beforeAll(async () => { store = new FakeStore(); app = await buildApp({ config: cfg, store }); });
afterAll(async () => { await app.close(); });
beforeEach(() => { store.calls = []; store.denied = []; store.fail = false; store.pullResult = { events: [], next_cursor: 0, has_more: false, server_lamport: 0, predictions: null }; });

const push = (headers: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/sync/push', headers, payload: payload as never });

describe('authentication', () => {
  it('rejects missing, malformed, expired, wrong-issuer and wrong-audience tokens with 401', async () => {
    const body = { events: [bbtEvent(1)] };
    expect((await push({}, body)).statusCode).toBe(401);
    expect((await push({ authorization: 'Bearer not.a.jwt' }, body)).statusCode).toBe(401);
    const expired = app.jwt.sign({ sub: IDS.patientA, role: 'patient', exp: Math.floor(Date.now() / 1000) - 60 } as never, { iss: cfg.jwtIssuer, aud: cfg.jwtAudience } as never);
    expect((await push({ authorization: `Bearer ${expired}` }, body)).statusCode).toBe(401);
    expect((await push({ authorization: `Bearer ${token(IDS.patientA, 'patient', { iss: 'evil' })}` }, body)).statusCode).toBe(401);
    expect((await push({ authorization: `Bearer ${token(IDS.patientA, 'patient', { aud: 'other' })}` }, body)).statusCode).toBe(401);
    expect(store.calls).toHaveLength(0);
  });

  it('rejects a token with no expiry', async () => {
    const noExp = app.jwt.sign({ sub: IDS.patientA, role: 'patient' }, { iss: cfg.jwtIssuer, aud: cfg.jwtAudience } as never);
    expect((await push({ authorization: `Bearer ${noExp}` }, { events: [bbtEvent(1)] })).statusCode).toBe(401);
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: IDS.patientA, role: 'patient', iss: cfg.jwtIssuer, aud: cfg.jwtAudience, exp: 9999999999 })}.`;
    expect((await push({ authorization: `Bearer ${forged}` }, { events: [bbtEvent(1)] })).statusCode).toBe(401);
  });

  it('rejects a token signed with another secret', async () => {
    const other = (await buildApp({ config: testConfig({ JWT_SECRET: 'z'.repeat(40) }), store }));
    const t = other.jwt.sign({ sub: IDS.patientA, role: 'patient' }, { iss: cfg.jwtIssuer, aud: cfg.jwtAudience, expiresIn: '5m' } as never);
    await other.close();
    expect((await push({ authorization: `Bearer ${t}` }, { events: [bbtEvent(1)] })).statusCode).toBe(401);
  });

  it('rejects a token with an unknown role or non-uuid subject', async () => {
    expect((await push({ authorization: `Bearer ${token(IDS.patientA, 'superuser' as Role)}` }, { events: [bbtEvent(1)] })).statusCode).toBe(401);
    expect((await push({ authorization: `Bearer ${token('not-a-uuid', 'patient')}` }, { events: [bbtEvent(1)] })).statusCode).toBe(401);
  });
});

describe('RBAC', () => {
  it.each<[Role, number]>([['patient', 200], ['clinician', 403], ['admin', 403]])('POST /sync/push as %s -> %i', async (role, status) => {
    const res = await push(auth(IDS.patientA, role), { events: [bbtEvent(1)] });
    expect(res.statusCode).toBe(status);
    if (status === 403) {
      expect(store.calls).toHaveLength(0);
      expect(store.denied).toEqual([expect.objectContaining({ action: 'sync.push', role })]);
    }
  });

  it('admin can never pull PHI', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/sync/pull?patient_id=${IDS.patientA}`, headers: auth(IDS.admin, 'admin') });
    expect(res.statusCode).toBe(403);
    expect(store.calls).toHaveLength(0);
  });

  it('clinicians cannot grant consent or revoke it', async () => {
    const h = auth(IDS.clinician, 'clinician');
    expect((await app.inject({ method: 'POST', url: '/api/v1/consents', headers: h, payload: { clinician_id: IDS.clinician } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/consents/${IDS.clinician}`, headers: h })).statusCode).toBe(403);
  });
});

describe('POST /api/v1/sync/push', () => {
  it('derives the subject pseudonym from the token, never from the body', async () => {
    const res = await push(auth(IDS.patientA, 'patient'), { events: [bbtEvent(1)], subject_id: 'x'.repeat(64) });
    expect(res.statusCode).toBe(400); // unknown field rejected (strict schema)
    const ok = await push(auth(IDS.patientA, 'patient'), { events: [bbtEvent(1)] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ accepted: ['x'], server_lamport: 7, recalculation: 'queued' });
    const call = store.calls[0]!;
    expect(call.args[1]).toBe(pseudonymize(IDS.patientA, cfg.pseudonymKey));
    const ctx = call.args[0] as AccessContext;
    expect(ctx.actor).toEqual({ id: IDS.patientA, role: 'patient' });
    expect(ctx.meta.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.meta.requestId).toBeTruthy();
  });

  it('validation errors list paths and codes but never echo submitted values', async () => {
    const res = await push(auth(IDS.patientA, 'patient'), { events: [bbtEvent(1, { payload: { temp_c: 99.123 } })] });
    expect(res.statusCode).toBe(400);
    const text = res.body;
    expect(text).toContain('events.0.payload.temp_c');
    expect(text).not.toContain('99.123');
    expect(store.calls).toHaveLength(0);
  });

  it.each([
    ['empty batch', { events: [] }],
    ['no body fields', {}],
    ['impossible date', { events: [bbtEvent(1, { log_date: '2025-02-30' })] }],
    ['oversize batch', { events: Array.from({ length: 501 }, (_, i) => bbtEvent(i + 1)) }],
  ])('400 for %s', async (_n, body) => {
    expect((await push(auth(IDS.patientA, 'patient'), body)).statusCode).toBe(400);
  });

  it('400 for malformed JSON and 413 for oversize bodies, with generic messages', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...auth(IDS.patientA, 'patient'), 'content-type': 'application/json' }, payload: '{"events": [' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'bad_request' });
    const big = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...auth(IDS.patientA, 'patient'), 'content-type': 'application/json' }, payload: JSON.stringify({ pad: 'x'.repeat(1_100_000) }) });
    expect(big.statusCode).toBe(413);
  });

  it('turns store failures into an opaque 500 that leaks nothing', async () => {
    store.fail = true;
    const res = await push(auth(IDS.patientA, 'patient'), { events: [bbtEvent(1)] });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('PHI');
    expect(res.json()).toMatchObject({ error: 'internal_error' });
  });
});

describe('GET /api/v1/sync/pull', () => {
  const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });

  it('patient pulls own data; defaults applied', async () => {
    const res = await get('/api/v1/sync/pull', auth(IDS.patientA, 'patient'));
    expect(res.statusCode).toBe(200);
    expect(store.calls[0]!.args.slice(1)).toEqual([pseudonymize(IDS.patientA, cfg.pseudonymKey), 0, 200]);
  });

  it('patient may name themself but not another patient (denied + audited)', async () => {
    expect((await get(`/api/v1/sync/pull?patient_id=${IDS.patientA}`, auth(IDS.patientA, 'patient'))).statusCode).toBe(200);
    const res = await get(`/api/v1/sync/pull?patient_id=${IDS.patientB}`, auth(IDS.patientA, 'patient'));
    expect(res.statusCode).toBe(403);
    expect(store.denied).toEqual([expect.objectContaining({ action: 'sync.pull', subjectId: pseudonymize(IDS.patientB, cfg.pseudonymKey) })]);
  });

  it('clinician must name a patient; the store gets that patient\'s pseudonym', async () => {
    expect((await get('/api/v1/sync/pull', auth(IDS.clinician, 'clinician'))).statusCode).toBe(400);
    const res = await get(`/api/v1/sync/pull?patient_id=${IDS.patientB}&cursor=5&limit=10`, auth(IDS.clinician, 'clinician'));
    expect(res.statusCode).toBe(200);
    expect(store.calls[0]!.args.slice(1)).toEqual([pseudonymize(IDS.patientB, cfg.pseudonymKey), 5, 10]);
  });

  it('clinician without consent gets 403 (store returns null)', async () => {
    store.pullResult = null;
    expect((await get(`/api/v1/sync/pull?patient_id=${IDS.patientB}`, auth(IDS.clinician, 'clinician'))).statusCode).toBe(403);
  });

  it.each(['limit=0', 'limit=501', 'cursor=-1', 'cursor=abc', 'patient_id=zzz', 'extra=1'])('400 for query %s', async (q) => {
    expect((await get(`/api/v1/sync/pull?${q}`, auth(IDS.patientA, 'patient'))).statusCode).toBe(400);
  });
});

describe('consent endpoints', () => {
  it('patient grants (201), repeats (200), revokes (200) and revokes again (404)', async () => {
    const h = auth(IDS.patientA, 'patient');
    const g1 = await app.inject({ method: 'POST', url: '/api/v1/consents', headers: h, payload: { clinician_id: IDS.clinician } });
    expect([g1.statusCode, g1.json().status]).toEqual([201, 'granted']);
    expect(store.calls[0]!.args.slice(1)).toEqual([pseudonymize(IDS.patientA, cfg.pseudonymKey), IDS.clinician]);
    store.consent = 'already_active';
    expect((await app.inject({ method: 'POST', url: '/api/v1/consents', headers: h, payload: { clinician_id: IDS.clinician } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/consents/${IDS.clinician}`, headers: h })).statusCode).toBe(200);
    store.revoke = 'not_found';
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/consents/${IDS.clinician}`, headers: h })).statusCode).toBe(404);
    store.consent = 'granted'; store.revoke = 'revoked';
  });

  it('validates the clinician id', async () => {
    const h = auth(IDS.patientA, 'patient');
    expect((await app.inject({ method: 'POST', url: '/api/v1/consents', headers: h, payload: { clinician_id: 'nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/consents/nope', headers: h })).statusCode).toBe(400);
  });
});

describe('operations', () => {
  it('health is public; readiness reflects the database; security headers are set', async () => {
    const h = await app.inject({ method: 'GET', url: '/healthz' });
    expect(h.statusCode).toBe(200);
    expect(h.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    store.fail = true;
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  });

  it('rate limits per client', async () => {
    const limited = await buildApp({ config: testConfig({ RATE_LIMIT_PER_MINUTE: '3' }), store });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await limited.inject({ method: 'GET', url: '/readyz' })).statusCode);
    await limited.close();
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});
