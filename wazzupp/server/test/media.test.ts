import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Client, PNG, config, dm, group, newUser, q, say, start, type Ctx } from './helpers.ts';
import { sweepExpiredMessages } from '../src/modules/jobs.ts';

let ctx: Ctx;
before(async () => { ctx = await start(); });
after(async () => { await ctx.stop(); });

const fetchSigned = (c: Client, url: string, headers: Record<string, string> = {}) => c.req('GET', url, undefined, { auth: false, headers });

describe('media upload and delivery', () => {
  it('stores an image privately, generates a thumbnail and strips metadata', async () => {
    const a = await newUser(ctx, 'a');
    const exif = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#00a884' } }).jpeg().withExif({ IFD0: { Copyright: 'SECRET-OWNER' } }).toBuffer();
    assert.ok(exif.includes(Buffer.from('SECRET-OWNER')));
    const up = await a.upload(exif, 'photo.jpg', 'image');
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const m = up.body.media;
    assert.equal(m.mime, 'image/jpeg'); assert.equal(m.width, 800); assert.equal(m.hasThumb, true); assert.equal(m.scanStatus, 'unscanned');
    const urls = (await a.post('/api/media/urls', { ids: [m.id] })).body.urls[m.id];
    const full = await fetchSigned(a, urls.url);
    assert.equal(full.status, 200); assert.equal(full.headers['content-type'], 'image/jpeg');
    assert.ok(!full.raw.includes(Buffer.from('SECRET-OWNER')), 'EXIF removed');
    assert.match(String(full.headers['cache-control']), /private/);
    const thumb = await fetchSigned(a, urls.thumbUrl);
    assert.equal(thumb.headers['content-type'], 'image/webp');
    assert.equal((await sharp(thumb.raw).metadata()).width, 480);
  });

  it('validates file type by content, not by name or declared type', async () => {
    const a = await newUser(ctx, 'a');
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);
    assert.equal((await a.upload(exe, 'photo.png', 'image')).status, 415);
    assert.equal((await a.upload(exe, 'doc.pdf', 'document')).status, 415);
    assert.equal((await a.upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg', 'image')).status, 415);
    assert.equal((await a.upload(Buffer.from('<html><script>alert(1)</script></html>'), 'x.html', 'document')).status, 415, 'html is never accepted as a document');
    assert.equal((await a.upload(Buffer.from('plain text notes'), 'notes.txt', 'document')).status, 201);
    assert.equal((await a.upload(Buffer.alloc(0), 'empty.png', 'image')).status, 400);
    assert.equal((await a.upload(PNG, 'a.png', 'video')).status, 415, 'an image cannot pose as a video');
    assert.equal((await a.upload(Buffer.from('not an image but has png name'), 'a.png', 'image')).status, 415);
  });

  it('enforces size limits and storage quota', async () => {
    const a = await newUser(ctx, 'a');
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: 'red' } }).png().toBuffer();
    config.maxUploadBytes.image = png.length - 1;
    assert.equal((await a.upload(png, 'big.png', 'image')).status, 413);
    config.maxUploadBytes.image = 16 * 1024 ** 2;
    const orig = config.storageQuotaBytes; config.storageQuotaBytes = png.length + 10;
    assert.equal((await a.upload(png, 'one.png', 'image')).status, 201);
    assert.equal((await a.upload(png, 'two.png', 'image')).status, 413);
    config.storageQuotaBytes = orig;
    const usage = (await a.get('/api/storage/usage')).body;
    assert.equal(usage.byKind[0].count, 1);
  });

  it('only owner and conversation members can obtain or use signed URLs', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve');
    const conv = await dm(a, b);
    const up = (await a.upload(PNG, 'private.png', 'image')).body.media;
    // not yet attached to any message: only the owner
    assert.deepEqual(Object.keys((await b.post('/api/media/urls', { ids: [up.id] })).body.urls), []);
    const sent = await a.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'image', mediaId: up.id, body: 'look' });
    assert.equal(sent.status, 201); assert.equal(sent.body.message.media.id, up.id);
    assert.equal(Object.keys((await b.post('/api/media/urls', { ids: [up.id] })).body.urls).length, 1);
    assert.equal(Object.keys((await eve.post('/api/media/urls', { ids: [up.id] })).body.urls).length, 0, 'eve gets nothing by guessing the id');

    const bUrl = (await b.post('/api/media/urls', { ids: [up.id] })).body.urls[up.id].url;
    assert.equal((await fetchSigned(eve, bUrl)).status, 200, 'the signed URL itself is the capability for that user... but it is bound to b\'s id:');
    // Tampering with the user binding or signature fails
    assert.equal((await fetchSigned(eve, bUrl.replace(/u=[^&]+/, `u=${eve.user.id}`))).status, 403);
    assert.equal((await fetchSigned(eve, bUrl.replace(/s=[^&]+/, 's=AAAA'))).status, 403);
    assert.equal((await fetchSigned(eve, bUrl.replace(/e=\d+/, 'e=99999999999'))).status, 403);
    // Expired
    const expired = bUrl.replace(/e=\d+/, `e=${Math.floor(Date.now() / 1000) - 10}`);
    assert.equal((await fetchSigned(eve, expired)).status, 403);
    // Eve forging a URL for herself with no secret
    assert.equal((await fetchSigned(eve, `/api/media/${up.id}/content?u=${eve.user.id}&e=${Math.floor(Date.now() / 1000) + 300}&t=0&s=forged`)).status, 403);
    assert.equal((await fetchSigned(eve, `/api/media/${up.id}/content`)).status, 400);
    // Eve cannot delete it either
    assert.equal((await eve.del(`/api/media/${up.id}`)).status, 404);
  });

  it('revokes access immediately when a member is removed, even with a live URL', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const g = await group(a, 'Media group', [b]);
    const up = (await a.upload(PNG, 'g.png', 'image')).body.media;
    await a.post(`/api/conversations/${g}/messages`, { clientMsgId: randomUUID(), kind: 'image', mediaId: up.id });
    const url = (await b.post('/api/media/urls', { ids: [up.id] })).body.urls[up.id].url;
    assert.equal((await fetchSigned(b, url)).status, 200);
    await a.del(`/api/conversations/${g}/members/${b.user.id}`);
    assert.equal((await fetchSigned(b, url)).status, 404, 'live URL stops working');
  });

  it('cannot attach someone else\'s upload to your own message', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve');
    const conv = await dm(eve, b);
    const up = (await a.upload(PNG, 'mine.png', 'image')).body.media;
    const r = await eve.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'image', mediaId: up.id });
    assert.equal(r.status, 400);
    assert.equal((await eve.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'video', mediaId: (await eve.upload(PNG, 'x.png', 'image')).body.media.id })).status, 400, 'kind mismatch');
    assert.equal((await eve.patch('/api/me', { avatarMediaId: up.id })).status, 400, 'cannot use another user\'s upload as avatar');
  });

  it('supports range requests and voice notes with waveform metadata', async () => {
    const a = await newUser(ctx, 'a');
    // minimal valid ogg header is enough for sniffing
    const head = Buffer.alloc(36); head.write('OggS', 0, 'latin1'); head.write('OpusHead', 28, 'latin1');
    const ogg = Buffer.concat([head, Buffer.alloc(60000, 7)]);
    const up = await a.upload(ogg, 'voice.ogg', 'voice', { durationMs: '4200', waveform: JSON.stringify([0.1, 0.5, 0.9, 0.3]) });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.media.durationMs, 4200); assert.deepEqual(up.body.media.waveform, [0.1, 0.5, 0.9, 0.3]);
    const url = (await a.post('/api/media/urls', { ids: [up.body.media.id] })).body.urls[up.body.media.id].url;
    const part = await fetchSigned(a, url, { range: 'bytes=0-99' });
    assert.equal(part.status, 206); assert.equal(part.raw.length, 100); assert.match(String(part.headers['content-range']), /^bytes 0-99\/\d+$/);
    assert.equal((await fetchSigned(a, url, { range: 'bytes=999999999-' })).status, 416);
  });

  it('keeps shared media when one copy is deleted, and removes unreferenced files', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const c = await newUser(ctx, 'c');
    const ab = await dm(a, b); const ac = await dm(a, c);
    const up = (await a.upload(PNG, 'f.png', 'image')).body.media;
    const sent = (await a.post(`/api/conversations/${ab}/messages`, { clientMsgId: randomUUID(), kind: 'image', mediaId: up.id })).body.message;
    const fwd = (await a.post(`/api/messages/${sent.id}/forward`, { conversationIds: [ac] })).body.messages[0];
    await a.del(`/api/messages/${sent.id}?scope=all`);
    assert.equal(Object.keys((await c.post('/api/media/urls', { ids: [up.id] })).body.urls).length, 1, 'forwarded copy still works');
    await a.del(`/api/messages/${fwd.id}?scope=all`);
    assert.ok((await q('select deleted_at from media_assets where id = $1', [up.id])).rows[0].deleted_at, 'asset deleted when nothing references it');
    assert.equal(Object.keys((await a.post('/api/media/urls', { ids: [up.id] })).body.urls).length, 0);
  });

  it('removes media when a disappearing message expires', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b');
    const conv = await dm(a, b);
    await a.patch(`/api/conversations/${conv}`, { disappearingSeconds: 60 });
    const up = (await a.upload(PNG, 'e.png', 'image')).body.media;
    const m = (await a.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'image', mediaId: up.id })).body.message;
    await q(`update messages set expires_at = now() - interval '1 second' where id = $1`, [m.id]);
    await sweepExpiredMessages();
    assert.ok((await q('select deleted_at from media_assets where id = $1', [up.id])).rows[0].deleted_at);
  });

  it('lists shared media, documents and links for the gallery', async () => {
    const a = await newUser(ctx, 'a'); const b = await newUser(ctx, 'b'); const eve = await newUser(ctx, 'eve');
    const conv = await dm(a, b);
    for (let i = 0; i < 3; i++) await a.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'image', mediaId: (await a.upload(PNG, `i${i}.png`, 'image')).body.media.id });
    await a.post(`/api/conversations/${conv}/messages`, { clientMsgId: randomUUID(), kind: 'document', mediaId: (await a.upload(Buffer.from('hello doc'), 'n.txt', 'document')).body.media.id });
    await say(a, conv, 'read https://example.com/page now');
    assert.equal((await b.get(`/api/media?conversationId=${conv}&kind=image`)).body.items.length, 3);
    assert.equal((await b.get(`/api/media?conversationId=${conv}&kind=document`)).body.items.length, 1);
    assert.equal((await b.get(`/api/media?conversationId=${conv}&kind=links`)).body.items[0].urls[0], 'https://example.com/page');
    assert.equal((await eve.get(`/api/media?conversationId=${conv}&kind=image`)).status, 404);
  });

  it('rejects dangerous document extensions even if the bytes look like a zip', async () => {
    const a = await newUser(ctx, 'a');
    const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(100)]);
    assert.equal((await a.upload(zip, 'installer.exe', 'document')).status, 415);
    assert.equal((await a.upload(zip, 'archive.zip', 'document')).status, 201);
  });
});
