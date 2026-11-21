# Fertility platform — backend and calculation engine

Offline-first, zero-trust backend for a clinical fertility-tracking app.
Built per the master prompt; this README states what exists, how to run it, and — just as
important — what does **not** exist yet.

```
services/biochem-engine/   Python 3.12+ · FastAPI · pure deterministic calculation core
services/api-gateway/      Node 22 · Fastify · Zod · JWT · RBAC · audit · sync endpoints · recalc worker
packages/sync-protocol/    Shared TypeScript: event schemas, Lamport clock, deterministic ordering
apps/pwa/                  Installable offline-first web app (demo phone app), served by the API
deploy/ · Dockerfile · render.yaml   Single-container demo deployment (provisioning, key derivation, Render blueprint)
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
| `hormone_analyzer` | Thresholds come from a versioned **assay profile** (`core/profiles.py`); the default holds the values below. Baseline = mean of a cycle's first 5 readings per analyte. E3G ≥ 1.5 × baseline → rise. LH ≥ 2.5 × baseline **or** ≥ 25 mIU/mL → surge (absolute rule needs no baseline). LH peak = highest value in the first surge episode. PdG ≥ 5.0 µg/mL on 3 consecutive days after the peak → ovulation confirmed. Exact rational arithmetic (`Fraction`), no float drift. |
| `cycle_synthesizer` | Daily status `LOW / HIGH / PEAK / OVULATION_CONFIRMED / INSUFFICIENT_DATA` with machine-readable flags and plain-language reasoning. Each day sees only data dated ≤ that day, so **issued history never changes when later data arrives**. |

Status rules: confirmed (PdG or BBT) ▸ PEAK (LH surge today or yesterday; or egg-white mucus + E3G rise) ▸
HIGH (E3G rise or watery/egg-white mucus) ▸ LOW (mucus or a judgeable E3G reading, no trigger) ▸
INSUFFICIENT_DATA. A temperature alone never yields LOW before a confirmed shift.

### Evidence status of the thresholds

Primary sources read in full: Ecochard 2013 (*Steroids*, author manuscript), Pattnaik 2023 (*Sci Rep*, Inito;
vendor-authored), Bouchard 2019 (*Front Public Health*). Shilaih 2018 (*Biosci Rep*) read through a fetch tool (first ~40 % of
the text). Bouchard 2021 (Mira) abstract only. Sources not obtained are
marked unverified.

| Rule | Status |
|---|---|
| PdG ≥ 5.0 µg/mL on 3 consecutive first-morning days after the LH surge | **Supported by one ultrasound-referenced study.** Ecochard 2013 (107 women, 283 ovulatory cycles): 3-day model, threshold 5 µg/mL — counted after the end of fertile mucus: specificity **1.00**, sensitivity 0.92; after a first positive LH kit (20 mIU/mL): specificity **0.986**, sensitivity **0.72** (only 76 % of cycles reached that LH positive). The abstract's "100 %" holds for the mucus start only. Authors state: no validation set, estimates "can be overly optimistic", European women only, one threshold cannot cover reduced luteal PdG (PCOS, perimenopause). Bouchard 2019 (read in full) adds only weak support: 13 women, 34 cycles, qualitative strips, LH-surge reference; it reports whether a cycle had *any* positive strip (14/17 = 82 % at 5 µg/mL; 59 % at 7), **not** the 3-in-a-row rule's accuracy; its table and text disagree (7 µg/mL column sums to 11/18 vs 10/17 in the text); and its background restates Ecochard as "100 % specificity after the LH surge", which Ecochard's own table does not show (0.986 for the LH start). It has no Mira data. |
| BBT 3-over-6, third reading ≥ 0.20 °C above the coverline | **0.20 °C is consistent with the one paper read** (Shilaih 2018: ≥ 0.2 °C above at least 5 of the preceding 6 days, 3 consecutive days) — but that used wrist *skin* temperature and compares against each of the six days, not their maximum, so the coverline form is a variant. Originator not verified; a "0.3 °C" figure from a search summary was not found in the text. |
| LH ≥ 2.5× baseline or ≥ 25 mIU/mL | **No source uses these values.** Ecochard's LH kit threshold was 20 mIU/mL (20 → specificity 0.95 / sensitivity 0.43 for detecting ovulation; 25 → 0.97 / 0.34). Pattnaik 2023 defines a surge as LH **baseline + 5 mIU/mL**. Thresholds are assay-specific. |
| E3G ≥ 1.5× follicular baseline | **No source uses this reference.** Pattnaik 2023 uses ≥ 1.5× the **previous day**, expects the E3G surge 5–6 days before the LH peak, and reports an early E3G > 100 ng/mL in 20 cycles. |
| Anovulation | Pattnaik 2023 proposes PdG ≥ 2.75× pre-LH baseline within 3 days after the LH surge (100 % / 100 %, n = 100; reference: mid-luteal PdG > 5 µg/mL, **not** ultrasound; vendor-authored). Not implemented. The 2023 international PCOS guideline (Teede et al.) is not read in full. |

Open points the papers raise for the engine (none changed yet — each is a clinical decision):

1. **`≥ 5.0` vs `> 5`.** Ecochard defines positivity as "above" the threshold. The engine uses ≥ (the product spec).
2. **Where PdG counting starts.** Ecochard counts from a first positive LH kit or the end of fertile mucus. The
   engine counts days after the LH *peak*, which is later and so more conservative; a mucus-based start is not implemented.
3. **LH peak = first surge episode** (default profile). Pattnaik reports multiple LH surges before the ovulating one
   in 39 of 55 ovulatory cycles and defines the ovulation day as the *highest* LH value, so the first-episode rule can
   pick a premature surge. The Mira profile already uses the highest-value-then-decline rule instead.
4. **Reduced luteal PdG** (PCOS, perimenopause, luteal-phase deficiency) means a fixed 5 µg/mL can miss ovulation.

Because of this, thresholds are **not hard-coded**: each prediction is computed under a named `AssayProfile`
and stored with the version `biochem-<engine>+<profile>`. Registered profiles:

| Profile | Source | Status |
|---|---|---|
| `spec-provisional-1` (default) | product specification | E3G/LH multiples unsupported by any source; PdG rule supported (Ecochard 2013) |
| `mira-marquette-2021-preliminary` | Bouchard, Fehring & Mu 2021 (*Expert Rev Mol Diagn* 21:1349) | **PRELIMINARY: built from the abstract and highlights only; full text not read** |

The **Mira profile** (the app targets the Mira monitor) uses absolute, device-specific rules: fertile window opens
when E3G **> 150 ng/mL**; LH peak = the cycle's *highest* LH (**> 11 mIU/mL**) followed by **2 consecutive days at
least 50 % lower**; the window stays open **4 days after the confirmed peak**. Because the peak needs the following
two days, it is only known retrospectively; days before confirmation can still be `PEAK` as a *candidate* (LH > 11
today or yesterday), and days after confirmation up to peak + 4 are `HIGH`. Unresolved before relying on it:

* A 2023 Mira case report quotes **100 ng/mL** for the E3G cut-off; this abstract says **150**. Read the full text.
* Whether "> 11 mIU/mL" is strict is ambiguous in the abstract (the engine treats it as strict).
* **No Mira PdG threshold is published there**, so PdG confirmation is **disabled** in this profile; ovulation is
  confirmed by BBT only. Ecochard's 5 µg/mL was measured by ELISA and cannot be assumed to transfer to Mira's PdG.
* Reference was the Clearblue monitor, not ultrasound; 21 women × 3 cycles.

Select a profile with `ASSAY_PROFILE` (worker environment); the default stays `spec-provisional-1`. The engine's
`/v1/analyze` accepts `"profile"` and rejects unknown names (the worker then drops that job and audits an error).
Add a profile only after its thresholds are verified against a source. Profiles cannot yet express Pattnaik's
LH increment (baseline + 5 mIU/mL) or day-over-day E3G ratio.

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
| `POST /api/v1/auth/register` · `POST /api/v1/auth/login` | public | scrypt-hashed passwords; sign-up always creates a patient; 10 attempts/min/IP; returns a short-lived JWT |
| `POST /api/v1/sync/push` | patient | ≤ 500 events; returns `accepted / duplicates / conflicts / server_lamport` |
| `GET  /api/v1/sync/pull?cursor&limit[&patient_id]` | patient; clinician (needs `patient_id` + consent) | events after cursor; latest predictions on the final page |
| `POST /api/v1/consents` · `DELETE /api/v1/consents/:clinicianId` | patient | grant / revoke clinician access |
| `GET /healthz` · `/readyz` | public | liveness / DB readiness |

Event kinds: `BBT`, `HORMONE`, `MUCUS`, `CYCLE` (period start — bounds the engine's analysis window);
ops `SET` / `RETRACT`.

## Run it on your own computer

**Option A: one command (no Docker).** Needs Node 22+, Python 3.12+ and PostgreSQL 14+ installed:
```bash
pip install fastapi uvicorn pydantic     # the engine's runtime
npm run local                            # installs, builds, starts everything
```
Open **http://localhost:8080**, create an account, and log a few days. The script starts a private PostgreSQL in
`.local/` (stopped on Ctrl-C; your data and its secret survive restarts, delete `.local/` to start fresh) and runs the
same provisioning and start script as the hosted demo. To use a database you already have, set `DATABASE_OWNER_URL`
to a login that may create roles. `PORT=9000 npm run local` changes the port, and
`ASSAY_PROFILE=mira-marquette-2021-preliminary npm run local` tries the Mira thresholds. It will not start
PostgreSQL as root; run it as a normal user.

**Option B: Docker.** `docker compose up --build`, then open http://localhost:8080 (placeholder passwords; local use only).

**Using it on a phone while developing:** `http://localhost` works for installing the app on the same computer. A
phone on your Wi-Fi can open it with `HOST=0.0.0.0 npm run local`, but browsers only allow *installing* and offline
mode over https, so use the hosted demo or an https tunnel for that.

Verified: Option A was run from a clean copy as a normal (non-root) user: private database creation, migrations,
the 9-check browser test, restart with data preserved, and clean shutdown. Option B (`docker-compose.yml`) was **not**
run (no Docker daemon was available).

## Android app (APK)

`apps/android/` wraps the web app in a native Android shell with Capacitor (the files are bundled in the app).
Build it with `bash apps/android/build-apk.sh` (needs Node 22, JDK 21 and the Android SDK with `platforms;android-35`
and `build-tools;35.0.0`, `ANDROID_HOME` set), or run the **Build Android APK** workflow under GitHub → Actions and
download the artifact. Result: `apps/android/dist/cycle-tracker-demo-debug.apk` (about 4 MB).

**Install:** copy the APK to the phone, open it, and allow *Install unknown apps* for the app you opened it from
(Android asks). It is a **debug-signed** build for testing: it is not for the Play Store, which needs a release
key. Android may show a "not verified" warning.

**First launch:** the app has no server of its own. Enter the **server address** of a running deployment (for
example your Render address) together with your account details. After the first sign-in the address is remembered,
entries are stored encrypted on the phone, and everything keeps working offline; it syncs when the server is
reachable. **The server must use https**: cleartext `http://` is blocked in this build (it would expose health data on
the network), so a plain `http://192.168.x.x` development server will not work. Auto-backup of the app's data is off.

Not verified: the APK was built and inspected here (package, signature, bundled files, no cleartext, no backup) and
the app's native-mode behaviour (server-address field, different-origin API calls, no service worker) was tested in a
real browser with the Capacitor flag set, but it was **not run on an Android device or emulator**.

## Hosted demo and phone app

The repo includes an installable **web app (PWA)** in `apps/pwa/` that the API serves at `/`, and a one-click
**Render** blueprint. It is a *demo*: free hosting sleeps when idle, and nothing here is validated for real
health data (the page says so).

**Deploy (you need a Render account; I could not create the live URL for you):**
1. Render dashboard → **New → Blueprint** → select this GitHub repo and the branch to deploy.
2. Set the blueprint path to **`fertility-platform/render.yaml`**. It creates one Docker web service and one
   Postgres database; `MASTER_SECRET` is generated for you and every key and database password is derived from it.
3. When the deploy is live, open the `https://….onrender.com` address (first load after idle can take a minute).

**Install on a phone** (needs the https address): Android Chrome → menu → *Install app*; iPhone Safari →
Share → *Add to Home Screen*. It then opens full-screen, works offline, and syncs when back online.

**How it works:** one container runs provisioning (`deploy/provision.mjs`: migrations, then the three restricted
database roles), the Python engine, and the Node API, which also serves the app and runs the recalculation
worker. The database owner login is used only for provisioning; the app connects as the restricted roles.
Try the Mira thresholds by setting `ASSAY_PROFILE=mira-marquette-2021-preliminary` (preliminary, see above).

**The web app vs the final design:** on-device data is AES-256-GCM encrypted in IndexedDB under a key derived from
the user's password (PBKDF2), so it cannot be reset — a forgotten password means the on-device copy is
unrecoverable (the synced server copy remains). The production design calls for React Native with SQLCipher; this
PWA shares the real sync protocol, Lamport ordering code and server API, but not the storage layer.

**Verified here:** the full path (provisioning as a non-superuser `CREATEROLE` login, key derivation, start script,
API + app + worker + engine) was run natively, and `node scripts/e2e-pwa.mjs <url>` drives it in a real phone-sized
browser: register, log days, server predictions, offline logging, offline reload and unlock, resync, a second
device, and ciphertext-only on-device storage (9 checks).
**Not verified:** the `Dockerfile` and `render.yaml` themselves were not built or deployed (no Docker daemon was
available, and I have no Render access). Expect to fix small things on the first deploy — most likely in the
Render database permissions (the provisioner needs a database login that can create roles; it says so if not).

## Not built yet (be aware before relying on this)

* **No password reset or e-mail verification**, no refresh tokens (access tokens last `TOKEN_TTL`, default 1 h; the
  web app silently signs in again while open), and no account lockout beyond the per-IP rate limit.
  Clinician and admin accounts cannot self-register and there is no UI for provisioning them.
* **No React Native/SQLCipher app and no clinic dashboard** (roadmap phase 3); the demo apps (web and Android shell) are patient-only. No
  Cloudflare/AWS gateway config and no CI workflow. TLS 1.3 is assumed to terminate at the edge.
* **No key management.** Keys come from the environment (the demo derives all of them from one `MASTER_SECRET`); there is no KMS integration or rotation
  (the `v1:` ciphertext envelope has no key id yet).
* **Audit log is tamper-resistant, not tamper-proof**: a database superuser could still drop its triggers.
  A hash chain / external WORM sink would close that.
* If a patient retracts *all* biomarker data, or starts a new cycle with no data yet, the previous
  predictions are kept rather than cleared.
* **Clinical validation.** Tests prove the code implements the stated rules on synthetic cycles; they are
  not validation against real cycle datasets. This is not a certified medical device, and HIPAA/GDPR
  compliance also needs organisational controls (BAAs/DPAs, DPIA, access reviews, backups, pen-testing).
