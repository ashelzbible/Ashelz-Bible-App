// End-to-end test of the web app against the real API (server mode) in a real phone-sized browser.
// Usage: node scripts/e2e-pwa.mjs http://127.0.0.1:8099 [screenshot-dir]
// Needs Playwright with a Chromium build available to `require('playwright')`.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const iso = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const email = `e2e-${Date.now()}@example.com`, password = 'correct-horse-battery';
let step = 0;
const ok = (m) => console.log(`ok ${++step} - ${m}`);

const browser = await chromium.launch();
const mk = async () => { const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }); const p = await c.newPage(); p.on('dialog', (d) => d.accept()); return [c, p]; };
const [context, page] = await mk();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(m.text())) problems.push(`console: ${m.text()}`); });
const shot = async (n) => { if (shots) await page.screenshot({ path: `${shots}/${n}.png` }); };
const T = (p, id) => p.getByTestId(id);
const pending = async (p) => ((await T(p, 'pending').first().textContent()) ?? '').trim();
const synced = (p) => p.waitForFunction(() => document.querySelector('[data-testid=pending]')?.textContent.includes('All saved'), null, { timeout: 30000 });

/** Log a day via the Log Your Day screen (opened from the Home tile). */
async function logDay(p, date, f = {}) {
  await T(p, 'tab-home').click(); await T(p, 'tile-bbt').click();
  await p.fill('[data-testid=log-date]', date);
  if (f.period) await T(p, 'period-yes').click();
  if (f.temp !== undefined) await p.fill('[data-testid=temp-input]', String(f.temp));
  if (f.mucus) await T(p, `mucus-${f.mucus}`).click();
  for (const s of f.symptoms ?? []) await T(p, `sym-${s}`).click();
  await T(p, 'save-day').click();
  await T(p, 'log-msg').filter({ hasText: /Saved/ }).waitFor();
}

try {
  // --- installability ---------------------------------------------------------
  await page.goto(base);
  assert.equal(await page.title(), 'Cycle Tracker Demo');
  const manifest = await (await page.request.get(`${base}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, 'standalone');
  for (const i of manifest.icons) assert.equal((await page.request.get(base + i.src)).status(), 200, `icon ${i.src}`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  ok('manifest valid, icons served, service worker active');

  // --- register with sync (the default when a server is available) -----------------
  await T(page, 'toggle-mode').click();
  assert.equal(await page.locator('#sync').isChecked(), true, 'sync is on by default when the server is available');
  await page.fill('#name', 'E2E Tester'); await page.fill('#email', email); await page.fill('#password', 'short');
  await T(page, 'submit').click(); // the browser's own minlength validation stops the submit
  assert.equal(await page.evaluate(() => document.querySelector('#password').validity.tooShort), true);
  await page.fill('#password', password);
  await T(page, 'submit').click();
  await T(page, 'onboarding').waitFor();
  ok('registered with sync; short password refused by the form first');

  // --- log period days, temperature, mucus, symptoms and hormones; everything must sync ------------
  for (let i = 0; i < 4; i++) await logDay(page, iso(-11 + i), { period: true, symptoms: i === 0 ? ['cramps', 'bloating'] : [] });
  for (let i = 4; i < 10; i++) await logDay(page, iso(-11 + i), { temp: 36.4 + i * 0.01, mucus: i > 6 ? 'watery' : 'creamy' });
  await T(page, 'tab-home').click(); await T(page, 'tile-hormones').click();
  await page.fill('[data-testid=hormone-date]', iso(-1)); await page.fill('[data-testid=hormone-lh]', '30'); await page.fill('[data-testid=hormone-e3g]', '25');
  await T(page, 'save-hormones').click(); await T(page, 'hormone-msg').filter({ hasText: /Saved/ }).waitFor();
  await T(page, 'tab-home').click();
  await synced(page);
  assert.match(await T(page, 'cycle-day').textContent(), /Cycle Day\s*12/);
  await shot('01-home');
  ok('period days, temperatures, mucus, symptoms and hormones all accepted by the server (sync shows "All saved")');

  // --- on-device storage is ciphertext ------------------------------------------------------------------
  const raw = await page.evaluate(async () => {
    let out = '';
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
      for (const s of db.objectStoreNames) out += JSON.stringify(await new Promise((res) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); }));
      db.close();
    }
    return out;
  });
  assert.ok(raw.length > 1000);
  for (const n of ['temp_c', 'lh_miu_ml', 'cramps', 'E2E Tester', email, 'PEAK']) assert.ok(!raw.includes(n), `plaintext "${n}" in IndexedDB`);
  ok('IndexedDB holds only ciphertext');

  // --- offline: log, reload from cache, unlock, resync ---------------------------------------------------------
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await logDay(page, iso(0), { temp: 36.7, mucus: 'egg' });
  await T(page, 'tab-home').click();
  assert.match(await pending(page), /2 waiting to sync/);
  await page.getByText('Offline', { exact: true }).waitFor();
  await T(page, 'tab-settings').click(); await T(page, 'logout').click();
  await page.reload(); // the app shell must come from the service worker cache
  await T(page, 'submit').waitFor();
  await page.fill('#email', email); await page.fill('#password', 'wrong-password-123'); await T(page, 'submit').click();
  await page.getByText(/Wrong password for the data on this device/).waitFor();
  assert.equal(await page.inputValue('#email'), email, 'email is kept after a failed sign-in');
  await page.fill('#password', password); await T(page, 'submit').click();
  await T(page, 'cycle-day').waitFor();
  assert.match(await pending(page), /2 waiting to sync/);
  ok('offline: entry saved, page reloads from cache, wrong password refused, correct password unlocks the waiting entry');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await synced(page);
  ok('back online: the waiting entries synced automatically');

  // --- a second device signs in and gets the same data --------------------------------------------------------------
  const [ctx2, p2] = await mk();
  await p2.goto(base);
  await p2.fill('#email', email); await p2.fill('#password', password); await T(p2, 'submit').click();
  await T(p2, 'cycle-day').waitFor({ timeout: 30000 });
  await p2.waitForFunction(() => /Cycle Day\s*12/.test(document.querySelector('[data-testid=cycle-day]')?.textContent ?? ''), null, { timeout: 30000 });
  await T(p2, 'tile-bbt').click(); await p2.fill('[data-testid=log-date]', iso(0));
  await p2.waitForFunction(() => document.querySelector('[data-testid=temp-input]')?.value === '36.7', null, { timeout: 30000 });
  await p2.fill('[data-testid=log-date]', iso(-11));
  assert.match((await T(p2, 'sym-cramps').getAttribute('aria-pressed')) ?? '', /true/);
  await ctx2.close();
  ok('a second device signs in and sees the same periods, temperatures and symptoms');

  // --- a device-only account can turn sync on later ------------------------------------------------------------------
  const email2 = `later-${Date.now()}@example.com`;
  const [ctx3, p3] = await mk();
  await p3.goto(base);
  await T(p3, 'toggle-mode').click(); await p3.uncheck('#sync');
  await p3.fill('#name', 'Later Sync'); await p3.fill('#email', email2); await p3.fill('#password', password); await T(p3, 'submit').click();
  await T(p3, 'onboarding').waitFor();
  assert.match(await T(p3, 'status').textContent(), /This device only/);
  await logDay(p3, iso(-4), { period: true, temp: 36.61 });
  await T(p3, 'tab-settings').click(); await T(p3, 'row-sync').click(); await T(p3, 'enable-sync').click();
  await T(p3, 'sync-now').waitFor();
  await T(p3, 'back').click(); await T(p3, 'tab-home').click(); await synced(p3);
  const [ctx4, p4] = await mk();
  await p4.goto(base); await p4.fill('#email', email2); await p4.fill('#password', password); await T(p4, 'submit').click();
  await T(p4, 'cycle-day').waitFor({ timeout: 30000 });
  await T(p4, 'tile-bbt').click(); await p4.fill('[data-testid=log-date]', iso(-4));
  await p4.waitForFunction(() => document.querySelector('[data-testid=temp-input]')?.value === '36.61', null, { timeout: 30000 });
  await ctx3.close(); await ctx4.close();
  ok('a device-only account turned sync on; its earlier entries reached a second device');

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
