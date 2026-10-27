import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.ts';
import { one, q } from './db/pool.ts';
import { hub, type Conn } from './lib/hub.ts';
import { resolveToken } from './lib/http.ts';
import { canSee } from './lib/users.ts';
import { markAllDelivered } from './modules/messages.ts';
import { callAction, relaySignal } from './modules/calls.ts';
import { HttpError } from './lib/errors.ts';

const inbound = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('typing'), conversationId: z.string().uuid(), state: z.enum(['composing', 'recording', 'paused']) }),
  z.object({ t: z.literal('call.signal'), callId: z.string().uuid(), signal: z.record(z.string(), z.any()) }),
  z.object({ t: z.literal('call.action'), callId: z.string().uuid(), action: z.enum(['accept', 'decline', 'cancel', 'end', 'media_up', 'failed']), reqId: z.string().max(40).optional() }),
]);

/** Who should hear that `userId` came online/offline: direct-chat peers, filtered by that user's privacy settings. */
async function presencePeers(userId: string): Promise<{ peers: string[]; visibleLastSeen: Set<string> }> {
  const { rows } = await q(
    `select distinct o.user_id peer,
            exists(select 1 from contacts c where c.owner_id = $1 and c.contact_id = o.user_id) is_contact,
            exists(select 1 from blocks b where (b.blocker_id = $1 and b.blocked_id = o.user_id) or (b.blocker_id = o.user_id and b.blocked_id = $1)) blocked
       from conversation_members m join conversations c on c.id = m.conversation_id and c.kind = 'direct' join conversation_members o on o.conversation_id = c.id and o.user_id <> $1
      where m.user_id = $1 and m.left_at is null limit 1000`, [userId]);
  const p = await one(`select settings from user_profiles where user_id = $1`, [userId]);
  const peers: string[] = []; const seen = new Set<string>();
  for (const r of rows) {
    if (r.blocked) continue;
    const online = p?.settings?.privacy?.online === 'everyone' ? canSee({ privacy: { lastSeen: 'everyone' } }, 'online', r.is_contact, false) : canSee(p?.settings, 'online', r.is_contact, false);
    if (online) peers.push(r.peer);
    if (canSee(p?.settings, 'lastSeen', r.is_contact, false)) seen.add(r.peer);
  }
  return { peers, visibleLastSeen: seen };
}

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const allowedOrigins = new Set([config.publicUrl, ...config.corsOrigins]);

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) { socket.destroy(); return; }
    const origin = req.headers.origin;
    if (origin && !config.isTest && !allowedOrigins.has(origin) && new URL(origin).host !== req.headers.host) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  const hb = setInterval(() => {
    for (const ws of wss.clients as Set<WebSocket & { alive?: boolean; conn?: Conn }>) {
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
      if (ws.conn) hub.setOnline(ws.conn.userId);
    }
  }, 30_000);
  const revalidate = setInterval(async () => {
    for (const ws of wss.clients as Set<WebSocket & { conn?: Conn }>) {
      const c = ws.conn; if (!c) continue;
      const ok = await one(`select 1 from sessions s join devices d on d.id = s.device_id join users u on u.id = s.user_id where s.id = $1 and s.revoked_at is null and s.expires_at > now() and d.revoked_at is null and u.status = 'active'`, [c.sessionId]).catch(() => ({}));
      if (!ok) ws.close(4001, 'session revoked');
    }
  }, 30_000);
  wss.on('close', () => { clearInterval(hb); clearInterval(revalidate); });

  function onConnection(ws: WebSocket & { alive?: boolean; conn?: Conn }) {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    let conn: Conn | null = null;
    const authTimer = setTimeout(() => { if (!conn) ws.close(4401, 'auth timeout'); }, 5000);
    const memberCache = new Map<string, { at: number; others: string[] | null }>();
    let budget = 60; // messages per 5s window
    const refill = setInterval(() => { budget = 60; }, 5000);

    const send = (m: unknown) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };

    ws.on('message', async (raw) => {
      if (--budget < 0) { ws.close(4429, 'rate limited'); return; }
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(4400, 'bad json'); return; }
      try {
        if (!conn) {
          if (msg?.t !== 'auth' || typeof msg.token !== 'string') { ws.close(4401, 'auth required'); return; }
          const a = await resolveToken(msg.token);
          if (!a) { ws.close(4401, 'invalid session'); return; }
          clearTimeout(authTimer);
          conn = { ws, userId: a.userId, deviceId: a.deviceId, sessionId: a.sessionId, id: randomUUID() };
          ws.conn = conn;
          const first = hub.localCount(a.userId) === 0;
          hub.add(conn);
          await hub.setOnline(a.userId);
          const latest = await one(`select coalesce(max(id),0)::bigint n from user_events where user_id = $1`, [a.userId]);
          // Replay anything the client missed. The overlap window re-sends recent events; clients de-duplicate by id.
          const last = Number.isFinite(Number(msg.lastEventId)) ? Number(msg.lastEventId) : null;
          let resync = false; let replayed = 0;
          if (last !== null) {
            const anchor = await one(`select created_at from user_events where id = $1 and user_id = $2`, [last, a.userId]);
            const oldest = await one(`select min(id)::bigint n from user_events where user_id = $1`, [a.userId]);
            if (!anchor && oldest?.n && last < oldest.n - 1 && last > 0) resync = true; // history pruned: client must reload state
            const rows = await q(
              `select id, type, payload from user_events where user_id = $1 and (id > $2 ${anchor ? `or created_at >= $3::timestamptz - interval '30 seconds'` : ''}) order by id limit 2001`,
              anchor ? [a.userId, last, anchor.created_at] : [a.userId, last]);
            if (rows.rowCount! > 2000) resync = true;
            else for (const r of rows.rows) { send({ t: 'event', id: r.id, type: r.type, payload: r.payload }); replayed++; }
          }
          const { peers } = await presencePeers(a.userId);
          // Presence snapshot of my own peers who are visible to me.
          const onlinePeers: string[] = [];
          const mine = await q(
            `select distinct o.user_id peer, p.settings, exists(select 1 from contacts c where c.owner_id = o.user_id and c.contact_id = $1) is_contact
               from conversation_members m join conversations c on c.id = m.conversation_id and c.kind = 'direct' join conversation_members o on o.conversation_id = c.id and o.user_id <> $1
               join user_profiles p on p.user_id = o.user_id
              where m.user_id = $1 and m.left_at is null limit 500`, [a.userId]);
          for (const r of mine.rows) if (canSee(r.settings, 'online', r.is_contact, false) && (await hub.isOnline(r.peer))) onlinePeers.push(r.peer);
          send({ t: 'ready', userId: a.userId, deviceId: a.deviceId, latestEventId: latest.n, resync, replayed, online: onlinePeers });
          if (first) hub.toUsers(peers, { t: 'presence', userId: a.userId, online: true });
          markAllDelivered(a.userId).catch((e) => console.error('markAllDelivered', e));
          return;
        }
        const m = inbound.safeParse(msg);
        if (!m.success) return;
        const d = m.data;
        switch (d.t) {
          case 'ping': send({ t: 'pong' }); await hub.setOnline(conn.userId); break;
          case 'typing': {
            let c = memberCache.get(d.conversationId);
            if (!c || Date.now() - c.at > 30_000) {
              const { rows } = await q(`select user_id from conversation_members where conversation_id = $1 and left_at is null and not removed`, [d.conversationId]);
              const ids = rows.map((r) => r.user_id as string);
              let others: string[] | null = ids.includes(conn.userId) ? ids.filter((i) => i !== conn!.userId) : null;
              if (others && others.length === 1) { const b = await one(`select 1 from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`, [conn.userId, others[0]]); if (b) others = []; }
              memberCache.set(d.conversationId, (c = { at: Date.now(), others }));
            }
            if (c.others && c.others.length <= 256) hub.toUsers(c.others, { t: 'typing', conversationId: d.conversationId, userId: conn.userId, state: d.state });
            break;
          }
          case 'call.signal': await relaySignal(conn.userId, d.callId, d.signal); break;
          case 'call.action': {
            const call = await callAction(conn.userId, d.callId, d.action);
            send({ t: 'call.ack', reqId: d.reqId, call });
            break;
          }
        }
      } catch (e) {
        if (e instanceof HttpError) send({ t: 'error', code: e.code, message: e.message });
        else { console.error(JSON.stringify({ level: 'error', msg: 'ws handler', err: String(e) })); send({ t: 'error', code: 'internal' }); }
      }
    });

    ws.on('close', async () => {
      clearTimeout(authTimer); clearInterval(refill);
      if (!conn) return;
      hub.remove(conn);
      await q(`update devices set last_seen_at = now() where id = $1`, [conn.deviceId]).catch(() => {});
      if (hub.localCount(conn.userId) === 0) {
        await hub.setOffline(conn.userId);
        const { peers, visibleLastSeen } = await presencePeers(conn.userId).catch(() => ({ peers: [] as string[], visibleLastSeen: new Set<string>() }));
        const now = new Date().toISOString();
        hub.send(peers.map((p) => ({ userId: p, msg: { t: 'presence', userId: conn!.userId, online: false, lastSeenAt: visibleLastSeen.has(p) ? now : null } })));
      }
    });
    ws.on('error', () => {});
  }
  return { wss, close: () => { clearInterval(hb); clearInterval(revalidate); for (const c of wss.clients) c.terminate(); wss.close(); } };
}
