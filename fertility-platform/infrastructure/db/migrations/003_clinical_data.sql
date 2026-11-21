-- 003: PHI tables. Rows are keyed only by the pseudonymous subject_id.

CREATE DOMAIN clinical_data.subject_id AS text
  CHECK (VALUE ~ '^[0-9a-f]{64}$');

-- Append-only event log written by offline clients (one event = one mutation).
--   op SET      : the (kind, log_date) value becomes `payload`
--   op RETRACT  : the (kind, log_date) value is withdrawn
-- The effective value of a (kind, log_date) is the event with the greatest
-- (lamport, device_id, event_id), a total order, so every replica and the
-- server converge deterministically without ever rewriting history.
CREATE TABLE clinical_data.biomarker_events (
  server_seq   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id   clinical_data.subject_id NOT NULL,
  event_id     uuid        NOT NULL,
  device_id    uuid        NOT NULL,
  lamport      bigint      NOT NULL CHECK (lamport >= 0),
  client_ts    timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  kind         text        NOT NULL CHECK (kind IN ('BBT', 'HORMONE', 'MUCUS', 'CYCLE')),
  op           text        NOT NULL CHECK (op IN ('SET', 'RETRACT')),
  log_date     date        NOT NULL,
  payload      jsonb       NOT NULL,
  payload_hash text        NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (subject_id, event_id)
);
CREATE INDEX biomarker_events_pull_idx
  ON clinical_data.biomarker_events (subject_id, server_seq);
CREATE INDEX biomarker_events_effective_idx
  ON clinical_data.biomarker_events (subject_id, kind, log_date, lamport DESC, device_id DESC, event_id DESC);

-- Deterministic engine output, tagged with the algorithm version that made it.
CREATE TABLE clinical_data.prediction_runs (
  run_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id        clinical_data.subject_id NOT NULL,
  algorithm_version text        NOT NULL,
  input_hash        text        NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  ovulation_confirmed_on        date,
  anovulatory_pattern_suspected boolean NOT NULL,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  last_computed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, algorithm_version, input_hash)
);
CREATE INDEX prediction_runs_latest_idx
  ON clinical_data.prediction_runs (subject_id, last_computed_at DESC);

CREATE TABLE clinical_data.predictions (
  run_id     uuid NOT NULL REFERENCES clinical_data.prediction_runs (run_id) ON DELETE CASCADE,
  subject_id clinical_data.subject_id NOT NULL,
  log_date   date NOT NULL,
  status     text NOT NULL CHECK (status IN ('LOW', 'HIGH', 'PEAK', 'OVULATION_CONFIRMED', 'INSUFFICIENT_DATA')),
  flags      jsonb NOT NULL,
  reasoning  jsonb NOT NULL,
  PRIMARY KEY (run_id, log_date)
);

-- Patient-granted clinician access (consent). Revocation keeps the row.
CREATE TABLE clinical_data.care_relationships (
  clinician_id uuid NOT NULL,
  subject_id   clinical_data.subject_id NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  PRIMARY KEY (clinician_id, subject_id, granted_at)
);
CREATE UNIQUE INDEX care_relationships_active_idx
  ON clinical_data.care_relationships (clinician_id, subject_id) WHERE revoked_at IS NULL;

-- Work queue for asynchronous recalculation (one pending job per subject).
CREATE TABLE clinical_data.recalc_jobs (
  subject_id   clinical_data.subject_id PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  attempts     integer     NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_error   text
);

-- Biomarker events are immutable. Privileges already withhold UPDATE/DELETE;
-- these triggers are defence in depth. The only exception is the GDPR
-- erasure function below, which runs as phi_erasure and may DELETE.
CREATE FUNCTION clinical_data.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'phi_erasure' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on %.% is not permitted: append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER biomarker_events_immutable
  BEFORE UPDATE OR DELETE ON clinical_data.biomarker_events
  FOR EACH ROW EXECUTE FUNCTION clinical_data.forbid_mutation();
CREATE TRIGGER biomarker_events_no_truncate
  BEFORE TRUNCATE ON clinical_data.biomarker_events
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_data.forbid_mutation();
CREATE TRIGGER predictions_immutable
  BEFORE UPDATE OR DELETE ON clinical_data.predictions
  FOR EACH ROW EXECUTE FUNCTION clinical_data.forbid_mutation();

-- GDPR Art. 17 erasure of a subject's PHI. Not granted to any login role by
-- default: a DBA grants EXECUTE to a break-glass role for a verified request.
CREATE FUNCTION clinical_data.erase_subject(p_subject clinical_data.subject_id)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical_data AS $$
DECLARE n bigint;
BEGIN
  -- predictions are deleted explicitly: an FK cascade would run as the table
  -- owner, not phi_erasure, and be blocked by the append-only trigger.
  DELETE FROM clinical_data.predictions WHERE subject_id = p_subject;
  DELETE FROM clinical_data.prediction_runs WHERE subject_id = p_subject;
  DELETE FROM clinical_data.recalc_jobs WHERE subject_id = p_subject;
  DELETE FROM clinical_data.care_relationships WHERE subject_id = p_subject;
  DELETE FROM clinical_data.biomarker_events WHERE subject_id = p_subject;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION clinical_data.erase_subject(clinical_data.subject_id) FROM PUBLIC;
ALTER FUNCTION clinical_data.erase_subject(clinical_data.subject_id) OWNER TO phi_erasure;
