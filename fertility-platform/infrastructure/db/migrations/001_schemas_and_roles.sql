-- 001: schemas and least-privilege roles.
--
-- Three trust zones:
--   identity_vault  PII  (names, contact details) - reachable only by identity_app
--   clinical_data   PHI  (biomarkers, predictions) - reachable by phi_app / engine_worker
--   audit           immutable access log
--
-- Roles are NOLOGIN groups. Operators create login roles per service and GRANT
-- the matching group, e.g.  CREATE ROLE gateway LOGIN PASSWORD '...' IN ROLE phi_app;
-- The application must never connect as the migration/owner role.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['identity_app', 'phi_app', 'engine_worker', 'audit_reader', 'phi_erasure']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS identity_vault;
CREATE SCHEMA IF NOT EXISTS clinical_data;
CREATE SCHEMA IF NOT EXISTS audit;

REVOKE ALL ON SCHEMA identity_vault, clinical_data, audit FROM PUBLIC;

GRANT USAGE ON SCHEMA identity_vault TO identity_app;
GRANT USAGE ON SCHEMA clinical_data  TO phi_app, engine_worker, phi_erasure;
GRANT USAGE ON SCHEMA audit          TO phi_app, engine_worker, audit_reader;
