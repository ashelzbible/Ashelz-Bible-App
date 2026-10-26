# Architecture

```
 Browser / PWA (React) ──HTTPS──► Fastify API ──► PostgreSQL (source of truth)
        ▲   ▲                         │  │
        │   └──── WebSocket /ws ◄─────┘  ├──► Private object storage (signed URLs)
        │            ▲                   ├──► Redis (optional: fan-out, presence, rate limits)
   WebRTC media      │                   └──► Web Push / SMTP
  (peer-to-peer or via TURN)
```

## Server modules (`server/src/modules`)

| Module | Responsibility |
|---|---|
| `auth` | register, verify, login (lockout, MFA), password reset, device-bound sessions, new-login alerts |
| `users` | profile, versioned settings, contacts, blocks, devices, notifications, push subscriptions, reports, export, deletion |
| `conversations` | direct chats, groups, channels, members/roles, invite links, per-user state (pin/mute/archive/folder/draft) |
| `messages` | the single write path (`sendMessage`), receipts, reactions, edits, deletes, forwards, pins, stars, polls |
| `media` | validated uploads, thumbnails, signed delivery with Range support, quotas, gallery |
| `status` | 24 h statuses with audiences, views, reactions, replies, mute |
| `calls` | 1:1 call state machine, ICE configuration, signalling relay |
| `communities` | communities, announcement groups, linked groups, public discovery |
| `search` | authorised message/chat search, recent searches, SSRF-safe link previews |
| `notify` | in-app + web push, privacy-aware payloads, quiet hours, delivery tracking |
| `admin` | staff-only console: users, reports, appeals, flags, audit log, queue health |
| `keys` | public key directory for the future E2EE milestone |
| `jobs` | durable queue and recurring maintenance (expiry, scheduled messages, call timeouts, pruning) |
| `ai` | optional, off by default, explicit-consent drafting |

## Message ordering and idempotency

`sendMessage` runs in one transaction that first locks the conversation row (`FOR UPDATE`), then
1. returns the existing row if `(conversation, sender, clientMsgId)` was already stored (so retries and concurrent duplicates never double-send),
2. validates membership, posting rights, blocks, media ownership and per-kind metadata,
3. allocates `seq = last_seq + 1` (gap-free, server-authoritative order),
4. writes the message and emits events for every member.

## Realtime and recovery

Each domain event is written to `user_events` **inside the same transaction** as the change, then pushed over WebSockets after commit. A client persists the highest event id it saw. On reconnect it sends `lastEventId`; the server replays everything newer (with a 30 s overlap window to cover late commits; clients de-duplicate by id). If the cursor is older than retained history the server answers `resync: true` and the client reloads conversation state and open threads. Receipts are per-member watermarks (`last_delivered_seq`, `read_receipt_seq`); a group tick advances only when every other member has reached it.

Per-user conversation state and settings carry a version; stale writes return `409 version_conflict` (with the current copy for settings).

## Clients

The web client keeps a normalized store (`web/src/lib/store.ts`), applies events idempotently, sends messages optimistically through a durable outbox (`localStorage`, replayed on reconnect with the same `clientMsgId`), and fetches signed media URLs lazily in batches. The same code runs as an installable PWA on Android, iOS, Windows, macOS and Linux. Native wrappers (Capacitor/Tauri) are a packaging step, not yet done.

## Data model

See `server/src/db/migrations/001_core.sql`. Notable choices: receipts are watermarks rather than a row per message per member; reactions, votes and stars are keyed rows; media is referenced by messages and deleted only when unreferenced; `messages.undelivered` hides a message sent after the recipient blocked the sender without revealing the block.
