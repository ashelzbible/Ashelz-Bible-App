// Copy the dependency-free parts of @fertility/sync-protocol (Lamport clock, ordering, canonical JSON)
// into the web app, so the browser runs the exact code the server and tests run. Run after the protocol is built.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/sync-protocol/dist');
const dst = join(root, 'apps/pwa/vendor/sync-protocol');
const files = ['clock.js', 'order.js', 'canonical.js'];
if (process.argv.includes('--check')) { // fail if the committed copies differ from a fresh build of the protocol
  const stale = files.filter((f) => !existsSync(join(dst, f)) || readFileSync(join(dst, f), 'utf8') !== readFileSync(join(src, f), 'utf8'));
  if (stale.length) { console.error(`apps/pwa/vendor is out of date (${stale.join(', ')}). Run: npm run build`); process.exit(1); }
  console.log('client protocol copies are up to date');
} else {
  mkdirSync(dst, { recursive: true });
  for (const f of files) copyFileSync(join(src, f), join(dst, f));
  console.log(`copied client protocol to ${dst}`);
}
