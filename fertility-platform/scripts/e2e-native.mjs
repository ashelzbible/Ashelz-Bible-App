// Browser test of the web app as the Android app runs it: files served from their own origin (the app's bundled
// copy), the API on another origin, window.Capacitor present, and the server address typed in by the user.
// Usage: node scripts/e2e-native.mjs <api-url> <app-www-dir> [app-port]
//   The API must allow the app origin:  CORS_ORIGINS=http://localhost:<app-port>
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)('playwright');
const [api, www, portArg] = process.argv.slice(2);
const port = Number(portArg ?? 3001);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer((req, res) => { // a minimal static server standing in for the Android web view's local server
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(www, p === '/' ? 'index.html' : p);
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
}).listen(port);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
await ctx.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true }; }); // what the native bridge provides
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
let step = 0;
const ok = (m) => console.log(`ok ${++step} - ${m}`);
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

try {
  await page.goto(`http://localhost:${port}/`);
  await page.locator('#server').waitFor();
  assert.equal(await page.evaluate(() => navigator.serviceWorker?.controller ?? null), null);
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
  ok('server-address field shown in the app; no service worker registered');

  await page.getByTestId('toggle-mode').click();
  await page.fill('#server', 'ftp://nonsense');
  await page.fill('#name', 'Native Tester'); await page.fill('#email', `native-${Date.now()}@example.com`); await page.fill('#password', 'correct-horse-battery');
  await page.getByTestId('submit').click();
  await page.getByText(/does not look right/).waitFor();
  ok('a malformed server address is refused with a clear message');

  // after an error the form is re-rendered: the password and name are cleared (the e-mail and server are kept)
  await page.fill('#server', api);
  await page.fill('#name', 'Native Tester');
  await page.fill('#password', 'correct-horse-battery');
  await page.getByTestId('submit').click();
  await page.getByRole('heading', { name: 'Today' }).waitFor();
  ok('registered against a server on a different origin (CORS preflight + bearer token work)');

  await page.fill('#temp', '36.55'); await page.fill('#lh', '30'); await page.fill('#e3g', '12');
  await page.getByText('Egg-white', { exact: true }).click();
  await page.getByTestId('save').click();
  await page.getByTestId('msg').filter({ hasText: /Saved/ }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid=pending]')?.textContent.includes('All saved'), null, { timeout: 30000 });
  await page.getByTestId('tab-chart').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.pill')].some((p) => p.textContent === 'Peak'), null, { timeout: 30000 });
  ok('entry synced to the server and the server prediction (Peak) came back');

  assert.equal(await page.evaluate(() => localStorage.getItem('serverUrl')), new URL(api).origin);
  await page.getByTestId('tab-account').click();
  await page.getByTestId('logout').click();
  await page.getByTestId('submit').waitFor();
  assert.equal(await page.inputValue('#server'), new URL(api).origin, 'server address is remembered');
  ok('server address remembered after sign-out');

  assert.deepEqual(problems, [], problems.join(' | '));
  ok('no console or page errors');
  console.log(`\nALL ${step} NATIVE-MODE CHECKS PASSED`);
} catch (e) {
  console.error('\nFAILED:', e.message, '\n', problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
