import { Redis } from 'ioredis';
import { config } from '../config.ts';
import { tooMany } from './errors.ts';

interface Store { hit(key: string, windowSec: number): Promise<number>; }

class MemoryStore implements Store {
  private m = new Map<string, { n: number; exp: number }>();
  async hit(key: string, windowSec: number) {
    const now = Date.now();
    const e = this.m.get(key);
    if (!e || e.exp < now) { this.m.set(key, { n: 1, exp: now + windowSec * 1000 }); this.gc(now); return 1; }
    return ++e.n;
  }
  private gc(now: number) { if (this.m.size > 50000) for (const [k, v] of this.m) if (v.exp < now) this.m.delete(k); }
  reset() { this.m.clear(); }
}
class RedisStore implements Store {
  r: Redis;
  constructor(r: Redis) { this.r = r; }
  async hit(key: string, windowSec: number) {
    const k = `wz:rl:${key}`;
    const n = await this.r.incr(k);
    if (n === 1) await this.r.expire(k, windowSec);
    return n;
  }
}

export const memoryStore = new MemoryStore();
let store: Store = memoryStore;
export function useRedisRateLimit(r: Redis) { store = new RedisStore(r); }

/** Throws 429 when `limit` hits per `windowSec` are exceeded for `key`. */
export async function rateLimit(key: string, limit: number, windowSec: number) {
  if (config.rateLimitDisabled) return;
  const n = await store.hit(key, windowSec);
  if (n > limit) throw tooMany('rate_limited', 'Too many requests, slow down');
}
