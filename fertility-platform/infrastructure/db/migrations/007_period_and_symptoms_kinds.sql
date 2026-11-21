-- 007: two more entry kinds: PERIOD (a bleeding day; cycle starts are derived from runs of these days) and
-- SYMPTOMS (a list of symptom tags for a day). Neither feeds the calculation engine except PERIOD via cycle starts.
ALTER TABLE clinical_data.biomarker_events DROP CONSTRAINT biomarker_events_kind_check;
ALTER TABLE clinical_data.biomarker_events
  ADD CONSTRAINT biomarker_events_kind_check
  CHECK (kind IN ('BBT', 'HORMONE', 'MUCUS', 'CYCLE', 'PERIOD', 'SYMPTOMS'));
