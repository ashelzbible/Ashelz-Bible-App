import type { Db, Tx } from '../db/pool.ts';
import { q } from '../db/pool.ts';
import { notFound } from './errors.ts';

export interface ConvRow {
  id: string; kind: 'direct' | 'group' | 'channel' | 'announcement'; direct_key: string | null; title: string | null; description: string; avatar_media_id: string | null;
  created_by: string | null; announce_only: boolean; members_can_edit_info: boolean; members_can_invite: boolean; disappearing_seconds: number | null;
  community_id: string | null; is_public: boolean; last_seq: number; role: string; muted_until: Date | null; first_visible_seq: number;
}

/** Returns the conversation plus the caller's membership; 404 (never 403) when the caller is not an active member, so ids do not leak existence. */
export async function requireMember(db: Db | Tx, conversationId: string, userId: string, lock = false): Promise<ConvRow> {
  const sql = `select c.*, m.role, m.muted_until, m.first_visible_seq
                 from conversations c join conversation_members m on m.conversation_id = c.id
                where c.id = $1 and m.user_id = $2 and m.left_at is null and not m.removed ${lock ? 'for update of c' : ''}`;
  const params = [conversationId, userId];
  const res = 'one' in db ? await db.q<ConvRow>(sql, params) : await db.query<ConvRow>(sql, params);
  const row = res.rows[0];
  if (!row) throw notFound('conversation_not_found');
  return row;
}

export async function activeMemberIds(db: Db | Tx, conversationId: string): Promise<string[]> {
  const sql = `select user_id from conversation_members where conversation_id = $1 and left_at is null and not removed`;
  const res = 'one' in db ? await db.q(sql, [conversationId]) : await db.query(sql, [conversationId]);
  return res.rows.map((r) => r.user_id);
}

export const isStaffRole = (role: string) => role === 'owner' || role === 'admin';
export const canPost = (c: Pick<ConvRow, 'kind' | 'announce_only' | 'role'>) =>
  c.kind === 'channel' || c.kind === 'announcement' || c.announce_only ? isStaffRole(c.role) : c.role !== 'subscriber';

export interface MediaDTO { id: string; kind: string; mime: string; size: number; name: string | null; width: number | null; height: number | null; durationMs: number | null; waveform: number[] | null; hasThumb: boolean; }
export interface MessageDTO {
  id: string; conversationId: string; seq: number; senderId: string | null; clientMsgId: string; kind: string; body: string; meta: Record<string, any>;
  media: MediaDTO | null; replyTo: { id: string; senderId: string | null; kind: string; body: string; deleted: boolean } | null; forwarded: boolean;
  mentions: string[]; createdAt: string; editedAt: string | null; deleted: boolean; expiresAt: string | null; pinned: boolean; undelivered?: boolean;
}

/** Column list for message rows; media and reply preview are joined so one query hydrates a page. */
export const MESSAGE_COLS = `
  m.id, m.conversation_id, m.seq, m.sender_id, m.client_msg_id, m.kind, m.body, m.meta, m.forwarded, m.mentions, m.created_at, m.edited_at,
  m.deleted_for_all_at, m.expires_at, m.pinned_at, m.undelivered, m.media_id,
  a.kind a_kind, a.mime a_mime, a.size a_size, a.original_name a_name, a.width a_w, a.height a_h, a.duration_ms a_dur, a.waveform a_wave, (a.thumb_key is not null) a_thumb,
  r.id r_id, r.sender_id r_sender, r.kind r_kind, r.body r_body, (r.deleted_for_all_at is not null) r_deleted`;
export const MESSAGE_JOINS = `left join media_assets a on a.id = m.media_id and a.deleted_at is null left join messages r on r.id = m.reply_to_id`;

export function toMessage(r: any): MessageDTO {
  const deleted = !!r.deleted_for_all_at;
  return {
    id: r.id, conversationId: r.conversation_id, seq: r.seq, senderId: r.sender_id, clientMsgId: r.client_msg_id, kind: r.kind,
    body: deleted ? '' : r.body, meta: deleted ? {} : r.meta, forwarded: r.forwarded, mentions: r.mentions, createdAt: r.created_at.toISOString(),
    editedAt: r.edited_at ? r.edited_at.toISOString() : null, deleted, expiresAt: r.expires_at ? r.expires_at.toISOString() : null, pinned: !!r.pinned_at,
    media: !deleted && r.media_id && r.a_kind ? { id: r.media_id, kind: r.a_kind, mime: r.a_mime, size: r.a_size, name: r.a_name, width: r.a_w, height: r.a_h, durationMs: r.a_dur, waveform: r.a_wave, hasThumb: r.a_thumb } : null,
    replyTo: r.r_id ? { id: r.r_id, senderId: r.r_sender, kind: r.r_kind, body: r.r_deleted ? '' : String(r.r_body).slice(0, 140), deleted: r.r_deleted } : null,
    ...(r.undelivered ? { undelivered: true } : {}),
  };
}

export async function loadMessage(db: Db | Tx, id: string): Promise<MessageDTO | null> {
  const sql = `select ${MESSAGE_COLS} from messages m ${MESSAGE_JOINS} where m.id = $1`;
  const res = 'one' in db ? await db.q(sql, [id]) : await db.query(sql, [id]);
  return res.rows[0] ? toMessage(res.rows[0]) : null;
}

export type Status = 'sent' | 'delivered' | 'read';
export function statusFor(msg: { seq: number; undelivered?: boolean }, w: { delivered: number; read: number } | null): Status {
  if (!w || msg.undelivered) return 'sent';
  if (w.read >= msg.seq) return 'read';
  if (w.delivered >= msg.seq) return 'delivered';
  return 'sent';
}
/** Minimum delivered/read watermarks across the other active members (everyone must have it for the tick to advance). */
export async function otherWatermarks(db: Db, conversationId: string, me: string) {
  const r = await db.query(
    `select coalesce(min(last_delivered_seq),0)::bigint d, coalesce(min(read_receipt_seq),0)::bigint r, count(*)::int n
       from conversation_members where conversation_id = $1 and user_id <> $2 and left_at is null and not removed`, [conversationId, me]);
  return r.rows[0].n ? { delivered: Number(r.rows[0].d), read: Number(r.rows[0].r) } : null;
}
void q;

/** In channels, subscribers must not learn who the admins are: sender identity is stripped from what they receive. */
export const isMasked = (c: { kind: string; role: string }) => c.kind === 'channel' && c.role === 'subscriber';
export function maskMsg<T extends { senderId: string | null; replyTo: { senderId: string | null } | null; mentions: string[] }>(m: T): T {
  return { ...m, senderId: null, mentions: [], replyTo: m.replyTo ? { ...m.replyTo, senderId: null } : null, senderName: null } as T;
}
