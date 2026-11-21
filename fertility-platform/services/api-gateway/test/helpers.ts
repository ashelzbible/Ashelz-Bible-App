import { loadConfig, type Config } from '../src/config.js';

export const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://phi_app@localhost/db',
  JWT_SECRET: 'j'.repeat(40),
  PSEUDONYM_KEY: '11'.repeat(32),
  FIELD_ENCRYPTION_KEY: '22'.repeat(32),
  IP_HASH_KEY: '33'.repeat(32),
  EMAIL_HASH_KEY: '44'.repeat(32),
  ENGINE_TOKEN: 'e'.repeat(40),
  RATE_LIMIT_PER_MINUTE: '1000',
};

export const testConfig = (over: NodeJS.ProcessEnv = {}): Config => loadConfig({ ...TEST_ENV, ...over });

export const IDS = {
  patientA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  patientB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  clinician: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  admin: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  device: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};

export const bbtEvent = (n: number, over: Record<string, unknown> = {}) => ({
  event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  device_id: IDS.device,
  lamport: n,
  client_ts: '2025-03-01T06:30:00Z',
  kind: 'BBT',
  op: 'SET',
  log_date: `2025-03-${String(((n - 1) % 28) + 1).padStart(2, '0')}`,
  payload: { temp_c: 36.5 },
  ...over,
});
