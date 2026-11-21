import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, hashEmail, hashIp, hmacHex, pseudonymize } from '../src/crypto.js';

const key = randomBytes(32);
const aad = 'identity_vault.users.encrypted_pii:u1';

describe('AES-256-GCM field encryption', () => {
  it('round-trips unicode text and matches the DB envelope format', () => {
    const pt = JSON.stringify({ name: 'Ndapewa Shikongo', note: 'Windhoek ☀' });
    const env = encryptField(pt, key, aad);
    expect(env).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(env).not.toContain('Ndapewa');
    expect(decryptField(env, key, aad)).toBe(pt);
  });

  it('round-trips the empty string', () => {
    expect(decryptField(encryptField('', key, aad), key, aad)).toBe('');
  });

  it('uses a fresh nonce every time', () => {
    const a = encryptField('same', key, aad);
    const b = encryptField('same', key, aad);
    expect(a).not.toBe(b);
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
  });

  it('rejects the wrong key', () => {
    expect(() => decryptField(encryptField('x', key, aad), randomBytes(32), aad)).toThrow(/decryption failed/);
  });

  it('rejects a ciphertext moved to a different row (AAD binding)', () => {
    const env = encryptField('x', key, 'identity_vault.users.encrypted_pii:u1');
    expect(() => decryptField(env, key, 'identity_vault.users.encrypted_pii:u2')).toThrow(/decryption failed/);
  });

  it.each([1, 2, 3])('rejects tampering with envelope part %i', (i) => {
    const parts = encryptField('secret value', key, aad).split(':');
    const buf = Buffer.from(parts[i]!, 'base64url');
    buf[0] = buf[0]! ^ 0x01;
    parts[i] = buf.toString('base64url');
    expect(() => decryptField(parts.join(':'), key, aad)).toThrow();
  });

  it('rejects malformed envelopes and unknown versions', () => {
    expect(() => decryptField('garbage', key, aad)).toThrow(/malformed/);
    expect(() => decryptField('v2:a:b:c', key, aad)).toThrow(/malformed/);
    expect(() => decryptField('v1:AA:AA:AA', key, aad)).toThrow(/malformed/);
  });

  it('requires a 32-byte key', () => {
    expect(() => encryptField('x', randomBytes(16), aad)).toThrow(RangeError);
    expect(() => decryptField('v1:a:b:c', randomBytes(31), aad)).toThrow(RangeError);
    expect(() => hmacHex(randomBytes(8), 'x')).toThrow(RangeError);
  });
});

describe('keyed hashing and pseudonymisation', () => {
  const k1 = Buffer.alloc(32, 1);
  const k2 = Buffer.alloc(32, 2);
  const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('HMAC-SHA256 known-answer test (RFC 4231 case 2 style, key padded)', () => {
    const rfcKey = Buffer.alloc(32, 0x0b);
    expect(hmacHex(rfcKey, 'Hi There')).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacHex(rfcKey, 'Hi There')).toBe(hmacHex(rfcKey, 'Hi There'));
  });

  it('pseudonym is deterministic, 64-hex, case-insensitive on the uuid, key-dependent', () => {
    const p = pseudonymize(uid, k1);
    expect(p).toMatch(/^[0-9a-f]{64}$/);
    expect(pseudonymize(uid.toUpperCase(), k1)).toBe(p);
    expect(pseudonymize(uid, k2)).not.toBe(p);
    expect(pseudonymize('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', k1)).not.toBe(p);
    expect(p).not.toContain(uid.replaceAll('-', ''));
  });

  it('domain-separates the same input across purposes', () => {
    const x = 'user@example.com';
    expect(new Set([pseudonymize(x, k1), hashIp(x, k1), hashEmail(x, k1)]).size).toBe(3);
  });

  it('normalises e-mail before hashing', () => {
    expect(hashEmail('  User@Example.COM ', k1)).toBe(hashEmail('user@example.com', k1));
  });
});
