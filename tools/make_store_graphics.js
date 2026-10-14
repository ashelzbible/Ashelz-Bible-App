/* Makes the Google Play graphics: 512 icon, 1024x500 feature graphic and phone screenshots.  Run from the app folder:  node tools/make_store_graphics.js
   Needs Playwright with a Chromium browser (npm i playwright). Output goes to docs/play-store/graphics. */
var path = require('path'), fs = require('fs'), http = require('http');
var pw; try { pw = require('playwright'); } catch(e) { pw = require(process.env.PLAYWRIGHT_PATH || '/home/user/Pessa--App/node_modules/playwright'); }
var root = path.join(__dirname, '..'), out = path.join(root, 'docs', 'play-store', 'graphics'); fs.mkdirSync(out, { recursive: true });
var types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
var srv = http.createServer(function(q, r){ var p = decodeURIComponent(q.url.split('?')[0]); if(p.endsWith('/')) p += 'index.html'; var f = path.join(root, p); if(!fs.existsSync(f) || fs.statSync(f).isDirectory()){ r.statusCode = 404; r.end('no'); return; } r.setHeader('content-type', types[path.extname(f)] || 'application/octet-stream'); r.end(fs.readFileSync(f)); }).listen(8140);
(async function(){
  var b = await pw.chromium.launch({ args: ['--no-sandbox'] });
  fs.copyFileSync(path.join(root, 'icon-512.png'), path.join(out, 'icon-512.png'));
  /* feature graphic 1024x500 */
  var logo = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'logo.png')).toString('base64');
  var pg0 = await (await b.newContext({ viewport: { width: 1024, height: 500 } })).newPage();
  await pg0.setContent('<body style="margin:0;width:1024px;height:500px;background:linear-gradient(160deg,#0a1f4d,#1646b4 60%,#2b7bff);font-family:Georgia,serif;color:#fff;display:flex;align-items:center;overflow:hidden;position:relative"><div style="position:absolute;right:-60px;top:-60px;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle,rgba(255,225,140,.55),rgba(255,225,140,0) 65%)"></div><img src="' + logo + '" style="width:300px;height:300px;margin:0 50px 0 70px;position:relative"><div style="position:relative"><div style="font:italic 700 96px Georgia,serif;color:#f6c453;line-height:1">Ashelz</div><div style="font:600 46px system-ui,sans-serif;margin-top:6px">Bible App</div><div style="font:500 24px system-ui,sans-serif;letter-spacing:6px;margin-top:18px;opacity:.95">BIBLE • DEVOTIONAL • HOPE</div><div style="font:600 26px system-ui,sans-serif;margin-top:22px;color:#cfe0ff">100% free. No ads. No subscriptions.</div></div></body>');
  await pg0.screenshot({ path: path.join(out, 'feature-graphic-1024x500.png') });
  /* phone screenshots 1080x1920 */
  var ctx = await b.newContext({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2, serviceWorkers: 'block' }), pg = await ctx.newPage();
  await pg.goto('http://localhost:8140/'); await pg.evaluate(function(){ localStorage.setItem('woh_skip_v1', '"1"'); localStorage.setItem('woh_name_v1', '"Grace"'); }); await pg.reload(); await pg.waitForTimeout(1500);
  async function snap(name){ await pg.waitForTimeout(700); await pg.screenshot({ path: path.join(out, name) }); }
  await snap('screenshot-1-home.png');
  await pg.click('[data-tab=devotions]'); await snap('screenshot-2-devotions.png');
  await pg.click('[data-tab=bible]'); await pg.waitForTimeout(300); await pg.fill('input[aria-label="Search the Bible"]', 'Psalms 23'); await pg.press('input[aria-label="Search the Bible"]', 'Enter'); await pg.waitForTimeout(1200); await snap('screenshot-3-reader.png');
  async function more(label){ await pg.click('[data-tab=more]'); await pg.locator('button.li', { hasText: label }).first().click(); }
  await more('Prayers'); await snap('screenshot-4-prayers.png');
  await pg.click('[data-tab=more]'); await pg.waitForTimeout(400); await pg.locator('button.li', { hasText: 'Online Homecell' }).first().click(); await snap('screenshot-5-homecell.png');
  await pg.click('[data-tab=more]'); await pg.locator('button.li', { hasText: 'Theme' }).first().click(); await snap('screenshot-6-theme.png');
  await b.close(); srv.close(); console.log('graphics in ' + out);
})().catch(function(e){ console.error(e); process.exit(1); });
