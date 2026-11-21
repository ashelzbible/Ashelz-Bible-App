// Browser test of the whole interface with NO server at all: only static files are served. Everything (accounts,
// storage, fertility calculations, estimates) must work on the device alone and nothing may call an API.
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
page.on('dialog', (d) => d.accept());
const shot = async (n) => { if (shots) await page.screenshot({ path: `${shots}/${n}.png` }); };
const T = (id) => page.getByTestId(id);
const tab = async (id) => { await T(`tab-${id}`).click(); };

/** Log one day through the real Log Your Day screen. */
async function logDay(date, f = {}) {
  await page.fill('[data-testid=log-date]', date);
  if (f.period) await T('period-yes').click();
  if (f.temp !== undefined) await page.fill('[data-testid=temp-input]', String(f.temp));
  if (f.mucus) await T(`mucus-${f.mucus}`).click();
  for (const s of f.symptoms ?? []) await T(`sym-${s}`).click();
  await T('save-day').click();
  await T('log-msg').filter({ hasText: /Saved/ }).waitFor();
}
try {
  // ---- static files only: no server offered ------------------------------------------------------------------
  await page.goto(base);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await shot('01-login');
  await T('toggle-mode').click();
  await page.getByText(/No server needed/).waitFor();
  assert.equal(await page.locator('#sync').count(), 0, 'no sync option without a server');
  await page.fill('#name', 'Ashlyn De Koe'); await page.fill('#email', email); await page.fill('#password', password);
  await T('submit').click();
  await T('onboarding').waitFor();
  assert.match(await T('status').textContent(), /This device only/);
  await shot('02-home-empty');
  ok('no server needed: account created on the device; Home asks for the first period');

  // ---- log three cycles through the real screens -----------------------------------------------------------------
  await T('start-period').click();
  await T('save-day').waitFor();
  const starts = [-69, -40, -11];
  for (const s of starts) for (let i = 0; i < 4; i++) {
    await logDay(iso(s + i), { period: true, symptoms: i === 0 ? ['cramps'] : [] });
  }
  // temperatures, mucus and hormones across the current cycle (days -11..0)
  const temps = [36.42, 36.45, 36.4, 36.48, 36.44, 36.46, 36.43, 36.45, 36.62, 36.7, 36.72, 36.75];
  const mucus = ['dry', 'dry', 'creamy', 'creamy', 'creamy', 'watery', 'watery', 'egg', 'egg', 'creamy', 'dry', 'dry'];
  for (let i = 0; i < 12; i++) {
    await page.fill('[data-testid=log-date]', iso(-11 + i));
    await page.fill('[data-testid=temp-input]', String(temps[i]));
    await T(`mucus-${mucus[i]}`).click();
    await T('save-day').click();
    await T('log-msg').filter({ hasText: /Saved|Nothing changed/ }).waitFor();
  }
  await tab('home'); await T('tile-hormones').click(); // stay on the Hormones screen and step through the days
  for (let i = 0; i < 12; i++) { // LH 30 on day -3: the peak
    const lh = i === 8 ? 30 : 4, e3g = i >= 6 && i <= 8 ? 24 : 10;
    await page.fill('[data-testid=hormone-date]', iso(-11 + i));
    await page.fill('[data-testid=hormone-lh]', String(lh));
    await page.fill('[data-testid=hormone-e3g]', String(e3g));
    await T('save-hormones').click();
    await T('hormone-msg').filter({ hasText: /Saved/ }).waitFor();
  }
  await tab('home');
  ok('three cycles, 12 days of temperature, mucus, symptoms and hormones logged through the screens');

  // ---- Home ---------------------------------------------------------------------------------------------------------
  await T('cycle-day').waitFor();
  assert.match(await T('cycle-day').textContent(), /Cycle Day\s*12\s*of 29/);
  assert.match(await T('next-period').textContent(), /Next Period in 18 Days/);
  assert.match(await T('next-period').textContent(), /estimate/);
  assert.match(await T('ovulation-card').textContent(), /Ovulation/);
  assert.match(await T('fertility-window').textContent(), /Fertility Window/);
  await shot('03-home');
  ok('Home: cycle day 12 of 29 (from two completed cycles), next period and ovulation shown as estimates');

  // ---- Calendar -------------------------------------------------------------------------------------------------------
  await tab('calendar');
  assert.match(await T(`cal-day-${iso(-10)}`).getAttribute('class'), /period/);
  assert.match(await T(`cal-day-${iso(0)}`).getAttribute('class'), /today/);
  assert.match(await T('cycle-overview').textContent(), /29 Days/);
  assert.match(await T('cycle-overview').textContent(), /Normal Cycle/);
  await shot('04-calendar');
  await T('cal-prev').click();
  await T('cal-next').click();
  await T(`cal-day-${iso(-8)}`).click();
  await T('save-day').waitFor();
  assert.equal(await page.inputValue('[data-testid=log-date]'), iso(-8));
  assert.equal(await page.inputValue('[data-testid=temp-input]'), String(temps[3]));
  await T('back').click();
  ok('Calendar: logged period days, today, cycle overview; tapping a day opens it with its saved values');

  // ---- Log screen details: units, stepper, validation, symptoms -----------------------------------------------------------
  await tab('settings'); await T('row-units').click(); await T('unit-F').click();
  await T('back').click(); await T('tab-home').click(); await T('tile-bbt').click();
  await page.fill('[data-testid=log-date]', iso(-8));
  assert.equal(await page.inputValue('[data-testid=temp-input]'), '97.7'); // 36.48 C
  await T('temp-plus').click();
  assert.equal(await page.inputValue('[data-testid=temp-input]'), '97.8');
  await page.fill('[data-testid=temp-input]', '120');
  await T('save-day').click();
  await T('log-msg').filter({ hasText: /does not look right/ }).waitFor();
  await page.fill('[data-testid=temp-input]', '97.9');
  await T('save-day').click();
  await T('log-msg').filter({ hasText: /Saved/ }).waitFor();
  await T('back').click();
  await tab('settings'); await T('row-units').click(); await T('unit-C').click();
  await T('back').click(); await tab('home'); await T('tile-bbt').click();
  await page.fill('[data-testid=log-date]', iso(-8));
  assert.equal(await page.inputValue('[data-testid=temp-input]'), '36.61'); // stored in C: 97.9 F
  await T('temp-minus').click();
  assert.equal(await page.inputValue('[data-testid=temp-input]'), '36.56');
  await shot('05-log');
  ok('Log: °F entry is stored in °C, converts back, stepper and range check work');
  await T('back').click();

  // ---- Charts ------------------------------------------------------------------------------------------------------------------
  await tab('charts');
  await T('bbt-chart').waitFor(); await T('hormone-chart').waitFor();
  await T(`bbt-pt-${iso(-8)}`).click();
  assert.match(await T('bbt-tip').textContent(), /CD 4/);
  await T('range-3M').click(); await T('bbt-chart').waitFor();
  await T('range-Custom').click(); await T('custom-from').waitFor();
  await page.fill('[data-testid=custom-from]', iso(-12)); await T('bbt-chart').waitFor();
  await T('range-1M').click();
  assert.match(await T('fertile-days').textContent(), /measured/);
  await T('day').first().waitFor();
  await shot('06-charts');
  ok('Charts: BBT and hormone charts, point details with cycle day, ranges incl. custom, measured fertile days');

  // ---- History --------------------------------------------------------------------------------------------------------------------
  await tab('history');
  assert.match(await T('cycle-current').textContent(), /Day 12 of ~29/);
  assert.equal(await T('cycle-prev-0').count(), 1); assert.equal(await T('cycle-prev-1').count(), 1);
  assert.match(await T('cycle-prev-0').textContent(), /29 Days/);
  assert.match(await T('insights').textContent(), /consistent \(29 days\)/);
  await shot('07-history');
  ok('History: current and previous cycles with lengths, and insights');

  // ---- Settings ----------------------------------------------------------------------------------------------------------------------
  await tab('settings');
  await T('edit-profile').click(); await page.fill('[data-testid=profile-input]', 'Ashlyn Test'); await T('save-profile').click();
  await T('settings-msg').filter({ hasText: 'Saved' }).waitFor(); await T('back').click();
  assert.equal((await T('profile-name').textContent()), 'Ashlyn Test');
  await T('row-sync').click(); assert.match(await T('device-only').textContent(), /only on this device/);
  assert.equal(await T('enable-sync').count(), 0); await T('back').click();
  await T('row-notifications').click(); await T('reminder-toggle').check();
  await T('settings-msg').filter({ hasText: /only work in the Android app/ }).waitFor(); await T('back').click();
  await T('row-cycle').click();
  await page.fill('[data-testid=pref-cycleLength]', '60'); await page.locator('[data-testid=pref-cycleLength]').blur();
  await T('settings-msg').filter({ hasText: /whole number from 21 to 45/ }).waitFor();
  await page.fill('[data-testid=pref-cycleLength]', '31'); await page.locator('[data-testid=pref-cycleLength]').blur();
  await T('settings-msg').filter({ hasText: 'Saved' }).waitFor();
  await T('profile-select').selectOption('mira-marquette-2021-preliminary');
  await page.waitForFunction(() => document.querySelector('[data-testid=evidence]')?.textContent.includes('PRELIMINARY'));
  await T('profile-select').selectOption('spec-provisional-1');
  await page.waitForFunction(() => document.querySelector('[data-testid=evidence]')?.textContent.includes('Ecochard 2013'));
  await T('pref-goal').selectOption('conceive');
  await T('back').click();
  for (const r of ['privacy', 'help', 'about']) { await T(`row-${r}`).click(); await T('screen-title').waitFor(); await T('back').click(); }
  await shot('08-settings');
  await tab('home');
  assert.match(await T('cycle-day').textContent(), /of 29/, 'the typical length setting does not override your own history');
  ok('Settings: profile, sync, reminders (browser limits stated), preferences with validation, thresholds, privacy, help, about');

  // ---- storage is ciphertext ----------------------------------------------------------------------------------------------------------
  const raw = await page.evaluate(async () => {
    let out = '';
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
      for (const s of db.objectStoreNames) out += JSON.stringify(await new Promise((res) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); }));
      db.close();
    }
    return out;
  });
  for (const n of ['temp_c', 'lh_miu_ml', 'cramps', 'Ashlyn', email, 'PEAK', 'PERIOD']) assert.ok(!raw.includes(n), `plaintext "${n}" in IndexedDB`);
  ok('everything on the device is ciphertext (temperatures, hormones, symptoms, name, email, results)');

  // ---- offline reload, wrong password, remembered settings -----------------------------------------------------------------------------------
  await tab('settings'); await T('logout').click();
  await context.setOffline(true);
  await page.reload();
  await T('submit').waitFor();
  await page.fill('#email', email); await page.fill('#password', 'wrong-password-123'); await T('submit').click();
  await page.getByText(/Wrong password for the data on this device/).waitFor();
  await page.fill('#password', password); await T('submit').click();
  await T('cycle-day').waitFor();
  assert.match(await T('cycle-day').textContent(), /Cycle Day\s*12/);
  await tab('settings'); assert.equal(await T('profile-name').textContent(), 'Ashlyn Test');
  await context.setOffline(false);
  ok('offline reload from cache, wrong password refused, data, name and preferences restored');

  await T('logout').click();
  await page.fill('#email', 'nobody@example.com'); await page.fill('#password', password); await T('submit').click();
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
