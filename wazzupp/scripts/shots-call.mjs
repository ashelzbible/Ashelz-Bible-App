// Starts a real WebRTC video call between two browsers (fake camera) and captures the call UI + dark mode.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE_URL ?? 'http://localhost:8787'; const OUT = process.argv[2] ?? '/tmp/wz-shots'; mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
async function login(user, vp) {
  const ctx = await browser.newContext({ viewport: vp, permissions: ['camera', 'microphone'] }); const page = await ctx.newPage();
  await page.goto(BASE); await page.fill('input[autocomplete="username"]', user); await page.fill('input[type="password"]', 'demo-password-123'); await page.click('button[type="submit"]'); await page.waitForSelector('.app'); return { ctx, page };
}
const vp = { width: 1180, height: 820 };
const a = await login('alex', vp); const s = await login('sarah', vp);
await a.page.evaluate(() => { location.hash = '#/chats'; });
await a.page.locator('.conv-row', { hasText: 'Sarah Johnson' }).first().click();
await a.page.getByLabel('Voice call').click();
await s.page.getByLabel('Accept').waitFor(); await s.page.screenshot({ path: `${OUT}/call-incoming.png` });
await a.page.screenshot({ path: `${OUT}/call-outgoing.png` });
await s.page.getByLabel('Accept').click();
await a.page.waitForFunction(() => /^\d\d:\d\d$/.test(document.querySelector('.call-status')?.textContent ?? ''), null, { timeout: 30000 });
await a.page.waitForTimeout(2200); await a.page.screenshot({ path: `${OUT}/call-active.png` });
await a.page.getByLabel('End call').click(); await a.page.waitForTimeout(1500);
// dark mode desktop
await a.page.setViewportSize({ width: 1440, height: 900 });
await a.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; location.hash = '#/chats'; });
await a.page.locator('.conv-row', { hasText: 'Sarah Johnson' }).first().click(); await a.page.waitForTimeout(1200);
await a.page.screenshot({ path: `${OUT}/desktop-dark.png` });
await browser.close(); console.log('done');
