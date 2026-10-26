import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, dm, group, newUser, q, say, start, type Ctx } from './helpers.ts';

let ctx: Ctx;
before(async () => { ctx = await start(); });
after(async () => { await ctx.stop(); });

describe('groups', () => {
  it('creates a group with owner role, system message and members', async () => {
    const a = await newUser(ctx, 'owner'); const b = await newUser(ctx, 'b'); const c = await newUser(ctx, 'c');
    const r = await a.post('/api/groups', { title: 'Family Group', description: 'Us', memberIds: [b.user.id, c.user.id] });
    assert.equal(r.status, 201);
    const conv = r.body.conversation;
    assert.equal(conv.role, 'owner'); assert.equal(conv.memberCount, 3);
    const members = (await b.get(`/api/conversations/${conv.id}/members`)).body.members;
    assert.deepEqual(members.map((m: any) => m.role), ['owner', 'member', 'member']);
    const msgs = (await b.get(`/api/conversations/${conv.id}/messages`)).body.messages;
    assert.equal(msgs[0].kind, 'system'); assert.equal(msgs[0].meta.event, 'group_created');
    assert.equal((await b.get('/api/conversations')).body.conversations[0].unread, 0, 'system messages do not count as unread');
  });

  it('enforces roles: only admins manage members, settings and roles', async () => {
    const a = await newUser(ctx, 'owner'); const b = await newUser(ctx, 'b'); const c = await newUser(ctx, 'c'); const d = await newUser(ctx, 'd');
    const g = await group(a, 'Team', [b, c]);
    assert.equal((await b.patch(`/api/conversations/${g}`, { title: 'Hijacked' })).status, 403);
    assert.equal((await b.patch(`/api/conversations/${g}`, { announceOnly: true })).status, 403);
    assert.equal((await b.del(`/api/conversations/${g}/members/${c.user.id}`)).status, 403);
    assert.equal((await b.patch(`/api/conversations/${g}/members/${c.user.id}`, { role: 'admin' })).status, 403);
    assert.equal((await a.patch(`/api/conversations/${g}/members/${b.user.id}`, { role: 'admin' })).status, 200);
    assert.equal((await b.patch(`/api/conversations/${g}`, { title: 'Renamed' })).status, 200);
    assert.equal((await b.del(`/api/conversations/${g}/members/${a.user.id}`)).status, 403, 'nobody removes the owner');
    assert.equal((await b.post(`/api/conversations/${g}/members`, { userIds: [d.user.id] })).status, 200);
    const gone = await b.del(`/api/conversations/${g}/members/${c.user.id}`);
    assert.equal(gone.status, 204);
    assert.equal((await c.get(`/api/conversations/${g}/messages`)).status, 404, 'removed members lose access immediately');
    assert.equal((await c.post(`/api/conversations/${g}/messages`, { clientMsgId: randomUUID(), kind: 'text', body: 'still here?' })).status, 404);
  });

  it('announcement-only groups let only admins post', async () => {
    const a = await newUser(ctx, 'owner'); const b = await newUser(ctx, 'b');
    const g = await group(a, 'News', [b]);
    await a.patch(`/api/conversations/${g}`, { announceOnly: true });
    const r = await b.post(`/api/conversations/${g}/messages`, { clientMsgId: randomUUID(), kind: 'text', body: 'can I talk?' });
    assert.equal(r.status, 403); assert.equal(r.body.error.code, 'posting_restricted');
    assert.equal((await a.post(`/api/conversations/${g}/messages`, { clientMsgId: randomUUID(), kind: 'text', body: 'announcement' })).status, 201);
    // members can still react and read
    const m = (await b.get(`/api/conversations/${g}/messages`)).body.messages.at(-1);
    assert.equal((await b.put(`/api/messages/${m.id}/reaction`, { emoji: '👍' })).status, 200);
  });

  it('lets admins delete anyone\'s message, but members only their own', async () => {
    const a = await newUser(ctx, 'owner'); const b = await newUser(ctx, 'b'); const c = await newUser(ctx, 'c');
    const g = await group(a, 'Mod', [b, c]);
    const bad = await say(b, g, 'bad message');
    assert.equal((await c.del(`/api/messages/${bad.id}?scope=all`)).status, 403);
    assert.equal((await a.del(`/api/messages/${bad.id}?scope=all`)).status, 204);
    assert.equal((await c.put(`/api/messages/${bad.id}/pin`, { pinned: true })).status, 403, 'members cannot pin in groups');
  });

  it('transfers ownership when the owner leaves, and lets members leave', async () => {
    const a = await newUser(ctx, 'owner'); const b = await newUser(ctx, 'b'); const c = await newUser(ctx, 'c');
    const g = await group(a, 'Leaving', [b, c]);
    await a.patch(`/api/conversations/${g}/members/${c.user.id}`, { role: 'admin' });
    assert.equal((await a.post(`/api/conversations/${g}/leave`)).status, 204);
    const roles = Object.fromEntries((await b.get(`/api/conversations/${g}/members`)).body.members.map((m: any) => [m.username, m.role]));
    assert.equal(roles[(c as any).username], 'owner');
    assert.equal((await a.get(`/api/conversations/${g}`)).status, 404);
  });

  it('respects group-invite privacy and blocks', async () => {
    const a = await newUser(ctx, 'owner'); const closed = await newUser(ctx, 'closed'); const blocker = await newUser(ctx, 'blocker'); const open = await newUser(ctx, 'open');
    await closed.patch('/api/me/settings', { patch: { privacy: { groupInvites: 'nobody' } } });
    await blocker.put(`/api/blocks/${a.user.id}`);
    const r = await a.post('/api/groups', { title: 'Privacy', memberIds: [closed.user.id, blocker.user.id, open.user.id] });
    assert.deepEqual(r.body.added, [open.user.id]);
    assert.deepEqual(r.body.skipped.map((s: any) => s.reason).sort(), ['blocked', 'privacy']);
  });

  it('invite links: hashed, expiring, usage-limited, revocable; removed members cannot rejoin', async () => {
    const a = await newUser(ctx, 'owner'); const b = await newUser(ctx, 'b'); const c = await newUser(ctx, 'c'); const d = await newUser(ctx, 'd');
    const g = await group(a, 'Links', []);
    assert.equal((await b.post(`/api/conversations/${g}/invites`, {})).status, 404, 'non members cannot mint links');
    const inv = (await a.post(`/api/conversations/${g}/invites`, { maxUses: 2 })).body;
    const stored = (await q('select code_hash from invite_links where id = $1', [inv.id])).rows[0].code_hash.toString('hex');
    assert.ok(!stored.includes(inv.code), 'only a hash is stored');
    assert.equal((await b.get(`/api/invites/${inv.code}`)).body.invite.title, 'Links');
    assert.equal((await b.post(`/api/invites/${inv.code}/join`)).status, 200);
    assert.equal((await b.post(`/api/invites/${inv.code}/join`)).body.already, true);
    assert.equal((await c.post(`/api/invites/${inv.code}/join`)).status, 200);
    assert.equal((await d.post(`/api/invites/${inv.code}/join`)).status, 404, 'max uses reached');
    assert.equal((await b.post(`/api/invites/not-a-real-code-at-all/join`)).status, 404);
    // revoke
    const inv2 = (await a.post(`/api/conversations/${g}/invites`, {})).body;
    assert.equal((await b.del(`/api/invites/${inv2.id}`)).status, 403);
    assert.equal((await a.del(`/api/invites/${inv2.id}`)).status, 204);
    assert.equal((await d.post(`/api/invites/${inv2.code}/join`)).status, 404);
    // expiry
    const inv3 = (await a.post(`/api/conversations/${g}/invites`, {})).body;
    await q(`update invite_links set expires_at = now() - interval '1 minute' where id = $1`, [inv3.id]);
    assert.equal((await d.post(`/api/invites/${inv3.code}/join`)).status, 404);
    // removed users cannot sneak back in through a link
    await a.del(`/api/conversations/${g}/members/${c.user.id}`);
    const inv4 = (await a.post(`/api/conversations/${g}/invites`, {})).body;
    assert.equal((await c.post(`/api/invites/${inv4.code}/join`)).status, 403);
    assert.equal((await a.post(`/api/conversations/${g}/members`, { userIds: [c.user.id] })).body.added[0], c.user.id, 'an admin can re-add');
  });
});

describe('authorization: changing ids never exposes other people\'s data', () => {
  it('a non-member cannot read, write, react, edit, delete, forward, pin, star, read-receipt or list members', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve');
    const conv = await dm(a, b); const g = await group(a, 'Private group', [b]);
    const m = await say(a, conv, 'top secret'); const gm = await say(a, g, 'group secret');
    const eveDm = await dm(eve, a);
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `/api/conversations/${conv}`], ['GET', `/api/conversations/${conv}/messages`], ['GET', `/api/conversations/${g}/messages?after=0`],
      ['POST', `/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'text', body: 'injected' }],
      ['POST', `/api/conversations/${g}/messages`, { clientMsgId: randomUUID(), kind: 'text', body: 'injected' }],
      ['PUT', `/api/messages/${m.id}/reaction`, { emoji: '😈' }], ['PATCH', `/api/messages/${m.id}`, { body: 'changed' }], ['DELETE', `/api/messages/${m.id}?scope=all`],
      ['DELETE', `/api/messages/${m.id}?scope=me`], ['POST', `/api/messages/${gm.id}/forward`, { conversationIds: [eveDm] }], ['PUT', `/api/messages/${m.id}/pin`, { pinned: true }],
      ['PUT', `/api/messages/${m.id}/star`, { starred: true }], ['GET', `/api/messages/${m.id}/edits`], ['POST', `/api/conversations/${conv}/read`, { seq: 5 }],
      ['POST', `/api/conversations/${conv}/delivered`, { seq: 5 }], ['GET', `/api/conversations/${g}/members`], ['POST', `/api/conversations/${g}/members`, { userIds: [eve.user.id] }],
      ['DELETE', `/api/conversations/${g}/members/${b.user.id}`], ['POST', `/api/conversations/${g}/invites`, {}], ['GET', `/api/conversations/${g}/invites`],
      ['PATCH', `/api/conversations/${g}`, { title: 'pwned' }], ['PATCH', `/api/conversations/${conv}/state`, { pinned: true }], ['PUT', `/api/conversations/${conv}/draft`, { draft: 'x' }],
      ['POST', `/api/conversations/${conv}/clear`], ['POST', `/api/conversations/${g}/leave`], ['GET', `/api/conversations/${conv}/pinned`],
      ['POST', `/api/messages/${m.id}/vote`, { options: [0] }], ['GET', `/api/media?conversationId=${conv}&kind=image`], ['POST', '/api/calls', { conversationId: conv, kind: 'audio' }],
      ['POST', `/api/conversations/${conv}/scheduled`, { body: 'x', sendAt: new Date(Date.now() + 3600_000).toISOString() }],
      ['POST', '/api/reports', { messageId: m.id, reason: 'spam' }],
    ];
    for (const [method, url, body] of attempts) {
      const r = await eve.req(method, url, body);
      assert.ok(r.status === 404 || r.status === 403, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(!JSON.stringify(r.body).includes('secret'), `${method} ${url} leaked content`);
    }
    // And nothing changed
    assert.equal((await a.get(`/api/conversations/${conv}/messages`)).body.messages.length, 1);
    assert.equal((await q(`select body, edited_at from messages where id = $1`, [m.id])).rows[0].body, 'top secret');
    assert.equal((await q(`select count(*)::int n from message_reactions where message_id = $1`, [m.id])).rows[0].n, 0);
    assert.equal((await q(`select count(*)::int n from conversation_members where conversation_id = $1`, [g])).rows[0].n, 2);
    // Eve's unauthenticated variants
    const anon = new Client(ctx);
    for (const [method, url, body] of attempts.slice(0, 6)) assert.equal((await anon.req(method, url, body)).status, 401);
  });

  it('identical errors for unknown vs forbidden conversations (no existence oracle)', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve');
    const conv = await dm(a, b);
    const real = await eve.get(`/api/conversations/${conv}/messages`);
    const fake = await eve.get(`/api/conversations/${randomUUID()}/messages`);
    assert.equal(real.status, fake.status);
    assert.equal(real.body.error.code, fake.body.error.code);
  });

  it('rejects malformed ids and SQL-ish input safely', async () => {
    const a = await newUser(ctx, 'a');
    assert.equal((await a.get(`/api/conversations/not-a-uuid/messages`)).status, 400);
    assert.equal((await a.get(`/api/conversations/1' or '1'='1/messages`)).status, 400);
    assert.equal((await a.get(`/api/users/search?q=${encodeURIComponent("x' or 1=1 --")}`)).status, 200);
    assert.equal((await a.get('/api/users/search?q=ab')).status, 400);
  });

  it('privacy-filters profile data and user discovery', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    await b.patch('/api/me', { bio: 'my bio', statusText: 'secret status' });
    assert.equal((await a.get(`/api/users/${b.user.id}`)).body.user.statusText, 'secret status');
    await b.patch('/api/me/settings', { patch: { privacy: { about: 'contacts', lastSeen: 'nobody', discoverable: true } } });
    const v = (await a.get(`/api/users/${b.user.id}`)).body.user;
    assert.equal(v.statusText, null); assert.equal(v.bio, null); assert.equal(v.lastSeenAt, null);
    await b.put(`/api/contacts/${a.user.id}`, {});
    assert.equal((await a.get(`/api/users/${b.user.id}`)).body.user.statusText, 'secret status', 'contacts see the about text');
    // email lookup: only for opted-in accounts, exact match
    assert.equal((await a.get(`/api/users/search?q=${encodeURIComponent((b as any).email)}`)).body.users.length, 1);
    await b.patch('/api/me/settings', { patch: { privacy: { discoverable: false } } });
    assert.equal((await a.get(`/api/users/search?q=${encodeURIComponent((b as any).email)}`)).body.users.length, 0, 'not discoverable');
    assert.equal((await a.get(`/api/users/search?q=${encodeURIComponent((b as any).email.slice(0, 6) + '@')}`)).body.users.length, 0);
  });

  it('finds usernames containing underscores and treats LIKE wildcards literally', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'finder_target');
    const un = (b as any).username as string;
    assert.equal((await a.get(`/api/users/search?q=${encodeURIComponent(un.slice(0, 9))}`)).body.users.length, 1);
    assert.equal((await a.get('/api/users/search?q=%25%25%25')).body.users.length, 0, 'a wildcard does not match everyone');
    assert.equal((await a.get('/api/users/search?q=___')).body.users.length, 0, 'underscores are literal');
  });

  it('versions settings and rejects stale writes with the current copy', async () => {
    const a = await newUser(ctx, 'a');
    const s = (await a.get('/api/me/settings')).body;
    const ok = await a.patch('/api/me/settings', { baseVersion: s.version, patch: { appearance: { theme: 'dark' } } });
    assert.equal(ok.body.settings.appearance.theme, 'dark'); assert.equal(ok.body.version, s.version + 1);
    const stale = await a.patch('/api/me/settings', { baseVersion: s.version, patch: { appearance: { theme: 'light' } } });
    assert.equal(stale.status, 409); assert.equal(stale.body.error.details.settings.appearance.theme, 'dark');
    assert.equal((await a.patch('/api/me/settings', { patch: { appearance: { theme: 'neon' } } })).status, 400);
    assert.equal((await a.patch('/api/me/settings', { patch: { unknown: 1 } })).status, 400);
  });
});
