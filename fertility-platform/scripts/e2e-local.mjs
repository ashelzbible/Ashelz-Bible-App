// Browser test of the app with NO server at all: only static files are served. Everything (accounts, storage,
// fertility calculations) must work on the device alone, and nothing may be sent to an API.
// Usage: node scripts/e2e-local.mjs http://127.0.0.1:8085 [screenshot-dir]    (start:  node scripts/serve-static.mjs 8085)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8085';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const iso = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const email = `local-${Date.now()}@example.com`, password = 'correct-horse-battery';
let step = 0;
const ok = (m) => console.log(`ok ${++step} - ${m}`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
const page = await context.newPage();
const problems = [], apiCalls = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|ERR_FAILED|status of 404/.test(m.text())) problems.push(`console: ${m.text()}`); });
page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) apiCalls.push(r.url()); });
const shot = async (n) => { if (shots) await page.screenshot({ path: `${shots}/${n}.png` }); };
async function logDay(date, f = {}) {
  await page.fill('#date', date);
  if (f.temp !== undefined) await page.fill('#temp', String(f.temp));
  if (f.lh !== undefined) await page.fill('#lh', String(f.lh));
  if (f.e3g !== undefined) await page.fill('#e3g', String(f.e3g));
  if (f.mucus) await page.getByText(f.mucus, { exact: true }).click();
  await page.getByTestId('save').click();
  await page.getByTestId('msg').filter({ hasText: /Saved/ }).waitFor();
}
const pills = () => page.locator('.pill').allTextContents();

try {
  await page.goto(base);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.getByTestId('toggle-mode').click();
  await page.getByText(/No server needed/).waitFor();
  assert.equal(await page.locator('#sync').count(), 0, 'no sync option without a server');
  await shot('01-register');
  ok('static files only: the sign-up form says no server is needed and offers no sync');

  await page.fill('#name', 'Local Tester'); await page.fill('#email', email); await page.fill('#password', password);
  await page.getByTestId('submit').click();
  await page.getByRole('heading', { name: 'Today' }).waitFor();
  assert.match(await page.getByTestId('status').textContent(), /This device only/);
  ok('account created entirely on the device');

  const temps = [36.42, 36.45, 36.40, 36.48, 36.44, 36.46];
  for (let i = 0; i < temps.length; i++) await logDay(iso(-9 + i), { temp: temps[i], e3g: 10, lh: 4, mucus: i < 3 ? 'Dry' : 'Sticky' });
  await logDay(iso(-3), { temp: 36.5, e3g: 12, lh: 30, mucus: 'Egg-white' });
  await page.getByTestId('tab-chart').click();
  await page.getByTestId('day').first().waitFor();
  const p = await pills();
  assert.equal(p.length, 7); assert.ok(p.includes('Peak'), `expected Peak in ${p}`);
  assert.match(await page.getByTestId('computed').textContent(), /on this device/);
  await page.getByTestId('day').first().locator('summary').click();
  await shot('02-cycle');
  ok('the fertility timeline is calculated on the device immediately (7 days, includes Peak)');

  await page.getByTestId('tab-account').click();
  assert.match(await page.getByTestId('device-only').textContent(), /only on this device/);
  assert.equal(await page.getByTestId('enable-sync').count(), 0, 'no sync button when there is no server');
  await page.getByTestId('profile-select').selectOption('mira-marquette-2021-preliminary');
  await page.getByText('Where these numbers come from').click();
  assert.match(await page.getByTestId('evidence').textContent(), /PRELIMINARY/);
  await page.getByTestId('tab-chart').click();
  assert.match(await page.getByTestId('computed').textContent(), /mira-marquette-2021-preliminary/);
  assert.match(await page.getByTestId('provisional').textContent(), /provisional/);
  // same pills for this data, but the reasoning now cites the Mira rule (a candidate peak needing two lower days)
  await page.getByTestId('day').first().locator('summary').click();
  assert.match(await page.getByTestId('day').first().textContent(), /candidate peak confirmed when 2 consecutive days follow at least 50% lower/);
  await shot('03-mira');
  ok('switching to the Mira threshold set recalculates the timeline on the device');

  const raw = await page.evaluate(async () => {
    let out = '';
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
      for (const s of db.objectStoreNames) out += JSON.stringify(await new Promise((res) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); }));
      db.close();
    }
    return out;
  });
  for (const n of ['temp_c', 'lh_miu_ml', 'Local Tester', email, 'PEAK', 'mira-marquette']) assert.ok(!raw.includes(n), `plaintext "${n}" in IndexedDB`);
  ok('everything on the device is ciphertext');

  await page.getByTestId('tab-account').click();
  await page.getByTestId('logout').click();
  await context.setOffline(true);
  await page.reload();
  await page.getByTestId('submit').waitFor();
  await page.fill('#email', email); await page.fill('#password', 'wrong-password-123'); await page.getByTestId('submit').click();
  await page.getByText(/Wrong password for the data on this device/).waitFor();
  await page.fill('#password', password); await page.getByTestId('submit').click();
  await page.getByRole('heading', { name: 'Today' }).waitFor();
  await page.getByTestId('tab-chart').click();
  await page.getByTestId('day').first().waitFor();
  assert.match(await page.getByTestId('computed').textContent(), /mira-marquette-2021-preliminary/, 'the chosen threshold set is remembered');
  ok('offline reload from cache, wrong password refused, data and threshold choice restored');
  await context.setOffline(false);

  await page.getByTestId('tab-account').click(); await page.getByTestId('logout').click();
  await page.fill('#email', 'nobody@example.com'); await page.fill('#password', password); await page.getByTestId('submit').click();
  await page.getByText(/No account with this email on this device/).waitFor();
  ok('an unknown email is refused (there is no server to look it up)');

  assert.deepEqual(apiCalls, [], `the app called an API: ${apiCalls.join(', ')}`);
  assert.deepEqual(problems, [], problems.join(' | '));
  ok('no API calls and no console or page errors');
  console.log(`\nALL ${step} LOCAL-ONLY CHECKS PASSED`);
} catch (e) {
  await shot('failure');
  console.error('\nFAILED:', e.message, '\n', problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
