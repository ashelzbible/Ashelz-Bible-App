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


## TURN (calls across different networks)

Calls go phone to phone when they can. Behind mobile data (carrier NAT) or strict Wi-Fi they need a TURN relay. Pick one:

1. **Cloudflare Realtime TURN** (credentials API). Create a TURN key in the Cloudflare dashboard (Realtime → TURN), then set
   `ICE_API_URL=https://rtc.live.cloudflare.com/v1/turn/keys/<TURN_KEY_ID>/credentials/generate-ice-servers` and `ICE_API_TOKEN=<TURN key API token>`.
   Wazzupp calls it from the server (the token never reaches the browser), refreshes every 30 minutes and drops the port-53 URLs that browsers time out on.
   Check Cloudflare's current pricing and whether your account needs a card before relying on it.
2. **Metered** (credentials API). Create an app at metered.ca, then set `ICE_API_URL=https://<yourapp>.metered.live/api/v1/turn/credentials?apiKey=<API_KEY>` and leave `ICE_API_TOKEN` empty. The URL holds a key, so keep it in the host's secret settings only.
3. **Metered Open Relay "static auth"** (no account). It speaks the same coturn shared-secret scheme Wazzupp already uses:
   `TURN_URLS=turn:staticauth.openrelay.metered.ca:80,turn:staticauth.openrelay.metered.ca:443,turns:staticauth.openrelay.metered.ca:443?transport=tcp` and `TURN_SECRET=<the shared secret published on metered.ca/tools/openrelay>`.
   That secret is public, so anyone can use the relay and it is rate-limited: fine for trying calls, not for production.
4. **Your own coturn** with `use-auth-secret`: `TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349` and `TURN_SECRET=<static-auth-secret>`.

Never commit these values; set them in the host's environment settings. `GET /api/calls/ice` reports `turnConfigured: true` once credentials are loaded.

**Test it:** put one phone on mobile data and the other on Wi-Fi (or a different Wi-Fi), place a video call, and check that audio and video flow both ways. Without TURN this commonly fails.

## Phone numbers

A phone number is an optional, **unverified** contact detail. No SMS codes are sent, an unverified number cannot be used to sign in, and other people cannot find you by it. An email address is required whenever verification is on. Real SMS verification needs a paid SMS provider (for example Twilio on a paid account); plug it into `server/src/lib/mailer.ts` where the `sms` channel is sent.
