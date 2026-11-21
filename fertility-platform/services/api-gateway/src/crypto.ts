import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const TAG_BYTES = 16;
const VERSION = 'v1';

function requireKey(key: Buffer): void {
  if (key.length !== 32) throw new RangeError('key must be exactly 32 bytes');
}

/**
 * AES-256-GCM field encryption. Output envelope: `v1:<iv>:<tag>:<ciphertext>`
 * (base64url), matching the CHECK constraint on identity_vault.users.
 *
 * `aad` (additional authenticated data) binds the ciphertext to its location,
 * e.g. `identity_vault.users.encrypted_pii:<user_id>`, so a ciphertext copied
 * to another row or column fails authentication instead of decrypting.
 */
export function encryptField(plaintext: string, key: Buffer, aad: string): string {
  requireKey(key);
  const iv = randomBytes(IV_BYTES); // fresh random nonce per encryption
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

/** Decrypt an envelope; throws if the key, AAD or any byte differs from what was encrypted. */
export function decryptField(envelope: string, key: Buffer, aad: string): string {
  requireKey(key);
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('unsupported or malformed ciphertext envelope');
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('unsupported or malformed ciphertext envelope');
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('decryption failed: wrong key, wrong context, or tampered data');
  }
}

/** Keyed hash (HMAC-SHA256) as lowercase hex. */
export function hmacHex(key: Buffer, data: string): string {
  requireKey(key);
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/**
 * Cryptographic pseudonym linking identity_vault.users.user_id to
 * clinical_data.*.subject_id. Deterministic, irreversible without the key, and
 * not stored in the vault, so the two databases cannot be joined by an
 * attacker who lacks PSEUDONYM_KEY.
 */
export function pseudonymize(userId: string, key: Buffer): string {
  return hmacHex(key, `subject:v1:${userId.toLowerCase()}`);
}

export function hashIp(ip: string, key: Buffer): string {
  return hmacHex(key, `ip:v1:${ip}`);
}

export function hashEmail(email: string, key: Buffer): string {
  return hmacHex(key, `email:v1:${email.trim().toLowerCase()}`);
}
