import { config } from '../config.ts';

export interface IceServer { urls: string[]; username?: string; credential?: string }
let cached: IceServer[] = [];

/**
 * TURN from a provider's credentials API (Cloudflare Realtime TURN, Metered, ...). Set ICE_API_URL; add ICE_API_TOKEN for
 * providers that want a bearer token and a POST (Cloudflare). The URL may contain an API key, so it is treated as a secret.
 * Credentials are fetched on boot and refreshed every 30 minutes, so calls never wait on the provider.
 */
export async function refreshProviderIce(): Promise<void> {
  const { url, token, ttlSeconds } = config.iceApi;
  if (!url) { cached = []; return; }
  try {
    const res = await fetch(url, {
      method: token ? 'POST' : 'GET', signal: AbortSignal.timeout(8000),
      headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : undefined,
      body: token ? JSON.stringify({ ttl: ttlSeconds }) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    const raw: any[] = Array.isArray(j) ? j : Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : [];
    cached = raw.map((s) => ({ urls: ([] as string[]).concat(s.urls ?? s.url ?? []).filter((u) => !/:53(\?|$)/.test(u)), username: s.username, credential: s.credential }))
      .filter((s) => s.urls.length && (!s.urls.some((u) => /^turns?:/.test(u)) || (s.username && s.credential)));
  } catch (e) {
    console.error(JSON.stringify({ level: 'warn', msg: 'ice provider refresh failed', err: String(e) })); // keep the last good credentials
  }
}
export const providerIce = () => cached;
export const providerHasTurn = () => cached.some((s) => s.urls.some((u) => /^turns?:/.test(u)));
export function startIceRefresh() {
  if (!config.iceApi.url) return;
  void refreshProviderIce();
  setInterval(() => void refreshProviderIce(), 30 * 60 * 1000).unref();
}
