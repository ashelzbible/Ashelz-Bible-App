import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashIp, pseudonymize } from '../src/crypto.js';
import { createPool } from '../src/db.js';
import { EngineRejectedError, HttpEngineClient, type EngineClient } from '../src/engine-client.js';
import { IdentityStore } from '../src/identity-store.js';
import { StoreIdentityService } from '../src/identity-service.js';
import { RecalcWorker } from '../src/recalc.js';
import { buildApp } from '../src/server.js';
import { PgPhiStore } from '../src/store.js';
import type { Role } from '../src/types.js';
import { ADMIN_URL, createTestDb, startEngine, type TestDb } from './db-fixture.js';
import { IDS, TEST_ENV, testConfig } from './helpers.js';

const suite = ADMIN_URL ? describe : describe.skip;

suite('integration: Postgres RLS + real Python engine', () => {
  const cfg = testConfig();
  let db: TestDb;
  let phiPool: pg.Pool;
  let workerPool: pg.Pool;
  let identityPool: pg.Pool;
  let app: FastifyInstance;
  let engine: { url: string; stop(): Promise<void> };
  let worker: RecalcWorker;

  const tok = (sub: string, role: Role) => ({
    authorization: `Bearer ${app.jwt.sign({ sub, role }, { iss: cfg.jwtIssuer, aud: cfg.jwtAudience, expiresIn: '5m' } as never)}`,
  });
  const subjectA = pseudonymize(IDS.patientA, cfg.pseudonymKey);
  const subjectB = pseudonymize(IDS.patientB, cfg.pseudonymKey);
  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin.query<T>(sql, params)).rows;

  beforeAll(async () => {
    db = await createTestDb();
    phiPool = createPool(db.urls.phi, 4);
    workerPool = createPool(db.urls.worker, 4);
    identityPool = createPool(db.urls.identity, 4);
    engine = await startEngine(18000 + Math.floor(Math.random() * 1000), TEST_ENV.ENGINE_TOKEN!);
    app = await buildApp({ config: cfg, store: new PgPhiStore(phiPool) });
    worker = new RecalcWorker(workerPool, new HttpEngineClient(engine.url, TEST_ENV.ENGINE_TOKEN!));
  });

  afterAll(async () => {
    await app?.close();
    await engine?.stop();
    await Promise.all([phiPool?.end(), workerPool?.end(), identityPool?.end()]);
    await db?.teardown();
  });

  // ---- A textbook 17-day ovulatory cycle, as offline events --------------------------
  let lam = 0;
  const ev = (kind: string, day: number, payload: object | null, over: Record<string, unknown> = {}) => ({
    event_id: crypto.randomUUID(),
    device_id: IDS.device,
    lamport: ++lam,
    client_ts: '2025-03-20T07:00:00Z',
    kind,
    op: payload ? 'SET' : 'RETRACT',
    log_date: `2025-03-${String(day).padStart(2, '0')}`,
    ...(payload ? { payload } : {}),
    ...over,
  });

  function fullCycleEvents() {
    const e3g = [10, 10, 10, 10, 10, 11, 11, 11, 11, 16, 20, 20, 20, 12, 12, 12, 12];
    const lh = [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 12, 30, 8, 4, 4, 4];
    const pdg = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 6, 6, 7];
    const temps = [36.4, 36.45, 36.42, 36.5, 36.44, 36.46, 36.43, 36.45, 36.44, 36.47, 36.45, 36.44, 36.46, 36.44, 36.8, 36.82, 36.9];
    const mucus: Record<number, number> = { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 10: 3, 11: 3, 12: 4, 13: 4, 14: 2, 15: 1, 16: 1 };
    const events: object[] = [ev('CYCLE', 1, {})];
    for (let d = 1; d <= 17; d++) {
      events.push(ev('BBT', d, { temp_c: temps[d - 1] }));
      events.push(ev('HORMONE', d, { lh_miu_ml: lh[d - 1], e3g_ng_ml: e3g[d - 1], pdg_ug_ml: pdg[d - 1] }));
      if (mucus[d] !== undefined) events.push(ev('MUCUS', d, { score: mucus[d] }));
    }
    return events;
  }

  const post = (url: string, headers: Record<string, string>, payload?: unknown, method: 'POST' | 'GET' | 'DELETE' = 'POST') =>
    app.inject({ method, url, headers, payload: payload as never, remoteAddress: '203.0.113.7' });

  describe('identity vault', () => {
    it('stores PII only as AES-GCM ciphertext, bound to its row', async () => {
      const ids = new IdentityStore(identityPool, cfg.fieldEncryptionKey, cfg.emailHashKey);
      const uid = await ids.createUser({ full_name: 'Ndapewa Shikongo', email: 'Ndapewa@Example.com' }, 'patient');
      const [row] = await q<{ encrypted_pii: string; email_hash: string }>('SELECT encrypted_pii, email_hash FROM identity_vault.users WHERE user_id = $1', [uid]);
      expect(row!.encrypted_pii).not.toContain('Ndapewa');
      expect(row!.email_hash).toMatch(/^[0-9a-f]{64}$/);
      expect((await ids.getUser(uid))!.pii.full_name).toBe('Ndapewa Shikongo');
      expect(await ids.findByEmail('  ndapewa@example.com')).toEqual({ userId: uid, role: 'patient' });
      await expect(ids.createUser({ full_name: 'Dup', email: 'ndapewa@example.com' }, 'patient')).rejects.toThrow(/already exists/);

      // An attacker with DB write access copies the ciphertext onto another account.
      const other = await ids.createUser({ full_name: 'Other Person', email: 'other@example.com' }, 'patient');
      await q('UPDATE identity_vault.users SET encrypted_pii = $1 WHERE user_id = $2', [row!.encrypted_pii, other]);
      await expect(ids.getUser(other)).rejects.toThrow(/decryption failed/);
    });

    it('registers and signs in with a scrypt-hashed password; no password or name is stored in the clear', async () => {
      const svc = new StoreIdentityService(new IdentityStore(identityPool, cfg.fieldEncryptionKey, cfg.emailHashKey));
      const created = await svc.register('Login.Test@Example.com', 'a-long-enough-pass', 'Login Test');
      expect(created).toMatchObject({ userId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(await svc.register('login.test@example.com', 'another-long-pass', 'Dup')).toBe('exists');
      const uid = (created as { userId: string }).userId;
      expect(await svc.authenticate('LOGIN.test@example.com', 'a-long-enough-pass')).toEqual({ userId: uid, role: 'patient' });
      expect(await svc.authenticate('login.test@example.com', 'wrong-password!!')).toBeNull();
      expect(await svc.authenticate('nobody@example.com', 'a-long-enough-pass')).toBeNull();
      const [row] = await q<{ password_hash: string; encrypted_pii: string }>('SELECT password_hash, encrypted_pii FROM identity_vault.users WHERE user_id = $1', [uid]);
      expect(row!.password_hash).toMatch(/^scrypt\$/);
      expect(JSON.stringify(row)).not.toContain('a-long-enough-pass');
      expect(JSON.stringify(row)).not.toContain('Login Test');
    });

    it('the PHI login role cannot read the vault, and the identity role cannot read PHI', async () => {
      await expect(phiPool.query('SELECT * FROM identity_vault.users')).rejects.toThrow(/permission denied/);
      await expect(identityPool.query('SELECT * FROM clinical_data.biomarker_events')).rejects.toThrow(/permission denied/);
    });
  });

  describe('offline sync end to end', () => {
    const events = fullCycleEvents();

    it('push stores events idempotently and queues one recalculation', async () => {
      const res = await post('/api/v1/sync/push', tok(IDS.patientA, 'patient'), { events });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toHaveLength(events.length);
      expect(body).toMatchObject({ duplicates: [], conflicts: [], recalculation: 'queued', server_lamport: events.length });

      expect(await q('SELECT 1 FROM clinical_data.biomarker_events WHERE subject_id = $1', [subjectA])).toHaveLength(events.length);
      expect(await q('SELECT 1 FROM clinical_data.recalc_jobs')).toHaveLength(1);
      // Only the pseudonym reaches the PHI tables.
      expect(await q('SELECT 1 FROM clinical_data.biomarker_events WHERE subject_id <> $1', [subjectA])).toHaveLength(0);
    });

    it('retrying the same batch (flaky mobile network) changes nothing', async () => {
      const res = await post('/api/v1/sync/push', tok(IDS.patientA, 'patient'), { events });
      const body = res.json();
      expect(body.accepted).toEqual([]);
      expect(body.duplicates).toHaveLength(events.length);
      expect(body.recalculation).toBe('none');
      expect(await q('SELECT 1 FROM clinical_data.biomarker_events')).toHaveLength(events.length);
    });

    it('reusing an event_id with different content is rejected and never overwrites history', async () => {
      const original = events[1] as { event_id: string; payload: { temp_c: number } };
      const forged = { ...original, payload: { temp_c: 37.9 } };
      const res = await post('/api/v1/sync/push', tok(IDS.patientA, 'patient'), { events: [forged] });
      expect(res.json().conflicts).toEqual([{ event_id: original.event_id, reason: 'EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT' }]);
      const [stored] = await q<{ payload: { temp_c: number } }>('SELECT payload FROM clinical_data.biomarker_events WHERE event_id = $1', [original.event_id]);
      expect(stored!.payload.temp_c).toBe(original.payload.temp_c);
    });

    it('a duplicate event_id twice in one batch with different content is flagged, not silently merged', async () => {
      const a = ev('MUCUS', 20, { score: 1 });
      const b = { ...a, payload: { score: 4 } };
      const res = await post('/api/v1/sync/push', tok(IDS.patientA, 'patient'), { events: [a, b] });
      expect(res.json()).toMatchObject({ accepted: [a.event_id], conflicts: [{ event_id: a.event_id }] });
    });

    it('the worker calls the real engine and stores versioned predictions', async () => {
      expect(await worker.drain()).toBe(1);
      expect(await q('SELECT 1 FROM clinical_data.recalc_jobs')).toHaveLength(0);
      const [run] = await q<{ algorithm_version: string; ovulation_confirmed_on: string }>(
        'SELECT algorithm_version, ovulation_confirmed_on::text FROM clinical_data.prediction_runs WHERE subject_id = $1', [subjectA]);
      expect(run!.algorithm_version).toMatch(/^biochem-/);
      expect(run!.ovulation_confirmed_on).toBe('2025-03-17');
    });

    it('pull returns events and the deterministic prediction timeline', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/v1/sync/pull?limit=500', headers: tok(IDS.patientA, 'patient') });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.events.length).toBe(events.length + 1); // + the lone mucus event pushed above
      expect(body.has_more).toBe(false);
      const by = Object.fromEntries(body.predictions.days.map((d: { log_date: string; status: string }) => [d.log_date, d.status]));
      expect(by['2025-03-10']).toBe('HIGH');
      expect(by['2025-03-12']).toBe('PEAK');
      expect(by['2025-03-14']).toBe('PEAK');
      expect(by['2025-03-15']).toBe('LOW');
      expect(by['2025-03-17']).toBe('OVULATION_CONFIRMED');
      expect(body.predictions.ovulation_confirmed_on).toBe('2025-03-17');
    });

    it('pull paginates with a cursor without gaps or repeats', async () => {
      const seen: number[] = [];
      let cursor = 0;
      for (let i = 0; i < 50; i++) {
        const r = await app.inject({ method: 'GET', url: `/api/v1/sync/pull?cursor=${cursor}&limit=10`, headers: tok(IDS.patientA, 'patient') });
        const b = r.json();
        seen.push(...b.events.map((e: { server_seq: number }) => e.server_seq));
        if (!b.has_more) break;
        expect(b.predictions).toBeNull(); // only attached on the final page
        cursor = b.next_cursor;
      }
      expect(seen).toHaveLength(events.length + 1);
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    });

    it('another patient sees none of it', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: tok(IDS.patientB, 'patient') });
      expect(r.json()).toMatchObject({ events: [], predictions: null });
    });
  });

  describe('database enforces isolation even if the gateway is wrong', () => {
    it('even a compromised gateway cannot write or read across subjects (RLS, raw connection)', async () => {
      const c = await phiPool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.role','patient',true), set_config('app.subject_id',$1,true)", [subjectA]);
        const insertFor = (subject: string, id: string) =>
          c.query(
            `INSERT INTO clinical_data.biomarker_events (subject_id, event_id, device_id, lamport, client_ts, kind, op, log_date, payload, payload_hash)
             VALUES ($1, $2, $3, 1, now(), 'BBT', 'SET', '2025-03-25', '{}', repeat('0',64))`,
            [subject, id, IDS.device],
          );
        await c.query('SAVEPOINT s');
        await expect(insertFor(subjectB, crypto.randomUUID())).rejects.toThrow(/row-level security/);
        await c.query('ROLLBACK TO s');
        // an unqualified SELECT (a forgotten WHERE clause) still only sees A
        const seen = await c.query('SELECT DISTINCT subject_id FROM clinical_data.biomarker_events');
        expect(seen.rows.map((r) => r.subject_id)).toEqual([subjectA]);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    });

    it('the PHI role cannot update or delete events or touch audit rows', async () => {
      await expect(phiPool.query('UPDATE clinical_data.biomarker_events SET lamport = 0')).rejects.toThrow(/permission denied/);
      await expect(phiPool.query('DELETE FROM clinical_data.biomarker_events')).rejects.toThrow(/permission denied/);
      await expect(phiPool.query('DELETE FROM audit.audit_logs')).rejects.toThrow(/permission denied/);
      await expect(phiPool.query('SELECT * FROM audit.audit_logs')).rejects.toThrow(/permission denied/);
    });

    it('a pooled connection never carries one request\'s identity into the next', async () => {
      const c = await phiPool.connect();
      try {
        const r = await c.query("SELECT current_setting('app.subject_id', true) AS s, current_setting('app.role', true) AS r");
        expect(r.rows[0].s || '').toBe('');
        expect(r.rows[0].r || '').toBe('');
        expect((await c.query('SELECT count(*)::int AS n FROM clinical_data.biomarker_events')).rows[0].n).toBe(0);
      } finally {
        c.release();
      }
    });
  });

  describe('clinician access follows consent', () => {
    const pull = (role: Role, sub: string) =>
      app.inject({ method: 'GET', url: `/api/v1/sync/pull?patient_id=${IDS.patientA}&limit=5`, headers: tok(sub, role) });

    it('denied without consent, allowed after the patient grants, denied again after revoke', async () => {
      expect((await pull('clinician', IDS.clinician)).statusCode).toBe(403);

      const g = await app.inject({ method: 'POST', url: '/api/v1/consents', headers: tok(IDS.patientA, 'patient'), payload: { clinician_id: IDS.clinician } });
      expect(g.statusCode).toBe(201);
      const ok = await pull('clinician', IDS.clinician);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().events).toHaveLength(5);

      const other = await pull('clinician', 'ffffffff-ffff-4fff-8fff-ffffffffffff');
      expect(other.statusCode).toBe(403);
      expect((await pull('clinician', IDS.clinician)).statusCode).toBe(200);

      const rv = await app.inject({ method: 'DELETE', url: `/api/v1/consents/${IDS.clinician}`, headers: tok(IDS.patientA, 'patient') });
      expect(rv.statusCode).toBe(200);
      expect((await pull('clinician', IDS.clinician)).statusCode).toBe(403);
    });

    it('admin is refused', async () => {
      expect((await pull('admin', IDS.admin)).statusCode).toBe(403);
    });
  });

  describe('audit trail', () => {
    it('records every read and write with actor, hashed IP, action and resource', async () => {
      const ipHash = hashIp('203.0.113.7', cfg.ipHashKey);
      const writes = await q<{ actor_id: string; ip_hash: string; resource_id: string; subject_id: string; request_id: string }>(
        "SELECT * FROM audit.audit_logs WHERE action = 'sync.push' AND outcome = 'SUCCESS'");
      expect(writes.length).toBeGreaterThanOrEqual(47);
      for (const w of writes) {
        expect(w.actor_id).toBe(IDS.patientA);
        expect(w.ip_hash).toBe(ipHash);
        expect(w.subject_id).toBe(subjectA);
        expect(w.resource_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(w.request_id).toBeTruthy();
      }
      expect(await q("SELECT 1 FROM audit.audit_logs WHERE action = 'sync.push.duplicate'")).toHaveLength(47);
      expect(await q("SELECT 1 FROM audit.audit_logs WHERE action = 'sync.push.conflict' AND outcome = 'DENIED'")).toHaveLength(2);
      expect((await q("SELECT 1 FROM audit.audit_logs WHERE action = 'sync.pull' AND operation = 'READ' AND outcome = 'SUCCESS'")).length).toBeGreaterThan(3);
      expect(await q("SELECT 1 FROM audit.audit_logs WHERE action = 'consent.grant'")).toHaveLength(1);
      expect(await q("SELECT 1 FROM audit.audit_logs WHERE action = 'consent.revoke'")).toHaveLength(1);
      expect((await q("SELECT 1 FROM audit.audit_logs WHERE actor_role = 'clinician' AND outcome = 'DENIED'")).length).toBeGreaterThanOrEqual(2);
      expect((await q("SELECT 1 FROM audit.audit_logs WHERE actor_role = 'admin' AND outcome = 'DENIED'")).length).toBeGreaterThanOrEqual(1);
      expect((await q("SELECT 1 FROM audit.audit_logs WHERE actor_role = 'engine' AND action = 'recalc.store'")).length).toBe(1);
      // No raw address anywhere in the log.
      expect(await q("SELECT 1 FROM audit.audit_logs WHERE ip_hash = '203.0.113.7'")).toHaveLength(0);
    });

    it('cannot be altered, even by the table owner', async () => {
      await expect(db.admin.query("UPDATE audit.audit_logs SET action = 'x'")).rejects.toThrow(/immutable/);
      await expect(db.admin.query('DELETE FROM audit.audit_logs')).rejects.toThrow(/immutable/);
    });
  });

  describe('last-writer-wins by Lamport order, retraction, determinism', () => {
    it('a later Lamport value beats an earlier one regardless of arrival order; retract removes', async () => {
      const day = 28;
      const late = ev('MUCUS', day, { score: 4 }, { lamport: 5000 });
      const early = ev('MUCUS', day, { score: 0 }, { lamport: 4000 });
      const retracted = ev('MUCUS', 27, null, { lamport: 5001 });
      const wasSet = ev('MUCUS', 27, { score: 2 }, { lamport: 4999 });
      // arrives out of order: the newer edit first, the older edit later
      await post('/api/v1/sync/push', tok(IDS.patientB, 'patient'), { events: [late, retracted] });
      await post('/api/v1/sync/push', tok(IDS.patientB, 'patient'), { events: [early, wasSet] });
      await post('/api/v1/sync/push', tok(IDS.patientB, 'patient'), { events: [ev('MUCUS', 26, { score: 0 }, { lamport: 4001 })] });
      await worker.drain();
      const r = await app.inject({ method: 'GET', url: '/api/v1/sync/pull?limit=500', headers: tok(IDS.patientB, 'patient') });
      const days = Object.fromEntries(r.json().predictions.days.map((d: { log_date: string; status: string; flags: string[] }) => [d.log_date, d]));
      expect(days['2025-03-28'].status).toBe('HIGH'); // score 4 (lamport 5000) won over score 0 (lamport 4000)
      expect(days['2025-03-28'].flags).toContain('MUCUS_PEAK_WITHOUT_HORMONE_SUPPORT');
      expect(days['2025-03-27']?.flags ?? []).not.toContain('MUCUS_FERTILE'); // retraction won
      expect(days['2025-03-26'].status).toBe('LOW');
    });

    it('an unchanged input re-uses the existing prediction run instead of duplicating it', async () => {
      const before = await q('SELECT 1 FROM clinical_data.prediction_runs WHERE subject_id = $1', [subjectA]);
      // new event that does not change the effective state: an older edit superseded by the existing one
      const stale = ev('BBT', 3, { temp_c: 36.1 }, { lamport: 1 });
      await post('/api/v1/sync/push', tok(IDS.patientA, 'patient'), { events: [stale] });
      await worker.drain();
      expect(await q('SELECT 1 FROM clinical_data.prediction_runs WHERE subject_id = $1', [subjectA])).toHaveLength(before.length);
      expect((await q("SELECT 1 FROM audit.audit_logs WHERE action = 'recalc.unchanged'")).length).toBe(1);
    });
  });

  describe('worker failure handling', () => {
    const failing = (err: Error): EngineClient => ({ analyze: async () => { throw err; } });

    it('transient engine outages keep the job, back off, and record only an error code', async () => {
      await post('/api/v1/sync/push', tok(IDS.patientA, 'patient'), { events: [ev('MUCUS', 3, { score: 2 })] });
      const w = new RecalcWorker(workerPool, failing(new Error('connection refused with temp 36.5')));
      expect(await w.drain(1)).toBe(1);
      const [job] = await q<{ last_error: string; attempts: number; locked_until: Date }>('SELECT last_error, attempts, locked_until FROM clinical_data.recalc_jobs');
      expect(job).toMatchObject({ last_error: 'TRANSIENT_ERROR', attempts: 1 });
      expect(job!.locked_until.getTime()).toBeGreaterThan(Date.now());
      expect(await w.runOnce()).toBe(false); // backed off: not claimable yet
    });

    it('an engine 4xx is permanent: the job is dropped and the failure audited', async () => {
      await q('DELETE FROM clinical_data.recalc_jobs'); // test hygiene (owner may delete)
      await post('/api/v1/sync/push', tok(IDS.patientA, 'patient'), { events: [ev('MUCUS', 4, { score: 1 })] });
      const w = new RecalcWorker(workerPool, failing(new EngineRejectedError('422')));
      await w.drain(1);
      expect(await q('SELECT 1 FROM clinical_data.recalc_jobs')).toHaveLength(0);
      expect((await q("SELECT 1 FROM audit.audit_logs WHERE outcome = 'ERROR'")).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('assay profile selection', () => {
    it('the worker asks the real engine for the configured profile and stores it in the version', async () => {
      await post('/api/v1/sync/push', tok(IDS.patientB, 'patient'), {
        events: [ev('HORMONE', 29, { e3g_ng_ml: 160 }), ev('MUCUS', 29, { score: 0 })],
      });
      const mira = new RecalcWorker(workerPool, new HttpEngineClient(engine.url, TEST_ENV.ENGINE_TOKEN!), undefined, 'mira-marquette-2021-preliminary');
      expect(await mira.drain()).toBe(1);
      const [run] = await q<{ algorithm_version: string }>(
        'SELECT algorithm_version FROM clinical_data.prediction_runs WHERE subject_id = $1 ORDER BY last_computed_at DESC LIMIT 1', [subjectB]);
      expect(run!.algorithm_version).toMatch(/\+mira-marquette-2021-preliminary$/);
      const r = await app.inject({ method: 'GET', url: '/api/v1/sync/pull?limit=500', headers: tok(IDS.patientB, 'patient') });
      const day = r.json().predictions.days.find((d: { log_date: string }) => d.log_date === '2025-03-29');
      expect(day.status).toBe('HIGH'); // E3G 160 > 150 ng/mL under the Mira rule
      expect(day.reasoning.join(' ')).toContain('150 ng/mL');
    });

    it('an unknown profile is rejected by the engine and the job is dropped, not retried forever', async () => {
      await post('/api/v1/sync/push', tok(IDS.patientB, 'patient'), { events: [ev('MUCUS', 30, { score: 1 })] });
      const bad = new RecalcWorker(workerPool, new HttpEngineClient(engine.url, TEST_ENV.ENGINE_TOKEN!), undefined, 'no-such-profile');
      await bad.drain(1);
      expect(await q('SELECT 1 FROM clinical_data.recalc_jobs WHERE subject_id = $1', [subjectB])).toHaveLength(0);
    });
  });

  describe('GDPR erasure', () => {
    it('erase_subject removes a subject\'s PHI (break-glass function, not callable by the app)', async () => {
      await expect(phiPool.query('SELECT clinical_data.erase_subject($1)', [subjectA])).rejects.toThrow(/permission denied/);
      await q('SELECT clinical_data.erase_subject($1)', [subjectA]);
      expect(await q('SELECT 1 FROM clinical_data.biomarker_events WHERE subject_id = $1', [subjectA])).toHaveLength(0);
      expect(await q('SELECT 1 FROM clinical_data.prediction_runs WHERE subject_id = $1', [subjectA])).toHaveLength(0);
      expect((await q('SELECT 1 FROM clinical_data.biomarker_events WHERE subject_id = $1', [subjectB])).length).toBeGreaterThan(0);
    });
  });
});
