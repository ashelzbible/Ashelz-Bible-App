# Deployment

## Environment variables

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | enables production checks (secrets required, dev outbox disabled) |
| `DATABASE_URL` | PostgreSQL connection string |
| `URL_SIGNING_SECRET` | **required in production**, >= 32 random chars; signs media URLs, wraps TOTP seeds |
| `PUBLIC_URL`, `CORS_ORIGINS` | origin allow-list for WebSocket/CORS |
| `TRUST_PROXY=true` | behind a reverse proxy (correct client IPs for rate limits) |
| `REDIS_URL` | enables multi-instance fan-out, presence and shared rate limiting |
| `SMTP_URL`, `MAIL_FROM` | verification/reset/new-login email (without it, mail only lands in the `outbox` table) |
| `MEDIA_DIR`, `STORAGE_QUOTA_BYTES` | local object storage root and per-user quota |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push (generate with `npx web-push generate-vapid-keys`) |
| `STUN_URLS`, `TURN_URLS`, `TURN_SECRET` | ICE servers; `TURN_SECRET` is coturn's `static-auth-secret` |
| `REQUIRE_VERIFICATION` | default `true` |
| `ANTHROPIC_API_KEY` | optional AI drafting (also needs the `ai_tools` flag) |
| `ADMIN_EMAILS` | emails that become `admin` on registration (bootstrap) |
| `PORT`, `HOST` | listen address |

## Production checklist

1. Run behind TLS (WebRTC, service workers, push and microphone/camera require HTTPS). Terminate TLS at a proxy that upgrades `/ws`.
2. Set `URL_SIGNING_SECRET`, `DATABASE_URL`, `PUBLIC_URL`, `TRUST_PROXY`, SMTP, VAPID keys.
3. Deploy coturn (`use-auth-secret`, `static-auth-secret=$TURN_SECRET`) and set `TURN_URLS`. Without TURN, calls fail behind symmetric NATs/corporate firewalls.
4. `npm ci && npm run build:web && npm start`. Migrations run at boot under an advisory lock; multiple instances are safe.
5. Back up PostgreSQL and the media directory. For multiple app servers replace `LocalStorage` (implement `Storage` in `server/src/lib/storage.ts`, e.g. S3-compatible with presigned URLs) or use a shared volume.
6. Plug a malware scanner with `setScanner` (e.g. ClamAV) before enabling public uploads.
7. Monitor `/healthz` (liveness) and `/readyz` (DB/Redis). Logs are structured JSON with credentials redacted.
8. Create the first admin: register with an email in `ADMIN_EMAILS`, or `update users set role='admin' where username='...'`.

## Not provided

Docker/Kubernetes manifests, CI, Sentry-style error reporting, S3 driver, FCM/APNs, SMS gateway, an SFU for group calls, and native app packaging are not included.
