import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { hash, verify } from '@node-rs/argon2';

export const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest();
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const numericCode = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, '0');

// Argon2id (OWASP recommended parameters).
export const hashPassword = (pw: string) => hash(pw, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = async (h: string, pw: string) => { try { return await verify(h, pw); } catch { return false; } };

export function hmac(secret: string, data: string) { return createHmac('sha256', secret).update(data).digest('base64url'); }
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Encrypts small secrets at rest (TOTP seeds) with AES-256-GCM. Key is derived from URL_SIGNING_SECRET;
// rotate by re-enrolling MFA. This is server-side secret storage, unrelated to message E2EE.
const dek = createHash('sha256').update('wz-dek:' + config.urlSigningSecret).digest();
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function unseal(sealed: string): string {
  const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', dek, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
