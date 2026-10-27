import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Socket, dm, newUser, say, start, type Ctx } from './helpers.ts';

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
