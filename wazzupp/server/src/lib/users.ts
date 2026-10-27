import { one, q } from '../db/pool.ts';
import type { Db } from '../db/pool.ts';
import { withDefaults } from './settings.ts';

export interface SelfUser {
  id: string; username: string; email: string | null; phone: string | null; displayName: string; bio: string; statusText: string;
  avatarMediaId: string | null; emailVerified: boolean; phoneVerified: boolean; mfaEnabled: boolean; role: string;
  settings: Record<string, any>; settingsVersion: number; createdAt: string;
}

export async function loadSelf(userId: string): Promise<SelfUser> {
  const r = await one(
    `select u.id, u.username, u.email, u.phone, u.email_verified_at, u.phone_verified_at, u.mfa_enabled, u.role, u.created_at,
            p.display_name, p.bio, p.status_text, p.avatar_media_id, p.settings, p.settings_version
       from users u join user_profiles p on p.user_id = u.id where u.id = $1`, [userId]);
  return {
    id: r.id, username: r.username, email: r.email, phone: r.phone, displayName: r.display_name, bio: r.bio, statusText: r.status_text,
    avatarMediaId: r.avatar_media_id, emailVerified: !!r.email_verified_at, phoneVerified: !!r.phone_verified_at, mfaEnabled: r.mfa_enabled,
    role: r.role, settings: withDefaults(r.settings), settingsVersion: r.settings_version, createdAt: r.created_at.toISOString(),
  };
}

export type Field = 'lastSeen' | 'online' | 'profilePhoto' | 'about' | 'phoneVisible';

/** Does `owner` allow `viewer` to see `field`? "contacts" means the owner has saved the viewer as a contact. */
export async function allowed(ownerId: string, viewerId: string, field: Field, db: Db = { query: q } as any): Promise<boolean> {
  if (ownerId === viewerId) return true;
  const r = await db.query(
    `select p.settings->'privacy'->>$3 as pv, exists(select 1 from contacts c where c.owner_id = $1 and c.contact_id = $2) as is_contact,
            exists(select 1 from blocks b where b.blocker_id = $1 and b.blocked_id = $2) as blocked
       from user_profiles p where p.user_id = $1`, [ownerId, viewerId, field === 'online' ? 'lastSeen' : field]);
  const row = r.rows[0];
  if (!row || row.blocked) return false;
  const def = field === 'phoneVisible' ? 'nobody' : 'everyone';
  const v = row.pv ?? def;
  return v === 'everyone' || (v === 'contacts' && row.is_contact);
}

export interface PublicUser { id: string; username: string; displayName: string; avatarMediaId: string | null; bio: string | null; statusText: string | null; lastSeenAt: string | null; phone: string | null; }

export async function publicUser(userId: string, viewerId: string): Promise<PublicUser | null> {
  const r = await one(
    `select u.id, u.username, u.phone, u.status, p.display_name, p.bio, p.status_text, p.avatar_media_id,
            (select max(last_seen_at) from devices d where d.user_id = u.id) last_seen
       from users u join user_profiles p on p.user_id = u.id where u.id = $1`, [userId]);
  if (!r || r.status === 'deleted') return null;
  const [photo, about, seen, phone] = await Promise.all([
    allowed(userId, viewerId, 'profilePhoto'), allowed(userId, viewerId, 'about'), allowed(userId, viewerId, 'lastSeen'), allowed(userId, viewerId, 'phoneVisible'),
  ]);
  return {
    id: r.id, username: r.username, displayName: r.display_name,
    avatarMediaId: photo ? r.avatar_media_id : null, bio: about ? r.bio : null, statusText: about ? r.status_text : null,
    lastSeenAt: seen && r.last_seen ? r.last_seen.toISOString() : null, phone: phone ? r.phone : null,
  };
}

export async function isBlockedEitherWay(a: string, b: string, db: Db = { query: q } as any) {
  const r = await db.query('select 1 from blocks where (blocker_id=$1 and blocked_id=$2) or (blocker_id=$2 and blocked_id=$1) limit 1', [a, b]);
  return r.rowCount! > 0;
}

/** Pure privacy check used where the settings were already loaded in bulk. */
export function canSee(settings: Record<string, any> | null, field: Field, isContact: boolean, blocked: boolean): boolean {
  if (blocked) return false;
  const key = field === 'online' ? 'lastSeen' : field;
  const v = settings?.privacy?.[key] ?? (field === 'phoneVisible' ? 'nobody' : 'everyone');
  return v === 'everyone' || (v === 'contacts' && isContact);
}
