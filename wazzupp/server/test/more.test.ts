import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Socket, dm, newUser, say, start, type Ctx } from './helpers.ts';
import { config } from '../src/config.ts';
import { refreshProviderIce } from '../src/lib/ice.ts';

let ctx: Ctx;
before(async () => { ctx = await start(); });
after(async () => { await ctx.stop(); });

describe('channels hide who is posting from subscribers', () => {
  it('strips sender identity from lists, events and member lists for subscribers, but not for admins', async () => {
    const owner = await newUser(ctx, 'owner'); const fan = await newUser(ctx, 'fan');
    const ch = (await owner.post('/api/groups', { title: 'Daily Brief', kind: 'channel', isPublic: true })).body.conversation;
    await fan.post(`/api/channels/${ch.id}/subscribe`);
    const sf = await Socket.connect(ctx, fan.token); const so = await Socket.connect(ctx, owner.token);
    const m = await say(owner, ch.id, 'Welcome to the channel');
    const forFan = await sf.event('message.new', (p) => p.message.id === m.id);
    const forOwner = await so.event('message.new', (p) => p.message.id === m.id);
    assert.equal(forFan.payload.message.senderId, null); assert.equal(forOwner.payload.message.senderId, owner.user.id);
    const list = (await fan.get(`/api/conversations/${ch.id}/messages`)).body.messages.find((x: any) => x.id === m.id);
    assert.equal(list.senderId, null);
    assert.equal((await owner.get(`/api/conversations/${ch.id}/messages`)).body.messages.find((x: any) => x.id === m.id).senderId, owner.user.id);
    assert.deepEqual((await fan.get(`/api/conversations/${ch.id}/members`)).body.members, []);
    assert.ok((await owner.get(`/api/conversations/${ch.id}/members`)).body.members.length >= 2);
    await fan.put(`/api/messages/${m.id}/star`, { starred: true });
    assert.equal((await fan.get('/api/starred')).body.messages[0].senderId, null);
    sf.close(); so.close();
  });
});

describe('status sharing and default audiences', () => {
  it('lets viewers forward a status only when the owner allows sharing', async () => {
    const owner = await newUser(ctx, 'owner'); const viewer = await newUser(ctx, 'viewer'); const friend = await newUser(ctx, 'friend');
    await owner.put(`/api/contacts/${viewer.user.id}`, {});
    const vf = await dm(viewer, friend);
    const s1 = (await owner.post('/api/status', { kind: 'text', body: 'shareable thought' })).body.id;
    const fwd = await viewer.post(`/api/status/${s1}/forward`, { conversationIds: [vf] });
    assert.equal(fwd.status, 200); assert.equal(fwd.body.messages[0].body, 'shareable thought'); assert.equal(fwd.body.messages[0].forwarded, true);
    await owner.patch('/api/me/settings', { patch: { privacy: { statusSharing: false } } });
    const s2 = (await owner.post('/api/status', { kind: 'text', body: 'private thought' })).body.id;
    const denied = await viewer.post(`/api/status/${s2}/forward`, { conversationIds: [vf] });
    assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'sharing_disabled');
    assert.equal((await friend.post(`/api/status/${s2}/forward`, { conversationIds: [vf] })).status, 404, 'people outside the audience cannot see it, let alone forward it');
    assert.equal((await viewer.get('/api/status')).body.feed[0].items.find((i: any) => i.id === s2).allowSharing, false);
  });

  it('uses the saved "contacts except" and "only share with" lists as defaults', async () => {
    const owner = await newUser(ctx, 'owner'); const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    for (const u of [a, b]) await owner.put(`/api/contacts/${u.user.id}`, {});
    await owner.patch('/api/me/settings', { patch: { privacy: { statusAudience: 'except', statusExcept: [b.user.id] } } });
    await owner.post('/api/status', { kind: 'text', body: 'not for b' });
    assert.equal((await a.get('/api/status')).body.feed.length, 1); assert.equal((await b.get('/api/status')).body.feed.length, 0);
    await owner.patch('/api/me/settings', { patch: { privacy: { statusAudience: 'only', statusOnly: [] } } });
    assert.equal((await owner.post('/api/status', { kind: 'text', body: 'nobody' })).status, 400, 'an empty "only" list is rejected');
  });
});

describe('starred, events and feedback', () => {
  it('returns who sent a starred message and which chat it is in', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b); const m = await say(b, conv, 'save this');
    await a.put(`/api/messages/${m.id}/star`, { starred: true });
    const st = (await a.get('/api/starred')).body.messages[0];
    assert.equal(st.senderName, b.user.displayName); assert.equal(st.chat.title, b.user.displayName); assert.equal(st.chat.kind, 'direct');
  });
  it('lists upcoming events from my chats only', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve');
    const conv = await dm(a, b);
    const soon = new Date(Date.now() + 86400_000).toISOString(); const old = new Date(Date.now() - 5 * 86400_000).toISOString();
    for (const [title, startsAt] of [['Braai', soon], ['Old thing', old]]) assert.equal((await a.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'event', meta: { title, startsAt } })).status, 201);
    const ev = (await b.get('/api/events')).body.events;
    assert.deepEqual(ev.map((e: any) => e.meta.title), ['Braai']); assert.equal(ev[0].chat.title, a.user.displayName);
    assert.equal((await eve.get('/api/events')).body.events.length, 0);
  });
  it('accepts feedback and rejects empty or oversized input', async () => {
    const a = await newUser(ctx, 'a');
    assert.equal((await a.post('/api/feedback', { kind: 'bug', message: 'The call button does nothing on my tablet' })).status, 201);
    assert.equal((await a.post('/api/feedback', { message: 'x' })).status, 400);
    assert.equal((await a.post('/api/feedback', { message: 'y'.repeat(5000) })).status, 400);
  });
});

describe('sign in with Google', () => {
  const CLIENT = 'test-client.apps.googleusercontent.com';
  const tokens = new Map<string, any>();
  const realFetch = globalThis.fetch;
  before(() => {
    (config as any).googleClientId = CLIENT;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/tokeninfo')) { const t = tokens.get(new URL(u).searchParams.get('id_token')!); return t ? new Response(JSON.stringify(t), { status: 200 }) : new Response('{}', { status: 400 }); }
      return realFetch(url, init);
    }) as typeof fetch;
  });
  after(() => { globalThis.fetch = realFetch; (config as any).googleClientId = ''; });
  const claims = (over: any = {}) => ({ iss: 'https://accounts.google.com', aud: CLIENT, email: 'gina@example.com', email_verified: 'true', name: 'Gina Google', exp: String(Math.floor(Date.now() / 1000) + 600), ...over });
  const tok = (c: any) => { const t = 'tok-' + Math.random().toString(36).slice(2) + 'x'.repeat(20); tokens.set(t, c); return t; };

  it('creates a verified account on first use, signs the same person in again, and rejects bad tokens', async () => {
    const c = new Client(ctx);
    assert.equal((await c.get('/api/auth/config')).body.googleClientId, CLIENT);
    const first = await c.post('/api/auth/google', { credential: tok(claims()) });
    assert.equal(first.status, 201); assert.equal(first.body.user.displayName, 'Gina Google'); assert.equal(first.body.user.emailVerified, true); assert.equal(first.body.user.username, 'gina');
    const again = await c.post('/api/auth/google', { credential: tok(claims()) });
    assert.equal(again.status, 200); assert.equal(again.body.user.id, first.body.user.id);
    assert.equal((await c.post('/api/auth/google', { credential: tok(claims({ aud: 'someone-else' })) })).status, 401, 'token for another app');
    assert.equal((await c.post('/api/auth/google', { credential: tok(claims({ email_verified: 'false', email: 'x@example.com' })) })).status, 401);
    assert.equal((await c.post('/api/auth/google', { credential: tok(claims({ exp: '1' })) })).status, 401);
    assert.equal((await c.post('/api/auth/google', { credential: 'not-a-real-token-at-all-000' })).status, 401);
    // someone else with the same local part gets a different username
    const other = await c.post('/api/auth/google', { credential: tok(claims({ email: 'gina@another.org', name: 'Gina Two' })) });
    assert.equal(other.status, 201); assert.notEqual(other.body.user.username, 'gina');
  });

  it('is off when no client ID is configured, and links to an existing password account by verified email', async () => {
    const pw = await newUser(ctx, 'linker');
    const email = pw.user.email as string;
    const r = await new Client(ctx).post('/api/auth/google', { credential: tok(claims({ email, name: 'Linker' })) });
    assert.equal(r.status, 200); assert.equal(r.body.user.id, pw.user.id);
    (config as any).googleClientId = '';
    assert.equal((await new Client(ctx).post('/api/auth/google', { credential: tok(claims()) })).status, 400);
    (config as any).googleClientId = CLIENT;
  });
});

describe('TURN credentials from a provider API', () => {
  it('fetches Cloudflare-style ICE servers server-side and hands them to signed-in users', async () => {
    const realFetch = globalThis.fetch; let seen: any = null;
    (config as any).iceApi = { url: 'https://rtc.example.test/v1/turn/keys/K/credentials/generate-ice-servers', token: 'secret-token', ttlSeconds: 86400 };
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).startsWith('https://rtc.example.test/')) { seen = init; return new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.example.test:3478'] }, { urls: ['turn:turn.example.test:3478?transport=udp', 'turn:turn.example.test:53?transport=udp', 'turns:turn.example.test:443?transport=tcp'], username: 'u1', credential: 'c1' }] }), { status: 201 }); }
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      await refreshProviderIce();
      assert.equal(seen.method, 'POST'); assert.equal(seen.headers.authorization, 'Bearer secret-token'); assert.equal(JSON.parse(seen.body).ttl, 86400);
      const a = await newUser(ctx, 'ice');
      const r = (await a.get('/api/calls/ice')).body;
      assert.equal(r.turnConfigured, true);
      const turn = r.iceServers.find((s: any) => s.username === 'u1');
      assert.deepEqual(turn.urls, ['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:443?transport=tcp'], 'port 53 is dropped');
      assert.equal(turn.credential, 'c1');
    } finally { globalThis.fetch = realFetch; (config as any).iceApi = { url: '', token: '', ttlSeconds: 86400 }; await refreshProviderIce(); }
  });
});
