// Copy the dependency-free parts of @fertility/sync-protocol (Lamport clock, ordering, canonical JSON)
// into the web app, so the browser runs the exact code the server and tests run. Run after the protocol is built.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/sync-protocol/dist');
const dst = join(root, 'apps/pwa/vendor/sync-protocol');
mkdirSync(dst, { recursive: true });
for (const f of ['clock.js', 'order.js', 'canonical.js']) copyFileSync(join(src, f), join(dst, f));
console.log(`copied client protocol to ${dst}`);
