import { z } from 'zod';

const hexKey = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .regex(/^[0-9a-fA-F]{64}$/, `${name} must be 64 hex characters (32 bytes)`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  /** Trust X-Forwarded-For (set only when running behind the Cloudflare/AWS gateway). */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),

  /** Login role granted `phi_app`: serves patients and clinicians. */
  DATABASE_URL: z.string().url(),
  /** Login role granted `engine_worker`: recalculation worker only. */
  WORKER_DATABASE_URL: z.string().url().optional(),
  /** Login role granted `identity_app`: identity service only. */
  IDENTITY_DATABASE_URL: z.string().url().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('fertility-identity'),
  JWT_AUDIENCE: z.string().min(1).default('fertility-api'),

  /** HMAC-SHA256 key deriving clinical_data.subject_id from identity_vault.user_id. */
  PSEUDONYM_KEY: hexKey('PSEUDONYM_KEY'),
  /** AES-256-GCM key for identity_vault.users.encrypted_pii. */
  FIELD_ENCRYPTION_KEY: hexKey('FIELD_ENCRYPTION_KEY'),
  /** HMAC key hashing client IPs for the audit log. */
  IP_HASH_KEY: hexKey('IP_HASH_KEY'),
  /** HMAC key hashing e-mail addresses for unique lookup. */
  EMAIL_HASH_KEY: hexKey('EMAIL_HASH_KEY'),

  ENGINE_URL: z.string().url().default('http://127.0.0.1:8000'),
  ENGINE_TOKEN: z.string().min(32, 'ENGINE_TOKEN must be at least 32 characters'),

  /** Named assay profile the recalculation worker asks the engine to use (e.g. mira-marquette-2021-preliminary). */
  ASSAY_PROFILE: z.string().regex(/^[a-z0-9._-]+$/i, 'ASSAY_PROFILE must be a profile name').default('spec-provisional-1'),

  /** Access-token lifetime, e.g. 15m, 1h, 12h. */
  TOKEN_TTL: z.string().regex(/^\d+[smhd]$/, 'TOKEN_TTL must look like 15m, 1h or 7d').default('1h'),
  /** Run the recalculation worker inside the API process (single-container demo deployments). */
  RUN_WORKER: z.enum(['true', 'false']).default('false'),
  /** Directory of the installable web app to serve at /. Unset = API only. */
  PWA_DIR: z.string().optional(),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  trustProxy: boolean;
  databaseUrl: string;
  workerDatabaseUrl?: string;
  identityDatabaseUrl?: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  pseudonymKey: Buffer;
  fieldEncryptionKey: Buffer;
  ipHashKey: Buffer;
  emailHashKey: Buffer;
  engineUrl: string;
  engineToken: string;
  assayProfile: string;
  tokenTtl: string;
  runWorker: boolean;
  pwaDir?: string;
  rateLimitPerMinute: number;
}

/** Parse and validate the environment. Throws with every problem listed; never echoes secret values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;

  const keys: Array<[string, string]> = [
    ['PSEUDONYM_KEY', e.PSEUDONYM_KEY],
    ['FIELD_ENCRYPTION_KEY', e.FIELD_ENCRYPTION_KEY],
    ['IP_HASH_KEY', e.IP_HASH_KEY],
    ['EMAIL_HASH_KEY', e.EMAIL_HASH_KEY],
  ];
  const seen = new Map<string, string>();
  for (const [name, value] of keys) {
    const k = value.toLowerCase();
    const other = seen.get(k);
    if (other) throw new Error(`Invalid configuration: ${name} must differ from ${other} (one key per purpose)`);
    seen.set(k, name);
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    trustProxy: e.TRUST_PROXY === 'true',
    databaseUrl: e.DATABASE_URL,
    workerDatabaseUrl: e.WORKER_DATABASE_URL,
    identityDatabaseUrl: e.IDENTITY_DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    jwtIssuer: e.JWT_ISSUER,
    jwtAudience: e.JWT_AUDIENCE,
    pseudonymKey: Buffer.from(e.PSEUDONYM_KEY, 'hex'),
    fieldEncryptionKey: Buffer.from(e.FIELD_ENCRYPTION_KEY, 'hex'),
    ipHashKey: Buffer.from(e.IP_HASH_KEY, 'hex'),
    emailHashKey: Buffer.from(e.EMAIL_HASH_KEY, 'hex'),
    engineUrl: e.ENGINE_URL,
    engineToken: e.ENGINE_TOKEN,
    assayProfile: e.ASSAY_PROFILE,
    tokenTtl: e.TOKEN_TTL,
    runWorker: e.RUN_WORKER === 'true',
    pwaDir: e.PWA_DIR,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
  };
}
