import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TEST_ENV } from './helpers.js';

describe('loadConfig', () => {
  it('parses a valid environment into typed values and 32-byte keys', () => {
    const c = loadConfig(TEST_ENV);
    expect(c.port).toBe(8080);
    expect(c.trustProxy).toBe(false);
    expect(c.pseudonymKey).toHaveLength(32);
    expect(c.fieldEncryptionKey).toHaveLength(32);
  });

  it('fails fast and lists every problem without echoing secret values', () => {
    let msg = '';
    try {
      loadConfig({ ...TEST_ENV, JWT_SECRET: 'short-secret-value', PSEUDONYM_KEY: 'zz', ENGINE_TOKEN: undefined });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/JWT_SECRET/);
    expect(msg).toMatch(/PSEUDONYM_KEY/);
    expect(msg).toMatch(/ENGINE_TOKEN/);
    expect(msg).not.toContain('short-secret-value');
  });

  it('refuses to reuse one key for two purposes', () => {
    expect(() => loadConfig({ ...TEST_ENV, IP_HASH_KEY: TEST_ENV.PSEUDONYM_KEY })).toThrow(/one key per purpose/);
    expect(() => loadConfig({ ...TEST_ENV, EMAIL_HASH_KEY: TEST_ENV.FIELD_ENCRYPTION_KEY!.toUpperCase() })).toThrow(/one key per purpose/);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ ...TEST_ENV, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });
});
