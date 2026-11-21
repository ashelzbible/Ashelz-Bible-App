// Prints `export NAME='value'` lines for the app, derived from MASTER_SECRET and DATABASE_OWNER_URL.
// Usage:  eval "$(node deploy/env.mjs)"
import { derive, roleUrl } from './derive.mjs';

const { rolePasswords, ...keys } = derive(process.env.MASTER_SECRET);
const owner = process.env.DATABASE_OWNER_URL;
if (!owner) throw new Error('DATABASE_OWNER_URL is required');
const out = {
  ...keys,
  DATABASE_URL: roleUrl(owner, 'gateway', rolePasswords.gateway),
  WORKER_DATABASE_URL: roleUrl(owner, 'worker', rolePasswords.worker),
  IDENTITY_DATABASE_URL: roleUrl(owner, 'identity', rolePasswords.identity),
};
for (const [k, v] of Object.entries(out)) console.log(`export ${k}='${v.replaceAll("'", "'\\''")}'`);
