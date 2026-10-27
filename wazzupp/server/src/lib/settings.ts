import { z } from 'zod';

const audience = z.enum(['everyone', 'contacts', 'nobody']);

export const settingsSchema = z.object({
  privacy: z.object({
    lastSeen: audience,
    online: z.enum(['everyone', 'same_as_last_seen']),
    profilePhoto: audience,
    about: audience,
    phoneVisible: audience,
    readReceipts: z.boolean(),
    groupInvites: audience,
    statusAudience: z.enum(['contacts', 'except', 'only']),
    linkPreviews: z.boolean(),
    discoverable: z.boolean(),
    statusSharing: z.boolean(),
    statusExcept: z.array(z.string().uuid()).max(500),
    statusOnly: z.array(z.string().uuid()).max(500),
  }).partial(),
  notifications: z.object({
    messages: z.boolean(),
    groups: z.boolean(),
    calls: z.boolean(),
    previews: z.boolean(),
    sound: z.boolean(),
    quietHours: z.object({ enabled: z.boolean(), start: z.string().regex(/^\d\d:\d\d$/), end: z.string().regex(/^\d\d:\d\d$/), utcOffsetMinutes: z.number().int().min(-840).max(840) }).partial(),
  }).partial(),
  appearance: z.object({
    theme: z.enum(['system', 'light', 'dark']),
    fontSize: z.enum(['sm', 'md', 'lg']),
    wallpaper: z.enum(['doodle', 'plain', 'emerald']),
    language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    highContrast: z.boolean(),
    reduceMotion: z.boolean(),
  }).partial(),
  media: z.object({
    autoDownloadImages: z.boolean(), autoDownloadVideos: z.boolean(), autoDownloadDocuments: z.boolean(), dataSaver: z.boolean(),
  }).partial(),
  statusTtlHours: z.number().int().min(1).max(24).optional(),
}).partial().strict();

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS = {
  privacy: { lastSeen: 'everyone', online: 'everyone', profilePhoto: 'everyone', about: 'everyone', phoneVisible: 'nobody', readReceipts: true, groupInvites: 'everyone', statusAudience: 'contacts', linkPreviews: true, discoverable: false, statusSharing: true, statusExcept: [], statusOnly: [] },
  notifications: { messages: true, groups: true, calls: true, previews: true, sound: true, quietHours: { enabled: false, start: '22:00', end: '07:00', utcOffsetMinutes: 0 } },
  appearance: { theme: 'system', fontSize: 'md', wallpaper: 'doodle', language: 'en', highContrast: false, reduceMotion: false },
  media: { autoDownloadImages: true, autoDownloadVideos: false, autoDownloadDocuments: false, dataSaver: false },
  statusTtlHours: 24,
} as const;

type Json = Record<string, any>;
export function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] ? deepMerge(base[k], v) : v;
  }
  return out;
}
export const withDefaults = (stored: Json): Json => deepMerge(DEFAULT_SETTINGS as unknown as Json, stored ?? {});

export function inQuietHours(s: Json, now = new Date()): boolean {
  const qh = s.notifications?.quietHours;
  if (!qh?.enabled) return false;
  const local = new Date(now.getTime() + (qh.utcOffsetMinutes ?? 0) * 60000);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const [sh, sm] = qh.start.split(':').map(Number); const [eh, em] = qh.end.split(':').map(Number);
  const a = sh * 60 + sm, b = eh * 60 + em;
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}
