-- 004: immutable audit log of every read/write of PHI.
-- ip_hash is a keyed HMAC (never a raw address). Writers may only INSERT.

CREATE TABLE audit.audit_logs (
  audit_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id      uuid,                                   -- NULL for the engine worker
  actor_role    text NOT NULL CHECK (actor_role IN ('patient', 'clinician', 'admin', 'engine')),
  ip_hash       text CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  operation     text NOT NULL CHECK (operation IN ('READ', 'WRITE')),
  action        text NOT NULL,                          -- e.g. sync.push
  resource_type text NOT NULL,
  resource_id   text,
  subject_id    text,                                   -- pseudonym of the data subject
  request_id    text,
  outcome       text NOT NULL DEFAULT 'SUCCESS' CHECK (outcome IN ('SUCCESS', 'DENIED', 'ERROR'))
);
CREATE INDEX audit_logs_subject_idx ON audit.audit_logs (subject_id, occurred_at);
CREATE INDEX audit_logs_actor_idx   ON audit.audit_logs (actor_id, occurred_at);

CREATE FUNCTION audit.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is immutable (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit.audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_mutation();

REVOKE ALL ON audit.audit_logs FROM PUBLIC;
GRANT INSERT ON audit.audit_logs TO phi_app, engine_worker;
GRANT SELECT ON audit.audit_logs TO audit_reader;

ALTER TABLE audit.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_insert ON audit.audit_logs FOR INSERT TO phi_app, engine_worker WITH CHECK (true);
CREATE POLICY audit_read   ON audit.audit_logs FOR SELECT TO audit_reader USING (true);
