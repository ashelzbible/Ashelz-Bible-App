# API reference (summary)

All endpoints are JSON under `/api`, authenticated with `Authorization: Bearer <token>` unless noted. Errors: `{ "error": { "code", "message", "details"? }, "requestId" }`. Ids are UUIDs. Unknown or forbidden resources both return `404`.

## Auth
`POST /auth/register`, `POST /auth/login` (`mfaCode` when enabled), `POST /auth/logout`, `POST /auth/verify`, `POST /auth/verify/resend`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/appeal` (suspended users)
`POST /me/password`, `POST /me/mfa/setup|enable|disable`

## Account
`GET|PATCH /me`, `GET|PATCH /me/settings` (`baseVersion`; `409 version_conflict`), `GET /me/export`, `DELETE /me`, `GET /devices`, `DELETE /devices/:id`, `GET /notifications`, `POST /notifications/read`, `GET /push/config`, `POST /push/subscribe|unsubscribe`

## People
`GET /users/:id`, `GET /users/search?q=`, `POST /contacts/sync`, `GET /contacts`, `PUT|DELETE /contacts/:id`, `GET /blocks`, `PUT|DELETE /blocks/:id`, `POST /reports`

## Conversations
`GET /conversations`, `GET /conversations/:id`, `POST /conversations/direct`, `POST /groups` (`kind: group|channel`), `PATCH /conversations/:id`, `PATCH /conversations/:id/state`, `PUT /conversations/:id/draft`, `POST /conversations/:id/clear|leave|read|delivered`
Members: `GET|POST /conversations/:id/members`, `PATCH|DELETE /conversations/:id/members/:userId`
Invites: `POST|GET /conversations/:id/invites`, `DELETE /invites/:id`, `GET /invites/:code`, `POST /invites/:code/join`
Folders: `GET|POST /folders`, `DELETE /folders/:id`

## Messages
`POST /conversations/:id/messages` (`clientMsgId` makes it idempotent), `GET /conversations/:id/messages?before=|after=&limit=`
`PATCH /messages/:id`, `GET /messages/:id/edits`, `DELETE /messages/:id?scope=me|all`, `PUT /messages/:id/reaction|star|pin`, `POST /messages/:id/forward|vote`
`GET /starred`, `GET /conversations/:id/pinned`, `POST|GET|DELETE /conversations/:id/scheduled`, `/scheduled/:id`
Kinds: text, image, video, voice, audio, document, location, contact, sticker, gif, poll, event (system messages are server-only).

## Media
`POST /media` (multipart `kind`, `file`, optional `durationMs`, `waveform`), `POST /media/urls` (batch signed URLs), `GET /media/:id/content?u&e&t&s` (signed), `DELETE /media/:id`, `GET /media?conversationId&kind`, `GET /storage/usage`

## Status, calls, communities, search
`POST /status`, `GET /status`, `GET /status/mine`, `POST /status/:id/view|react|reply`, `PUT /status/mute/:userId`, `DELETE /status/:id`
`GET /calls/ice`, `POST /calls`, `POST /calls/:id/accept|decline|cancel|end|media_up|failed`, `GET /calls`, `GET /calls/active`
`POST|GET /communities`, `GET /communities/discover`, `GET /communities/:id`, `POST /communities/:id/join|leave|announce|invites|groups`, `POST /communities/:id/groups/:cid/join`, `POST /channels/:id/subscribe`
`GET /search`, `GET|DELETE /search/recent`, `GET /link-preview?url=`
`PUT /keys/device`, `GET /keys/users/:id`, `GET /keys/transparency/:id`
`GET /ai/status`, `POST /ai/draft` (disabled unless configured)

## Admin (staff only)
`/admin/stats|users|reports|appeals|audit|flags|jobs|security-events` and actions (`suspend`, `unsuspend`, `role`, `reports/:id/action`, `appeals/:id/resolve`, `flags/:key`).

## WebSocket `/ws`
Client first sends `{t:"auth", token, lastEventId?}` (5 s timeout). Server replies `{t:"ready", userId, deviceId, latestEventId, resync, replayed, online[]}` then streams:
- `{t:"event", id, type, payload}`: durable events (`message.new|update|delete|hide|reactions|star`, `poll.votes`, `receipt`, `conversation.update|state|cleared`, `settings.update`, `profile.update`, `status.*`, `call.incoming|state`, `devices.update`, `security.new_login`, `blocks.update`)
- ephemeral: `typing`, `presence`, `call.signal`, `call.ack`, `pong`, `error`
Client may send `ping`, `typing {conversationId,state}`, `call.signal {callId,signal}`, `call.action {callId,action,reqId}`.
Close codes: `4401` auth required/invalid, `4001` session or device revoked, `4429` flooding.
