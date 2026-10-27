import './env.ts';
import type { FastifyInstance } from 'fastify';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { buildApp } from '../src/app.ts';
import { migrate } from '../src/db/migrate.ts';
import { pool, q, setPublisher } from '../src/db/pool.ts';
import { hub } from '../src/lib/hub.ts';
import { attachWebSocket } from '../src/ws.ts';
import { config } from '../src/config.ts';
import { memoryStore } from '../src/lib/ratelimit.ts';
import { stopWorker } from '../src/modules/jobs.ts';

export { config, q, pool };

export async function resetDb() {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate(false);
  memoryStore.reset();
}

export interface Ctx { app: FastifyInstance; port: number; stop: () => Promise<void>; }

export async function start(): Promise<Ctx> {
  await resetDb();
  setPublisher((events) => hub.send(events.map((e) => ({ userId: e.userId, msg: { t: 'event', id: e.id, type: e.type, payload: e.payload } }))));
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const ws = attachWebSocket(app.server);
  const port = (app.server.address() as any).port as number;
  return {
    app, port,
    stop: async () => { stopWorker(); ws.close(); await app.close(); await pool.end(); rmSync(process.env.MEDIA_DIR!, { recursive: true, force: true }); },
  };
}

export interface Api { status: number; body: any; headers: Record<string, any>; raw: Buffer }

export class Client {
  ctx: Ctx;
  token = '';
  user: any = null;
  deviceId = '';
  constructor(ctx: Ctx) { this.ctx = ctx; }

  async req(method: string, url: string, body?: unknown, extra: { headers?: Record<string, string>; auth?: boolean; payload?: any } = {}): Promise<Api> {
    const headers: Record<string, string> = { ...(extra.headers ?? {}) };
    if (this.token && extra.auth !== false) headers.authorization = `Bearer ${this.token}`;
    const res = await this.ctx.app.inject({ method: method as any, url, headers: extra.payload || body === undefined ? headers : { 'content-type': 'application/json', ...headers }, payload: extra.payload ?? (body === undefined ? undefined : JSON.stringify(body)) });
    let parsed: any = null;
    try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = null; }
    return { status: res.statusCode, body: parsed, headers: res.headers as any, raw: res.rawPayload };
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, body ?? {});
  put = (url: string, body?: unknown) => this.req('PUT', url, body ?? {});
  patch = (url: string, body?: unknown) => this.req('PATCH', url, body ?? {});
  del = (url: string, body?: unknown) => this.req('DELETE', url, body);

  async upload(file: Buffer, filename: string, kind: string, extra: Record<string, string> = {}) {
    const boundary = '----wz' + randomUUID();
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries({ kind, ...extra })) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`));
    return this.req('POST', '/api/media', undefined, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) });
  }
}

let counter = 0;
export async function newUser(ctx: Ctx, name?: string, opts: { verify?: boolean; password?: string } = {}): Promise<Client> {
  const n = ++counter;
  const username = (name ?? 'user') + n + '_' + Math.random().toString(36).slice(2, 6);
  const c = new Client(ctx);
  const password = opts.password ?? 'correct-horse-battery';
  const res = await c.post('/api/auth/register', { username, password, displayName: name ?? `User ${n}`, email: `${username}@example.test`, deviceName: 'Test device' });
  if (res.status !== 201) throw new Error('register failed ' + JSON.stringify(res.body));
  c.token = res.body.token; c.user = res.body.user; c.deviceId = res.body.deviceId;
  (c as any).password = password; (c as any).email = `${username}@example.test`; (c as any).username = username;
  if (opts.verify !== false) await verifyEmail(c);
  return c;
}

export async function latestCode(userId: string): Promise<string> {
  const r = await q(`select body from outbox where user_id = $1 order by id desc limit 1`, [userId]);
  return /(\d{6})/.exec(r.rows[0].body)![1];
}
export async function verifyEmail(c: Client) {
  const res = await c.post('/api/auth/verify', { kind: 'email', code: await latestCode(c.user.id) });
  if (res.status !== 200) throw new Error('verify failed ' + JSON.stringify(res.body));
  c.user = res.body.user;
}
export async function login(ctx: Ctx, c: Client, deviceName = 'Second device'): Promise<Client> {
  const d = new Client(ctx);
  const res = await d.post('/api/auth/login', { identifier: (c as any).username, password: (c as any).password, deviceName });
  if (res.status !== 200) throw new Error('login failed ' + JSON.stringify(res.body));
  d.token = res.body.token; d.user = res.body.user; d.deviceId = res.body.deviceId;
  (d as any).password = (c as any).password; (d as any).username = (c as any).username;
  return d;
}

export async function dm(a: Client, b: Client): Promise<string> {
  const r = await a.post('/api/conversations/direct', { userId: b.user.id });
  if (r.status !== 200) throw new Error('dm failed ' + JSON.stringify(r.body));
  return r.body.conversation.id;
}
export async function say(c: Client, convId: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await c.post(`/api/conversations/${convId}/messages`, { clientMsgId: randomUUID(), kind: 'text', body, ...extra });
  if (r.status !== 201 && r.status !== 200) throw new Error('send failed ' + JSON.stringify(r.body));
  return r.body.message;
}
export async function group(owner: Client, title: string, members: Client[]): Promise<string> {
  const r = await owner.post('/api/groups', { title, memberIds: members.map((m) => m.user.id) });
  if (r.status !== 201) throw new Error('group failed ' + JSON.stringify(r.body));
  return r.body.conversation.id;
}

// ---- WebSocket test client ----
export class Socket {
  ws: WebSocket;
  msgs: any[] = [];
  waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.resolve(m); return false; } return true; });
    });
  }
  static async connect(ctx: Ctx, token: string, lastEventId?: number): Promise<Socket> {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    await once(ws, 'open');
    const s = new Socket(ws);
    ws.send(JSON.stringify({ t: 'auth', token, lastEventId }));
    await s.wait((m) => m.t === 'ready');
    return s;
  }
  wait(pred: (m: any) => boolean, ms = 3000): Promise<any> {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for ws message; got ' + JSON.stringify(this.msgs.map((m) => m.t + ':' + (m.type ?? ''))))), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  event(type: string, pred: (p: any) => boolean = () => true, ms = 3000) { return this.wait((m) => m.t === 'event' && m.type === type && pred(m.payload), ms); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  closed() { return new Promise<number>((res) => { if (this.ws.readyState === 3) res(0); else this.ws.once('close', (code) => res(code)); }); }
  close() { this.ws.close(); }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 1x1 PNG
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
