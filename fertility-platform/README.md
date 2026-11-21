# Fertility platform — backend and calculation engine

Offline-first, zero-trust backend for a clinical fertility-tracking app.
Built per the master prompt; this README states what exists, how to run it, and — just as
important — what does **not** exist yet.

```
services/biochem-engine/   Python 3.12+ · FastAPI · pure deterministic calculation core
services/api-gateway/      Node 22 · Fastify · Zod · JWT · RBAC · audit · sync endpoints · recalc worker
packages/sync-protocol/    Shared TypeScript: event schemas, Lamport clock, deterministic ordering
infrastructure/db/         PostgreSQL migrations (PII / PHI / audit zones, RLS) + adversarial SQL tests
```

## Data flow

```
 phone (SQLCipher, outbox of events, Lamport clock)
   │  POST /api/v1/sync/push   (batched, idempotent by event_id)
   ▼
 api-gateway ── JWT → RBAC → Zod → pseudonym = HMAC(user_id) ──► PostgreSQL (role phi_app, RLS)
   │                                   biomarker_events  (append-only)   audit.audit_logs (same txn)
   │  queue one recalc job per subject
   ▼
 recalc worker (role engine_worker) ── effective state per (kind, date) ─► biochem-engine /v1/analyze
   │                                                                          (pure functions, versioned)
   └──► prediction_runs / predictions (tagged with algorithm_version, input_hash)
 phone ◄── GET /api/v1/sync/pull?cursor=…   events after cursor + latest predictions
```

## Calculation engine (`services/biochem-engine/core`)

All three modules are pure (no I/O, clock or randomness) and never impute missing values.

| Module | Rule implemented |
|---|---|
| `bbt_analyzer` | 3-over-6: six calendar-consecutive valid baseline readings; coverline = their max; next three consecutive readings all above it; third ≥ coverline + 0.20 °C. Excludes fever (> 37.8 °C), flagged sleep disruption, implausible values and ambiguous duplicate dates. Compared in integer hundredths of a degree, so "≥ 0.20" is exact. |
| `hormone_analyzer` | Baseline = mean of a cycle's first 5 readings per analyte. E3G ≥ 1.5 × baseline → rise. LH ≥ 2.5 × baseline **or** ≥ 25 mIU/mL → surge (absolute rule needs no baseline). LH peak = highest value in the first surge episode. PdG ≥ 5.0 µg/mL on 3 consecutive days after the peak → ovulation confirmed. Exact rational arithmetic (`Fraction`), no float drift. |
| `cycle_synthesizer` | Daily status `LOW / HIGH / PEAK / OVULATION_CONFIRMED / INSUFFICIENT_DATA` with machine-readable flags and plain-language reasoning. Each day sees only data dated ≤ that day, so **issued history never changes when later data arrives**. |

Status rules: confirmed (PdG or BBT) ▸ PEAK (LH surge today or yesterday; or egg-white mucus + E3G rise) ▸
HIGH (E3G rise or watery/egg-white mucus) ▸ LOW (mucus or a judgeable E3G reading, no trigger) ▸
INSUFFICIENT_DATA. A temperature alone never yields LOW before a confirmed shift.

Design decisions you may want to review clinically:
* "Consecutive" means calendar-consecutive. A fever/disrupted day inside the 6-day baseline blocks that
  candidate shift rather than being skipped — the strict reading of "no guessing".
* LH surge alone → `PEAK` (master prompt). The architecture note says "E3G rise *followed by* LH surge";
  say if you want PEAK to require both.
* Ovulation is reported as a 2-day window before the first high temperature, not a point estimate.
* `anovulatory_pattern_suspected` is a cycle-level hint (≥ 35 days of data, no surge, no shift); it is
  not a diagnosis.

## Security model

* **Pseudonymisation** — `subject_id = HMAC-SHA256(PSEUDONYM_KEY, user_id)`, computed in the gateway,
  never stored in the vault. A database-only breach cannot join identity to health data.
* **Three database zones, three login roles** — `identity_app` (vault), `phi_app` (gateway),
  `engine_worker` (recalculation), plus `audit_reader`. No role crosses zones.
* **RLS on every PHI table, `FORCE`d** — patients see only their pseudonym; clinicians only patients with
  an active, patient-granted consent; admins see no PHI; unset session context returns nothing.
  Session settings are transaction-local so pooled connections cannot leak identity.
* **Immutability** — events, predictions and audit rows are append-only by privilege *and* trigger.
* **Audit** — every PHI read/write (and every denial) writes `audit.audit_logs` in the *same transaction*:
  if the audit row can't be written, the operation doesn't happen. IPs are stored as keyed hashes.
* **Field encryption** — AES-256-GCM, random 96-bit nonce, AAD binds ciphertext to table+column+row.
* **Sync** — idempotent by `event_id`; a reused id with different content is rejected, never overwritten;
  per-subject advisory lock keeps `server_seq` order equal to commit order so cursors can't skip events;
  concurrent edits resolve by `(lamport, device_id, event_id)`, identical on client and server.
* **GDPR erasure** — `clinical_data.erase_subject()` (break-glass; not granted to any app role).

## Run it

```bash
# 1. engine tests (100 % line + branch coverage enforced)
cd services/biochem-engine && pip install -e '.[test]' && pytest

# 2. TypeScript: install, build, test
cd ../.. && npm install && npm run build && npm test

# 3. database: migrate (as the OWNER role) and run the adversarial RLS tests
DATABASE_URL=postgres://owner@localhost/fertility infrastructure/db/migrate.sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infrastructure/db/tests/rls_test.sql

# 4. integration tests (real Postgres + real Python engine); needs a superuser URL
TEST_ADMIN_DATABASE_URL=postgres://postgres@localhost/postgres npm test -w @fertility/api-gateway

# 5. run
ENGINE_TOKEN=… uvicorn app.asgi:app --port 8000        # in services/biochem-engine
node services/api-gateway/dist/main.js                   # API (see .env.example)
node services/api-gateway/dist/worker-main.js            # recalculation worker
```

## API

| Method & path | Roles | Notes |
|---|---|---|
| `POST /api/v1/sync/push` | patient | ≤ 500 events; returns `accepted / duplicates / conflicts / server_lamport` |
| `GET  /api/v1/sync/pull?cursor&limit[&patient_id]` | patient; clinician (needs `patient_id` + consent) | events after cursor; latest predictions on the final page |
| `POST /api/v1/consents` · `DELETE /api/v1/consents/:clinicianId` | patient | grant / revoke clinician access |
| `GET /healthz` · `/readyz` | public | liveness / DB readiness |

Event kinds: `BBT`, `HORMONE`, `MUCUS`, `CYCLE` (period start — bounds the engine's analysis window);
ops `SET` / `RETRACT`.

## Not built yet (be aware before relying on this)

* **No login / token issuance.** The gateway *verifies* HS256 JWTs (`exp`, `iss`, `aud` required) from an
  identity service; `IdentityStore` (encrypted PII, e-mail hash) exists, the HTTP service around it does not.
* **No mobile app or clinic dashboard** (roadmap phase 3), **no Cloudflare/AWS gateway config**, no
  Dockerfiles/compose, no CI workflow. TLS 1.3 is assumed to terminate at the edge.
* **No key management.** Keys come from the environment; there is no KMS integration or rotation
  (the `v1:` ciphertext envelope has no key id yet).
* **Audit log is tamper-resistant, not tamper-proof**: a database superuser could still drop its triggers.
  A hash chain / external WORM sink would close that.
* If a patient retracts *all* biomarker data, or starts a new cycle with no data yet, the previous
  predictions are kept rather than cleared.
* **Clinical validation.** Tests prove the code implements the stated rules on synthetic cycles; they are
  not validation against real cycle datasets. This is not a certified medical device, and HIPAA/GDPR
  compliance also needs organisational controls (BAAs/DPAs, DPIA, access reviews, backups, pen-testing).
