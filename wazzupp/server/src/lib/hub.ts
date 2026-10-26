import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { Redis } from 'ioredis';
import { config } from '../config.ts';

export interface Conn { ws: WebSocket; userId: string; deviceId: string; sessionId: string; id: string; }

interface Item { userId: string; msg: unknown }

/**
 * Realtime fan-out. Local sockets are delivered directly; with REDIS_URL set, events are also published
 * on a Redis channel so every API instance delivers to its own sockets. Presence uses TTL keys in Redis,
 * or local socket counts otherwise.
 */
class Hub {
  private conns = new Map<string, Set<Conn>>();
  private origin = randomUUID();
  private pub?: Redis;
  private sub?: Redis;

  async start(redisUrl: string) {
    if (!redisUrl) return;
    this.pub = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
    this.sub = new Redis(redisUrl);
    await this.sub.subscribe('wz:bus');
    this.sub.on('message', (_ch, raw) => {
      try {
        const p = JSON.parse(raw) as { origin: string; items: Item[] };
        if (p.origin === this.origin) return;
        for (const it of p.items) this.deliverLocal(it.userId, it.msg);
      } catch { /* ignore malformed */ }
    });
  }
  get redis() { return this.pub; }
  async stop() { await this.sub?.quit().catch(() => {}); await this.pub?.quit().catch(() => {}); }

  add(c: Conn) { let s = this.conns.get(c.userId); if (!s) this.conns.set(c.userId, (s = new Set())); s.add(c); }
  remove(c: Conn) { const s = this.conns.get(c.userId); if (!s) return; s.delete(c); if (!s.size) this.conns.delete(c.userId); }
  localCount(userId: string) { return this.conns.get(userId)?.size ?? 0; }
  connectionsOf(userId: string) { return [...(this.conns.get(userId) ?? [])]; }

  private deliverLocal(userId: string, msg: unknown, onlyDevice?: string) {
    const s = this.conns.get(userId);
    if (!s) return;
    const raw = JSON.stringify(msg);
    for (const c of s) if (c.ws.readyState === 1 && (!onlyDevice || c.deviceId === onlyDevice)) c.ws.send(raw);
  }

  send(items: Item[]) {
    for (const it of items) this.deliverLocal(it.userId, it.msg);
    if (this.pub && items.length) this.pub.publish('wz:bus', JSON.stringify({ origin: this.origin, items })).catch(() => {});
  }
  toUsers(userIds: string[], msg: unknown) { this.send(userIds.map((userId) => ({ userId, msg }))); }

  async setOnline(userId: string) { await this.pub?.set(`wz:online:${userId}`, '1', 'EX', 75).catch(() => {}); }
  async setOffline(userId: string) { if (!this.localCount(userId)) await this.pub?.del(`wz:online:${userId}`).catch(() => {}); }
  async isOnline(userId: string): Promise<boolean> {
    if (this.localCount(userId) > 0) return true;
    if (!this.pub) return false;
    return (await this.pub.exists(`wz:online:${userId}`).catch(() => 0)) === 1;
  }
  get online() { return this.conns.size; }
}
export const hub = new Hub();
void config;
