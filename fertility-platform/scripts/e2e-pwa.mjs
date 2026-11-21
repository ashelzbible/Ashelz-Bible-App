// End-to-end test of the installable web app in a real (headless) browser at phone size.
// Usage: node scripts/e2e-pwa.mjs http://127.0.0.1:8099 [screenshot-dir]
// Needs Playwright with a Chromium build available to `require('playwright')`.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const iso = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const email = `e2e-${Date.now()}@example.com`;
const password = 'correct-horse-battery';
let step = 0;
const ok = (m) => console.log(`ok ${++step} - ${m}`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_INTERNET_DISCONNECTED')) problems.push(`console: ${m.text()}`); }); // failed fetches while offline are expected
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

async function logDay(date, { temp, lh, e3g, mucus, disturbed } = {}) {
  await page.fill('#date', date);
  if (temp !== undefined) await page.fill('#temp', String(temp));
  if (disturbed) await page.check('#disturbed');
  if (lh !== undefined) await page.fill('#lh', String(lh));
  if (e3g !== undefined) await page.fill('#e3g', String(e3g));
  if (mucus) await page.getByText(mucus, { exact: true }).click();
  await page.getByTestId('save').click();
  await page.getByTestId('msg').filter({ hasText: /Saved/ }).waitFor();
}
const pending = async () => (await page.getByTestId('pending').first().textContent()).trim();

try {
  // --- installability ---------------------------------------------------------
  await page.goto(base);
  assert.equal(await page.title(), 'Cycle Tracker Demo');
  const manifest = await (await page.request.get(`${base}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  for (const i of manifest.icons) assert.equal((await page.request.get(base + i.src)).status(), 200, `icon ${i.src}`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  ok('manifest valid, icons served, service worker active');
  await shot('01-login');

  // --- register ---------------------------------------------------------------
  await page.getByTestId('toggle-mode').click();
  await page.fill('#name', 'E2E Tester');
  await page.fill('#email', email);
  await page.fill('#password', 'short');
  await page.getByTestId('submit').click(); // the browser's own minlength validation stops the submit
  assert.equal(await page.evaluate(() => document.querySelector('#password').validity.tooShort), true);
  assert.equal(await page.getByRole('heading', { name: 'Today' }).count(), 0);
  await page.fill('#password', password);
  await page.getByTestId('submit').click();
  await page.getByRole('heading', { name: 'Today' }).waitFor();
  ok('registered; short password rejected first');

  // --- log a cycle online -------------------------------------------------------
  const temps = [36.42, 36.45, 36.40, 36.48, 36.44, 36.46];
  for (let i = 0; i < temps.length; i++) await logDay(iso(-9 + i), { temp: temps[i], e3g: 10, lh: 4, mucus: i < 3 ? 'Dry' : 'Sticky' });
  await logDay(iso(-3), { temp: 36.5, e3g: 12, lh: 30, mucus: 'Egg-white' }); // LH 30 >= 25: surge
  await shot('02-today-logged');
  await page.getByTestId('tab-chart').click();
  // predictions arrive asynchronously (worker + engine) and refine as events sync: wait for the final one
  await page.waitForFunction(() => [...document.querySelectorAll('.pill')].some((p) => p.textContent === 'Peak'), null, { timeout: 30000 });
  const pills = await page.locator('.pill').allTextContents();
  assert.equal(pills.length, 7, `expected 7 daily statuses, got ${pills}`);
  await page.getByTestId('provisional').waitFor();
  assert.equal(await pending(), 'All saved & synced');
  await page.getByTestId('day').first().locator('summary').click();
  await shot('03-cycle');
  ok(`events synced and server predictions arrived (${pills.length} days, includes Peak)`);

  // --- raw device storage is encrypted -------------------------------------------
  const raw = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    let out = '';
    for (const { name } of dbs) {
      const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
      for (const s of db.objectStoreNames) {
        const all = await new Promise((res) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
        out += JSON.stringify(all);
      }
      db.close();
    }
    return out;
  });
  assert.ok(raw.length > 1000, 'something is stored');
  for (const needle of ['temp_c', '36.42', 'lh_miu_ml', 'E2E Tester', email, 'predictions', 'event_id', 'PEAK']) assert.ok(!raw.includes(needle), `plaintext "${needle}" found in IndexedDB`);
  ok('IndexedDB holds only ciphertext (no temperatures, hormones, name, email or predictions in the clear)');

  // --- offline: log, reload, unlock, resync -----------------------------------------
  await page.getByTestId('tab-today').click();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await logDay(iso(-2), { temp: 36.7, mucus: 'Creamy' });
  assert.equal(await pending(), '2 waiting to sync');
  await page.getByText('Offline', { exact: true }).waitFor();
  assert.match(await page.getByTestId('msg').textContent(), /Saved on this device/);
  await shot('04-offline');
  await page.reload(); // app shell must come from the service worker cache
  await page.getByTestId('submit').waitFor();
  await page.fill('#email', email);
  await page.fill('#password', 'wrong-password-123');
  await page.getByTestId('submit').click();
  await page.getByText(/Wrong password for the data on this device/).waitFor();
  assert.equal(await page.inputValue('#email'), email, 'email is kept after a failed sign-in');
  await page.fill('#password', password);
  await page.getByTestId('submit').click();
  await page.getByRole('heading', { name: 'Today' }).waitFor();
  await page.fill('#date', iso(-2));
  assert.equal(await page.inputValue('#temp'), '36.7');
  assert.equal(await pending(), '2 waiting to sync');
  ok('offline: entry saved, page reloads from cache, wrong password refused, correct password unlocks the entry');

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('[data-testid=pending]')?.textContent.includes('All saved'), null, { timeout: 30000 });
  ok('back online: the waiting entry synced automatically');

  // --- a second device sees everything (fresh browser profile, same account) ---------------
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const p2 = await ctx2.newPage();
  await p2.goto(base);
  await p2.fill('#email', email);
  await p2.fill('#password', password);
  await p2.getByTestId('submit').click();
  await p2.getByRole('heading', { name: 'Today' }).waitFor();
  await p2.fill('#date', iso(-2));
  await p2.waitForFunction(() => document.querySelector('#temp')?.value === '36.7', null, { timeout: 30000 });
  await ctx2.close();
  ok('a second device signs in and pulls the same data from the server');

  // --- validation, lock, wipe ------------------------------------------------------------------
  await page.fill('#date', iso(-1));
  await page.fill('#temp', '45');
  await page.getByTestId('save').click(); // blocked by the browser's own max=42 validation, nothing is saved
  assert.equal(await page.evaluate(() => document.querySelector('#temp').validity.rangeOverflow), true);
  assert.equal(await pending(), 'All saved & synced');
  await page.getByTestId('tab-account').click();
  await page.getByTestId('logout').click();
  await page.getByTestId('submit').waitFor();
  ok('invalid temperature refused; sign-out returns to the lock screen');

  assert.deepEqual(problems, [], `browser errors: ${problems.join(' | ')}`);
  ok('no console or page errors');
  console.log(`\nALL ${step} E2E CHECKS PASSED`);
} catch (e) {
  await shot('failure');
  console.error('\nE2E FAILED:', e.message);
  console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
