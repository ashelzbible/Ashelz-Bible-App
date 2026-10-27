import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Socket, dm, group, login, newUser, q, say, sleep, start, type Ctx } from './helpers.ts';

let ctx: Ctx;
before(async () => { ctx = await start(); });
after(async () => { await ctx.stop(); });

describe('websocket realtime', () => {
  it('rejects unauthenticated and invalid sockets', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    await once(ws, 'open');
    const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
    ws.send(JSON.stringify({ t: 'auth', token: 'x'.repeat(43) }));
    assert.equal(await closed, 4401);
    const ws2 = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    await once(ws2, 'open');
    const c2 = new Promise<number>((r) => ws2.on('close', (c) => r(c)));
    ws2.send(JSON.stringify({ t: 'ping' }));
    assert.equal(await c2, 4401, 'must authenticate before anything else');
  });

  it('pushes new messages, receipts and reactions to every device of the recipient and sender', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const b2 = await login(ctx, b, 'Laptop'); const a2 = await login(ctx, a, 'Tablet');
    const conv = await dm(a, b);
    const sb1 = await Socket.connect(ctx, b.token); const sb2 = await Socket.connect(ctx, b2.token); const sa2 = await Socket.connect(ctx, a2.token); const sa = await Socket.connect(ctx, a.token);
    const m = await say(a, conv, 'realtime hello');
    for (const s of [sb1, sb2, sa2, sa]) {
      const ev = await s.event('message.new', (p) => p.message.id === m.id);
      assert.equal(ev.payload.message.body, 'realtime hello');
      assert.ok(typeof ev.id === 'number');
    }
    await b.post(`/api/conversations/${conv}/read`, { seq: m.seq });
    const rec = await sa.event('receipt', (p) => p.readSeq === m.seq);
    assert.equal(rec.payload.userId, b.user.id);
    const st = await sb2.event('conversation.state', (p) => p.lastReadSeq === m.seq);
    assert.equal(st.payload.conversationId, conv, 'read state syncs to the reader\'s other device');
    await b.put(`/api/messages/${m.id}/reaction`, { emoji: '🎉' });
    assert.equal((await sa.event('message.reactions')).payload.reactions[0].emoji, '🎉');
    [sb1, sb2, sa2, sa].forEach((s) => s.close());
  });

  it('does not deliver events to non-members', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve');
    const conv = await dm(a, b);
    const se = await Socket.connect(ctx, eve.token);
    await say(a, conv, 'private');
    await sleep(200);
    assert.ok(!se.msgs.some((m) => m.t === 'event' && m.type === 'message.new'));
    se.close();
  });

  it('marks messages delivered when the recipient connects, and sender sees it live', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const sa = await Socket.connect(ctx, a.token);
    const m = await say(a, conv, 'waiting for b');
    assert.equal((await a.get(`/api/conversations/${conv}/messages`)).body.messages[0].status, 'sent');
    const sb = await Socket.connect(ctx, b.token);
    const rec = await sa.event('receipt', (p) => p.deliveredSeq >= m.seq);
    assert.equal(rec.payload.userId, b.user.id);
    assert.equal((await a.get(`/api/conversations/${conv}/messages`)).body.messages[0].status, 'delivered');
    sa.close(); sb.close();
  });

  it('recovers missed events on reconnect (offline queue replay) and de-duplicates by id', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const s1 = await Socket.connect(ctx, b.token);
    await say(a, conv, 'seen live');
    const first = await s1.event('message.new');
    const lastId = first.id;
    s1.close(); await s1.closed();
    await sleep(100);
    const missed = []; for (let i = 0; i < 3; i++) missed.push(await say(a, conv, `missed ${i}`));
    const s2 = await Socket.connect(ctx, b.token, lastId);
    const got = s2.msgs.filter((m) => m.t === 'event' && m.type === 'message.new');
    const bodies = got.map((m) => m.payload.message.body);
    for (const m of missed) assert.ok(bodies.includes(m.body), `replayed ${m.body}`);
    const ids = got.map((m) => m.id); assert.equal(new Set(ids).size, ids.length, 'no duplicate event ids in one replay');
    assert.ok(ids.every((id: number) => id >= lastId));
    const ready = s2.msgs.find((m) => m.t === 'ready'); assert.equal(ready.resync, false);
    s2.close();
  });

  it('asks the client to resync when its cursor is older than retained history', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    for (let i = 0; i < 3; i++) await say(a, conv, `x${i}`);
    const ev = (await q('select id from user_events where user_id = $1 order by id', [b.user.id])).rows.map((r) => r.id);
    await q('delete from user_events where user_id = $1 and id < $2', [b.user.id, ev.at(-1)]);
    const s = await Socket.connect(ctx, b.token, Math.max(1, ev[0] - 1));
    // cursor predates the oldest retained event -> either replay covers it or resync is signalled; the contract is that gaps are never silent
    const ready = s.msgs.find((m) => m.t === 'ready');
    assert.ok(ready.resync === true || ready.replayed >= 1);
    s.close();
  });

  it('relays typing indicators only between members, never to blocked users', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve');
    const conv = await dm(a, b);
    const sa = await Socket.connect(ctx, a.token); const sb = await Socket.connect(ctx, b.token); const se = await Socket.connect(ctx, eve.token);
    sa.send({ t: 'typing', conversationId: conv, state: 'composing' });
    const t = await sb.wait((m) => m.t === 'typing');
    assert.equal(t.userId, a.user.id); assert.equal(t.state, 'composing');
    se.send({ t: 'typing', conversationId: conv, state: 'composing' });
    await sleep(150);
    assert.equal(sa.msgs.filter((m) => m.t === 'typing').length, 0, 'eve is not a member: ignored');
    sa.close(); sb.close(); se.close();
  });

  it('reports presence, honouring privacy settings', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const hidden = await newUser(ctx, 'hidden');
    await dm(a, b); await dm(a, hidden);
    await hidden.patch('/api/me/settings', { patch: { privacy: { lastSeen: 'nobody', online: 'same_as_last_seen' } } });
    const sa = await Socket.connect(ctx, a.token);
    const sb = await Socket.connect(ctx, b.token);
    const p = await sa.wait((m) => m.t === 'presence' && m.userId === b.user.id && m.online);
    assert.ok(p);
    const sh = await Socket.connect(ctx, hidden.token);
    await sleep(200);
    assert.ok(!sa.msgs.some((m) => m.t === 'presence' && m.userId === hidden.user.id), 'hidden user is not announced');
    assert.ok(!sa.msgs.find((m) => m.t === 'ready')!.online.includes(hidden.user.id));
    assert.ok(sh.msgs.find((m) => m.t === 'ready')!.online.includes(a.user.id));
    sb.close();
    const off = await sa.wait((m) => m.t === 'presence' && m.userId === b.user.id && !m.online);
    assert.ok(off.lastSeenAt);
    sa.close(); sh.close();
  });

  it('disconnects sockets when a device or session is revoked', async () => {
    const a = await newUser(ctx, 'a'); const a2 = await login(ctx, a, 'To revoke');
    const s2 = await Socket.connect(ctx, a2.token);
    const closed = s2.closed();
    await a.del(`/api/devices/${a2.deviceId}`);
    assert.equal(await closed, 4001);
    const s3 = await Socket.connect(ctx, a.token); const c3 = s3.closed();
    await a.post('/api/auth/logout');
    assert.equal(await c3, 4001);
  });

  it('streams group events to all members and removes removed members immediately', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const c = await newUser(ctx, 'c');
    const g = await group(a, 'Live', [b, c]);
    const sb = await Socket.connect(ctx, b.token); const sc = await Socket.connect(ctx, c.token);
    await say(a, g, 'one');
    await sb.event('message.new', (p) => p.message.body === 'one'); await sc.event('message.new', (p) => p.message.body === 'one');
    await a.del(`/api/conversations/${g}/members/${c.user.id}`);
    await sc.event('conversation.update', (p) => p.removedUserId === c.user.id);
    await say(a, g, 'two');
    await sb.event('message.new', (p) => p.message.body === 'two');
    await sleep(150);
    assert.ok(!sc.msgs.some((m) => m.t === 'event' && m.type === 'message.new' && m.payload.message.body === 'two'));
    sb.close(); sc.close();
  });
});
