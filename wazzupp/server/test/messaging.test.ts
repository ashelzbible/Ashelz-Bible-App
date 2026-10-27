import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dm, group, newUser, q, say, start, type Ctx } from './helpers.ts';
import { sendDueScheduled, sweepExpiredMessages } from '../src/modules/jobs.ts';
import { config } from '../src/config.ts';

let ctx: Ctx;
before(async () => { ctx = await start(); });
after(async () => { await ctx.stop(); });

describe('private messaging', () => {
  it('creates one direct conversation per pair regardless of who starts it', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const c1 = await dm(a, b); const c2 = await dm(b, a); const c3 = await dm(a, b);
    assert.equal(c1, c2); assert.equal(c1, c3);
    assert.equal((await a.post('/api/conversations/direct', { userId: a.user.id })).status, 400);
  });

  it('assigns server ids and gapless increasing seq, and returns history in order', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const sent = [];
    for (let i = 0; i < 5; i++) sent.push(await say(i % 2 ? a : b, conv, `msg ${i}`));
    assert.deepEqual(sent.map((m) => m.seq), [1, 2, 3, 4, 5]);
    const hist = (await a.get(`/api/conversations/${conv}/messages`)).body.messages;
    assert.deepEqual(hist.map((m: any) => m.body), ['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']);
    assert.ok(hist.every((m: any) => /^[0-9a-f-]{36}$/.test(m.id)));
  });

  it('is idempotent: retrying the same clientMsgId never duplicates', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const clientMsgId = randomUUID();
    const r1 = await a.post(`/api/conversations/${conv}/messages`, { clientMsgId, kind: 'text', body: 'once' });
    const r2 = await a.post(`/api/conversations/${conv}/messages`, { clientMsgId, kind: 'text', body: 'once' });
    assert.equal(r1.status, 201); assert.equal(r2.status, 200);
    assert.equal(r1.body.message.id, r2.body.message.id);
    assert.equal(r2.body.duplicate, true);
    assert.equal((await q('select count(*)::int n from messages where conversation_id = $1', [conv])).rows[0].n, 1);
  });

  it('keeps seq unique and gapless under concurrent senders', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    await Promise.all(Array.from({ length: 40 }, (_, i) => say(i % 2 ? a : b, conv, `c${i}`)));
    const seqs = (await q('select seq from messages where conversation_id = $1 order by seq', [conv])).rows.map((r) => r.seq);
    assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('retries concurrent duplicates of the same clientMsgId into one row', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const clientMsgId = randomUUID();
    const rs = await Promise.all(Array.from({ length: 8 }, () => a.post(`/api/conversations/${conv}/messages`, { clientMsgId, kind: 'text', body: 'race' })));
    assert.ok(rs.every((r) => r.status === 200 || r.status === 201));
    assert.equal(new Set(rs.map((r) => r.body.message.id)).size, 1);
    assert.equal((await q('select count(*)::int n from messages where conversation_id = $1', [conv])).rows[0].n, 1);
  });

  it('paginates with cursors in both directions', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    for (let i = 1; i <= 25; i++) await say(a, conv, `m${i}`);
    const p1 = (await b.get(`/api/conversations/${conv}/messages?limit=10`)).body;
    assert.equal(p1.messages.length, 10); assert.equal(p1.hasMore, true);
    assert.equal(p1.messages[0].body, 'm16'); assert.equal(p1.messages[9].body, 'm25');
    const p2 = (await b.get(`/api/conversations/${conv}/messages?limit=10&before=${p1.messages[0].seq}`)).body;
    assert.equal(p2.messages[0].body, 'm6'); assert.equal(p2.messages[9].body, 'm15');
    const p3 = (await b.get(`/api/conversations/${conv}/messages?limit=10&before=${p2.messages[0].seq}`)).body;
    assert.equal(p3.messages.length, 5); assert.equal(p3.hasMore, false);
    const gap = (await b.get(`/api/conversations/${conv}/messages?after=20&limit=50`)).body;
    assert.deepEqual(gap.messages.map((m: any) => m.seq), [21, 22, 23, 24, 25]);
  });

  it('validates content: empty, oversized, bad kinds, bad meta', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const send = (body: any) => a.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), ...body });
    assert.equal((await send({ kind: 'text', body: '   ' })).status, 400);
    assert.equal((await send({ kind: 'text', body: 'x'.repeat(8001) })).status, 400);
    assert.equal((await send({ kind: 'system', body: 'hi' })).status, 400, 'clients cannot forge system messages');
    assert.equal((await send({ kind: 'image' })).status, 400);
    assert.equal((await send({ kind: 'location', meta: { lat: 999, lng: 0 } })).status, 400);
    assert.equal((await send({ kind: 'location', meta: { lat: -26.2, lng: 28.04, label: 'Joburg' } })).status, 201);
    assert.equal((await send({ kind: 'contact', meta: { name: 'Anna Brown', phone: '+264812345678' } })).status, 201);
    assert.equal((await send({ kind: 'gif', meta: { url: 'http://insecure.example/x.gif' } })).status, 400);
    assert.equal((await send({ kind: 'event', meta: { title: 'Braai', startsAt: '2030-01-01T10:00:00Z' } })).status, 201);
  });
});

describe('receipts and unread', () => {
  it('tracks sent -> delivered -> read and unread counts', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const m1 = await say(a, conv, 'one'); const m2 = await say(a, conv, 'two');
    const list = (await b.get('/api/conversations')).body.conversations[0];
    assert.equal(list.unread, 2); assert.equal(list.lastMessage.body, 'two');
    assert.equal((await a.get(`/api/conversations/${conv}/messages`)).body.messages[1].status, 'sent');
    assert.equal((await b.post(`/api/conversations/${conv}/delivered`, { seq: m2.seq })).status, 204);
    assert.equal((await a.get(`/api/conversations/${conv}/messages`)).body.messages[1].status, 'delivered');
    assert.equal((await b.post(`/api/conversations/${conv}/read`, { seq: m1.seq })).status, 200);
    const msgs = (await a.get(`/api/conversations/${conv}/messages`)).body.messages;
    assert.equal(msgs[0].status, 'read'); assert.equal(msgs[1].status, 'delivered');
    assert.equal((await b.get('/api/conversations')).body.conversations[0].unread, 1);
    await b.post(`/api/conversations/${conv}/read`, { seq: 999 });
    assert.equal((await b.get('/api/conversations')).body.conversations[0].unread, 0);
    assert.equal((await a.get('/api/conversations')).body.conversations[0].unread, 0, 'own messages are never unread');
  });
  it('hides read receipts when the reader turned them off', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    assert.equal((await b.patch('/api/me/settings', { patch: { privacy: { readReceipts: false } } })).status, 200);
    const conv = await dm(a, b);
    const m = await say(a, conv, 'private');
    await b.post(`/api/conversations/${conv}/read`, { seq: m.seq });
    assert.equal((await a.get(`/api/conversations/${conv}/messages`)).body.messages[0].status, 'delivered');
    assert.equal((await b.get('/api/conversations')).body.conversations[0].unread, 0, 'but b still sees their own state');
  });
  it('group ticks only advance when every member has the message', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const c = await newUser(ctx, 'c');
    const g = await group(a, 'Trio', [b, c]);
    const m = await say(a, g, 'hello group');
    await b.post(`/api/conversations/${g}/read`, { seq: m.seq });
    const st = async () => (await a.get(`/api/conversations/${g}/messages`)).body.messages.at(-1).status;
    assert.equal(await st(), 'sent');
    await c.post(`/api/conversations/${g}/read`, { seq: m.seq });
    assert.equal(await st(), 'read');
  });
});

describe('message actions', () => {
  it('replies, reacts, edits with history, and respects the edit window', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const m = await say(a, conv, 'original');
    const r = await say(b, conv, 'replying', { replyToId: m.id });
    assert.equal(r.replyTo.id, m.id); assert.equal(r.replyTo.body, 'original');
    assert.equal((await b.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'text', body: 'x', replyToId: randomUUID() })).status, 400);
    const rx = await b.put(`/api/messages/${m.id}/reaction`, { emoji: '🔥' });
    assert.deepEqual(rx.body.reactions.map((x: any) => x.emoji), ['🔥']);
    await b.put(`/api/messages/${m.id}/reaction`, { emoji: '❤️' });
    assert.equal((await a.get(`/api/conversations/${conv}/messages`)).body.messages[0].reactions[0].emoji, '❤️');
    assert.equal((await b.put(`/api/messages/${m.id}/reaction`, { emoji: null })).body.reactions.length, 0);

    assert.equal((await b.patch(`/api/messages/${m.id}`, { body: 'hax' })).status, 403, 'only the sender edits');
    const e1 = await a.patch(`/api/messages/${m.id}`, { body: 'edited once' });
    assert.equal(e1.body.message.body, 'edited once'); assert.ok(e1.body.message.editedAt);
    await a.patch(`/api/messages/${m.id}`, { body: 'edited twice' });
    const hist = (await a.get(`/api/messages/${m.id}/edits`)).body;
    assert.deepEqual(hist.edits.map((x: any) => x.body), ['original', 'edited once']); assert.equal(hist.current, 'edited twice');
    await q(`update messages set created_at = now() - interval '1 hour' where id = $1`, [m.id]);
    assert.equal((await a.patch(`/api/messages/${m.id}`, { body: 'too late' })).status, 403);
  });

  it('deletes for me (only me) and for everyone (tombstone, reactions cleared)', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const m1 = await say(a, conv, 'keep for a'); const m2 = await say(a, conv, 'delete for all');
    assert.equal((await b.del(`/api/messages/${m1.id}?scope=me`)).status, 204);
    assert.deepEqual((await b.get(`/api/conversations/${conv}/messages`)).body.messages.map((m: any) => m.body), ['delete for all']);
    assert.equal((await a.get(`/api/conversations/${conv}/messages`)).body.messages.length, 2);
    await b.put(`/api/messages/${m2.id}/reaction`, { emoji: '👍' });
    assert.equal((await b.del(`/api/messages/${m2.id}?scope=all`)).status, 403, 'recipient cannot delete for everyone');
    assert.equal((await a.del(`/api/messages/${m2.id}?scope=all`)).status, 204);
    const after = (await b.get(`/api/conversations/${conv}/messages`)).body.messages;
    assert.equal(after[0].deleted, true); assert.equal(after[0].body, '');
    assert.equal((await q('select count(*)::int n from message_reactions where message_id = $1', [m2.id])).rows[0].n, 0);
    assert.equal((await a.patch(`/api/messages/${m2.id}`, { body: 'zombie' })).status, 409);
    config.deleteForAllWindowSeconds = 1;
    const m3 = await say(a, conv, 'old'); await q(`update messages set created_at = now() - interval '1 minute' where id = $1`, [m3.id]);
    assert.equal((await a.del(`/api/messages/${m3.id}?scope=all`)).status, 403, 'delete-for-all window enforced');
    config.deleteForAllWindowSeconds = 48 * 3600;
  });

  it('forwards (marked forwarded), stars, pins (max 3) and votes in polls', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const c = await newUser(ctx, 'c');
    const ab = await dm(a, b); const ac = await dm(a, c);
    const m = await say(a, ab, 'forward me');
    const f = await a.post(`/api/messages/${m.id}/forward`, { conversationIds: [ac] });
    assert.equal(f.body.messages[0].forwarded, true); assert.equal(f.body.messages[0].body, 'forward me');
    assert.equal((await c.post(`/api/messages/${m.id}/forward`, { conversationIds: [ac] })).status, 404, 'c cannot forward a message from a chat they are not in');

    await b.put(`/api/messages/${m.id}/star`, { starred: true });
    assert.equal((await b.get('/api/starred')).body.messages.length, 1);
    assert.equal((await a.get('/api/starred')).body.messages.length, 0, 'stars are private');

    const ids = []; for (let i = 0; i < 4; i++) ids.push((await say(a, ab, `p${i}`)).id);
    for (let i = 0; i < 3; i++) assert.equal((await a.put(`/api/messages/${ids[i]}/pin`, { pinned: true })).status, 200);
    assert.equal((await a.put(`/api/messages/${ids[3]}/pin`, { pinned: true })).status, 409);
    assert.equal((await b.get(`/api/conversations/${ab}/pinned`)).body.messages.length, 3);

    const poll = await say(a, ab, '', { kind: 'poll', meta: { question: 'Which day?', options: ['Mon', 'Tue', 'Wed'], multi: false } });
    assert.equal((await b.post(`/api/messages/${poll.id}/vote`, { options: [1] })).body.votes.length, 1);
    assert.equal((await b.post(`/api/messages/${poll.id}/vote`, { options: [0, 1] })).status, 400, 'single choice');
    assert.equal((await b.post(`/api/messages/${poll.id}/vote`, { options: [7] })).status, 400);
    await a.post(`/api/messages/${poll.id}/vote`, { options: [1] });
    const votes = (await a.get(`/api/conversations/${ab}/messages`)).body.messages.find((x: any) => x.id === poll.id).votes;
    assert.equal(votes.filter((v: any) => v.option === 1).length, 2);
  });

  it('mentions are validated against membership', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const out = await newUser(ctx, 'out');
    const g = await group(a, 'Team', [b]);
    const m = await say(a, g, '@b @out', { mentions: [b.user.id, out.user.id] });
    assert.deepEqual(m.mentions, [b.user.id]);
    assert.equal((await b.get('/api/conversations')).body.conversations[0].unreadMentions, 1);
  });

  it('disappearing messages are hidden at expiry and tombstoned by the sweeper', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    assert.equal((await a.patch(`/api/conversations/${conv}`, { disappearingSeconds: 3600 })).status, 200);
    const m = await say(a, conv, 'ephemeral');
    assert.ok(m.expiresAt);
    await q(`update messages set expires_at = now() - interval '1 second' where id = $1`, [m.id]);
    assert.equal((await b.get(`/api/conversations/${conv}/messages`)).body.messages.filter((x: any) => x.body === 'ephemeral').length, 0, 'hidden immediately');
    assert.ok(await sweepExpiredMessages() >= 1);
    assert.ok((await q('select deleted_for_all_at from messages where id = $1', [m.id])).rows[0].deleted_for_all_at);
    assert.equal((await q('select body from messages where id = $1', [m.id])).rows[0].body, '');
  });

  it('schedules a message and delivers it when due', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    assert.equal((await a.post(`/api/conversations/${conv}/scheduled`, { body: 'past', sendAt: new Date(Date.now() - 1000).toISOString() })).status, 400);
    const r = await a.post(`/api/conversations/${conv}/scheduled`, { body: 'later', sendAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(r.status, 201);
    await q(`update scheduled_messages set send_at = now() - interval '1 second' where id = $1`, [r.body.id]);
    await sendDueScheduled();
    await sendDueScheduled();
    assert.equal((await b.get(`/api/conversations/${conv}/messages`)).body.messages.filter((m: any) => m.body === 'later').length, 1);
  });
});

describe('blocking', () => {
  it('blocked users cannot reach the blocker, and nothing reveals the block', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    await say(a, conv, 'before');
    assert.equal((await b.put(`/api/blocks/${a.user.id}`)).status, 204);
    const sent = await a.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'text', body: 'after block' });
    assert.equal(sent.status, 201, 'sender sees a normal send');
    assert.equal((await a.get(`/api/conversations/${conv}/messages`)).body.messages.at(-1).status, 'sent', 'but it is never delivered');
    assert.deepEqual((await b.get(`/api/conversations/${conv}/messages`)).body.messages.map((m: any) => m.body), ['before']);
    assert.equal((await b.get('/api/conversations')).body.conversations[0].unread, 1, 'only the pre-block message counts');
    assert.equal((await a.get(`/api/users/${b.user.id}`)).status, 404, 'the blocker is invisible to the blocked user');
    assert.equal((await a.post('/api/calls', { conversationId: conv, kind: 'audio' })).status, 403);
    const r = await b.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'text', body: 'hi' });
    assert.equal(r.status, 403); assert.equal(r.body.error.code, 'unblock_to_send');
    assert.equal((await b.del(`/api/blocks/${a.user.id}`)).status, 204);
    assert.deepEqual((await b.get(`/api/conversations/${conv}/messages`)).body.messages.map((m: any) => m.body), ['before'], 'messages sent during the block stay hidden');
  });
  it('a blocked user cannot start a new conversation with the blocker', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    await b.put(`/api/blocks/${a.user.id}`);
    assert.equal((await a.post('/api/conversations/direct', { userId: b.user.id })).status, 404);
  });
});

describe('search, drafts, state', () => {
  it('searches only authorized conversations, with filters', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const spy = await newUser(ctx, 'spy');
    const conv = await dm(a, b);
    await say(a, conv, 'Meeting at 11am in the boardroom'); await say(b, conv, 'Lunch plans'); await say(a, conv, 'see https://example.com/doc');
    assert.equal((await b.get('/api/search?q=boardroom')).body.messages.length, 1);
    assert.equal((await spy.get('/api/search?q=boardroom')).body.messages.length, 0);
    assert.equal((await spy.get(`/api/search?q=boardroom&conversationId=${conv}`)).body.messages.length, 0);
    assert.equal((await b.get('/api/search?q=example&kind=link')).body.messages.length, 1);
    assert.equal((await b.get('/api/search?q=100%25')).body.messages.length, 0, 'LIKE wildcards are escaped');
    assert.ok((await b.get('/api/search/recent')).body.terms.includes('boardroom'));
    await b.patch('/api/me', { displayName: 'Sarah Johnson' });
    assert.equal((await a.get('/api/search?q=Sarah&type=chats')).body.chats.length, 1);
  });
  it('syncs per-user state with versioning and rejects stale writes', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const s1 = await a.patch(`/api/conversations/${conv}/state`, { pinned: true, archived: true, mutedUntil: 'forever' });
    assert.equal(s1.body.conversation.pinned, true); assert.equal(s1.body.conversation.muted, true);
    const v = s1.body.conversation.version;
    assert.equal((await a.patch(`/api/conversations/${conv}/state`, { favorite: true, baseVersion: v })).status, 200);
    assert.equal((await a.patch(`/api/conversations/${conv}/state`, { favorite: false, baseVersion: v })).status, 409);
    assert.equal((await b.get('/api/conversations')).body.conversations[0].pinned, false, 'state is per user');
    await a.put(`/api/conversations/${conv}/draft`, { draft: 'half-written' });
    assert.equal((await a.get('/api/conversations')).body.conversations[0].draft, 'half-written');
    assert.equal((await b.get('/api/conversations')).body.conversations[0].draft, null);
    await a.patch(`/api/conversations/${conv}/state`, { archived: true, mutedUntil: null });
    await say(b, conv, 'unarchives');
    assert.equal((await a.get('/api/conversations')).body.conversations[0].archived, false);
  });
  it('clears a chat for one user only', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    await say(a, conv, 'one'); await say(a, conv, 'two');
    assert.equal((await b.post(`/api/conversations/${conv}/clear`)).status, 204);
    assert.equal((await b.get(`/api/conversations/${conv}/messages`)).body.messages.length, 0);
    assert.equal((await a.get(`/api/conversations/${conv}/messages`)).body.messages.length, 2);
    await say(a, conv, 'three');
    assert.deepEqual((await b.get(`/api/conversations/${conv}/messages`)).body.messages.map((m: any) => m.body), ['three']);
  });
});
