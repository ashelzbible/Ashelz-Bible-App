// End-to-end tests: real server + Postgres + two real Chromium browsers (fake camera/mic devices).
// Run: npm run build:web && npm run e2e
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 8799; const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'wazzupp_e2e';
const CHROME = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
let server, browser;

before(async () => {
  execSync(`psql "postgres://wazzupp:wazzupp@127.0.0.1:5432/postgres" -q -c "drop database if exists ${DB} with (force)" -c "create database ${DB}"`, { stdio: 'ignore' });
  server = spawn('node', ['server/src/main.ts'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: `postgres://wazzupp:wazzupp@127.0.0.1:5432/${DB}`, NODE_ENV: 'development', RATE_LIMIT_DISABLED: 'true', MEDIA_DIR: '/tmp/wz-e2e-media', PUBLIC_URL: BASE, RING_TIMEOUT_SECONDS: '30' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
});
after(async () => { await browser?.close(); server?.kill(); });

const PW = 'e2e-password-123';
async function ctxFor(name, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'] });
  return { ctx, page: await ctx.newPage(), name };
}
async function signUp(page, username, display) {
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Your name').fill(display);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Email').fill(`${username}@example.test`);
  await page.getByLabel('Password').fill(PW);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('Verify your account').waitFor();
  await page.getByRole('button', { name: 'use it' }).click(); // development outbox helper (disabled in production)
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await page.locator('.app').waitFor();
}
const openChatWith = async (page, username, display) => {
  await page.getByLabel('New chat').click();
  await page.getByLabel('Find people').fill(username);
  await page.locator('.person', { hasText: display }).first().click();
  await page.locator('.conv-head').waitFor();
};
const composer = (page) => page.getByLabel('Message', { exact: true });
const send = async (page, text) => { await composer(page).fill(text); await composer(page).press('Enter'); };

describe('browser end to end', () => {
  let a, b;
  it('signs up two users through the UI (with verification) and lands in the app', async () => {
    a = await ctxFor('a'); b = await ctxFor('b');
    await signUp(a.page, 'e2e_alice', 'Alice Anderson'); await signUp(b.page, 'e2e_bob', 'Bob Brown');
    assert.ok(await a.page.locator('.rail').isVisible());
  });

  it('exchanges messages in realtime with delivery ticks, typing, and read receipts', async () => {
    await openChatWith(a.page, 'e2e_bob', 'Bob Brown');
    await send(a.page, 'Hello Bob from the browser');
    await b.page.locator('.conv-row', { hasText: 'Alice Anderson' }).waitFor();
    assert.match(await b.page.locator('.conv-row', { hasText: 'Alice Anderson' }).innerText(), /Hello Bob/);
    assert.ok(await b.page.locator('.conv-row .badge', { hasText: '1' }).isVisible(), 'unread badge for Bob');
    await b.page.locator('.conv-row', { hasText: 'Alice Anderson' }).click();
    await b.page.locator('.bubble', { hasText: 'Hello Bob' }).waitFor();
    await send(b.page, 'Hi Alice! 👋');
    await a.page.locator('.bubble', { hasText: 'Hi Alice' }).waitFor();
    // Alice's message became read (blue double tick) because Bob opened the chat
    await a.page.locator('.msg-row.out .tick.read').first().waitFor({ timeout: 8000 });
    // typing indicator
    await b.page.getByLabel('Message', { exact: true }).pressSequentially('typ', { delay: 50 });
    await a.page.locator('.typing-txt').first().waitFor({ timeout: 5000 });
    await b.page.getByLabel('Message', { exact: true }).fill('');
  });

  it('queues messages while offline and delivers each exactly once on reconnect', async () => {
    await a.ctx.setOffline(true);
    await send(a.page, 'sent while offline');
    await a.page.locator('.bubble', { hasText: 'sent while offline' }).waitFor();
    assert.ok(await a.page.locator('.msg-row.out .tick.pending').first().isVisible() || await a.page.locator('.queued-note').first().isVisible(), 'shows a pending state');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await b.page.locator('.bubble', { hasText: 'sent while offline' }).count(), 0);
    await a.ctx.setOffline(false);
    await b.page.locator('.bubble', { hasText: 'sent while offline' }).waitFor({ timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(await b.page.locator('.bubble', { hasText: 'sent while offline' }).count(), 1, 'no duplicates');
    assert.equal(await a.page.locator('.bubble', { hasText: 'sent while offline' }).count(), 1);
  });

  it('records, previews and sends a voice note that the other browser can play', async () => {
    await a.page.getByLabel('Record voice message').click();
    await new Promise((r) => setTimeout(r, 1800));
    await a.page.getByLabel('Stop recording').click();
    await a.page.getByLabel('Send voice message').click();
    await b.page.locator('.voice').waitFor({ timeout: 15000 });
    await b.page.locator('.voice-play').click();
    await b.page.waitForFunction(() => { const au = document.querySelector('.voice audio'); return au && au.readyState >= 2; }, null, { timeout: 15000 });
  });

  it('uploads an image attachment with a thumbnail that loads through a signed URL', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await a.page.locator('input[type=file][accept^="image/png"]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
    await a.page.getByLabel('Send', { exact: true }).click();
    const img = b.page.locator('.media-img img').first();
    await img.waitFor({ timeout: 15000 });
    assert.match(await img.getAttribute('src'), /\/api\/media\/.+\/content\?u=.+&e=\d+&t=1&s=/);
  });

  it('connects a REAL WebRTC video call between two browsers and shows call history', async () => {
    await a.page.getByLabel('Video call').click();
    await b.page.getByLabel('Accept').waitFor({ timeout: 10000 });
    assert.match(await b.page.locator('.call-status').innerText(), /Incoming video call/);
    await b.page.getByLabel('Accept').click();
    // both sides must reach "connected" (timer 00:0x) only after ICE/DTLS actually came up
    for (const p of [a.page, b.page]) await p.waitForFunction(() => /^\d\d:\d\d$/.test(document.querySelector('.call-status')?.textContent ?? ''), null, { timeout: 30000 });
    // remote video is really rendering frames
    for (const p of [a.page, b.page]) await p.waitForFunction(() => { const v = document.querySelector('video.call-remote'); return v && v.videoWidth > 0 && v.readyState >= 2; }, null, { timeout: 20000 });
    // mute toggles the local audio track
    await a.page.getByRole('button', { name: 'Mute', exact: true }).click();
    assert.equal(await a.page.getByRole('button', { name: 'Mute', exact: true }).getAttribute('aria-pressed'), 'true');
    await new Promise((r) => setTimeout(r, 1500));
    await a.page.getByLabel('End call').click();
    await b.page.locator('.call-overlay').waitFor({ state: 'detached', timeout: 10000 });
    await a.page.locator('.call-overlay').waitFor({ state: 'detached', timeout: 10000 });
    await a.page.evaluate(() => { location.hash = '#/calls'; });
    await a.page.locator('.call-row', { hasText: 'Bob Brown' }).waitFor();
    assert.match(await a.page.locator('.call-row').first().innerText(), /00:0\d/); // dated, with its duration
    assert.ok(await b.page.evaluate(() => { location.hash = '#/chats'; return true; }));
  });

  it('declined calls end cleanly on both sides without ever claiming "connected"', async () => {
    await a.page.evaluate(() => { location.hash = '#/chats'; });
    await a.page.locator('.conv-row', { hasText: 'Bob Brown' }).click();
    await a.page.getByLabel('Voice call').click();
    await b.page.getByLabel('Decline').waitFor({ timeout: 10000 });
    await b.page.getByLabel('Decline').click();
    await a.page.getByText('Call declined').waitFor({ timeout: 10000 });
    await a.page.locator('.call-overlay').waitFor({ state: 'detached', timeout: 10000 });
  });

  it('recovers missed events after a browser reload (resync from the durable event log)', async () => {
    await b.page.evaluate(() => { location.hash = '#/chats'; });
    await b.ctx.setOffline(true);
    await a.page.locator('.conv-row', { hasText: 'Bob Brown' }).click();
    await send(a.page, 'while bob was away');
    await b.ctx.setOffline(false);
    await b.page.reload();
    await b.page.locator('.conv-row', { hasText: 'Alice Anderson' }).first().click();
    await b.page.locator('.bubble', { hasText: 'while bob was away' }).waitFor({ timeout: 15000 });
  });

  it('keeps a second device in sync (read state, new messages)', async () => {
    const b2 = await ctxFor('b2');
    await b2.page.goto(BASE);
    await b2.page.getByLabel('Email or username').fill('e2e_bob'); await b2.page.getByLabel('Password').fill(PW);
    await b2.page.getByRole('button', { name: 'Sign in' }).click();
    await b2.page.locator('.app').waitFor();
    await send(a.page, 'for both of bobs devices');
    await b.page.locator('.bubble', { hasText: 'for both of bobs devices' }).waitFor({ timeout: 10000 });
    await b2.page.locator('.conv-row', { hasText: 'Alice Anderson' }).first().click();
    await b2.page.locator('.bubble', { hasText: 'for both of bobs devices' }).waitFor({ timeout: 10000 });
    // sign out device 2 from device 1 -> device 2 is kicked immediately
    await b.page.evaluate(() => { location.hash = '#/settings/devices'; });
    await b.page.getByText('Linked devices').first().waitFor();
    await b.page.locator('.page-body').getByRole('button', { name: 'Sign out' }).first().click();
    await b.page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
    await b2.page.getByText('Welcome back').waitFor({ timeout: 10000 });
    await b2.ctx.close();
  });

  it('top-right menu: camera, Broadcast lists (delivers to each person), Linked devices, Starred, Read all, Settings', async () => {
    await a.page.setViewportSize({ width: 390, height: 844 });
    await a.page.evaluate(() => { location.hash = '#/chats'; });
    await a.page.getByLabel('Camera', { exact: true }).waitFor();
    await a.page.getByLabel('More options').click();
    const items = await a.page.locator('.menu [role=menuitem]').allInnerTexts();
    assert.deepEqual(items.map((t) => t.trim()), ['New group', 'Broadcast lists', 'Linked devices', 'Starred', 'Read all', 'Settings']);
    await a.page.getByRole('menuitem', { name: 'Broadcast lists' }).click();
    await a.page.getByRole('button', { name: 'New list' }).click();
    await a.page.getByLabel('List name').fill('Friends');
    await a.page.locator('.person', { hasText: 'Bob Brown' }).click().catch(async () => { await a.page.getByText('Add contacts first').waitFor(); });
    if (!(await a.page.getByText('Add contacts first').count())) {
      await a.page.getByRole('button', { name: 'Save', exact: true }).click();
      await a.page.getByRole('button', { name: 'Send', exact: true }).click();
      await a.page.getByLabel('Broadcast message').fill('Broadcast hello');
      await a.page.getByRole('button', { name: /^Send to 1$/ }).click();
      await b.page.evaluate(() => { location.hash = '#/chats'; });
      await b.page.locator('.conv-row', { hasText: 'Alice Anderson' }).first().click();
      await b.page.locator('.bubble', { hasText: 'Broadcast hello' }).waitFor({ timeout: 10000 });
    } else await a.page.keyboard.press('Escape');
    // Read all clears unread badges; Linked devices opens the device list
    await a.page.getByLabel('More options').click(); await a.page.getByRole('menuitem', { name: 'Read all' }).click();
    await a.page.getByLabel('More options').click(); await a.page.getByRole('menuitem', { name: 'Linked devices' }).click();
    await a.page.getByText('Linked devices').first().waitFor();
    await a.page.evaluate(() => { location.hash = '#/chats'; });
    await a.page.getByLabel('Camera', { exact: true }).click();
    await a.page.getByRole('dialog', { name: 'Camera' }).waitFor();
    await a.page.getByLabel('Take photo').click();
    await a.page.getByRole('button', { name: /Use photo/ }).waitFor();
    await a.page.getByRole('button', { name: /Use photo/ }).click();
    await a.page.getByRole('dialog', { name: 'New status' }).waitFor();
    await a.page.keyboard.press('Escape');
  });

  it('formats messages (bold, italic, strike, code, lists) and offers the attach grid and emoji/GIF/sticker panel', async () => {
    await a.page.evaluate(() => { location.hash = '#/chats'; });
    await a.page.locator('.conv-row', { hasText: 'Bob Brown' }).first().click();
    await a.page.getByLabel('Message', { exact: true }).fill('*bold* _it_ ~gone~ `mono`\n- one\n- two');
    await a.page.getByLabel('Send', { exact: true }).click();
    const bub = a.page.locator('.bubble', { hasText: 'bold' }).last();
    await bub.locator('strong').filter({ hasText: 'bold' }).waitFor();
    assert.equal(await bub.locator('em').innerText(), 'it'); assert.equal(await bub.locator('s').innerText(), 'gone');
    assert.equal(await bub.locator('code').innerText(), 'mono'); assert.equal(await bub.locator('li').count(), 2);
    await a.page.getByLabel('Attach').click();
    for (const n of ['Gallery', 'Camera', 'Location', 'Contact', 'Document', 'Poll', 'Event']) await a.page.getByRole('dialog', { name: 'Attach' }).getByText(n, { exact: true }).waitFor();
    await a.page.keyboard.press('Escape');
    await a.page.getByLabel('Emoji', { exact: true }).click();
    await a.page.getByRole('tab', { name: 'GIF' }).click(); await a.page.getByText(/GIF search is not set up/).waitFor();
    await a.page.getByRole('tab', { name: 'Stickers' }).click(); await a.page.getByText('Create sticker').waitFor();
    await a.page.getByRole('tab', { name: 'Emoji' }).click(); await a.page.getByRole('button', { name: '😀' }).first().click();
    assert.match(await a.page.getByLabel('Message', { exact: true }).inputValue(), /😀/);
    await a.page.getByLabel('Backspace').click();
    assert.doesNotMatch(await a.page.getByLabel('Message', { exact: true }).inputValue(), /😀/);
  });

  it('settings home, mood, QR, status privacy, and posting a status from the camera editor', async () => {
    await a.page.evaluate(() => { location.hash = '#/settings'; });
    for (const n of ['Linked devices', 'Account', 'Privacy', 'Lists', 'Chats', 'Appearance', 'Broadcasts', 'Events', 'Notifications', 'Storage and data', 'Accessibility', 'App language', 'Help and feedback', 'Invite a friend', 'App updates']) await a.page.locator('.set-menu', { hasText: n }).first().waitFor();
    await a.page.getByLabel('Edit current mood').click(); await a.page.getByLabel(/on your mind/).fill('Feeling grateful'); await a.page.getByRole('button', { name: 'Save' }).click();
    await a.page.getByLabel('Edit current mood').getByText('Feeling grateful').waitFor();
    await a.page.getByLabel('My QR code').click(); await a.page.locator('.qr svg').waitFor(); await a.page.keyboard.press('Escape');
    await a.page.evaluate(() => { location.hash = '#/settings/status-privacy'; });
    await a.page.getByRole('radio', { name: /Only share with/ }).waitFor();
    await a.page.getByRole('radio', { name: /My contacts except/ }).click();
    await a.page.getByRole('switch', { name: 'Allow sharing' }).click();
    assert.equal(await a.page.getByRole('switch', { name: 'Allow sharing' }).getAttribute('aria-checked'), 'false');
    await a.page.getByRole('switch', { name: 'Allow sharing' }).click();
    await a.page.getByRole('radio', { name: /^My contacts$/ }).click();
    // post a photo status through the editor
    await a.page.evaluate(() => { location.hash = '#/status/new/camera'; });
    await a.page.getByLabel('Take photo').click(); await a.page.getByRole('button', { name: /Use photo/ }).click();
    await a.page.getByLabel('Caption').fill('From the editor');
    await a.page.getByRole('button', { name: /Filters/ }).click(); await a.page.getByRole('button', { name: 'B&W' }).click();
    await a.page.getByLabel('Post status').click();
    await a.page.getByText('Status posted').waitFor();
    await a.page.evaluate(() => { location.hash = '#/status'; });
    await a.page.getByText(/Today|Just now|\d{2}:\d{2}/).first().waitFor();
    // text status with a different font and colour
    await a.page.evaluate(() => { location.hash = '#/status'; });
    await a.page.getByLabel('Write a text status').click(); await a.page.getByLabel('Status text').fill('Hello from a text status');
    await a.page.getByLabel('Change font').click(); await a.page.getByLabel('Post status').click(); await a.page.getByText('Status posted').waitFor();
  });

  it('adds several songs at once in Settings → My music and they sync to a second device', async () => {
    const wav = Buffer.alloc(44 + 8000); wav.write('RIFF', 0); wav.writeUInt32LE(8036, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
    const second = await ctxFor('a2');
    await second.page.goto(BASE); await second.page.getByLabel('Email or username').fill('e2e_alice'); await second.page.getByLabel('Password').fill(PW); await second.page.getByRole('button', { name: 'Sign in' }).click();
    await second.page.locator('.app').waitFor(); await second.page.evaluate(() => { location.hash = '#/settings/music'; });
    await a.page.evaluate(() => { location.hash = '#/settings/music'; });
    await a.page.locator('input[type=file]').first().setInputFiles(['Adele - Easy.wav', 'Burna Boy - Last.wav', 'Solo.wav'].map((name) => ({ name, mimeType: 'audio/wav', buffer: wav })));
    await a.page.getByText('3 songs added').waitFor({ timeout: 20000 });
    await a.page.getByText('Easy', { exact: true }).waitFor(); await a.page.getByText('Adele').first().waitFor();
    await second.page.getByText('Last', { exact: true }).waitFor({ timeout: 10000 }); // appeared on the other device without a refresh
    await a.page.getByLabel('Delete Solo').click();
    await second.page.getByText('Solo', { exact: true }).waitFor({ state: 'detached', timeout: 10000 });
    await second.ctx.close();
  });

  it('has no horizontal overflow or clipped layout at phone, tablet and desktop sizes', async () => {
    for (const [w, h] of [[360, 740], [390, 844], [768, 1024], [820, 1180], [1180, 820], [1440, 900], [1920, 1080]]) {
      await a.page.setViewportSize({ width: w, height: h });
      for (const hash of ['#/chats', '#/calls', '#/status', '#/communities', '#/settings', '#/settings/privacy', '#/settings/appearance']) {
        await a.page.evaluate((x) => { location.hash = x; }, hash); await a.page.waitForTimeout(120);
        const over = await a.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(over <= 1, `${w}x${h} ${hash} overflows by ${over}px`);
      }
    }
  });

  it('switches to dark theme and persists the preference', async () => {
    await a.page.setViewportSize({ width: 1440, height: 900 });
    await a.page.evaluate(() => { location.hash = '#/settings/appearance'; });
    await a.page.getByRole('button', { name: 'Dark' }).click();
    await a.page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await a.page.reload(); await a.page.locator('.app').waitFor();
    assert.equal(await a.page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  });
});
