export class NetworkError extends Error {}

/** True inside the Android app (Capacitor injects window.Capacitor into its web view). */
export const isNative = () => typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();

const KEY = 'serverUrl';
export function getServerUrl() { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } }
export function setServerUrl(url) { try { localStorage.setItem(KEY, url); } catch { /* private mode: not persisted */ } }

/** "my-demo.onrender.com" or "http://192.168.1.5:8080/x" -> "https://my-demo.onrender.com" / "http://192.168.1.5:8080"; null if unusable. */
export function normalizeServerUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch { return null; }
}

/** Thin fetch wrapper. Network failures throw NetworkError; HTTP errors are returned, not thrown. */
export class Api {
  constructor() { this.token = null; }

  async request(method, path, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    // The web app is served by the API (same origin); the Android app calls the server address the user entered.
    const base = isNative() ? getServerUrl() : '';
    if (isNative() && !base) throw new NetworkError('no server address');
    let res;
    try {
      res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new NetworkError('offline');
    }
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, ok: res.ok, json };
  }

  async register(email, password, fullName) {
    const r = await this.request('POST', '/api/v1/auth/register', { email, password, full_name: fullName });
    if (r.ok) this.token = r.json.token;
    return r;
  }

  async login(email, password) {
    const r = await this.request('POST', '/api/v1/auth/login', { email, password });
    if (r.ok) this.token = r.json.token;
    return r;
  }

  push(events) { return this.request('POST', '/api/v1/sync/push', { events }); }
  pull(cursor, limit = 500) { return this.request('GET', `/api/v1/sync/pull?cursor=${cursor}&limit=${limit}`); }
}
