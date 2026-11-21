-- Adversarial tests for roles, RLS, immutability and erasure.
-- Run after migrations, as a superuser:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/rls_test.sql
-- Everything happens in one transaction that is rolled back.
BEGIN;

CREATE FUNCTION pg_temp.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', msg; END IF; RAISE NOTICE 'pass: %', msg; END $$;

-- Runs sql and requires that it raises an error (privilege or RLS violation).
CREATE FUNCTION pg_temp.denied(stmt text, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RAISE NOTICE 'pass: % (%)', msg, sqlerrm; RETURN;
  END;
  RAISE EXCEPTION 'FAIL: % was allowed', msg;
END $$;

CREATE FUNCTION pg_temp.count_as(role_name text, ctx jsonb, q text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', role_name);
  PERFORM set_config('app.role',       coalesce(ctx->>'role', ''),    true);
  PERFORM set_config('app.actor_id',   coalesce(ctx->>'actor', ''),   true);
  PERFORM set_config('app.subject_id', coalesce(ctx->>'subject', ''), true);
  EXECUTE q INTO n;
  RESET ROLE;
  RETURN n;
END $$;

-- Fixtures (inserted as superuser, bypassing RLS).
SELECT set_config('t.a', repeat('a', 64), true), set_config('t.b', repeat('b', 64), true),
       set_config('t.doc', '11111111-1111-1111-1111-111111111111', true),
       set_config('t.pa', '22222222-2222-2222-2222-222222222222', true);

INSERT INTO clinical_data.biomarker_events (subject_id, event_id, device_id, lamport, client_ts, kind, op, log_date, payload, payload_hash)
VALUES (repeat('a',64), gen_random_uuid(), gen_random_uuid(), 1, now(), 'BBT', 'SET', '2025-03-01', '{"temp_c":36.5}', repeat('0',64)),
       (repeat('b',64), gen_random_uuid(), gen_random_uuid(), 1, now(), 'BBT', 'SET', '2025-03-01', '{"temp_c":36.6}', repeat('1',64));

-- 1. Patient isolation ------------------------------------------------------
SELECT pg_temp.ok(pg_temp.count_as('phi_app', '{"role":"patient","actor":"22222222-2222-2222-2222-222222222222","subject":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
       'SELECT count(*) FROM clinical_data.biomarker_events') = 1, 'patient A sees only own events');
SELECT pg_temp.ok(pg_temp.count_as('phi_app', '{}', 'SELECT count(*) FROM clinical_data.biomarker_events') = 0,
       'no session context => no rows (fail closed)');
SELECT pg_temp.ok(pg_temp.count_as('phi_app', '{"role":"admin","actor":"22222222-2222-2222-2222-222222222222"}',
       'SELECT count(*) FROM clinical_data.biomarker_events') = 0, 'admin role sees no PHI');
SELECT pg_temp.ok(pg_temp.count_as('phi_app', '{"role":"patient","subject":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
       'SELECT count(*) FROM clinical_data.biomarker_events WHERE subject_id = repeat(''b'',64)') = 0,
       'patient A cannot read B even when asking for B explicitly');

DO $$ BEGIN
  SET LOCAL ROLE phi_app;
  PERFORM set_config('app.role','patient',true);
  PERFORM set_config('app.subject_id', repeat('a',64), true);
  INSERT INTO clinical_data.biomarker_events (subject_id, event_id, device_id, lamport, client_ts, kind, op, log_date, payload, payload_hash)
  VALUES (repeat('a',64), gen_random_uuid(), gen_random_uuid(), 2, now(), 'MUCUS', 'SET', '2025-03-02', '{"score":2}', repeat('2',64));
  RESET ROLE;
  RAISE NOTICE 'pass: patient A can insert own event';
END $$;

SELECT pg_temp.denied($q$
  SET LOCAL ROLE phi_app;
  SELECT set_config('app.role','patient',true), set_config('app.subject_id', repeat('a',64), true);
  INSERT INTO clinical_data.biomarker_events (subject_id, event_id, device_id, lamport, client_ts, kind, op, log_date, payload, payload_hash)
  VALUES (repeat('b',64), gen_random_uuid(), gen_random_uuid(), 3, now(), 'BBT', 'SET', '2025-03-03', '{}', repeat('3',64));
$q$, 'patient A cannot write events for subject B');
RESET ROLE;

-- 2. Immutability -------------------------------------------------------------
SELECT pg_temp.denied($q$ SET LOCAL ROLE phi_app; UPDATE clinical_data.biomarker_events SET lamport = 99 $q$, 'phi_app cannot UPDATE events');
RESET ROLE;
SELECT pg_temp.denied($q$ SET LOCAL ROLE phi_app; DELETE FROM clinical_data.biomarker_events $q$, 'phi_app cannot DELETE events');
RESET ROLE;
SELECT pg_temp.denied($q$ UPDATE clinical_data.biomarker_events SET lamport = 99 $q$, 'even superuser UPDATE is blocked by trigger');
SELECT pg_temp.denied($q$ DELETE FROM clinical_data.biomarker_events $q$, 'even superuser DELETE is blocked by trigger');
SELECT pg_temp.denied($q$ TRUNCATE clinical_data.biomarker_events $q$, 'TRUNCATE is blocked by trigger');

-- 3. Clinician access follows patient consent --------------------------------------
SELECT pg_temp.ok(pg_temp.count_as('phi_app', '{"role":"clinician","actor":"11111111-1111-1111-1111-111111111111"}',
       'SELECT count(*) FROM clinical_data.biomarker_events') = 0, 'clinician without consent sees nothing');

DO $$ BEGIN
  SET LOCAL ROLE phi_app;
  PERFORM set_config('app.role','patient',true);
  PERFORM set_config('app.subject_id', repeat('a',64), true);
  INSERT INTO clinical_data.care_relationships (clinician_id, subject_id)
  VALUES ('11111111-1111-1111-1111-111111111111', repeat('a',64));
  RESET ROLE;
END $$;
SELECT pg_temp.denied($q$
  SET LOCAL ROLE phi_app;
  SELECT set_config('app.role','patient',true), set_config('app.subject_id', repeat('b',64), true);
  INSERT INTO clinical_data.care_relationships (clinician_id, subject_id)
  VALUES ('11111111-1111-1111-1111-111111111111', repeat('a',64));
$q$, 'patient B cannot grant consent over subject A');
RESET ROLE;
SELECT pg_temp.denied($q$
  SET LOCAL ROLE phi_app;
  SELECT set_config('app.role','clinician',true), set_config('app.actor_id','11111111-1111-1111-1111-111111111111',true);
  INSERT INTO clinical_data.care_relationships (clinician_id, subject_id)
  VALUES ('11111111-1111-1111-1111-111111111111', repeat('b',64));
$q$, 'clinician cannot self-grant access');
RESET ROLE;

SELECT pg_temp.ok(pg_temp.count_as('phi_app', '{"role":"clinician","actor":"11111111-1111-1111-1111-111111111111"}',
       'SELECT count(*) FROM clinical_data.biomarker_events') = 2, 'consented clinician sees exactly patient A (2 events), not B');
SELECT pg_temp.ok(pg_temp.count_as('phi_app', '{"role":"clinician","actor":"33333333-3333-3333-3333-333333333333"}',
       'SELECT count(*) FROM clinical_data.biomarker_events') = 0, 'a different clinician sees nothing');

DO $$ BEGIN
  SET LOCAL ROLE phi_app;
  PERFORM set_config('app.role','patient',true);
  PERFORM set_config('app.subject_id', repeat('a',64), true);
  UPDATE clinical_data.care_relationships SET revoked_at = now();
  RESET ROLE;
END $$;
SELECT pg_temp.ok(pg_temp.count_as('phi_app', '{"role":"clinician","actor":"11111111-1111-1111-1111-111111111111"}',
       'SELECT count(*) FROM clinical_data.biomarker_events') = 0, 'revoked consent removes clinician access');

-- 4. Audit log ------------------------------------------------------------------------
DO $$ BEGIN
  SET LOCAL ROLE phi_app;
  INSERT INTO audit.audit_logs (actor_role, operation, action, resource_type) VALUES ('patient','READ','sync.pull','biomarker_events');
  RESET ROLE;
  RAISE NOTICE 'pass: phi_app can append audit rows';
END $$;
SELECT pg_temp.denied($q$ SET LOCAL ROLE phi_app; SELECT * FROM audit.audit_logs $q$, 'phi_app cannot read the audit log');
RESET ROLE;
SELECT pg_temp.denied($q$ SET LOCAL ROLE phi_app; UPDATE audit.audit_logs SET action = 'x' $q$, 'phi_app cannot UPDATE audit rows');
RESET ROLE;
SELECT pg_temp.denied($q$ UPDATE audit.audit_logs SET action = 'x' $q$, 'superuser UPDATE of audit rows blocked by trigger');
SELECT pg_temp.denied($q$ DELETE FROM audit.audit_logs $q$, 'superuser DELETE of audit rows blocked by trigger');
SELECT pg_temp.denied($q$ TRUNCATE audit.audit_logs $q$, 'TRUNCATE of audit log blocked');
SELECT pg_temp.ok(pg_temp.count_as('audit_reader', '{}', 'SELECT count(*) FROM audit.audit_logs') = 1, 'audit_reader can read audit rows');
SELECT pg_temp.denied($q$ SET LOCAL ROLE phi_app;
  INSERT INTO audit.audit_logs (actor_role, operation, action, resource_type, ip_hash) VALUES ('patient','READ','x','y','10.0.0.1') $q$,
  'raw (non-hash) IP address is rejected');
RESET ROLE;

-- 5. Zone separation --------------------------------------------------------------------------
SELECT pg_temp.denied($q$ SET LOCAL ROLE phi_app; SELECT * FROM identity_vault.users $q$, 'phi_app cannot touch the identity vault');
RESET ROLE;
SELECT pg_temp.denied($q$ SET LOCAL ROLE identity_app; SELECT * FROM clinical_data.biomarker_events $q$, 'identity_app cannot read PHI');
RESET ROLE;
SELECT pg_temp.denied($q$ SET LOCAL ROLE identity_app;
  INSERT INTO identity_vault.users (email_hash, encrypted_pii, role) VALUES (repeat('e',64), 'plaintext name', 'patient') $q$,
  'vault rejects PII that is not an encrypted envelope');
RESET ROLE;

-- 6. Engine worker ------------------------------------------------------------------------------
SELECT pg_temp.ok(pg_temp.count_as('engine_worker', '{}', 'SELECT count(*) FROM clinical_data.biomarker_events') = 3, 'engine_worker reads all events');
SELECT pg_temp.denied($q$ SET LOCAL ROLE engine_worker;
  INSERT INTO clinical_data.biomarker_events (subject_id, event_id, device_id, lamport, client_ts, kind, op, log_date, payload, payload_hash)
  VALUES (repeat('a',64), gen_random_uuid(), gen_random_uuid(), 9, now(), 'BBT', 'SET', '2025-03-09', '{}', repeat('4',64)) $q$,
  'engine_worker cannot write events');
RESET ROLE;
DO $$ BEGIN
  SET LOCAL ROLE engine_worker;
  INSERT INTO clinical_data.prediction_runs (subject_id, algorithm_version, input_hash, anovulatory_pattern_suspected)
  VALUES (repeat('a',64), 'biochem-1.0.0', repeat('5',64), false);
  RESET ROLE;
  RAISE NOTICE 'pass: engine_worker can store predictions';
END $$;
SELECT pg_temp.denied($q$ SET LOCAL ROLE engine_worker; UPDATE clinical_data.prediction_runs SET algorithm_version = 'tampered' $q$, 'engine_worker cannot rewrite prediction provenance');
RESET ROLE;
DO $$ BEGIN
  SET LOCAL ROLE engine_worker;
  INSERT INTO clinical_data.predictions (run_id, subject_id, log_date, status, flags, reasoning)
  SELECT run_id, subject_id, '2025-03-01', 'LOW', '[]', '[]' FROM clinical_data.prediction_runs WHERE subject_id = repeat('a',64);
  RESET ROLE;
  RAISE NOTICE 'pass: engine_worker can store prediction days';
END $$;
SELECT pg_temp.denied($q$ SET LOCAL ROLE engine_worker; DELETE FROM clinical_data.predictions $q$, 'engine_worker cannot delete predictions');
RESET ROLE;

-- 7. GDPR erasure ------------------------------------------------------------------------------------
SELECT pg_temp.denied($q$ SET LOCAL ROLE phi_app; SELECT clinical_data.erase_subject(repeat('a',64)) $q$, 'phi_app cannot call erase_subject');
RESET ROLE;
SELECT pg_temp.ok(clinical_data.erase_subject(repeat('a',64)) = 2, 'erase_subject removes subject A events');
SELECT pg_temp.ok((SELECT count(*) FROM clinical_data.biomarker_events WHERE subject_id = repeat('a',64)) = 0, 'no events remain for A');
SELECT pg_temp.ok((SELECT count(*) FROM clinical_data.prediction_runs WHERE subject_id = repeat('a',64)) = 0, 'prediction runs erased for A');
SELECT pg_temp.ok((SELECT count(*) FROM clinical_data.predictions WHERE subject_id = repeat('a',64)) = 0, 'prediction days erased for A (cascade-safe)');
SELECT pg_temp.ok((SELECT count(*) FROM clinical_data.biomarker_events WHERE subject_id = repeat('b',64)) = 1, 'subject B untouched');

ROLLBACK;
\echo ALL RLS TESTS PASSED
