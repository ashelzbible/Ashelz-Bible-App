export class NetworkError extends Error {}

/** Thin fetch wrapper. Network failures throw NetworkError; HTTP errors are returned, not thrown. */
export class Api {
  constructor() { this.token = null; }

  async request(method, path, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
