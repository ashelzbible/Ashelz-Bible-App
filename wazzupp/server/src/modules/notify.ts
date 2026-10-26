import webpush from 'web-push';
import { config } from '../config.ts';
import { q } from '../db/pool.ts';
import { hub } from '../lib/hub.ts';
import { inQuietHours, withDefaults } from '../lib/settings.ts';

export type PushPayload = { title: string; body: string; tag: string; data: Record<string, unknown> };
export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: PushPayload) => Promise<void>;

export const pushConfigured = !!(config.vapid.publicKey && config.vapid.privateKey);
if (pushConfigured) webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);

let sender: PushSender = async (sub, payload) => {
  if (!pushConfigured) throw new Error('web push not configured');
  await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
};
export function setPushSender(s: PushSender) { sender = s; }

const preview = (kind: string, body: string) => {
  switch (kind) {
    case 'image': return 'Photo';
    case 'video': return 'Video';
    case 'voice': return 'Voice message';
    case 'audio': return 'Audio';
    case 'document': return 'Document';
    case 'location': return 'Location';
    case 'contact': return 'Contact';
    case 'poll': return 'Poll';
    default: return body.length > 120 ? body.slice(0, 117) + '...' : body;
  }
};

/** Deliver a push to every subscription of a user and record the outcome on the notification row. */
export async function pushToUser(userId: string, notificationId: string | null, payload: PushPayload): Promise<'sent' | 'failed' | 'none'> {
  const subs = await q('select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1', [userId]);
  if (!subs.rowCount) return 'none';
  let ok = 0;
  for (const s of subs.rows) {
    try { await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); ok++; }
    catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await q('delete from push_subscriptions where id = $1', [s.id]);
      else console.error(JSON.stringify({ level: 'warn', msg: 'push failed', status: e?.statusCode }));
    }
  }
  const state = ok > 0 ? 'sent' : 'failed';
  if (notificationId) await q('update notifications set push_state = $2 where id = $1', [notificationId, state]);
  return state;
}

export async function notifyNewMessage(args: { conversationId: string; kind: string; title: string | null; convKind: string; messageId: string; senderId: string; senderName: string; text: string; msgKind: string; mentions: string[]; recipients: string[] }) {
  if (!args.recipients.length) return;
  const rows = await q(
    `select m.user_id, m.muted_until, p.settings
       from conversation_members m join user_profiles p on p.user_id = m.user_id
      where m.conversation_id = $1 and m.user_id = any($2::uuid[]) and m.left_at is null and not m.removed
        and not exists (select 1 from blocks b where b.blocker_id = m.user_id and b.blocked_id = $3)`,
    [args.conversationId, args.recipients, args.senderId]);
  for (const r of rows.rows) {
    const s = withDefaults(r.settings);
    const mentioned = args.mentions.includes(r.user_id);
    const muted = r.muted_until && r.muted_until > new Date();
    if (muted && !mentioned) continue;
    const isDirect = args.convKind === 'direct';
    if (!(isDirect ? s.notifications.messages : s.notifications.groups) && !mentioned) continue;
    const quiet = inQuietHours(s);
    const kind = mentioned ? 'mention' : args.convKind === 'announcement' ? 'announcement' : 'message';
    const n = await q(
      `insert into notifications(user_id, kind, conversation_id, payload, push_state) values ($1,$2,$3,$4,$5) returning id`,
      [r.user_id, kind, args.conversationId, JSON.stringify({ messageId: args.messageId, senderId: args.senderId }), quiet ? 'suppressed' : 'queued']);
    if (quiet) continue;
    if (await hub.isOnline(r.user_id)) { await q(`update notifications set push_state = 'none' where id = $1`, [n.rows[0].id]); continue; } // live socket shows it in-app
    const showPreview = s.notifications.previews;
    await pushToUser(r.user_id, n.rows[0].id, {
      title: showPreview ? (isDirect ? args.senderName : `${args.senderName} @ ${args.title ?? 'Group'}`) : 'Wazzupp',
      body: showPreview ? preview(args.msgKind, args.text) : 'New message',
      tag: `conv:${args.conversationId}`,
      data: { conversationId: args.conversationId },
    });
  }
}
