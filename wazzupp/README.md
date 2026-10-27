# Wazzupp

**Connect. Communicate. Collaborate.** A cross-device messaging and calling platform: real-time chat, groups, communities and channels, status updates, voice and video calls, media sharing, multi-device sync, notifications and a trust-and-safety console.

> Wazzupp is an independent product. It is not affiliated with WhatsApp or any other messaging brand, and uses no third-party trademarks or assets.

This directory is a self-contained workspace inside the repository. The existing Ashelz Bible App (the static site at the repository root) is untouched.

**Read [docs/CHECKLIST.md](docs/CHECKLIST.md) first.** It lists exactly what is built and tested, and what is not (native apps, E2EE, group calls, mobile push providers, ...).

## Stack

| Layer | Choice |
|---|---|
| Web client (responsive PWA) | React 19 + TypeScript + Vite, hand-written CSS design system (`web/src/styles`), lucide icons, Inter |
| API | Node 22 + Fastify + Zod validation, TypeScript run natively (type-checked with `tsc`) |
| Database | PostgreSQL 16 (forward-only SQL migrations, `server/src/db/migrations`) |
| Realtime | WebSocket (`ws`) + durable per-user event log for replay; optional Redis fan-out/presence/rate limiting |
| Calls | WebRTC (perfect negotiation), STUN/TURN with time-limited credentials, signalling over the authenticated WebSocket |
| Storage | Private object storage interface; local-disk driver included, access only via short-lived HMAC-signed URLs |
| Jobs | Postgres queue (`SKIP LOCKED`, exponential backoff, dead-letter) |
| Auth | Argon2id, opaque revocable session tokens (hashed at rest), TOTP MFA, per-device sessions |

## Quick start (development)

Requirements: Node >= 22.18, PostgreSQL >= 14 (with `pg_trgm`, `citext`, `pgcrypto`), optional Redis.

```bash
cd wazzupp
npm install
createdb wazzupp            # or set DATABASE_URL
npm run build:web           # builds the client into web/dist
npm start                   # migrates the DB and serves API + client on :8787
```

Open http://localhost:8787. In development the verification screen shows your 6-digit code from the **development mail outbox** (this endpoint does not exist when `NODE_ENV=production`). Configure `SMTP_URL` to send real mail.

For live client development run `npm run dev:server` and `npm run dev:web` (Vite proxies `/api` and `/ws`).

Optional demo data (synthetic accounts, made-up conversations): `node scripts/seed-demo.mjs` against a **development** server. Log in as `alex` / `demo-password-123`.

## Tests

```bash
npm run typecheck   # server + web
npm test            # 95 API/integration/realtime/security tests against a real Postgres (TEST_DATABASE_URL)
npm run build:web && npm run e2e   # browser end-to-end: two Chromium instances, real WebRTC call
```

Test database defaults to `postgres://wazzupp:wazzupp@127.0.0.1:5432/wazzupp_test` (it is dropped and recreated by the suite).

## Documentation

- [docs/CHECKLIST.md](docs/CHECKLIST.md): feature-by-feature status, test evidence, remaining work
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, data model, realtime/sync protocol
- [docs/SECURITY.md](docs/SECURITY.md): threat model, what is and is not protected, E2EE plan
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): environment variables, production setup, TURN, push, storage
- [docs/CALLS.md](docs/CALLS.md): call state machine and signalling
- [docs/API.md](docs/API.md): HTTP and WebSocket reference
- [docs/DESIGN.md](docs/DESIGN.md): design tokens and how the UI maps to the reference
