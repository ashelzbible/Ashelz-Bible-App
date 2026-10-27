// Captures screenshots of the running app (default http://localhost:8787) for visual review.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const OUT = process.argv[2] ?? '/tmp/wz-shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

async function login(ctx, user) {
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', 'demo-password-123');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.app', { timeout: 15000 });
  return page;
}
// Sarah stays connected so Alex sees her as online.
const sarahCtx = await browser.newContext(); const sarahPage = await login(sarahCtx, 'sarah');

const shots = [
  ['desktop', { width: 1440, height: 900 }, [['chat', '#/chats'], ['calls', '#/calls'], ['status', '#/status'], ['communities', '#/communities'], ['settings', '#/settings/privacy']]],
  ['tablet', { width: 1180, height: 820 }, [['chat', '#/chats'], ['calls', '#/calls'], ['communities', '#/communities'], ['status', '#/status']]],
  ['phone', { width: 390, height: 844 }, [['chats', '#/chats'], ['conv', '#/chats/open'], ['calls', '#/calls'], ['status', '#/status'], ['settings', '#/settings']]],
];
for (const [name, vp, routes] of shots) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: name === 'phone' ? 2 : 1.5, hasTouch: name === 'phone' });
  const page = await login(ctx, 'alex');
  await page.waitForTimeout(1200);
  for (const [label, hash] of routes) {
    if (hash === '#/chats/open' ) {
      await page.evaluate(() => { location.hash = '#/chats'; }); await page.waitForTimeout(300);
      await page.locator('.conv-row', { hasText: 'Sarah Johnson' }).first().click();
    } else if (name !== 'phone' && label === 'chat') {
      await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(300);
      await page.locator('.conv-row', { hasText: 'Sarah Johnson' }).first().click();
    } else if (label === 'calls' && name !== 'phone') {
      await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(500);
      await page.locator('.call-open').first().click();
    } else if (label === 'communities' && name !== 'phone') {
      await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(500);
      await page.locator('.conv-row', { hasText: 'Workplace' }).first().click();
    } else if (label === 'status' && name !== 'phone') {
      await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(500);
      await page.locator('.conv-row', { hasText: 'Sarah Johnson' }).first().click();
    } else { await page.evaluate((h) => { location.hash = h; }, hash); }
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}/${name}-${label}.png` });
  }
  await ctx.close();
}
await browser.close();
console.log('done', OUT);
