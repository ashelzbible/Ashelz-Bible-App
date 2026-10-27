import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import { Client, config, latestCode, login, newUser, q, start, verifyEmail, type Ctx } from './helpers.ts';
import { unseal } from '../src/lib/crypto.ts';
import { memoryStore } from '../src/lib/ratelimit.ts';
import { migrate } from '../src/db/migrate.ts';

let ctx: Ctx;
before(async () => { ctx = await start(); });
after(async () => { await ctx.stop(); });

describe('registration and verification', () => {
  it('registers, hashes the password with argon2id and never returns secrets', async () => {
    const c = await newUser(ctx, 'alice', { verify: false });
    assert.equal(c.user.emailVerified, false);
    assert.ok(!JSON.stringify(c.user).includes('password'));
    const row = (await q('select password_hash from users where id = $1', [c.user.id])).rows[0];
    assert.match(row.password_hash, /^\$argon2id\$/);
  });
  it('requires verification before messaging features, then allows them', async () => {
    const c = await newUser(ctx, 'bob', { verify: false });
    const blocked = await c.get('/api/conversations');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'verification_required');
    await verifyEmail(c);
    assert.equal((await c.get('/api/conversations')).status, 200);
  });
  it('rejects wrong or reused verification codes and stops after 5 attempts', async () => {
    const c = await newUser(ctx, 'carol', { verify: false });
    for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/verify', { kind: 'email', code: '000000' })).status, 400);
    const good = await latestCode(c.user.id);
    assert.equal((await c.post('/api/auth/verify', { kind: 'email', code: good })).status, 400, 'code locked after too many attempts');
  });
  it('rejects duplicate usernames and does not reveal that an email exists', async () => {
    const a = await newUser(ctx, 'dupe');
    const r1 = await new Client(ctx).post('/api/auth/register', { username: 'other_name', password: 'correct-horse-battery', displayName: 'x', email: (a as any).email });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error.code, 'account_exists');
    const r2 = await new Client(ctx).post('/api/auth/register', { username: (a as any).username.toUpperCase(), password: 'correct-horse-battery', displayName: 'x', email: 'new@example.test' });
    assert.equal(r2.status, 409);
  });
  it('rejects weak passwords and invalid input', async () => {
    const c = new Client(ctx);
    assert.equal((await c.post('/api/auth/register', { username: 'weak1', password: 'short', displayName: 'x', email: 'w@example.test' })).status, 400);
    assert.equal((await c.post('/api/auth/register', { username: 'weak2', password: 'password123', displayName: 'x', email: 'w2@example.test' })).status, 400);
    assert.equal((await c.post('/api/auth/register', { username: 'bad name!', password: 'correct-horse-battery', displayName: 'x', email: 'w3@example.test' })).status, 400);
    assert.equal((await c.post('/api/auth/register', { username: 'noid', password: 'correct-horse-battery', displayName: 'x' })).status, 400);
  });
  it('registers with a phone number (international format only)', async () => {
    const c = new Client(ctx);
    assert.equal((await c.post('/api/auth/register', { username: 'phoney', password: 'correct-horse-battery', displayName: 'P', phone: '0821234567' })).status, 400);
    assert.equal((await c.post('/api/auth/register', { username: 'phoney', password: 'correct-horse-battery', displayName: 'P', phone: '+27821234567' })).status, 400, 'phone alone cannot be verified, so an email is required');
    const ok = await c.post('/api/auth/register', { username: 'phoney', password: 'correct-horse-battery', displayName: 'P', phone: '+27821234567', email: 'phoney@example.com' });
    assert.equal(ok.status, 201); assert.equal(ok.body.user.phoneVerified, false);
    const sms = (await q(`select channel from outbox where user_id = $1`, [ok.body.user.id])).rows;
    assert.deepEqual(sms.map((r: any) => r.channel), ['email'], 'no SMS code is sent');
    // an unverified phone number cannot be used to sign in
    const pl = await new Client(ctx).post('/api/auth/login', { identifier: '+27821234567', password: 'correct-horse-battery' });
    assert.equal(pl.status, 401);
  });
});

describe('login and sessions', () => {
  it('logs in by email, username, and rejects bad credentials identically', async () => {
    const a = await newUser(ctx, 'login');
    const byEmail = await new Client(ctx).post('/api/auth/login', { identifier: (a as any).email, password: (a as any).password });
    assert.equal(byEmail.status, 200);
    const byName = await new Client(ctx).post('/api/auth/login', { identifier: (a as any).username, password: (a as any).password });
    assert.equal(byName.status, 200);
    const wrongPw = await new Client(ctx).post('/api/auth/login', { identifier: (a as any).email, password: 'nope-nope-nope' });
    const noUser = await new Client(ctx).post('/api/auth/login', { identifier: 'ghost@example.test', password: 'nope-nope-nope' });
    assert.equal(wrongPw.status, 401); assert.equal(noUser.status, 401);
    assert.deepEqual(wrongPw.body.error, noUser.body.error);
  });
  it('locks the account after 5 failures', async () => {
    const a = await newUser(ctx, 'lock');
    for (let i = 0; i < 5; i++) await new Client(ctx).post('/api/auth/login', { identifier: (a as any).email, password: 'wrong-wrong-wrong' });
    const r = await new Client(ctx).post('/api/auth/login', { identifier: (a as any).email, password: (a as any).password });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'account_locked');
  });
  it('stores only a hash of the session token and revokes on logout', async () => {
    const a = await newUser(ctx, 'sess');
    const rows = (await q('select token_hash from sessions where user_id = $1', [a.user.id])).rows;
    assert.ok(Buffer.isBuffer(rows[0].token_hash) && rows[0].token_hash.length === 32);
    assert.ok(!rows[0].token_hash.toString('utf8').includes(a.token));
    assert.equal((await a.post('/api/auth/logout')).status, 204);
    assert.equal((await a.get('/api/me')).status, 401);
  });
  it('rejects missing, malformed and forged tokens', async () => {
    const c = new Client(ctx);
    assert.equal((await c.get('/api/me')).status, 401);
    c.token = 'x'.repeat(43);
    assert.equal((await c.get('/api/me')).status, 401);
    c.token = '';
    assert.equal((await c.req('GET', '/api/me', undefined, { headers: { authorization: 'Basic abc' } })).status, 401);
  });
  it('ignores any user id supplied by the client (identity comes from the session)', async () => {
    const a = await newUser(ctx, 'idA'); const b = await newUser(ctx, 'idB');
    const r = await a.req('GET', '/api/me', undefined, { headers: { 'x-user-id': b.user.id } });
    assert.equal(r.body.user.id, a.user.id);
    const p = await a.patch('/api/me', { displayName: 'Hax', userId: b.user.id });
    assert.equal(p.status, 400, 'unknown fields are rejected');
  });
  it('lists devices, flags the current one, and signs out a single device', async () => {
    const a = await newUser(ctx, 'dev');
    const b = await login(ctx, a, 'Pixel tablet');
    const list = (await a.get('/api/devices')).body.devices;
    assert.equal(list.length, 2);
    assert.equal(list.filter((d: any) => d.current).length, 1);
    assert.equal((await a.del(`/api/devices/${b.deviceId}`)).status, 204);
    assert.equal((await b.get('/api/me')).status, 401);
    assert.equal((await a.get('/api/me')).status, 200);
    const c = await newUser(ctx, 'devother');
    assert.equal((await c.del(`/api/devices/${a.deviceId}`)).status, 404, 'cannot revoke another user device');
  });
  it('creates a new-login notification (flagged suspicious for an unfamiliar IP)', async () => {
    const a = await newUser(ctx, 'alert');
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.9', payload: { identifier: (a as any).username, password: (a as any).password, deviceName: 'Unknown laptop' } });
    assert.equal(r.statusCode, 200);
    const n = (await a.get('/api/notifications')).body.notifications.find((x: any) => x.kind === 'new_login');
    assert.ok(n); assert.equal(n.payload.deviceName, 'Unknown laptop'); assert.equal(n.payload.suspicious, true);
    assert.ok((await q(`select 1 from outbox where user_id = $1 and subject like '%unfamiliar%'`, [a.user.id])).rowCount);
  });
});

describe('password reset', () => {
  it('responds identically for unknown emails and revokes sessions on reset', async () => {
    const a = await newUser(ctx, 'reset');
    const known = await new Client(ctx).post('/api/auth/password/forgot', { email: (a as any).email });
    const unknown = await new Client(ctx).post('/api/auth/password/forgot', { email: 'nobody@example.test' });
    assert.equal(known.status, 204); assert.equal(unknown.status, 204);
    const code = await latestCode(a.user.id);
    assert.equal((await new Client(ctx).post('/api/auth/password/reset', { email: (a as any).email, code: '123456', newPassword: 'brand-new-password' })).status, 400);
    assert.equal((await new Client(ctx).post('/api/auth/password/reset', { email: (a as any).email, code, newPassword: 'brand-new-password' })).status, 204);
    assert.equal((await a.get('/api/me')).status, 401, 'old sessions are revoked');
    assert.equal((await new Client(ctx).post('/api/auth/password/reset', { email: (a as any).email, code, newPassword: 'another-new-password' })).status, 400, 'code is single use');
    const ok = await new Client(ctx).post('/api/auth/login', { identifier: (a as any).email, password: 'brand-new-password' });
    assert.equal(ok.status, 200);
  });
});

describe('multi-factor authentication', () => {
  it('requires a TOTP code once enabled, rejects replays, and can be disabled', async () => {
    const a = await newUser(ctx, 'mfa');
    const setup = (await a.post('/api/me/mfa/setup')).body;
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.secret), digits: 6, period: 30 });
    assert.equal((await a.post('/api/me/mfa/enable', { code: '000000' })).status, 400);
    const code = totp.generate();
    assert.equal((await a.post('/api/me/mfa/enable', { code })).status, 200);
    const stored = (await q('select mfa_secret from users where id = $1', [a.user.id])).rows[0].mfa_secret;
    assert.notEqual(stored, setup.secret, 'seed is encrypted at rest');
    assert.equal(unseal(stored), setup.secret);

    const creds = { identifier: (a as any).email, password: (a as any).password };
    const noCode = await new Client(ctx).post('/api/auth/login', creds);
    assert.equal(noCode.status, 401); assert.equal(noCode.body.error.code, 'mfa_required');
    const replay = await new Client(ctx).post('/api/auth/login', { ...creds, mfaCode: code });
    assert.equal(replay.status, 401, 'the code used to enable cannot be replayed');
    // Next time step
    const future = totp.generate({ timestamp: Date.now() + 30_000 });
    const ok = await new Client(ctx).post('/api/auth/login', { ...creds, mfaCode: future });
    assert.equal(ok.status, 200);
    const again = await new Client(ctx).post('/api/auth/login', { ...creds, mfaCode: future });
    assert.equal(again.status, 401, 'same code cannot be used twice');
  });
});

describe('rate limiting', () => {
  it('throttles login attempts per identifier', async () => {
    config.rateLimitDisabled = false; memoryStore.reset();
    try {
      const results: number[] = [];
      for (let i = 0; i < 13; i++) results.push((await new Client(ctx).post('/api/auth/login', { identifier: 'victim@example.test', password: 'x-x-x-x-x-x' })).status);
      assert.ok(results.includes(429), 'eventually rate limited: ' + results.join(','));
      assert.equal(results[0], 401);
    } finally { config.rateLimitDisabled = true; memoryStore.reset(); }
  });
  it('throttles message sending per user', async () => {
    const { dm } = await import('./helpers.ts');
    const a = await newUser(ctx, 'flood'); const b = await newUser(ctx, 'floodb');
    const conv = await dm(a, b);
    config.rateLimitDisabled = false; memoryStore.reset();
    try {
      let limited = 0;
      for (let i = 0; i < 130; i++) { const r = await a.post(`/api/conversations/${conv}/messages`, { clientMsgId: 'flood-msg-' + i, kind: 'text', body: 'x' }); if (r.status === 429) limited++; }
      assert.ok(limited > 0);
    } finally { config.rateLimitDisabled = true; memoryStore.reset(); }
  });
});

describe('account lifecycle', () => {
  it('exports data, then deletes and anonymizes the account', async () => {
    const { dm, say } = await import('./helpers.ts');
    const a = await newUser(ctx, 'gone'); const b = await newUser(ctx, 'stays');
    const conv = await dm(a, b);
    await say(a, conv, 'secret thing');
    const exp = await a.get('/api/me/export');
    assert.equal(exp.status, 200);
    assert.ok(exp.body.messagesSent.some((m: any) => m.body === 'secret thing'));
    assert.equal((await a.req('DELETE', '/api/me', { password: 'wrong-password', confirm: 'DELETE' })).status, 401);
    assert.equal((await a.req('DELETE', '/api/me', { password: (a as any).password, confirm: 'DELETE' })).status, 204);
    assert.equal((await a.get('/api/me')).status, 401);
    const row = (await q('select email, phone, status, username from users where id = $1', [a.user.id])).rows[0];
    assert.equal(row.email, null); assert.equal(row.status, 'deleted'); assert.match(row.username, /^deleted_/);
    const msgs = (await b.get(`/api/conversations/${conv}/messages`)).body.messages;
    assert.ok(msgs.every((m: any) => m.body !== 'secret thing'), 'authored messages are erased');
    assert.equal((await new Client(ctx).post('/api/auth/login', { identifier: (a as any).email, password: (a as any).password })).status, 401);
    assert.equal((await b.post('/api/conversations/direct', { userId: a.user.id })).status, 404);
  });
});

describe('migrations', () => {
  it('are idempotent: re-running applies nothing and keeps data', async () => {
    const before = (await q('select count(*)::int n from users')).rows[0].n;
    const applied = await migrate(false);
    assert.deepEqual(applied, []);
    assert.equal((await q('select count(*)::int n from users')).rows[0].n, before);
    const names = (await q('select name from schema_migrations order by name')).rows.map((r) => r.name);
    assert.deepEqual(names, ['001_core.sql', '002_productivity.sql', '003_call_log_and_scheduling.sql', '004_status_sharing_feedback.sql', '005_status_voice_font.sql', '006_music_library.sql']);
  });
});
