-- 005: row-level security on every PHI table, plus table privileges.
--
-- The gateway sets, per transaction (set_config(..., is_local => true)):
--   app.role        patient | clinician | admin
--   app.actor_id    authenticated user's uuid
--   app.subject_id  the patient's own pseudonym (patients only)
-- Unset settings yield NULL, every policy comparison is then NULL, and access
-- is denied (fail closed). `admin` matches no policy: admins manage identities,
-- never PHI.

CREATE FUNCTION clinical_data.app_role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.role', true), '') $$;

CREATE FUNCTION clinical_data.app_actor() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.actor_id', true), '')::uuid $$;

CREATE FUNCTION clinical_data.app_subject() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.subject_id', true), '') $$;

-- Is the current actor the subject, or a clinician with an active consent?
CREATE FUNCTION clinical_data.can_read(p_subject text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (clinical_data.app_role() = 'patient' AND p_subject = clinical_data.app_subject())
      OR (clinical_data.app_role() = 'clinician' AND EXISTS (
            SELECT 1 FROM clinical_data.care_relationships cr
             WHERE cr.clinician_id = clinical_data.app_actor()
               AND cr.subject_id = p_subject
               AND cr.revoked_at IS NULL))
$$;

CREATE FUNCTION clinical_data.is_self(p_subject text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT clinical_data.app_role() = 'patient' AND p_subject = clinical_data.app_subject()
$$;

GRANT EXECUTE ON FUNCTION clinical_data.app_role(), clinical_data.app_actor(),
  clinical_data.app_subject(), clinical_data.can_read(text), clinical_data.is_self(text)
  TO phi_app, engine_worker;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['biomarker_events', 'prediction_runs', 'predictions', 'care_relationships', 'recalc_jobs']
  LOOP
    EXECUTE format('REVOKE ALL ON clinical_data.%I FROM PUBLIC', t);
    EXECUTE format('ALTER TABLE clinical_data.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE clinical_data.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ---- phi_app (patients and clinicians, via the gateway) -------------------
GRANT SELECT, INSERT ON clinical_data.biomarker_events TO phi_app;
CREATE POLICY events_read   ON clinical_data.biomarker_events FOR SELECT TO phi_app
  USING (clinical_data.can_read(subject_id));
CREATE POLICY events_insert ON clinical_data.biomarker_events FOR INSERT TO phi_app
  WITH CHECK (clinical_data.is_self(subject_id));

GRANT SELECT ON clinical_data.prediction_runs, clinical_data.predictions TO phi_app;
CREATE POLICY runs_read ON clinical_data.prediction_runs FOR SELECT TO phi_app
  USING (clinical_data.can_read(subject_id));
CREATE POLICY predictions_read ON clinical_data.predictions FOR SELECT TO phi_app
  USING (clinical_data.can_read(subject_id));

GRANT SELECT, INSERT ON clinical_data.care_relationships TO phi_app;
GRANT UPDATE (revoked_at) ON clinical_data.care_relationships TO phi_app;
CREATE POLICY consent_read ON clinical_data.care_relationships FOR SELECT TO phi_app
  USING (clinical_data.is_self(subject_id)
         OR (clinical_data.app_role() = 'clinician' AND clinician_id = clinical_data.app_actor()));
CREATE POLICY consent_grant ON clinical_data.care_relationships FOR INSERT TO phi_app
  WITH CHECK (clinical_data.is_self(subject_id));
CREATE POLICY consent_revoke ON clinical_data.care_relationships FOR UPDATE TO phi_app
  USING (clinical_data.is_self(subject_id))
  WITH CHECK (clinical_data.is_self(subject_id));

GRANT SELECT, INSERT ON clinical_data.recalc_jobs TO phi_app;
GRANT UPDATE (requested_at, locked_until) ON clinical_data.recalc_jobs TO phi_app;
CREATE POLICY jobs_read   ON clinical_data.recalc_jobs FOR SELECT TO phi_app USING (clinical_data.is_self(subject_id));
CREATE POLICY jobs_insert ON clinical_data.recalc_jobs FOR INSERT TO phi_app WITH CHECK (clinical_data.is_self(subject_id));
CREATE POLICY jobs_bump   ON clinical_data.recalc_jobs FOR UPDATE TO phi_app
  USING (clinical_data.is_self(subject_id)) WITH CHECK (clinical_data.is_self(subject_id));

-- ---- engine_worker (internal recalculation worker; separate login) --------
GRANT SELECT ON clinical_data.biomarker_events TO engine_worker;
CREATE POLICY worker_events ON clinical_data.biomarker_events FOR SELECT TO engine_worker USING (true);

GRANT SELECT, INSERT ON clinical_data.prediction_runs TO engine_worker;
GRANT UPDATE (last_computed_at) ON clinical_data.prediction_runs TO engine_worker;
CREATE POLICY worker_runs_read   ON clinical_data.prediction_runs FOR SELECT TO engine_worker USING (true);
CREATE POLICY worker_runs_insert ON clinical_data.prediction_runs FOR INSERT TO engine_worker WITH CHECK (true);
CREATE POLICY worker_runs_touch  ON clinical_data.prediction_runs FOR UPDATE TO engine_worker USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON clinical_data.predictions TO engine_worker;
CREATE POLICY worker_predictions_read   ON clinical_data.predictions FOR SELECT TO engine_worker USING (true);
CREATE POLICY worker_predictions_insert ON clinical_data.predictions FOR INSERT TO engine_worker WITH CHECK (true);

GRANT SELECT, UPDATE, DELETE ON clinical_data.recalc_jobs TO engine_worker;
CREATE POLICY worker_jobs ON clinical_data.recalc_jobs FOR ALL TO engine_worker USING (true) WITH CHECK (true);

-- ---- phi_erasure (owner of erase_subject only) ------------------------------
GRANT SELECT, DELETE ON clinical_data.biomarker_events, clinical_data.prediction_runs,
  clinical_data.recalc_jobs, clinical_data.care_relationships TO phi_erasure;
GRANT SELECT, DELETE ON clinical_data.predictions TO phi_erasure;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['biomarker_events', 'prediction_runs', 'predictions', 'care_relationships', 'recalc_jobs']
  LOOP
    EXECUTE format('CREATE POLICY erasure ON clinical_data.%I FOR ALL TO phi_erasure USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
