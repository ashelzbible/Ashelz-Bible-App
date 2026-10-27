import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, PNG, Socket, dm, group, newUser, q, say, sleep, start, type Ctx } from './helpers.ts';
import { remindDueCalls, ringTimeout } from '../src/modules/calls.ts';
import { purgeExpiredStatuses } from '../src/modules/status.ts';
import { setPushSender, type PushPayload } from '../src/modules/notify.ts';
import { runDueJobs } from '../src/modules/jobs.ts';
import { config } from '../src/config.ts';
import { assertPublicUrl, isPrivateAddress } from '../src/lib/ssrf.ts';

let ctx: Ctx;
before(async () => { ctx = await start(); });
after(async () => { await ctx.stop(); });

describe('calls', () => {
  it('runs the full 1:1 state machine and only reaches "connected" when both peers report media', async () => {
    const a = await newUser(ctx, 'caller'); const b = await newUser(ctx, 'callee');
    const conv = await dm(a, b);
    const sa = await Socket.connect(ctx, a.token); const sb = await Socket.connect(ctx, b.token);
    const start = await a.post('/api/calls', { conversationId: conv, kind: 'video' });
    assert.equal(start.status, 201); assert.equal(start.body.call.state, 'ringing');
    const id = start.body.call.id;
    const incoming = await sb.event('call.incoming'); assert.equal(incoming.payload.call.id, id);
    assert.ok(!('state' in {}) );
    assert.equal((await a.post(`/api/calls/${id}/accept`)).status, 409, 'caller cannot accept own call');
    assert.equal((await b.post(`/api/calls/${id}/accept`)).body.call.state, 'connecting');
    await sa.event('call.state', (p) => p.call.state === 'connecting');
    // signalling relay
    sa.send({ t: 'call.signal', callId: id, signal: { type: 'offer', sdp: 'v=0...' } });
    const sig = await sb.wait((m) => m.t === 'call.signal'); assert.equal(sig.signal.type, 'offer'); assert.equal(sig.from, a.user.id);
    // one side reporting media is not enough
    assert.equal((await a.post(`/api/calls/${id}/media_up`)).body.call.state, 'connecting');
    assert.equal((await b.post(`/api/calls/${id}/media_up`)).body.call.state, 'connected');
    await sb.event('call.state', (p) => p.call.state === 'connected');
    await sleep(1100);
    assert.equal((await a.post(`/api/calls/${id}/end`)).body.call.state, 'ended');
    const hist = (await a.get('/api/calls')).body.calls[0];
    assert.equal(hist.direction, 'outgoing'); assert.equal(hist.state, 'ended'); assert.ok(hist.durationSec >= 1);
    assert.equal((await b.get('/api/calls')).body.calls[0].direction, 'incoming');
    const log = (await b.get(`/api/conversations/${conv}/messages`)).body.messages.find((m: any) => m.meta.event === 'call');
    assert.equal(log.meta.state, 'ended');
    assert.equal((await a.post(`/api/calls/${id}/end`)).body.call.state, 'ended', 'ending twice is harmless');
    sa.close(); sb.close();
  });

  it('records declined, cancelled and missed (with notification) outcomes', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    let c = (await a.post('/api/calls', { conversationId: conv, kind: 'audio' })).body.call;
    assert.equal((await b.post(`/api/calls/${c.id}/decline`)).body.call.state, 'declined');
    c = (await a.post('/api/calls', { conversationId: conv, kind: 'audio' })).body.call;
    assert.equal((await a.post(`/api/calls/${c.id}/cancel`)).body.call.state, 'cancelled');
    c = (await a.post('/api/calls', { conversationId: conv, kind: 'audio' })).body.call;
    await ringTimeout(c.id);
    assert.equal((await b.get('/api/calls')).body.calls[0].state, 'missed');
    assert.ok((await b.get('/api/notifications')).body.notifications.some((n: any) => n.kind === 'missed_call'));
    assert.ok(!(await a.get('/api/notifications')).body.notifications.some((n: any) => n.kind === 'missed_call'));
    await ringTimeout(c.id); // already terminal: no change, no duplicate
    assert.equal((await q(`select count(*)::int n from notifications where kind = 'missed_call'`)).rows[0].n, 1);
  });

  it('refuses calls while busy, to blocked users, in groups, and from non-members; strangers cannot touch a call', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve'); const c = await newUser(ctx, 'c');
    const conv = await dm(a, b); const g = await group(a, 'G', [b, c]);
    const call = (await a.post('/api/calls', { conversationId: conv, kind: 'audio' })).body.call;
    assert.equal((await b.post('/api/calls', { conversationId: conv, kind: 'audio' })).status, 409, 'already in a call');
    assert.equal((await a.post('/api/calls', { conversationId: g, kind: 'audio' })).status, 400);
    assert.equal((await eve.post('/api/calls', { conversationId: conv, kind: 'audio' })).status, 404);
    for (const act of ['accept', 'decline', 'end', 'media_up']) assert.equal((await eve.post(`/api/calls/${call.id}/${act}`)).status, 404, act);
    const se = await Socket.connect(ctx, eve.token);
    se.send({ t: 'call.signal', callId: call.id, signal: { type: 'offer', sdp: 'evil' } });
    const err = await se.wait((m) => m.t === 'error'); assert.equal(err.code, 'call_not_found');
    se.close();
    await a.post(`/api/calls/${call.id}/cancel`);
    assert.equal((await b.get('/api/calls/active')).body.call, null);
  });

  it('clears the call log for one user only', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    const c = (await a.post('/api/calls', { conversationId: conv, kind: 'audio' })).body.call;
    await a.post(`/api/calls/${c.id}/cancel`);
    const live = (await a.post('/api/calls', { conversationId: conv, kind: 'audio' })).body.call; // still ringing: must survive a clear
    assert.equal((await a.get('/api/calls')).body.calls.length, 2);
    assert.equal((await a.del('/api/calls')).status, 204);
    const left = (await a.get('/api/calls')).body.calls;
    assert.deepEqual(left.map((x: any) => x.id), [live.id]);
    assert.equal((await b.get('/api/calls')).body.calls.length, 2, "the other person's log is untouched");
    await a.post(`/api/calls/${live.id}/cancel`);
  });

  it('schedules calls, lists them for both people, enforces membership, and sends reminders when due', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve');
    const conv = await dm(a, b);
    const at = new Date(Date.now() + 3600_000).toISOString();
    assert.equal((await a.post('/api/calls/scheduled', { conversationId: conv, kind: 'video', startsAt: new Date(Date.now() - 1000).toISOString() })).status, 400);
    assert.equal((await eve.post('/api/calls/scheduled', { conversationId: conv, kind: 'video', startsAt: at })).status, 404, 'non-members cannot schedule');
    const r = await a.post('/api/calls/scheduled', { conversationId: conv, kind: 'video', startsAt: at, note: 'Project review' });
    assert.equal(r.status, 201);
    const mine = (await a.get('/api/calls/scheduled')).body.scheduled; const theirs = (await b.get('/api/calls/scheduled')).body.scheduled;
    assert.equal(mine.length, 1); assert.equal(mine[0].createdByMe, true); assert.equal(theirs[0].createdByMe, false); assert.equal(theirs[0].other.id, a.user.id);
    assert.equal((await eve.get('/api/calls/scheduled')).body.scheduled.length, 0);
    assert.equal((await eve.del(`/api/calls/scheduled/${r.body.id}`)).status, 404);
    await q(`update scheduled_calls set starts_at = now() - interval '1 second' where id = $1`, [r.body.id]);
    const sa = await Socket.connect(ctx, a.token);
    assert.equal(await remindDueCalls(), 1);
    assert.equal(await remindDueCalls(), 0, 'each reminder fires once');
    assert.equal((await sa.event('call.reminder')).payload.note, 'Project review');
    for (const u of [a, b]) assert.ok((await u.get('/api/notifications')).body.notifications.some((n: any) => n.kind === 'call_reminder'));
    assert.equal((await a.get('/api/calls/scheduled')).body.scheduled.length, 0);
    sa.close();
    const r2 = await a.post('/api/calls/scheduled', { conversationId: conv, kind: 'audio', startsAt: at });
    assert.equal((await b.del(`/api/calls/scheduled/${r2.body.id}`)).status, 204, 'either participant can cancel');
    assert.equal((await a.get('/api/calls/scheduled')).body.scheduled.length, 0);
  });

  it('serves ICE servers, with time-limited TURN credentials when TURN is configured', async () => {
    const a = await newUser(ctx, 'a');
    const stunOnly = (await a.get('/api/calls/ice')).body;
    assert.equal(stunOnly.turnConfigured, false);
    config.ice.turn = ['turn:turn.example.test:3478']; config.ice.turnSecret = 'coturn-shared-secret';
    const t = (await a.get('/api/calls/ice')).body;
    const turn = t.iceServers.find((s: any) => s.credential);
    assert.ok(turn.username.endsWith(`:${a.user.id}`)); assert.ok(Number(turn.username.split(':')[0]) > Date.now() / 1000);
    config.ice.turn = []; config.ice.turnSecret = '';
  });
});

describe('status updates', () => {
  it('shows statuses only to the right audience, records viewers, and enforces expiry', async () => {
    const owner = await newUser(ctx, 'owner'); const friend = await newUser(ctx, 'friend'); const stranger = await newUser(ctx, 'stranger'); const blocked = await newUser(ctx, 'blocked');
    for (const u of [friend, blocked]) await owner.put(`/api/contacts/${u.user.id}`, {});
    await owner.put(`/api/blocks/${blocked.user.id}`);
    const s = await owner.post('/api/status', { kind: 'text', body: 'Good vibes only', background: '#003B32' });
    assert.equal(s.status, 201);
    const feed = (await friend.get('/api/status')).body.feed;
    assert.equal(feed.length, 1); assert.equal(feed[0].items[0].body, 'Good vibes only'); assert.equal(feed[0].allViewed, false);
    assert.equal((await stranger.get('/api/status')).body.feed.length, 0);
    assert.equal((await blocked.get('/api/status')).body.feed.length, 0);
    assert.equal((await stranger.post(`/api/status/${s.body.id}/view`)).status, 404);
    assert.equal((await friend.post(`/api/status/${s.body.id}/view`)).status, 204);
    assert.equal((await friend.get('/api/status')).body.feed[0].allViewed, true);
    await friend.post(`/api/status/${s.body.id}/react`, { emoji: '🔥' });
    const mine = (await owner.get('/api/status/mine')).body.items[0];
    assert.equal(mine.viewers.length, 1); assert.equal(mine.viewers[0].reaction, '🔥');
    const reply = await friend.post(`/api/status/${s.body.id}/reply`, { body: 'Nice one' });
    assert.equal(reply.status, 200); assert.equal(reply.body.message.body, 'Nice one'); assert.match(reply.body.message.meta.statusReply.text, /Good vibes only/); assert.equal(reply.body.message.meta.statusReply.kind, 'text');
    // Expiry is enforced at read time, before any cleanup job runs.
    await q(`update status_updates set expires_at = now() - interval '1 second' where id = $1`, [s.body.id]);
    assert.equal((await friend.get('/api/status')).body.feed.length, 0);
    assert.equal((await friend.post(`/api/status/${s.body.id}/view`)).status, 404);
    assert.equal((await owner.get('/api/status/mine')).body.items.length, 0);
    assert.equal(await purgeExpiredStatuses(), 1);
  });

  it('supports image status with access-controlled media, "only" audiences, mute, and view-receipt privacy', async () => {
    const owner = await newUser(ctx, 'owner'); const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    for (const u of [a, b]) await owner.put(`/api/contacts/${u.user.id}`, {});
    const up = (await owner.upload(PNG, 's.png', 'image')).body.media;
    assert.equal((await owner.post('/api/status', { kind: 'image', mediaId: (await a.upload(PNG, 'x.png', 'image')).body.media.id })).status, 400, 'cannot use another user\'s media');
    const s = (await owner.post('/api/status', { kind: 'image', mediaId: up.id, caption: 'Sunset', audience: 'only', audienceIds: [a.user.id] })).body;
    assert.equal(Object.keys((await a.post('/api/media/urls', { ids: [up.id] })).body.urls).length, 1);
    assert.equal(Object.keys((await b.post('/api/media/urls', { ids: [up.id] })).body.urls).length, 0, 'b is excluded from the audience');
    assert.equal((await b.get('/api/status')).body.feed.length, 0);
    await a.patch('/api/me/settings', { patch: { privacy: { readReceipts: false } } });
    await a.post(`/api/status/${s.id}/view`);
    assert.equal((await owner.get('/api/status/mine')).body.items[0].viewers.length, 1);
    assert.equal(new Date((await owner.get('/api/status/mine')).body.items[0].viewers[0].viewedAt).getTime(), 0, 'owner is not told when');
    await a.put(`/api/status/mute/${owner.user.id}`, { muted: true });
    assert.equal((await a.get('/api/status')).body.feed[0].muted, true);
    assert.equal((await owner.del(`/api/status/${s.id}`)).status, 204);
    assert.equal((await a.get('/api/status')).body.feed.length, 0);
  });
});

describe('notifications', () => {
  it('sends generic push when previews are off, respects mute and quiet hours, tracks delivery', async () => {
    const sent: Array<{ to: string; p: PushPayload }> = [];
    setPushSender(async (sub, payload) => { sent.push({ to: sub.endpoint, p: payload }); });
    const a = await newUser(ctx, 'sender'); const b = await newUser(ctx, 'receiver');
    const conv = await dm(a, b);
    const sub = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } };
    assert.equal((await b.post('/api/push/subscribe', sub)).status, 204);
    assert.equal((await b.post('/api/push/subscribe', { ...sub, endpoint: 'http://insecure.test/x' })).status, 400);

    await say(a, conv, 'Meeting at 11am');
    assert.equal(sent.length, 1); assert.equal(sent[0].p.body, 'Meeting at 11am'); assert.equal(sent[0].p.title, a.user.displayName);
    await b.patch('/api/me/settings', { patch: { notifications: { previews: false } } });
    await say(a, conv, 'Super private text');
    assert.equal(sent[1].p.body, 'New message'); assert.equal(sent[1].p.title, 'Wazzupp');
    assert.ok(!JSON.stringify(sent[1]).includes('private'), 'no content in a generic push');
    await b.patch(`/api/conversations/${conv}/state`, { mutedUntil: 'forever' });
    await say(a, conv, 'muted'); assert.equal(sent.length, 2);
    await b.patch(`/api/conversations/${conv}/state`, { mutedUntil: null });
    const h = new Date().getUTCHours();
    await b.patch('/api/me/settings', { patch: { notifications: { quietHours: { enabled: true, start: `${String(h).padStart(2, '0')}:00`, end: `${String((h + 2) % 24).padStart(2, '0')}:00`, utcOffsetMinutes: 0 } } } });
    await say(a, conv, 'quiet'); assert.equal(sent.length, 2, 'suppressed during quiet hours');
    const states = (await q(`select push_state from notifications where user_id = $1 order by created_at`, [b.user.id])).rows.map((r) => r.push_state);
    assert.deepEqual(states, ['sent', 'sent', 'suppressed']);
    // no message text ever lands in the notifications table
    assert.ok(!(await q(`select payload::text p from notifications where user_id = $1`, [b.user.id])).rows.some((r) => r.p.includes('Meeting')));
    // blocked sender never notifies
    await b.patch('/api/me/settings', { patch: { notifications: { quietHours: { enabled: false } } } });
    await b.put(`/api/blocks/${a.user.id}`); await say(a, conv, 'blocked'); assert.equal(sent.length, 2);
  });

  it('prunes dead subscriptions on 410 and does not notify the sender, and mentions bypass mute', async () => {
    const sent: string[] = [];
    setPushSender(async (sub, p) => { if (sub.endpoint.includes('dead')) { const e: any = new Error('gone'); e.statusCode = 410; throw e; } sent.push(p.tag); });
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const g = await group(a, 'Mentions', [b]);
    await b.post('/api/push/subscribe', { endpoint: 'https://push.example.test/dead1', keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
    await b.post('/api/push/subscribe', { endpoint: 'https://push.example.test/live1', keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
    await a.post('/api/push/subscribe', { endpoint: 'https://push.example.test/sender', keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
    await b.patch(`/api/conversations/${g}/state`, { mutedUntil: 'forever' });
    await say(a, g, 'plain'); assert.equal(sent.length, 0);
    await say(a, g, '@b look', { mentions: [b.user.id] });
    assert.equal(sent.length, 1);
    assert.equal((await q(`select count(*)::int n from push_subscriptions where endpoint like '%dead1'`)).rows[0].n, 0);
    assert.equal((await q(`select count(*)::int n from notifications where user_id = $1`, [a.user.id])).rows[0].n, 0, 'sender gets nothing');
    assert.equal((await b.get('/api/notifications')).body.notifications[0].kind, 'mention');
    assert.equal((await b.post('/api/notifications/read')).status, 204);
    assert.ok((await b.get('/api/notifications')).body.notifications.every((n: any) => n.read));
  });

  it('does not push when the user has a live socket (in-app instead)', async () => {
    const sent: string[] = [];
    setPushSender(async (_s, p) => { sent.push(p.body); });
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    await b.post('/api/push/subscribe', { endpoint: 'https://push.example.test/online', keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
    const sb = await Socket.connect(ctx, b.token);
    await say(a, conv, 'seen in app'); assert.equal(sent.length, 0);
    sb.close(); await sb.closed(); await sleep(100);
    await say(a, conv, 'now offline'); assert.equal(sent.length, 1);
  });
});

describe('communities and channels', () => {
  it('creates communities with an announcement group where only admins can post', async () => {
    const owner = await newUser(ctx, 'owner'); const m = await newUser(ctx, 'member'); const out = await newUser(ctx, 'outsider');
    const c = (await owner.post('/api/communities', { name: 'Neighbourhood', description: 'Our street', visibility: 'private' })).body.community;
    assert.equal(c.role, 'owner'); assert.ok(c.announcementConversationId);
    assert.equal((await out.get(`/api/communities/${c.id}`)).status, 404, 'private communities are invisible');
    assert.equal((await out.post(`/api/communities/${c.id}/join`)).status, 404);
    assert.equal((await out.get('/api/communities/discover?q=Neigh')).body.communities.length, 0);
    const inv = (await owner.post(`/api/communities/${c.id}/invites`)).body;
    assert.equal((await m.post(`/api/invites/${inv.code}/join`)).status, 200);
    const ann = c.announcementConversationId;
    assert.equal((await m.post(`/api/communities/${c.id}/announce`, { body: 'hi all', clientMsgId: randomUUID() })).status, 403);
    assert.equal((await owner.post(`/api/communities/${c.id}/announce`, { body: 'Bin day is Tuesday', clientMsgId: randomUUID() })).status, 201);
    assert.ok((await m.get(`/api/conversations/${ann}/messages`)).body.messages.some((x: any) => x.body === 'Bin day is Tuesday'));
    assert.equal((await out.get(`/api/conversations/${ann}/messages`)).status, 404);
    // promote member -> can announce
    await owner.patch(`/api/communities/${c.id}/members/${m.user.id}`, { role: 'admin' });
    assert.equal((await m.post(`/api/communities/${c.id}/announce`, { body: 'Thanks!', clientMsgId: randomUUID() })).status, 201);
  });

  it('links groups, lets members join linked groups, and supports public discovery', async () => {
    const owner = await newUser(ctx, 'owner'); const m = await newUser(ctx, 'member');
    const c = (await owner.post('/api/communities', { name: 'Open Source Club', visibility: 'public' })).body.community;
    assert.equal((await m.get('/api/communities/discover?q=open')).body.communities.length, 1);
    assert.equal((await m.post(`/api/communities/${c.id}/join`)).status, 200);
    const g = await group(owner, 'Rust study', []);
    assert.equal((await m.post(`/api/communities/${c.id}/groups`, { conversationId: g })).status, 403);
    assert.equal((await owner.post(`/api/communities/${c.id}/groups`, { conversationId: g })).status, 204);
    assert.equal((await m.post(`/api/communities/${c.id}/groups/${g}/join`)).status, 200);
    assert.equal((await m.get(`/api/conversations/${g}`)).status, 200);
    const desc = (await m.get(`/api/communities/${c.id}`)).body.community;
    assert.equal(desc.groups[0].joined, true);
  });

  it('broadcast channels: public discovery, subscribe, owner-only posting', async () => {
    const owner = await newUser(ctx, 'owner'); const fan = await newUser(ctx, 'fan');
    const ch = (await owner.post('/api/groups', { title: 'Wazzupp News', kind: 'channel', isPublic: true })).body.conversation;
    assert.equal(ch.kind, 'channel');
    assert.equal((await fan.get('/api/communities/discover?q=News')).body.channels.length, 1);
    assert.equal((await fan.post(`/api/channels/${ch.id}/subscribe`)).status, 200);
    assert.equal((await fan.post(`/api/conversations/${ch.id}/messages`, { clientMsgId: randomUUID(), kind: 'text', body: 'hello?' })).status, 403);
    await say(owner, ch.id, 'Release 1.0 is out');
    assert.equal((await fan.get(`/api/conversations/${ch.id}/messages`)).body.messages.filter((x: any) => x.kind === 'text').length, 1);
    await owner.patch(`/api/conversations/${ch.id}`, { isPublic: false });
    const late = await newUser(ctx, 'late');
    assert.equal((await late.post(`/api/channels/${ch.id}/subscribe`)).status, 404, 'private channel is not subscribable');
  });
});

describe('administration and trust & safety', () => {
  async function admin() {
    const adm = await newUser(ctx, 'admin');
    await q(`update users set role = 'admin' where id = $1`, [adm.user.id]);
    return adm;
  }
  it('is restricted to staff; ordinary users get 403 and cannot self-promote', async () => {
    const u = await newUser(ctx, 'plain');
    for (const url of ['/api/admin/stats', '/api/admin/users', '/api/admin/reports', '/api/admin/audit', '/api/admin/flags', '/api/admin/jobs']) assert.equal((await u.get(url)).status, 403, url);
    assert.equal((await u.post(`/api/admin/users/${u.user.id}/role`, { role: 'admin' })).status, 403);
    assert.equal((await new Client(ctx).get('/api/admin/stats')).status, 401);
    const adm = await admin();
    assert.equal((await adm.get('/api/admin/stats')).status, 200);
  });

  it('moderates reports using only the reported snapshot, suspends users, audits everything', async () => {
    const adm = await admin(); const bad = await newUser(ctx, 'bad'); const rep = await newUser(ctx, 'reporter'); const innocent = await newUser(ctx, 'innocent');
    const conv = await dm(bad, rep); const priv = await dm(innocent, rep);
    await say(innocent, priv, 'my private chat with the reporter');
    const m = await say(bad, conv, 'abusive message');
    await say(bad, conv, 'earlier context that is not reported');
    assert.equal((await rep.post('/api/reports', { messageId: m.id, reason: 'harassment', details: 'please help' })).status, 201);
    assert.equal((await innocent.post('/api/reports', { messageId: m.id, reason: 'spam' })).status, 404, 'cannot report what you cannot see');
    const reports = (await adm.get('/api/admin/reports')).body.reports;
    assert.equal(reports.length, 1); assert.equal(reports[0].snapshot.body, 'abusive message');
    const text = JSON.stringify((await adm.get('/api/admin/reports')).body) + JSON.stringify((await adm.get('/api/admin/users')).body);
    assert.ok(!text.includes('private chat') && !text.includes('earlier context'), 'admins never see unreported chats');
    // there is simply no endpoint exposing conversations or messages
    for (const url of [`/api/conversations/${conv}`, `/api/conversations/${conv}/messages`, `/api/conversations/${conv}/members`, '/api/admin/messages', `/api/admin/conversations/${conv}`]) assert.ok([403, 404].includes((await adm.get(url)).status), url);
    assert.equal((await adm.post(`/api/admin/reports/${reports[0].id}/action`, { action: 'delete_message', reason: 'abuse' })).status, 200);
    assert.equal((await rep.get(`/api/conversations/${conv}/messages`)).body.messages[0].deleted, true);
    assert.equal((await adm.post(`/api/admin/reports/${reports[0].id}/action`, { action: 'suspend', reason: 'abuse' })).status, 200);
    assert.equal((await bad.get('/api/me')).status, 401, 'sessions revoked');
    const login = await new Client(ctx).post('/api/auth/login', { identifier: (bad as any).username, password: (bad as any).password });
    assert.equal(login.status, 403); assert.equal(login.body.error.code, 'account_suspended');
    // appeal -> accepted
    assert.equal((await new Client(ctx).post('/api/auth/appeal', { identifier: (bad as any).username, password: (bad as any).password, message: 'I am sorry, it will not happen again.' })).status, 204);
    const appeal = (await adm.get('/api/admin/appeals')).body.appeals[0];
    await adm.post(`/api/admin/appeals/${appeal.id}/resolve`, { accept: true });
    assert.equal((await new Client(ctx).post('/api/auth/login', { identifier: (bad as any).username, password: (bad as any).password })).status, 200);
    const audit = (await adm.get('/api/admin/audit')).body.events.map((e: any) => e.action);
    assert.ok(audit.includes('report.delete_message') && audit.includes('report.suspend') && audit.includes('appeal.accept'));
    assert.equal((await adm.post(`/api/admin/users/${adm.user.id}/suspend`, { reason: 'self harm test' })).status, 403, 'staff cannot be suspended by this path');
  });

  it('toggles feature flags (audited) that take effect immediately', async () => {
    const adm = await admin(); const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    await adm.put('/api/admin/flags/calls_enabled', { enabled: false });
    assert.equal((await a.post('/api/calls', { conversationId: conv, kind: 'audio' })).status, 403);
    await adm.put('/api/admin/flags/calls_enabled', { enabled: true });
    assert.equal((await a.post('/api/calls', { conversationId: conv, kind: 'audio' })).status, 201);
    await adm.put('/api/admin/flags/registration_open', { enabled: false });
    assert.equal((await new Client(ctx).post('/api/auth/register', { username: 'latecomer', password: 'correct-horse-battery', displayName: 'L', email: 'late@example.test' })).status, 403);
    await adm.put('/api/admin/flags/registration_open', { enabled: true });
  });

  it('reports queue health: failed jobs retry with backoff then dead-letter', async () => {
    const adm = await admin();
    await q(`insert into background_jobs(kind, payload, max_attempts) values ('does_not_exist', '{}', 2)`);
    await runDueJobs();
    const j = (await q(`select state, attempts, run_at > now() backoff from background_jobs where kind = 'does_not_exist'`)).rows[0];
    assert.equal(j.state, 'queued'); assert.equal(j.attempts, 1); assert.equal(j.backoff, true);
    await q(`update background_jobs set run_at = now() where kind = 'does_not_exist'`); await runDueJobs();
    assert.equal((await q(`select state from background_jobs where kind = 'does_not_exist'`)).rows[0].state, 'failed');
    assert.equal((await adm.get('/api/admin/jobs')).body.failed.length, 1);
  });
});

describe('key directory and misc', () => {
  const key = (n: number) => Buffer.alloc(32, n).toString('base64');
  it('stores only public key material, hands out one-time prekeys once, and logs identity changes', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve');
    await dm(a, b);
    const bundle = { identityKey: key(1), signedPrekey: key(2), signedPrekeySignature: Buffer.alloc(64, 3).toString('base64'), registrationId: 42, prekeys: [{ id: 1, key: key(4) }, { id: 2, key: key(5) }] };
    assert.equal((await b.put('/api/keys/device', bundle)).status, 204);
    const r1 = (await a.get(`/api/keys/users/${b.user.id}`)).body.devices[0];
    const r2 = (await a.get(`/api/keys/users/${b.user.id}`)).body.devices[0];
    const r3 = (await a.get(`/api/keys/users/${b.user.id}`)).body.devices[0];
    assert.notEqual(r1.oneTimePrekey.id, r2.oneTimePrekey.id); assert.equal(r3.oneTimePrekey, null);
    assert.equal((await eve.get(`/api/keys/users/${b.user.id}`)).status, 404, 'only people who share a chat can fetch bundles');
    await b.put('/api/keys/device', { ...bundle, identityKey: key(9) });
    const ev = (await a.get(`/api/keys/transparency/${b.user.id}`)).body.events.map((e: any) => e.kind);
    assert.deepEqual(ev, ['identity_changed', 'device_added']);
    assert.equal((await b.put('/api/keys/device', { ...bundle, identityKey: 'not base64!!' })).status, 400);
  });

  it('blocks SSRF in link previews and handles safe URLs', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '0.0.0.0', '100.64.0.1', '::ffff:127.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
    for (const url of ['http://localhost/', 'http://127.0.0.1:8787/api/me', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://user:pw@example.com/', 'file:///etc/passwd', 'ftp://example.com/x', 'http://foo.internal/']) await assert.rejects(assertPublicUrl(url), url);
    const a = await newUser(ctx, 'a');
    assert.equal((await a.get(`/api/link-preview?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`)).status, 400);
    assert.equal((await a.get(`/api/link-preview?url=${encodeURIComponent('http://localhost:8787/healthz')}`)).status, 400);
  });

  it('AI drafting is off by default and never reads chat history', async () => {
    const a = await newUser(ctx, 'a');
    assert.equal((await a.get('/api/ai/status')).body.available, false);
    assert.equal((await a.post('/api/ai/draft', { text: 'hello', consent: true })).status, 403);
    assert.equal((await a.post('/api/ai/draft', { text: 'hello' })).status, 400, 'explicit consent required on every call');
  });

  it('exposes health and readiness probes', async () => {
    const h = await ctx.app.inject({ url: '/healthz' }); assert.equal(h.statusCode, 200);
    const r = await ctx.app.inject({ url: '/readyz' }); assert.equal(r.statusCode, 200); assert.equal(JSON.parse(r.body).db, 'up');
  });

  it('sets security headers and returns JSON 404s for unknown API routes', async () => {
    const r = await ctx.app.inject({ url: '/api/nope' });
    assert.equal(r.statusCode, 404);
    const h = await ctx.app.inject({ url: '/healthz' });
    assert.match(String(h.headers['content-security-policy']), /default-src 'self'/);
    assert.equal(h.headers['x-content-type-options'], 'nosniff');
  });

  it('contact sync only reveals discoverable accounts', async () => {
    const a = await newUser(ctx, 'a');
    const hide = new Client(ctx), show = new Client(ctx);
    for (const [c, ph, nm] of [[hide, '+27820000001', 'hide'], [show, '+27820000002', 'show']] as const) {
      const r = await c.post('/api/auth/register', { username: 'sync_' + nm, password: 'correct-horse-battery', displayName: nm, phone: ph });
      c.token = r.body.token; c.user = r.body.user;
      await q(`update users set phone_verified_at = now() where id = $1`, [c.user.id]);
    }
    await show.patch('/api/me/settings', { patch: { privacy: { discoverable: true } } });
    const r = await a.post('/api/contacts/sync', { phones: ['+27820000001', '+27820000002', '+27829999999'] });
    assert.deepEqual(r.body.matches.map((m: any) => m.username), ['sync_show']);
  });
  it('supports voice statuses, per-status fonts, and a personal music library with song-backed updates', async () => {
    const owner = await newUser(ctx, 'mus_owner'); const friend = await newUser(ctx, 'mus_friend'); const stranger = await newUser(ctx, 'mus_stranger');
    await owner.put(`/api/contacts/${friend.user.id}`, {});
    // a tiny valid WAV file stands in for a song
    const wav = Buffer.alloc(44 + 800); wav.write('RIFF', 0); wav.writeUInt32LE(36 + 800, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(800, 40);
    const song = await owner.upload(wav, 'song.wav', 'audio'); assert.equal(song.status, 201);
    const mediaId = song.body.media.id;
    assert.equal((await friend.post('/api/music', { mediaId, title: 'Not mine' })).status, 400, 'only the owner of an audio file can add it');
    const added = await owner.post('/api/music', { mediaId, title: 'Sunrise', artist: 'The Tests', mood: 'Happy', genre: 'Pop' }); assert.equal(added.status, 201);
    assert.equal((await owner.get('/api/music?tab=suggested')).body.tracks.length, 1);
    assert.equal((await owner.get('/api/music?tab=starred')).body.tracks.length, 0);
    assert.equal((await owner.patch(`/api/music/${added.body.id}`, { starred: true })).status, 204);
    assert.equal((await owner.get('/api/music?tab=starred&q=sun')).body.tracks.length, 1);
    assert.equal((await friend.get('/api/music')).body.tracks.length, 0, 'libraries are private');
    // song on a photo status: viewers get access to the audio only while the status is visible to them
    const img = await owner.upload(PNG, 'p.png', 'image');
    assert.equal((await owner.post('/api/status', { kind: 'text', body: 'x', audioMediaId: mediaId })).status, 400, 'music needs a photo or video');
    const st = await owner.post('/api/status', { kind: 'image', mediaId: img.body.media.id, audioMediaId: mediaId, audioTitle: 'Sunrise · The Tests' }); assert.equal(st.status, 201);
    const item = (await friend.get('/api/status')).body.feed[0].items[0];
    assert.equal(item.audioMediaId, mediaId); assert.equal(item.audioTitle, 'Sunrise · The Tests');
    assert.equal((await friend.post('/api/media/urls', { ids: [mediaId] })).body.urls[mediaId] != null, true);
    assert.equal((await stranger.post('/api/media/urls', { ids: [mediaId] })).body.urls[mediaId] == null, true);
    // voice and fonts
    const v = await owner.upload(wav, 'v.wav', 'voice'); assert.equal(v.status, 201);
    assert.equal((await owner.post('/api/status', { kind: 'voice', mediaId: v.body.media.id, background: '#0B6E5C' })).status, 201);
    assert.equal((await owner.post('/api/status', { kind: 'text', body: 'fancy', font: 3, background: '#003B32' })).status, 201);
    assert.equal((await owner.post('/api/status', { kind: 'text', body: 'bad', font: 99 })).status, 400);
    const items = (await friend.get('/api/status')).body.feed[0].items;
    assert.ok(items.some((i: any) => i.kind === 'voice') && items.some((i: any) => i.font === 3));
    // deleting the song removes it from the library but keeps it for the live status that uses it
    assert.equal((await owner.del(`/api/music/${added.body.id}`)).status, 204);
    assert.equal((await owner.get('/api/music')).body.tracks.length, 0);
  });
});
