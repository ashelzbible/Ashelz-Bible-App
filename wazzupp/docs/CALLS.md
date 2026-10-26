# Calls

One-to-one voice and video calls use browser WebRTC with signalling over the authenticated WebSocket.

```
ringing ──accept──► connecting ──both peers report media up──► connected ──► ended
   ├── decline ──► declined         connecting/connected ──► failed | ended
   ├── cancel  ──► cancelled
   └── 45 s timeout ──► missed (+ missed-call notification, + chat log entry)
```

- The server is the source of truth for state. `connected` is set **only** after both participants report their ICE/DTLS connection reached `connected` (`POST /api/calls/:id/media_up`). The UI shows the timer only in that state; "Ringing", "Connecting" and "Reconnecting" are shown honestly.
- Signalling (`call.signal`) is relayed only between participants of a non-terminal call; non-participants get `call_not_found`. Blocked users cannot call.
- Perfect-negotiation pattern (callee is polite), ICE restart once after `disconnected`/`failed` for reconnection after network loss, getStats-based quality indicator.
- Mute, camera on/off, camera flip, audio output/input selection (`setSinkId`), screen sharing on desktop, permission errors with actionable messages.
- ICE: `GET /api/calls/ice` returns STUN plus time-limited TURN credentials (HMAC, 1 hour) when configured.

## Group calls

Not implemented. A full mesh does not scale; production group calls need a selective forwarding unit (LiveKit, mediasoup, Janus...). The data model (`calls`, `call_participants`) already supports multiple participants; the API currently rejects non-direct conversations with `group_calls_unsupported`.

## Background behaviour

Incoming calls ring while a tab/PWA is open; when closed a Web Push "incoming call" is sent if the user has a subscription. Full-screen native incoming-call UI (CallKit / ConnectionService) needs the native apps.
