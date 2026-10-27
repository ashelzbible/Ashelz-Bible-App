/**
 * In-page demo backend. Replaces fetch('/api/...') and WebSocket('/ws') so the real Wazzupp client runs with no server.
 * Everything lives in memory and resets on reload. Contacts reply with canned messages so the UI feels alive.
 * This file is used ONLY by the demo build; the real app talks to the real server.
 */
type J = Record<string, any>;
const uid = () => crypto.randomUUID();
const MIN = 60000;
const iso = (d: number) => new Date(d).toISOString();
const ME = 'u-alex';

class Err extends Error { constructor(public status: number, public code: string, message?: string) { super(message ?? code); } }

// ------------------------------------------------------------------ seed data
interface Person { id: string; username: string; displayName: string; statusText: string; online?: boolean; replies: string[] }
const people: Person[] = [
  { id: 'u-sarah', username: 'sarah', displayName: 'Sarah Johnson', statusText: 'Coffee first ☕', online: true, replies: ['Haha, same here 😄', 'Sounds like a plan!', 'Can you send me the details?', 'I just got out of a meeting, give me a sec', 'Love it ❤️', 'See you at 3!'] },
  { id: 'u-david', username: 'david', displayName: 'David Smith', statusText: 'At the gym', replies: ['👍', 'Will do', 'Let me check and get back to you', 'Nice!'] },
  { id: 'u-lisa', username: 'lisa', displayName: 'Lisa Brown', statusText: 'Hiking this weekend', replies: ['That photo was from the trail 🌲', 'Thanks for asking!', 'Haha 😂'] },
  { id: 'u-john', username: 'john', displayName: 'John Miller', statusText: 'Available', replies: ['No problem', 'Thanks!', 'Got it'] },
  { id: 'u-anna', username: 'anna', displayName: 'Anna Lee', statusText: 'Busy', replies: ['Can’t wait! 😍', 'Count me in', 'Yes!!'] },
  { id: 'u-mom', username: 'mom', displayName: 'Mom', statusText: 'Call me when you can', replies: ['Love you ❤️', 'Dinner at 7, don’t be late', 'Did you eat?'] },
  { id: 'u-alexr', username: 'alexr', displayName: 'Alex Rivera', statusText: 'Heads down', replies: ['Agenda is in the doc', 'Let’s sync at 11', 'Good call'] },
  { id: 'u-priya', username: 'priya', displayName: 'Priya Nair', statusText: 'New here', replies: ['Hi! Nice to meet you 👋', 'Thanks for reaching out'] },
  { id: 'u-tom', username: 'tom', displayName: 'Tom Becker', statusText: 'Hey there! I am using Wazzupp.', replies: ['Hey!', 'What’s up?'] },
];
const P = (id: string) => people.find((p) => p.id === id)!;
const contactIds = ['u-sarah', 'u-david', 'u-lisa', 'u-john', 'u-anna', 'u-mom', 'u-alexr'];

const SCENES: Record<string, [string, string][]> = {
  sunset: [['#2B2A4C', '0'], ['#B3541E', '.45'], ['#F29A4B', '.65'], ['#2A2118', '1']], city: [['#0F1B3A', '0'], ['#2B4378', '.6'], ['#101826', '1']], ocean: [['#7FB7E6', '0'], ['#2F7DBB', '.6'], ['#14405F', '1']],
  dawn: [['#F7C9A8', '0'], ['#EE8F6B', '.6'], ['#5A3A4E', '1']], forest: [['#CFE8D2', '0'], ['#4F9A6B', '.55'], ['#143B2B', '1']],
};
function scene(name: string, w = 900, h = 640, label = ''): string {
  const stops = SCENES[name].map(([c, o]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.62}" cy="${h * 0.58}" r="${h * 0.07}" fill="#FFE9B0" opacity=".92"/><path d="M0 ${h * 0.72} Q ${w * 0.25} ${h * 0.64} ${w * 0.5} ${h * 0.72} T ${w} ${h * 0.7} V ${h} H0 Z" fill="#0b1f2a" opacity=".85"/>${label ? `<text x="${w / 2}" y="${h * 0.34}" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="${h * 0.075}" fill="#fff">${label}</text>` : ''}</svg>`;
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

interface MediaRec { id: string; kind: string; mime: string; size: number; name: string; width: number | null; height: number | null; durationMs: number | null; waveform: number[] | null; url: string }
const media = new Map<string, MediaRec>();
function addMedia(url: string, kind: string, name: string, extra: Partial<MediaRec> = {}): MediaRec {
  const m: MediaRec = { id: uid(), kind, mime: kind === 'image' ? 'image/svg+xml' : 'application/octet-stream', size: Math.round(url.length * 0.75), name, width: 900, height: 640, durationMs: null, waveform: null, url, ...extra };
  media.set(m.id, m); return m;
}
const mediaDto = (m: MediaRec | undefined) => (m ? { id: m.id, kind: m.kind, mime: m.mime, size: m.size, name: m.name, width: m.width, height: m.height, durationMs: m.durationMs, waveform: m.waveform, hasThumb: m.kind === 'image' } : null);

interface Msg extends J { id: string; seq: number }
interface Conv {
  id: string; kind: 'direct' | 'group' | 'channel' | 'announcement'; title: string | null; description: string; peer?: string; members: string[]; roles: Record<string, string>;
  announceOnly: boolean; membersCanEditInfo: boolean; membersCanInvite: boolean; disappearingSeconds: number | null; communityId: string | null; isPublic: boolean;
  msgs: Msg[]; readSeq: number; watermark: { delivered: number; read: number }; muted: boolean; archived: boolean; pinned: boolean; favorite: boolean; markedUnread: boolean;
  folder: string | null; draft: string | null; version: number; lastAt: number; blocked: boolean;
}
const convs = new Map<string, Conv>();
let eventId = 0;

function msg(c: Conv, sender: string | null, kind: string, body: string, ago: number, extra: J = {}): Msg {
  const seq = c.msgs.length + 1;
  const m: Msg = {
    id: uid(), conversationId: c.id, seq, senderId: sender, clientMsgId: extra.clientMsgId ?? uid(), kind, body, meta: extra.meta ?? {}, media: extra.media ?? null, replyTo: extra.replyTo ?? null,
    forwarded: !!extra.forwarded, mentions: extra.mentions ?? [], createdAt: iso(Date.now() - ago * MIN), editedAt: null, deleted: false, expiresAt: null, pinned: false, reactions: [], starred: false,
    votes: extra.votes, senderName: sender ? P(sender)?.displayName ?? 'Alex Morgan' : null,
  };
  c.msgs.push(m); c.lastAt = new Date(m.createdAt).getTime(); return m;
}
function mkConv(kind: Conv['kind'], title: string | null, members: string[], opts: Partial<Conv> = {}): Conv {
  const c: Conv = { id: uid(), kind, title, description: '', members: [ME, ...members], roles: { [ME]: 'owner' }, announceOnly: false, membersCanEditInfo: false, membersCanInvite: true, disappearingSeconds: null, communityId: null, isPublic: false,
    msgs: [], readSeq: 0, watermark: { delivered: 0, read: 0 }, muted: false, archived: false, pinned: false, favorite: false, markedUnread: false, folder: null, draft: null, version: 1, lastAt: 0, blocked: false, ...opts };
  if (kind === 'direct') c.peer = members[0];
  convs.set(c.id, c); return c;
}
const markAllRead = (c: Conv) => { c.readSeq = c.msgs.length; };

function seed() {
  // Sarah (the chat shown in the design reference)
  const sarah = mkConv('direct', null, ['u-sarah']);
  msg(sarah, 'u-sarah', 'text', 'Hey! How are you? 😊', 4 * 60 + 8);
  msg(sarah, ME, 'text', "I'm good! Just finishing up some work.\nHow about you?", 4 * 60 + 7);
  msg(sarah, 'u-sarah', 'text', "Good! Let's catch up later.\nAre you free for coffee this afternoon?", 4 * 60 + 6);
  msg(sarah, ME, 'text', "That sounds great! ☕\nI'm free around 3pm.", 4 * 60 + 5);
  for (const [i, s] of (['sunset', 'city', 'ocean'] as const).entries()) { const m = addMedia(scene(s), 'image', `${s}.jpg`); msg(sarah, 'u-sarah', 'image', i === 0 ? 'Look at this view!' : '', 4 * 60 + 4 - i, { media: mediaDto(m) }); }
  msg(sarah, 'u-sarah', 'location', '', 4 * 60, { meta: { lat: -26.2041, lng: 28.0473, label: 'Rosebank Café' } });
  msg(sarah, ME, 'text', 'Wow, gorgeous!', 3 * 60 + 58).starred = true;
  msg(sarah, 'u-sarah', 'text', "Perfect! I'll see you then. 😊", 3 * 60 + 56);
  markAllRead(sarah); sarah.watermark = { delivered: sarah.msgs.length, read: sarah.msgs.length };
  sarah.msgs[0].reactions = [{ userId: ME, emoji: '❤️' }];

  const grp = (title: string, members: string[], build: (c: Conv) => void, opts: Partial<Conv> = {}) => { const c = mkConv('group', title, members, opts); for (const m of members) c.roles[m] = 'member'; build(c); return c; };
  const family = grp('Family Group', ['u-mom', 'u-sarah', 'u-anna'], (c) => {
    c.roles[ME] = 'member'; c.roles['u-mom'] = 'owner';
    msg(c, 'u-mom', 'text', 'Dinner at 7 on Sunday?', 600); msg(c, 'u-anna', 'text', 'Yes! I will bring dessert', 590); markAllRead(c);
    msg(c, 'u-mom', 'text', "Don't forget the photos", 200); msg(c, 'u-sarah', 'text', 'On it 📸', 195); msg(c, 'u-mom', 'text', 'See you all later! ❤️', 190);
  }, { pinned: true });
  grp('Work Team', ['u-alexr', 'u-david', 'u-lisa'], (c) => {
    c.roles[ME] = 'member'; c.roles['u-alexr'] = 'owner'; msg(c, 'u-alexr', 'text', 'Morning team', 330); msg(c, 'u-david', 'text', 'Morning!', 325); msg(c, 'u-lisa', 'text', 'Agenda is in the doc', 320); msg(c, 'u-david', 'text', 'Got it', 318); msg(c, 'u-alexr', 'text', 'Meeting at 11am', 315);
  });
  const david = mkConv('direct', null, ['u-david']);
  msg(david, 'u-david', 'voice', '', 300, { media: mediaDto(addMedia('', 'voice', 'voice.ogg', { durationMs: 12000, width: null, height: null, waveform: Array.from({ length: 40 }, (_, i) => Math.round((0.2 + 0.6 * Math.abs(Math.sin(i * 0.7))) * 100) / 100) })) });
  const lisa = mkConv('direct', null, ['u-lisa']);
  msg(lisa, 'u-lisa', 'image', '', 340, { media: mediaDto(addMedia(scene('forest', 800, 600), 'image', 'trail.jpg', { width: 800, height: 600 })) });
  msg(lisa, 'u-lisa', 'image', '', 339, { media: mediaDto(addMedia(scene('dawn', 800, 600), 'image', 'dawn.jpg', { width: 800, height: 600 })) });
  grp('Besties 💕', ['u-anna', 'u-lisa', 'u-sarah'], (c) => { c.roles[ME] = 'member'; c.roles['u-anna'] = 'owner'; msg(c, 'u-anna', 'text', 'Who is in for Saturday?', 1500); msg(c, 'u-lisa', 'text', 'Me!', 1498); msg(c, 'u-sarah', 'text', 'Count me in', 1497); msg(c, 'u-anna', 'text', "Can't wait! 😍", 1495); });
  const john = mkConv('direct', null, ['u-john']);
  msg(john, 'u-john', 'text', 'Can you send the slides?', 1700); msg(john, ME, 'text', 'Sent them over', 1698); msg(john, 'u-john', 'text', 'Thanks!', 1695); markAllRead(john); john.watermark = { delivered: 3, read: 3 };
  const alpha = grp('Project Alpha', ['u-alexr', 'u-david', 'u-john', 'u-lisa'], (c) => {
    msg(c, ME, 'document', '', 1400, { media: mediaDto(addMedia('data:text/plain;base64,' + btoa('Project Alpha plan'), 'document', 'Project-Alpha-plan.pdf', { mime: 'application/pdf', width: null, height: null, size: 2457600 })) });
    msg(c, 'u-alexr', 'poll', '', 1390, { meta: { question: 'Which day works best for the review?', options: ['Monday', 'Tuesday', 'Wednesday'], multi: false }, votes: [{ userId: 'u-alexr', option: 0 }, { userId: 'u-david', option: 0 }, { userId: 'u-lisa', option: 1 }] });
    markAllRead(c); c.watermark = { delivered: 2, read: 2 };
  });
  alpha.communityId = 'c-work';
  void sarah; void family;
}
seed();

// statuses
interface St { id: string; userId: string; kind: 'text' | 'image'; body: string; caption: string; background: string | null; mediaId: string | null; createdAt: number; viewed: boolean; reaction: string | null; viewers: J[] }
const statuses: St[] = [
  { id: uid(), userId: 'u-sarah', kind: 'image', body: '', caption: '', background: null, mediaId: addMedia(scene('sunset', 1080, 1920, 'Good Vibes Only'), 'image', 'status.jpg', { width: 1080, height: 1920 }).id, createdAt: Date.now() - 120000, viewed: false, reaction: null, viewers: [] },
  { id: uid(), userId: 'u-david', kind: 'text', body: 'Coffee first, everything else second ☕', caption: '', background: '#6A3A8C', mediaId: null, createdAt: Date.now() - 12 * MIN, viewed: false, reaction: null, viewers: [] },
  { id: uid(), userId: 'u-lisa', kind: 'text', body: 'Weekend plans: hiking!', caption: '', background: '#1B5E8A', mediaId: null, createdAt: Date.now() - 20 * MIN, viewed: false, reaction: null, viewers: [] },
  { id: uid(), userId: ME, kind: 'text', body: 'Shipped it 🚀', caption: '', background: '#003B32', mediaId: null, createdAt: Date.now() - 40 * MIN, viewed: true, reaction: null, viewers: [{ userId: 'u-sarah', displayName: 'Sarah Johnson', viewedAt: iso(Date.now() - 30 * MIN), reaction: '🔥' }, { userId: 'u-john', displayName: 'John Miller', viewedAt: iso(Date.now() - 22 * MIN), reaction: null }] },
];
const mutedStatus = new Set<string>();

const calls = [
  { id: uid(), conversationId: '', initiatorId: 'u-david', kind: 'audio', state: 'missed', ago: 100, dir: 'incoming', other: 'u-david', dur: 0 },
  { id: uid(), conversationId: '', initiatorId: ME, kind: 'video', state: 'ended', ago: 190, dir: 'outgoing', other: 'u-lisa', dur: 421 },
  { id: uid(), conversationId: '', initiatorId: 'u-sarah', kind: 'audio', state: 'ended', ago: 300, dir: 'incoming', other: 'u-sarah', dur: 754 },
  { id: uid(), conversationId: '', initiatorId: 'u-anna', kind: 'video', state: 'missed', ago: 1500, dir: 'incoming', other: 'u-anna', dur: 0 },
  { id: uid(), conversationId: '', initiatorId: ME, kind: 'audio', state: 'cancelled', ago: 1600, dir: 'outgoing', other: 'u-john', dur: 0 },
];

interface Comm { id: string; name: string; description: string; visibility: string; role: string; groups: string[]; members: string[]; announce: string }
const comms: Comm[] = [
  { id: 'c-work', name: 'Workplace', description: 'Everything for the team', visibility: 'private', role: 'owner', groups: [[...convs.values()].find((c) => c.title === 'Project Alpha')!.id], members: ['u-alexr', 'u-david', 'u-lisa', 'u-john'], announce: '' },
  { id: 'c-fam', name: 'Family', description: 'Family updates and plans', visibility: 'private', role: 'owner', groups: [], members: ['u-mom', 'u-sarah'], announce: '' },
  { id: 'c-fr', name: 'Friends', description: 'Hangouts and trips', visibility: 'private', role: 'owner', groups: [], members: ['u-anna'], announce: '' },
  { id: 'c-study', name: 'Study Group', description: 'Exam prep', visibility: 'private', role: 'owner', groups: [], members: [], announce: '' },
  { id: 'c-sport', name: 'Sports', description: 'Five-a-side and runs', visibility: 'private', role: 'owner', groups: [], members: [], announce: '' },
];
for (const c of comms) { const a = mkConv('announcement', `${c.name} · Announcements`, c.members, { announceOnly: true, communityId: c.id }); msg(a, ME, 'system', '', 3 * 24 * 60, { meta: { event: 'community_created', name: c.name, actorId: ME } }); markAllRead(a); a.lastAt = Date.now() - 3 * 86400000; c.announce = a.id; }
const folders: Array<{ id: string; name: string; position: number }> = [];

const settings: J = {
  privacy: { lastSeen: 'everyone', online: 'everyone', profilePhoto: 'everyone', about: 'everyone', phoneVisible: 'nobody', readReceipts: true, groupInvites: 'everyone', statusAudience: 'contacts', linkPreviews: true, discoverable: false },
  notifications: { messages: true, groups: true, calls: true, previews: true, sound: true, quietHours: { enabled: false, start: '22:00', end: '07:00', utcOffsetMinutes: 0 } },
  appearance: { theme: 'system', fontSize: 'md', wallpaper: 'doodle', language: 'en' }, media: { autoDownloadImages: true, autoDownloadVideos: false, autoDownloadDocuments: false, dataSaver: false }, statusTtlHours: 24,
};
let settingsVersion = 1;
const me: J = { id: ME, username: 'alex', email: 'alex@example.test', phone: null, displayName: 'Alex Morgan', bio: 'Building things with friends.', statusText: 'Available', avatarMediaId: null, emailVerified: true, phoneVerified: false, mfaEnabled: false, role: 'user' };
const meDto = () => ({ ...me, settings, settingsVersion });
const blocked = new Set<string>();
const contacts = new Set(contactIds);

// ------------------------------------------------------------------ sockets + events
const sockets = new Set<FakeWS>();
function emit(type: string, payload: J) { const id = ++eventId; for (const s of sockets) s.push({ t: 'event', id, type, payload }); }
function push(m: J) { for (const s of sockets) s.push(m); }

class FakeWS extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0; url: string; onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  constructor(url: string) { super(); this.url = url; setTimeout(() => { this.readyState = 1; sockets.add(this); this.fire('open', new Event('open')); }, 30); }
  private fire(name: string, ev: Event) { (this as any)['on' + name]?.(ev); this.dispatchEvent(ev); }
  send(raw: string) {
    let m: J; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'auth') this.push({ t: 'ready', userId: ME, deviceId: 'd-web', latestEventId: eventId, resync: false, replayed: 0, online: people.filter((p) => p.online).map((p) => p.id) });
    else if (m.t === 'ping') this.push({ t: 'pong' });
  }
  push(obj: J) { setTimeout(() => { if (this.readyState === 1) { const ev = new MessageEvent('message', { data: JSON.stringify(obj) }); this.fire('message', ev); } }, 0); }
  close() { this.readyState = 3; sockets.delete(this); this.fire('close', Object.assign(new Event('close'), { code: 1000 })); }
}

// ------------------------------------------------------------------ views
const nameOf = (id: string) => (id === ME ? 'Alex Morgan' : P(id)?.displayName ?? 'Someone');
const lastMsg = (c: Conv) => [...c.msgs].reverse().find((m) => !m.hidden) ?? null;
const msgView = (c: Conv, m: Msg) => { const { hidden: _h, ...rest } = m; void _h; return rest; };
function statusFor(c: Conv, m: Msg) { return m.senderId !== ME ? undefined : m.seq <= c.watermark.read ? 'read' : m.seq <= c.watermark.delivered ? 'delivered' : 'sent'; }
function convDto(c: Conv): J {
  const lm = lastMsg(c);
  const other = c.kind === 'direct' ? (() => { const p = P(c.peer!); return { id: p.id, username: p.username, displayName: p.displayName, avatarMediaId: null, statusText: p.statusText, lastSeenAt: p.online ? null : iso(Date.now() - 50 * MIN), blockedByMe: blocked.has(p.id) }; })() : null;
  const unread = c.msgs.filter((m) => m.seq > c.readSeq && m.senderId !== ME && m.kind !== 'system' && !m.deleted).length;
  return {
    id: c.id, kind: c.kind, title: c.title, description: c.description, avatarMediaId: null, announceOnly: c.announceOnly, membersCanEditInfo: c.membersCanEditInfo, membersCanInvite: c.membersCanInvite, disappearingSeconds: c.disappearingSeconds,
    communityId: c.communityId, isPublic: c.isPublic, lastSeq: c.msgs.length, memberCount: c.members.length, role: c.roles[ME] ?? 'member', other, lastMessage: lm ? { ...msgView(c, lm), status: statusFor(c, lm) } : null, lastMessageAt: lm ? lm.createdAt : null,
    unread, unreadMentions: 0, markedUnread: c.markedUnread, muted: c.muted, mutedUntil: c.muted ? '9999-12-31T00:00:00Z' : null, archived: c.archived, pinned: c.pinned, favorite: c.favorite, folder: c.folder, draft: c.draft, version: c.version, lastReadSeq: c.readSeq,
  };
}
const getConv = (id: string) => { const c = convs.get(id); if (!c) throw new Err(404, 'conversation_not_found'); return c; };
const getMsg = (id: string): [Conv, Msg] => { for (const c of convs.values()) { const m = c.msgs.find((x) => x.id === id); if (m) return [c, m]; } throw new Err(404, 'message_not_found'); };
const memberDto = (c: Conv, id: string) => { const p = id === ME ? { id: ME, username: 'alex', displayName: 'Alex Morgan', statusText: 'Available' } : P(id); return { id, username: p.username, displayName: p.displayName, role: c.roles[id] ?? 'member', avatarMediaId: null, statusText: p.statusText }; };

// ------------------------------------------------------------------ simulated contacts
const timers = new Set<ReturnType<typeof setTimeout>>();
const later = (ms: number, fn: () => void) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
function deliverMessage(c: Conv, m: Msg) { emit('message.new', { message: msgView(c, m) }); }
function simulateReply(c: Conv, mine: Msg) {
  if (c.kind === 'announcement' || c.kind === 'channel' || c.blocked) return;
  const peerId = c.kind === 'direct' ? c.peer! : c.members.filter((x) => x !== ME)[Math.floor(Math.random() * (c.members.length - 1))];
  if (!peerId || blocked.has(peerId)) return;
  const person = P(peerId);
  later(500, () => { c.watermark.delivered = Math.max(c.watermark.delivered, mine.seq); emit('receipt', { conversationId: c.id, userId: peerId, deliveredSeq: mine.seq }); });
  later(1400, () => { if (settings.privacy.readReceipts !== false || true) { c.watermark.read = Math.max(c.watermark.read, mine.seq); emit('receipt', { conversationId: c.id, userId: peerId, deliveredSeq: mine.seq, readSeq: mine.seq }); } push({ t: 'typing', conversationId: c.id, userId: peerId, state: 'composing' }); });
  later(3200, () => {
    push({ t: 'typing', conversationId: c.id, userId: peerId, state: 'paused' });
    const text = person.replies[Math.floor(Math.random() * person.replies.length)];
    const m = msg(c, peerId, 'text', text, 0); deliverMessage(c, m);
  });
}

// ------------------------------------------------------------------ routes
type H = (a: { m: RegExpMatchArray; body: J; q: URLSearchParams }) => any;
const R: Array<[string, RegExp, H]> = [];
const route = (method: string, path: string, h: H) => R.push([method, new RegExp('^' + path.replace(/:[a-z]+/g, '([^/]+)') + '$'), h]);
const noop = () => undefined;

route('POST', '/api/auth/login', () => ({ token: 'demo-token-' + 'x'.repeat(30), deviceId: 'd-web', user: meDto() }));
route('POST', '/api/auth/register', ({ body }) => { me.displayName = body.displayName || me.displayName; return [201, { token: 'demo-token-' + 'x'.repeat(30), deviceId: 'd-web', user: meDto() }]; });
route('POST', '/api/auth/logout', noop);
route('GET', '/api/me', () => ({ user: meDto() }));
route('PATCH', '/api/me', ({ body }) => { for (const k of ['displayName', 'bio', 'statusText', 'username']) if (body[k] !== undefined) me[k] = body[k]; return { user: meDto() }; });
route('GET', '/api/me/settings', () => ({ settings, version: settingsVersion }));
route('PATCH', '/api/me/settings', ({ body }) => { const merge = (a: J, b: J) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object' && !Array.isArray(v)) { a[k] = a[k] ?? {}; merge(a[k], v); } else a[k] = v; } }; merge(settings, body.patch); settingsVersion++; return { settings, version: settingsVersion }; });
route('GET', '/api/conversations', () => ({ conversations: [...convs.values()].filter((c) => c.msgs.length || c.kind === 'direct').map(convDto).sort((a, b) => (+b.pinned - +a.pinned) || (+new Date(b.lastMessageAt ?? 0) - +new Date(a.lastMessageAt ?? 0))) }));
route('GET', '/api/conversations/:id', ({ m }) => ({ conversation: convDto(getConv(m[1])) }));
route('POST', '/api/conversations/direct', ({ body }) => {
  const p = P(body.userId); if (!p) throw new Err(404, 'user_not_found');
  let c = [...convs.values()].find((x) => x.kind === 'direct' && x.peer === p.id);
  if (!c) c = mkConv('direct', null, [p.id]);
  return { conversation: convDto(c) };
});
route('POST', '/api/groups', ({ body }) => {
  const kind = body.kind === 'channel' ? 'channel' : 'group';
  const c = mkConv(kind, body.title, body.memberIds ?? [], { description: body.description ?? '', isPublic: !!body.isPublic, announceOnly: kind === 'channel' });
  for (const id of body.memberIds ?? []) c.roles[id] = kind === 'channel' ? 'subscriber' : 'member';
  msg(c, ME, 'system', '', 0, { meta: { event: kind === 'channel' ? 'channel_created' : 'group_created', title: body.title, actorId: ME } }); markAllRead(c);
  return [201, { conversation: convDto(c), added: body.memberIds ?? [], skipped: [] }];
});
route('PATCH', '/api/conversations/:id', ({ m, body }) => {
  const c = getConv(m[1]);
  for (const k of ['title', 'description', 'announceOnly', 'membersCanEditInfo', 'membersCanInvite', 'isPublic']) if (body[k] !== undefined) (c as any)[k] = body[k];
  if (body.disappearingSeconds !== undefined) { c.disappearingSeconds = body.disappearingSeconds || null; msg(c, ME, 'system', '', 0, { meta: { event: 'disappearing_changed', seconds: c.disappearingSeconds, actorId: ME } }); deliverMessage(c, c.msgs[c.msgs.length - 1]); }
  c.version++; emit('conversation.update', { conversationId: c.id }); return { ok: true };
});
route('PATCH', '/api/conversations/:id/state', ({ m, body }) => {
  const c = getConv(m[1]);
  if (body.mutedUntil !== undefined) c.muted = !!body.mutedUntil; for (const k of ['archived', 'pinned', 'favorite', 'markedUnread', 'folder']) if (body[k] !== undefined) (c as any)[k] = body[k];
  c.version++; return { conversation: convDto(c), ok: true };
});
route('PUT', '/api/conversations/:id/draft', ({ m, body }) => { getConv(m[1]).draft = body.draft || null; });
route('POST', '/api/conversations/:id/clear', ({ m }) => { const c = getConv(m[1]); c.msgs.forEach((x) => (x.hidden = true)); emit('conversation.cleared', { conversationId: c.id, upToSeq: c.msgs.length }); });
route('POST', '/api/conversations/:id/leave', ({ m }) => { convs.delete(m[1]); });
route('POST', '/api/conversations/:id/read', ({ m, body }) => { const c = getConv(m[1]); c.readSeq = Math.min(Math.max(c.readSeq, body.seq), c.msgs.length); c.markedUnread = false; return { lastReadSeq: c.readSeq }; });
route('POST', '/api/conversations/:id/delivered', noop);
route('GET', '/api/conversations/:id/members', ({ m }) => { const c = getConv(m[1]); return { members: c.members.map((id) => memberDto(c, id)) }; });
route('POST', '/api/conversations/:id/members', ({ m, body }) => { const c = getConv(m[1]); for (const id of body.userIds) if (!c.members.includes(id)) { c.members.push(id); c.roles[id] = 'member'; } return { added: body.userIds, skipped: [] }; });
route('DELETE', '/api/conversations/:id/members/:uid', ({ m }) => { const c = getConv(m[1]); c.members = c.members.filter((x) => x !== m[2]); });
route('PATCH', '/api/conversations/:id/members/:uid', ({ m, body }) => { getConv(m[1]).roles[m[2]] = body.role; return { ok: true }; });
route('POST', '/api/conversations/:id/invites', () => [201, { id: uid(), code: 'demo-' + uid().slice(0, 12), expiresAt: iso(Date.now() + 7 * 86400000) }]);
route('GET', '/api/conversations/:id/invites', () => ({ invites: [] }));
route('GET', '/api/conversations/:id/pinned', ({ m }) => { const c = getConv(m[1]); return { messages: c.msgs.filter((x) => x.pinned && !x.deleted) }; });
route('POST', '/api/conversations/:id/scheduled', () => [201, { id: uid() }]);
route('GET', '/api/scheduled', () => ({ scheduled: [] }));

route('GET', '/api/conversations/:id/messages', ({ m, q }) => {
  const c = getConv(m[1]); const limit = Number(q.get('limit') ?? 40); const before = q.get('before'); const after = q.get('after');
  let list = c.msgs.filter((x) => !x.hidden);
  if (after !== null) list = list.filter((x) => x.seq > Number(after)).slice(0, limit);
  else { if (before !== null) list = list.filter((x) => x.seq < Number(before)); list = list.slice(-limit); }
  const hasMore = after === null && list.length > 0 && c.msgs.some((x) => x.seq < list[0].seq && !x.hidden);
  return { messages: list.map((x) => ({ ...msgView(c, x), ...(x.senderId === ME ? { status: statusFor(c, x) } : {}) })), hasMore, watermarks: c.watermark };
});
route('POST', '/api/conversations/:id/messages', ({ m, body }) => {
  const c = getConv(m[1]);
  if (c.kind === 'channel' || c.announceOnly) if ((c.roles[ME] ?? 'member') === 'member') throw new Err(403, 'posting_restricted', 'Only admins can post here');
  const dup = c.msgs.find((x) => x.clientMsgId === body.clientMsgId); if (dup) return { message: msgView(c, dup), duplicate: true };
  const reply = body.replyToId ? c.msgs.find((x) => x.id === body.replyToId) : null;
  const md = body.mediaId ? mediaDto(media.get(body.mediaId)) : null;
  const nm = msg(c, ME, body.kind, body.body ?? '', 0, { clientMsgId: body.clientMsgId, meta: body.meta, media: md, replyTo: reply ? { id: reply.id, senderId: reply.senderId, kind: reply.kind, body: String(reply.body).slice(0, 140), deleted: reply.deleted } : null, mentions: body.mentions });
  if (body.kind === 'poll') nm.votes = [];
  c.readSeq = c.msgs.length; c.archived = false; deliverMessage(c, nm); simulateReply(c, nm);
  return [201, { message: { ...msgView(c, nm), status: 'sent' }, duplicate: false }];
});
route('PATCH', '/api/messages/:id', ({ m, body }) => { const [c, x] = getMsg(m[1]); (x.history ??= []).push({ body: x.body, editedAt: iso(Date.now()) }); x.body = body.body; x.editedAt = iso(Date.now()); emit('message.update', { message: msgView(c, x) }); return { message: msgView(c, x) }; });
route('GET', '/api/messages/:id/edits', ({ m }) => { const [, x] = getMsg(m[1]); return { current: x.body, edits: x.history ?? [] }; });
route('DELETE', '/api/messages/:id', ({ m, q }) => { const [c, x] = getMsg(m[1]); if (q.get('scope') === 'all') { x.deleted = true; x.body = ''; x.meta = {}; x.media = null; x.pinned = false; x.reactions = []; emit('message.delete', { conversationId: c.id, messageId: x.id }); } else { x.hidden = true; emit('message.hide', { conversationId: c.id, messageId: x.id }); } });
route('PUT', '/api/messages/:id/reaction', ({ m, body }) => { const [c, x] = getMsg(m[1]); x.reactions = (x.reactions as J[]).filter((r) => r.userId !== ME); if (body.emoji) x.reactions.push({ userId: ME, emoji: body.emoji }); emit('message.reactions', { conversationId: c.id, messageId: x.id, reactions: x.reactions }); return { reactions: x.reactions }; });
route('PUT', '/api/messages/:id/star', ({ m, body }) => { const [c, x] = getMsg(m[1]); x.starred = !!body.starred; emit('message.star', { conversationId: c.id, messageId: x.id, starred: x.starred }); return { starred: x.starred }; });
route('PUT', '/api/messages/:id/pin', ({ m, body }) => { const [c, x] = getMsg(m[1]); x.pinned = !!body.pinned; emit('message.update', { message: msgView(c, x) }); return { message: msgView(c, x) }; });
route('POST', '/api/messages/:id/vote', ({ m, body }) => { const [c, x] = getMsg(m[1]); x.votes = (x.votes ?? []).filter((v: J) => v.userId !== ME).concat(body.options.map((o: number) => ({ userId: ME, option: o }))); emit('poll.votes', { conversationId: c.id, messageId: x.id, votes: x.votes }); return { votes: x.votes }; });
route('POST', '/api/messages/:id/forward', ({ m, body }) => { const [, x] = getMsg(m[1]); const out = body.conversationIds.map((cid: string) => { const c = getConv(cid); const nm = msg(c, ME, x.kind, x.body, 0, { meta: x.meta, media: x.media, forwarded: true }); deliverMessage(c, nm); return msgView(c, nm); }); return { messages: out }; });
route('GET', '/api/starred', () => ({ messages: [...convs.values()].flatMap((c) => c.msgs.filter((x) => x.starred && !x.deleted).map((x) => msgView(c, x))) }));

route('GET', '/api/contacts', () => ({ contacts: [...contacts].map((id) => ({ id, username: P(id).username, displayName: P(id).displayName, alias: null, favorite: false, avatarMediaId: null, statusText: P(id).statusText })) }));
route('PUT', '/api/contacts/:id', ({ m }) => { contacts.add(m[1]); return { ok: true }; });
route('DELETE', '/api/contacts/:id', ({ m }) => { contacts.delete(m[1]); });
route('GET', '/api/blocks', () => ({ blocked: [...blocked].map((id) => ({ id, username: P(id).username, displayName: P(id).displayName })) }));
route('PUT', '/api/blocks/:id', ({ m }) => { blocked.add(m[1]); });
route('DELETE', '/api/blocks/:id', ({ m }) => { blocked.delete(m[1]); });
route('GET', '/api/users/search', ({ q }) => { const t = (q.get('q') ?? '').toLowerCase(); return { users: people.filter((p) => p.username.startsWith(t) || p.displayName.toLowerCase().includes(t)).map((p) => ({ id: p.id, username: p.username, displayName: p.displayName, avatarMediaId: null })) }; });
route('GET', '/api/devices', () => ({ devices: [{ id: 'd-web', name: 'This browser (demo)', platform: 'web', createdAt: iso(Date.now() - 86400000), lastSeenAt: iso(Date.now()), ip: null, current: true, online: true }, { id: 'd-phone', name: 'Pixel 8', platform: 'android', createdAt: iso(Date.now() - 5 * 86400000), lastSeenAt: iso(Date.now() - 3 * 3600000), ip: null, current: false, online: false }, { id: 'd-mac', name: 'Safari on macOS', platform: 'web', createdAt: iso(Date.now() - 9 * 86400000), lastSeenAt: iso(Date.now() - 86400000), ip: null, current: false, online: false }] }));
route('DELETE', '/api/devices/:id', noop);
route('GET', '/api/notifications', () => ({ notifications: [] }));
route('POST', '/api/notifications/read', noop);
route('GET', '/api/push/config', () => ({ webPush: false, vapidPublicKey: null, fcm: false, apns: false }));
route('GET', '/api/storage/usage', () => ({ quotaBytes: 2 * 1024 ** 3, usedBytes: 18_400_000, byKind: [{ kind: 'image', count: 12, bytes: 14_200_000 }, { kind: 'voice', count: 3, bytes: 900_000 }, { kind: 'document', count: 2, bytes: 3_300_000 }] }));
route('GET', '/api/folders', () => ({ folders }));
route('POST', '/api/folders', ({ body }) => { const f = { id: uid(), name: body.name, position: folders.length }; folders.push(f); return [201, { folder: f }]; });
route('DELETE', '/api/folders/:id', ({ m }) => { const i = folders.findIndex((f) => f.id === m[1]); if (i >= 0) { const n = folders[i].name; folders.splice(i, 1); convs.forEach((c) => { if (c.folder === n) c.folder = null; }); } });
route('POST', '/api/reports', () => [201, { ok: true }]);
route('GET', '/api/search/recent', () => ({ terms: [] }));
route('GET', '/api/search', ({ q }) => {
  const t = (q.get('q') ?? '').toLowerCase(); const cid = q.get('conversationId'); const type = q.get('type') ?? 'all';
  const out: J = {};
  if (type === 'all' || type === 'chats') out.chats = [...convs.values()].filter((c) => (c.title ?? P(c.peer ?? '')?.displayName ?? '').toLowerCase().includes(t)).map((c) => ({ id: c.id, kind: c.kind, title: c.title ?? P(c.peer!).displayName }));
  if (type !== 'chats') out.messages = [...convs.values()].filter((c) => !cid || c.id === cid).flatMap((c) => c.msgs.filter((x) => !x.hidden && !x.deleted && x.kind !== 'system' && String(x.body).toLowerCase().includes(t)).map((x) => msgView(c, x))).slice(0, 50);
  return out;
});
route('GET', '/api/media', ({ q }) => {
  const c = getConv(q.get('conversationId')!); const kind = q.get('kind');
  if (kind === 'links') return { items: c.msgs.filter((x) => /https?:\/\//.test(x.body)).map((x) => ({ messageId: x.id, seq: x.seq, urls: x.body.match(/https?:\/\/[^\s]+/g), createdAt: x.createdAt })) };
  const kinds = kind === 'audio' ? ['audio', 'voice'] : [kind];
  return { items: c.msgs.filter((x) => x.media && !x.deleted && kinds.includes(x.kind)).reverse().map((x) => ({ messageId: x.id, seq: x.seq, createdAt: x.createdAt, media: x.media })) };
});
route('POST', '/api/media/urls', ({ body }) => { const urls: J = {}; for (const id of body.ids) { const mm = media.get(id); if (mm) urls[id] = { url: mm.url, thumbUrl: mm.kind === 'image' ? mm.url : null, expiresAt: Date.now() + 3600000 }; } return { urls }; });
route('POST', '/api/media', ({ body }) => { const f: File = body.__file; return new Promise((res) => { const r = new FileReader(); r.onload = () => { const kind = body.kind ?? 'document'; const mm = addMedia(String(r.result), kind === 'avatar' ? 'image' : kind, f.name, { mime: f.type || 'application/octet-stream', size: f.size, width: null, height: null }); if (kind === 'image' || kind === 'avatar') { const img = new Image(); img.onload = () => { mm.width = img.width; mm.height = img.height; res([201, { media: mediaDto(mm) }]); }; img.onerror = () => res([201, { media: mediaDto(mm) }]); img.src = mm.url; } else res([201, { media: mediaDto(mm) }]); }; r.readAsDataURL(f); }); });

route('GET', '/api/status', () => {
  const groups = new Map<string, J>();
  for (const s of statuses.filter((x) => x.userId !== ME)) {
    const p = P(s.userId); let g = groups.get(s.userId);
    if (!g) groups.set(s.userId, (g = { userId: p.id, username: p.username, displayName: p.displayName, avatarMediaId: null, muted: mutedStatus.has(p.id), allViewed: true, latestAt: iso(s.createdAt), items: [] }));
    g.items.push({ id: s.id, kind: s.kind, body: s.body, caption: s.caption, background: s.background, mediaId: s.mediaId, createdAt: iso(s.createdAt), expiresAt: iso(s.createdAt + 86400000), viewed: s.viewed, reaction: s.reaction }); if (!s.viewed) g.allViewed = false; g.latestAt = iso(s.createdAt);
  }
  return { feed: [...groups.values()].sort((a, b) => +a.allViewed - +b.allViewed || +new Date(b.latestAt) - +new Date(a.latestAt)) };
});
route('GET', '/api/status/mine', () => ({ items: statuses.filter((s) => s.userId === ME).map((s) => ({ id: s.id, kind: s.kind, body: s.body, caption: s.caption, background: s.background, mediaId: s.mediaId, createdAt: iso(s.createdAt), expiresAt: iso(s.createdAt + 86400000), audience: 'contacts', viewers: s.viewers })) }));
route('POST', '/api/status', ({ body }) => { const s: St = { id: uid(), userId: ME, kind: body.kind, body: body.body ?? '', caption: body.caption ?? '', background: body.background ?? null, mediaId: body.mediaId ?? null, createdAt: Date.now(), viewed: true, reaction: null, viewers: [] }; statuses.push(s); later(2500, () => { s.viewers.push({ userId: 'u-sarah', displayName: 'Sarah Johnson', viewedAt: iso(Date.now()), reaction: '❤️' }); emit('status.viewed', {}); }); return [201, { id: s.id }]; });
route('POST', '/api/status/:id/view', ({ m }) => { const s = statuses.find((x) => x.id === m[1]); if (s) s.viewed = true; });
route('POST', '/api/status/:id/react', ({ m, body }) => { const s = statuses.find((x) => x.id === m[1]); if (s) s.reaction = body.emoji; });
route('POST', '/api/status/:id/reply', ({ m, body }) => { const s = statuses.find((x) => x.id === m[1])!; const c = [...convs.values()].find((x) => x.peer === s.userId)!; const nm = msg(c, ME, 'text', `↩ Status: “${(s.body || s.caption || 'Photo').slice(0, 80)}”\n${body.body}`, 0); deliverMessage(c, nm); simulateReply(c, nm); return { conversationId: c.id, message: msgView(c, nm) }; });
route('PUT', '/api/status/mute/:uid', ({ m, body }) => { if (body.muted) mutedStatus.add(m[1]); else mutedStatus.delete(m[1]); });
route('DELETE', '/api/status/:id', ({ m }) => { const i = statuses.findIndex((x) => x.id === m[1]); if (i >= 0) statuses.splice(i, 1); });

route('GET', '/api/calls', () => ({ calls: calls.map((c) => { const conv = [...convs.values()].find((x) => x.peer === c.other)!; return { id: c.id, conversationId: conv.id, initiatorId: c.initiatorId, kind: c.kind, state: c.state, createdAt: iso(Date.now() - c.ago * MIN), answeredAt: null, connectedAt: null, endedAt: null, endReason: null, direction: c.dir, other: { id: c.other, displayName: P(c.other).displayName, username: P(c.other).username, avatarMediaId: null }, durationSec: c.dur }; }) }));
route('GET', '/api/calls/active', () => ({ call: null }));
route('POST', '/api/calls', () => { throw new Err(503, 'demo_no_calls', 'Calls need a real server and your microphone. They are disabled in this in-page demo.'); });
route('GET', '/api/calls/ice', () => ({ iceServers: [], ttlSeconds: 3600, turnConfigured: false }));

const commDto = (c: Comm) => ({ id: c.id, name: c.name, description: c.description, visibility: c.visibility, avatarMediaId: null, members: c.members.length + 1, role: c.role, announcementConversationId: c.announce, createdAt: iso(Date.now() - 5 * 86400000),
  groups: c.groups.map((gid) => { const g = convs.get(gid)!; return { id: g.id, title: g.title, avatarMediaId: null, kind: g.kind, memberCount: g.members.length, joined: true }; }) });
route('GET', '/api/communities/discover', ({ q }) => { const t = (q.get('q') ?? '').toLowerCase(); return { communities: [{ id: 'c-open', name: 'Open Source Club', description: '', avatarMediaId: null, members: 128 }].filter((c) => c.name.toLowerCase().includes(t)), channels: [{ id: 'ch-news', title: 'Wazzupp News', description: '', avatarMediaId: null, members: 4210 }].filter((c) => c.title.toLowerCase().includes(t)) }; });
route('GET', '/api/communities', () => ({ communities: comms.map(commDto) }));
route('GET', '/api/communities/:id', ({ m }) => { const c = comms.find((x) => x.id === m[1]); if (!c) throw new Err(404, 'community_not_found'); return { community: commDto(c) }; });
route('GET', '/api/communities/:id/members', ({ m }) => { const c = comms.find((x) => x.id === m[1])!; return { members: [{ id: ME, username: 'alex', displayName: 'Alex Morgan', avatarMediaId: null, role: 'owner' }, ...c.members.map((id) => ({ id, username: P(id).username, displayName: P(id).displayName, avatarMediaId: null, role: 'member' }))] }; });
route('POST', '/api/communities', ({ body }) => { const a = mkConv('announcement', `${body.name} · Announcements`, [], { announceOnly: true }); const c: Comm = { id: uid(), name: body.name, description: body.description ?? '', visibility: body.visibility, role: 'owner', groups: [], members: [], announce: a.id }; a.communityId = c.id; msg(a, ME, 'system', '', 0, { meta: { event: 'community_created', name: c.name, actorId: ME } }); markAllRead(a); comms.unshift(c); return [201, { community: commDto(c) }]; });
route('POST', '/api/communities/:id/invites', () => [201, { id: uid(), code: 'demo-community-' + uid().slice(0, 8), link: '', expiresAt: iso(Date.now() + 7 * 86400000) }]);
route('POST', '/api/communities/:id/announce', ({ m, body }) => { const c = comms.find((x) => x.id === m[1])!; const a = getConv(c.announce); const nm = msg(a, ME, 'text', body.body, 0); deliverMessage(a, nm); return [201, { message: msgView(a, nm) }]; });
route('POST', '/api/communities/:id/groups', ({ m, body }) => { const c = comms.find((x) => x.id === m[1])!; c.groups.push(body.conversationId); getConv(body.conversationId).communityId = c.id; });
route('POST', '/api/communities/:id/leave', ({ m }) => { const i = comms.findIndex((x) => x.id === m[1]); if (i >= 0) comms.splice(i, 1); });
route('POST', '/api/communities/:id/join', () => { throw new Err(503, 'demo', 'Joining public communities is not part of the demo data.'); });
route('POST', '/api/me/password', noop);

function parseBody(init?: RequestInit): J {
  const b = init?.body; if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { return {}; } }
  if (b instanceof FormData) { const o: J = {}; b.forEach((v, k) => { if (v instanceof File) o.__file = v; else o[k] = v; }); return o; }
  return {};
}
export function installDemoBackend() {
  const realFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input as any, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 60));
    for (const [mth, re, h] of R) {
      const m = url.pathname.match(re); if (mth !== method || !m) continue;
      try {
        let out = await h({ m, body: parseBody(init), q: url.searchParams }); let status = 200;
        if (Array.isArray(out) && typeof out[0] === 'number') { status = out[0]; out = out[1]; }
        if (out === undefined) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
      } catch (e) {
        const er = e instanceof Err ? e : new Err(500, 'internal', String(e));
        return new Response(JSON.stringify({ error: { code: er.code, message: er.message } }), { status: er.status, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: { code: 'demo_unavailable', message: 'This feature needs the real server and is not part of the in-page demo.' } }), { status: 501, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  (window as any).WebSocket = FakeWS;
}
