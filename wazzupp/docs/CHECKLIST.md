# Progress checklist (honest status)

Legend: **Done** = implemented and covered by automated tests · **Built** = implemented, verified manually/by screenshot only · **Partial** · **Not done**.

Test evidence at the time of writing (all run in this repository):

| Suite | Command | Result |
|---|---|---|
| Type check (server + web) | `npm run typecheck` | clean |
| Lint | `npm run lint` | 0 errors |
| API / integration / realtime / security | `npm test` | **96 / 96 pass** (real PostgreSQL, real HTTP + WebSocket) |
| Browser end-to-end | `npm run e2e` | **11 / 11 pass** (two real Chromium instances, fake camera/mic) |

## Phase 1: foundation
- [x] Repository inspected; the existing Bible app is untouched (Wazzupp lives in `wazzupp/`; no root file changed, including the integrity-hashed README)
- [x] Design tokens + component system (`web/src/styles`), light and dark themes
- [x] Auth, sessions, devices, PostgreSQL schema + migrations (idempotent re-run tested), documented API

## Phase 2: responsive UI: **Built** (screenshots compared to the reference; see docs/DESIGN.md)
- [x] Desktop (rail + list + conversation + info panel), tablet (split panes), phone (bottom nav, ringed status row, unread badges)
- [x] No horizontal overflow at 360/390/768/820/1180/1440/1920 px across main screens (e2e test)
- [ ] Not pixel-identical: the reference uses stock photographs and a third-party-style logo. Avatars are initials or uploads, and the supplied Wazzupp logo is used.
- [ ] Native iOS/Android/Windows/macOS apps are **not built**; the PWA is installable on all of them. Capacitor/Tauri packaging is the next step.

## Phase 3: messaging core: **Done**
- [x] Register/login/verify email or phone, password reset, MFA (TOTP), lockout, rate limits, new-login alerts, account export and deletion
- [x] Real-time persistent messaging, server ids, gap-free ordering, idempotent send, cursor pagination
- [x] Sent / delivered / read (per-member watermarks, read-receipt privacy), unread counts and marker, typing, presence (privacy-aware)
- [x] Replies, reactions, edits + history, delete for me / for everyone (window enforced), forward, pin (max 3), star, mentions
- [x] Disappearing messages, scheduled messages, drafts (synced), archive/mute/pin/favourite/folders (versioned state), message search, recent searches
- [x] Blocking (silent, no oracle), contacts, discovery rules (opt-in), SSRF-safe link preview endpoint
- [x] Offline outbox with retry and duplicate prevention; reconnect replay; resync when history is pruned
- Not done: link-preview cards in the UI (endpoint exists), GIF search provider, stickers pack, live location (static location messages only)

## Phase 4: media, groups, status
- [x] Uploads with byte-sniffed type validation, size limits, quotas, EXIF stripping, thumbnails, private storage, signed short-lived URLs, Range requests, gallery (media/docs/links)
- [x] Voice notes: record, preview, send, cancel, waveform, speed, seek (e2e: recorded and played in a second browser)
- [x] Groups: roles, permissions, announcement-only, invite links (hashed, expiring, limited, revocable), removal semantics, privacy-respecting adds, polls, events (+.ics)
- [x] Status: text/image/video, audiences, viewers, reactions, replies, mute, expiry enforced at read time
- Not done: video thumbnails/transcoding (needs ffmpeg), PDF inline preview, malware scanning engine (hook only), resumable uploads (a failed voice-note upload stays in preview for retry)

## Phase 5: calls, notifications, devices
- [x] 1:1 voice/video WebRTC calls with server state machine, ringing/accept/decline/cancel/missed, call history, timers only after real connection, mute, camera, flip, output/input selection, screen share (desktop), quality indicator, ICE restart on network loss, TURN credentials
- [x] Device list and revocation (kicks the live socket), multi-device sync of messages/read state/settings (e2e)
- [x] In-app notifications, Web Push with privacy-aware payloads, mute, quiet hours, mentions-override-mute, delivery tracking (unit-tested with an injected sender)
- Not done: **group calls** (needs an SFU such as LiveKit), FCM/APNs mobile push, native incoming-call UI, background audio. **Web Push was not exercised against a real push service** (no VAPID keys in this environment).

## Phase 6: end-to-end encryption: **Not done**
- Public key directory + transparency log only (tested). **Messages are NOT end-to-end encrypted** and the UI says so. Plan in docs/SECURITY.md.

## Phase 7: communities, admin, productivity
- [x] Communities with announcement group, linked groups, member roles, public discovery, invite links; broadcast channels
- [x] Admin console: stats, users, suspend/restore (+appeals), reports with snapshot-only access, feature flags, audit log, job queue health, suspicious sign-ins; no way to read conversations
- [x] Optional AI drafting endpoint (off by default, explicit consent, needs `ANTHROPIC_API_KEY`; **not exercised against the live API**) and polls/events/scheduling
- Not done: AI/translation/transcription UI, shared calendars, group tasks, collaborative notes, business profiles/verification, customer-support inboxes, broadcast lists, message templates, team workspaces

## Phase 8: hardening
- [x] Security headers/CSP, rate limits (memory or Redis), health/ready probes, structured redacted logs, graceful shutdown, durable job queue with backoff
- [ ] Load/performance testing, third-party security review, S3 storage driver, CI pipeline, error-reporting integration, Docker/K8s manifests
- [ ] Redis mode (multi-instance fan-out) is implemented but was **not tested** in this environment's suite
- [ ] Accessibility: labels, roles, focus rings, reduced-motion and keyboard send/escape are in place; a full screen-reader audit has not been done

## Known limitations
- Single-region, single-database design; receipts in very large groups are not throttled.
- Presence for users beyond 1000 direct-chat peers is truncated.
- Email/SMS delivery needs your SMTP/SMS provider; without SMTP codes only reach the `outbox` table (and the dev-only helper).
