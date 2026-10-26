const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (iso: string | Date) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
export function listTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return clock(d);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
}
export function dayLabel(iso: string): string {
  const d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function lastSeenLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return `last seen today at ${clock(d)}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `last seen yesterday at ${clock(d)}`;
  return `last seen ${d.toLocaleDateString()}`;
}
export function duration(sec: number): string { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${pad(m)}:${pad(s)}`; }
export function bytes(n: number): string { if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`; if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`; return `${(n / 1073741824).toFixed(2)} GB`; }
export const initials = (name: string) => { const p = name.trim().split(/\s+/); return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); };
const PALETTE = [['#1F7A6B', '#0F4C43'], ['#2F6B9A', '#1B3F63'], ['#8A5BA8', '#53317A'], ['#B9693A', '#7C3B1B'], ['#3E7F4F', '#1E4A2C'], ['#A4506B', '#6B2641'], ['#5A6FA8', '#34447A'], ['#7C8A2E', '#4C5712']];
export function avatarColors(seed: string): [string, string] {
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] as [string, string];
}
export function convTitle(c: { kind: string; title: string | null; other: { displayName: string } | null }): string { return c.kind === 'direct' ? c.other?.displayName ?? 'Deleted account' : c.title ?? 'Group'; }
export function preview(m: { kind: string; body: string; deleted: boolean; meta: any } | null): { icon?: string; text: string } {
  if (!m) return { text: '' };
  if (m.deleted) return { icon: 'ban', text: 'This message was deleted' };
  switch (m.kind) {
    case 'image': return { icon: 'image', text: m.body || 'Photo' };
    case 'video': return { icon: 'video', text: m.body || 'Video' };
    case 'voice': return { icon: 'mic', text: 'Voice message' };
    case 'audio': return { icon: 'headphones', text: 'Audio' };
    case 'document': return { icon: 'file', text: m.body || 'Document' };
    case 'location': return { icon: 'map-pin', text: 'Location' };
    case 'contact': return { icon: 'user', text: `Contact: ${m.meta?.name ?? ''}` };
    case 'poll': return { icon: 'bar-chart', text: m.meta?.question ?? 'Poll' };
    case 'event': return { icon: 'calendar', text: m.meta?.title ?? 'Event' };
    case 'gif': return { text: 'GIF' };
    case 'sticker': return { text: 'Sticker' };
    case 'system': return { text: systemPreview(m.meta) };
    default: return { text: m.body };
  }
}
export function systemText(meta: any, meId: string | null, name: (id: string) => string): string {
  const who = (id: string) => (id === meId ? 'You' : name(id));
  const a = meta?.actorId ? who(meta.actorId) : '';
  switch (meta?.event) {
    case 'group_created': return `${a} created group “${meta.title}”`;
    case 'channel_created': return `${a} created the channel “${meta.title}”`;
    case 'community_created': return `${a} created the community “${meta.name}”`;
    case 'members_added': return `${a} added ${(meta.userIds ?? []).map(who).join(', ')}`;
    case 'member_removed': return `${a} removed ${who(meta.userId)}`;
    case 'member_left': return `${a} left`;
    case 'member_joined': return `${a} joined${meta.viaLink ? ' using an invite link' : ''}`;
    case 'role_changed': return `${a} made ${who(meta.userId)} ${meta.role === 'admin' ? 'an admin' : 'a member'}`;
    case 'title_changed': return `${a} changed the subject to “${meta.title}”`;
    case 'disappearing_changed': return meta.seconds ? `${a} turned on disappearing messages (${meta.seconds >= 86400 ? `${Math.round(meta.seconds / 86400)} days` : `${Math.round(meta.seconds / 3600)} hours`})` : `${a} turned off disappearing messages`;
    case 'community_linked': return `${a} added this group to a community`;
    case 'call': return `${meta.callKind === 'video' ? 'Video' : 'Voice'} call · ${meta.state === 'ended' && meta.durationSec ? `${Math.max(1, Math.round(meta.durationSec / 60))} min` : meta.state}`;
    default: return '';
  }
}

/** Short, name-free text for chat-list previews of system events. */
export function systemPreview(meta: any): string {
  switch (meta?.event) {
    case 'group_created': return `Group “${meta.title}” created`;
    case 'channel_created': return `Channel “${meta.title}” created`;
    case 'community_created': return `Community “${meta.name}” created`;
    case 'members_added': return 'New members were added';
    case 'member_removed': return 'A member was removed';
    case 'member_left': return 'A member left';
    case 'member_joined': return 'A new member joined';
    case 'role_changed': return 'Admin roles changed';
    case 'title_changed': return `Subject changed to “${meta.title}”`;
    case 'disappearing_changed': return meta.seconds ? 'Disappearing messages turned on' : 'Disappearing messages turned off';
    case 'community_linked': return 'Added to a community';
    case 'call': return `${meta.callKind === 'video' ? 'Video' : 'Voice'} call · ${meta.state}`;
    default: return '';
  }
}
