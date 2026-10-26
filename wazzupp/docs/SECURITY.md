# Security model

## What is implemented and tested

- Passwords: Argon2id. Constant-work login (a hash is verified even for unknown accounts), per-account lockout (5 failures / 15 min), per-IP and per-identifier rate limits, generic responses for password reset and duplicate registration.
- Sessions: 256-bit opaque tokens, only a SHA-256 hash stored; sliding expiry; instant revocation per device; sockets of revoked sessions are closed. Identity always comes from the session, never from client-supplied ids.
- MFA: TOTP with encrypted-at-rest seeds and replay protection.
- Authorization: every conversation/message/media/status/call endpoint authorises on the server. Non-members get the same `404` as for non-existent ids (no existence oracle). An automated test walks ~30 endpoints with a non-member and asserts no data is read or changed.
- Uploads: type detected from file bytes (never name/header), per-kind size limits, quotas, raster images re-encoded (strips EXIF/GPS), dangerous extensions and active content (SVG/HTML) rejected, malware-scan hook (`setScanner`) with `scan_status` tracked honestly (`unscanned` unless a scanner is plugged in).
- Media delivery: private storage, URLs signed (HMAC) for one user, 5 minute lifetime, access re-checked on every request so removed members lose access immediately.
- Privacy: last seen, online, photo, about, phone, read receipts, group-invite permissions, status audiences, discoverability (off by default; no registration oracle for phone/email). Blocks are silent.
- Link previews: server-side fetch with SSRF protection (private/loopback/link-local ranges, DNS re-check on every redirect, size/time limits). Client renders links with `rel="noopener noreferrer nofollow"`; no remote images are loaded (strict CSP).
- Transport/headers: CSP (`default-src 'self'`), `frame-ancestors 'none'`, nosniff, CORP; WebSocket origin check.
- Notifications: push payloads carry no content when previews are off; the notifications table never stores message text; logs redact credentials.
- Trust & safety: moderators see only content a participant reported (snapshot at report time). There is deliberately no endpoint to browse conversations. Admin actions are audited.
- Account deletion: anonymises the account and erases authored messages and media.

## What is NOT implemented (do not claim otherwise)

- **End-to-end encryption.** Messages are protected in transit by TLS and by access control at rest, but the server can read them. The UI says so. `keys` stores public prekey bundles and a key-transparency log as groundwork only.
- Malware scanning has no engine configured by default.
- Group calls, mobile push (FCM/APNs), SMS delivery, S3 storage, and encrypted backups are not implemented (see CHECKLIST).
- No third-party security audit or penetration test has been performed.

## E2EE plan (separate milestone)

Use a reviewed protocol and library (the Signal protocol via `libsignal`, with sender keys or MLS for groups), device identity keys stored non-extractably on each device, client-side attachment keys, safety-number verification, and key-change notices from the transparency log. Server changes: store ciphertext only, move search/forward/edit semantics to the client, redesign link previews and notification previews, add encrypted backups. Only after an independent review should the product say "end-to-end encrypted".

## Reporting

Report vulnerabilities privately to the operator of your deployment.
