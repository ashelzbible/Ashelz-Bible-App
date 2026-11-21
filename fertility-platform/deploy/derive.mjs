// Derive every secret from ONE master secret (HKDF-SHA256, a distinct label per purpose), so a single
// generated value configures the deployment while the keys stay independent of each other.
import { hkdfSync } from 'node:crypto';

export const ROLES = {
  gateway: { name: 'fertility_gateway', group: 'phi_app' },
  worker: { name: 'fertility_worker', group: 'engine_worker' },
  identity: { name: 'fertility_identity', group: 'identity_app' },
};

export function derive(master) {
  if (typeof master !== 'string' || master.length < 32) throw new Error('MASTER_SECRET must be set and at least 32 characters');
  const k = (label) => Buffer.from(hkdfSync('sha256', master, 'fertility-demo-v1', label, 32)).toString('hex');
  return {
    PSEUDONYM_KEY: k('pseudonym-key'),
    FIELD_ENCRYPTION_KEY: k('field-encryption-key'),
    IP_HASH_KEY: k('ip-hash-key'),
    EMAIL_HASH_KEY: k('email-hash-key'),
    JWT_SECRET: k('jwt-secret'),
    ENGINE_TOKEN: k('engine-token'),
    rolePasswords: Object.fromEntries(Object.keys(ROLES).map((r) => [r, k(`db-password:${r}`)])),
  };
}

/** Same server and database as the owner URL, but signed in as one of the restricted service roles. */
export function roleUrl(ownerUrl, role, password) {
  const u = new URL(ownerUrl);
  u.username = ROLES[role].name;
  u.password = password;
  return u.toString();
}
