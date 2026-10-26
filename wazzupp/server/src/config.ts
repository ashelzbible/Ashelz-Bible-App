import { randomBytes } from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function secret(name: string): string {
  const v = env[name];
  if (v && v.length >= 32) return v;
  if (isProd) throw new Error(`${name} must be set (min 32 chars) in production`);
  // Development only: ephemeral secret, sessions are opaque DB tokens so this only affects signed URLs.
  return randomBytes(32).toString('hex');
}

export const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://wazzupp:wazzupp@127.0.0.1:5432/wazzupp',
  redisUrl: env.REDIS_URL || '',
  urlSigningSecret: secret('URL_SIGNING_SECRET'),
  publicUrl: env.PUBLIC_URL ?? 'http://localhost:8787',
  corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  requireVerification: (env.REQUIRE_VERIFICATION ?? 'true') === 'true',
  sessionDays: Number(env.SESSION_DAYS ?? 30),
  mediaDir: env.MEDIA_DIR ?? './data/media',
  storageQuotaBytes: Number(env.STORAGE_QUOTA_BYTES ?? 2 * 1024 ** 3),
  maxUploadBytes: {
    image: 16 * 1024 ** 2,
    video: 64 * 1024 ** 2,
    audio: 32 * 1024 ** 2,
    voice: 16 * 1024 ** 2,
    document: 50 * 1024 ** 2,
    sticker: 2 * 1024 ** 2,
    avatar: 5 * 1024 ** 2,
  } as Record<string, number>,
  statusTtlSeconds: Number(env.STATUS_TTL_SECONDS ?? 24 * 3600),
  editWindowSeconds: Number(env.EDIT_WINDOW_SECONDS ?? 15 * 60),
  deleteForAllWindowSeconds: Number(env.DELETE_FOR_ALL_WINDOW_SECONDS ?? 48 * 3600),
  ringTimeoutSeconds: Number(env.RING_TIMEOUT_SECONDS ?? 45),
  eventRetentionDays: Number(env.EVENT_RETENTION_DAYS ?? 14),
  smtpUrl: env.SMTP_URL || '',
  mailFrom: env.MAIL_FROM ?? 'Wazzupp <no-reply@wazzupp.local>',
  vapid: { publicKey: env.VAPID_PUBLIC_KEY || '', privateKey: env.VAPID_PRIVATE_KEY || '', subject: env.VAPID_SUBJECT ?? 'mailto:admin@wazzupp.local' },
  ice: {
    stun: (env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean),
    turn: (env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    turnSecret: env.TURN_SECRET || '',
  },
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  adminEmails: (env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  rateLimitDisabled: env.RATE_LIMIT_DISABLED === 'true' && !isProd,
};
