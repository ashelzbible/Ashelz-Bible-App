import { api, ApiError, setToken, setUnauthorizedHandler } from './api.ts';
import { getState, resetState, setState, sortConvs, toast } from './store.ts';
import type { CallHistory, Conv, Me, Msg } from './types.ts';
import { applyAppearance } from './theme.ts';
import { realtime } from './realtime.ts';
import { getHash, setHash } from './nav.ts';

const LS = { token: 'wz.token', event: 'wz.lastEvent', outbox: 'wz.outbox' };
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
export const lastEventId = () => Number(ls.get(LS.event) ?? 0) || 0;
export const saveEventId = (n: number) => ls.set(LS.event, String(n));

// ---------------------------------------------------------------- boot / auth
export async function boot() {
  setUnauthorizedHandler(() => { void logout(false); });
  const t = ls.get(LS.token);
  if (!t) { setState({ booted: true }); return; }
  setToken(t);
  try {
    const { user } = await api.get<{ user: Me }>('/api/me');
    await startSession(user);
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) { setState({ booted: true }); toast('You are offline. Reconnecting…'); setTimeout(boot, 3000); return; }
    setToken(null); ls.del(LS.token); setState({ booted: true });
  }
}

export async function startSession(user: Me) {
  setState({ me: user, booted: true });
  applyAppearance(user.settings.appearance);
  realtime.start();
  await refreshAll();
}

export async function authenticate(path: string, body: Record<string, unknown>) {
  const r = await api.post<{ token: string; user: Me }>(path, { platform: 'web', deviceName: deviceName(), ...body });
  ls.set(LS.token, r.token); setToken(r.token);
  ls.del(LS.event);
  await startSession(r.user);
  return r.user;
}
function deviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

export async function logout(callServer = true) {
  if (callServer) { try { await api.post('/api/auth/logout'); } catch { /* already invalid */ } }
  realtime.stop(); setToken(null); ls.del(LS.token); ls.del(LS.event); ls.del(LS.outbox);
  resetState(); setHash('#/chats');
}

export async function refreshMe() { const { user } = await api.get<{ user: Me }>('/api/me'); setState({ me: user }); applyAppearance(user.settings.appearance); return user; }

// ---------------------------------------------------------------- data loading
export async function refreshAll() {
  await Promise.allSettled([loadConversations(), loadContacts(), loadStatus(), loadCalls(), loadFolders(), loadNotifications(), loadCommunities()]);
}
export async function loadConversations() {
  const { conversations } = await api.get<{ conversations: Conv[] }>('/api/conversations');
  const map: Record<string, Conv> = {};
  for (const c of conversations) map[c.id] = c;
  setState({ convs: map, convOrder: sortConvs(map) });
}
export async function refreshConversation(id: string) {
  try {
    const { conversation } = await api.get<{ conversation: Conv }>(`/api/conversations/${id}`);
    setState((s) => { const convs = { ...s.convs, [id]: conversation }; return { convs, convOrder: sortConvs(convs) }; });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) setState((s) => { const convs = { ...s.convs }; delete convs[id]; return { convs, convOrder: sortConvs(convs) }; });
  }
}
export const loadContacts = async () => { const r = await api.get('/api/contacts'); setState({ contacts: r.contacts }); };
export const loadCalls = async () => { const r = await api.get<{ calls: CallHistory[] }>('/api/calls'); setState({ calls: r.calls }); };
export const loadStatus = async () => { const [f, m] = await Promise.all([api.get('/api/status'), api.get('/api/status/mine')]); setState({ statusFeed: f.feed, myStatus: m.items }); };
export const loadFolders = async () => { const r = await api.get('/api/folders'); setState({ folders: r.folders }); };
export const loadNotifications = async () => { const r = await api.get('/api/notifications'); setState({ notifications: r.notifications }); };
export const loadCommunities = async () => { const r = await api.get('/api/communities'); setState({ communities: r.communities }); };

export async function loadMessages(convId: string, opts: { older?: boolean } = {}) {
  const cur = getState().msgs[convId];
  if (opts.older) {
    if (!cur || cur.loadingOlder || !cur.hasMore) return;
    const first = cur.list.find((m) => !m.local);
    if (!first) return;
    patchThread(convId, { loadingOlder: true });
    try {
      const r = await api.get(`/api/conversations/${convId}/messages?before=${first.seq}&limit=40`);
      setState((s) => { const t = s.msgs[convId]; return { msgs: { ...s.msgs, [convId]: { ...t, list: mergeList(t.list, r.messages), hasMore: r.hasMore, loadingOlder: false } }, wm: { ...s.wm, [convId]: r.watermarks } }; });
    } catch { patchThread(convId, { loadingOlder: false }); }
    return;
  }
  const r = await api.get(`/api/conversations/${convId}/messages?limit=40`);
  setState((s) => {
    const prev = s.msgs[convId]?.list ?? [];
    const locals = prev.filter((m) => m.local);
    return { msgs: { ...s.msgs, [convId]: { list: mergeList(locals, r.messages), hasMore: r.hasMore, loaded: true, loadingOlder: false } }, wm: { ...s.wm, [convId]: r.watermarks } };
  });
}
function patchThread(convId: string, p: Partial<{ hasMore: boolean; loaded: boolean; loadingOlder: boolean }>) {
  setState((s) => { const t = s.msgs[convId] ?? { list: [], hasMore: false, loaded: false, loadingOlder: false }; return { msgs: { ...s.msgs, [convId]: { ...t, ...p } } }; });
}
const rank = (m: Msg) => (m.local ? Number.MAX_SAFE_INTEGER : m.seq);
export function mergeList(a: Msg[], b: Msg[]): Msg[] {
  const byId = new Map<string, Msg>(); const byClient = new Map<string, string>();
  for (const m of [...a, ...b]) {
    const dupId = byClient.get(m.clientMsgId);
    if (dupId && dupId !== m.id) { if (m.local) continue; byId.delete(dupId); }
    byId.set(m.id, { ...byId.get(m.id), ...m });
    byClient.set(m.clientMsgId, m.id);
  }
  return [...byId.values()].sort((x, y) => rank(x) - rank(y) || +new Date(x.createdAt) - +new Date(y.createdAt));
}

export async function resyncOpenThreads() {
  await loadConversations();
  await Promise.allSettled(Object.keys(getState().msgs).map((id) => (getState().convs[id] ? loadMessages(id) : Promise.resolve())));
}

// ---------------------------------------------------------------- reading
const readTimers: Record<string, ReturnType<typeof setTimeout>> = {};
export function markRead(convId: string) {
  const c = getState().convs[convId]; if (!c) return;
  const seq = c.lastSeq;
  if (c.lastReadSeq >= seq && !c.markedUnread) return;
  clearTimeout(readTimers[convId]);
  readTimers[convId] = setTimeout(() => {
    setState((s) => { const cc = s.convs[convId]; return cc ? { convs: { ...s.convs, [convId]: { ...cc, unread: 0, unreadMentions: 0, markedUnread: false, lastReadSeq: seq } } } : {}; });
    api.post(`/api/conversations/${convId}/read`, { seq }).catch(() => {});
  }, 150);
}

// ---------------------------------------------------------------- sending (optimistic + durable outbox)
interface OutItem { convId: string; clientMsgId: string; payload: Record<string, unknown>; createdAt: string; tries: number }
const readOutbox = (): OutItem[] => { try { return JSON.parse(ls.get(LS.outbox) ?? '[]'); } catch { return []; } };
const writeOutbox = (o: OutItem[]) => ls.set(LS.outbox, JSON.stringify(o));

export function restoreOutbox() {
  for (const it of readOutbox()) addLocal(it.convId, it.clientMsgId, it.payload, it.createdAt, 'queued');
}
function addLocal(convId: string, clientMsgId: string, payload: Record<string, any>, createdAt = new Date().toISOString(), status: Msg['status'] = 'sending') {
  const me = getState().me!;
  const reply = payload.replyToId ? getState().msgs[convId]?.list.find((m) => m.id === payload.replyToId) : null;
  const local: Msg = {
    id: `local-${clientMsgId}`, conversationId: convId, seq: 0, senderId: me.id, clientMsgId, kind: payload.kind, body: payload.body ?? '', meta: payload.meta ?? {},
    media: payload._media ?? null, replyTo: reply ? { id: reply.id, senderId: reply.senderId, kind: reply.kind, body: reply.body.slice(0, 140), deleted: reply.deleted } : null,
    forwarded: false, mentions: payload.mentions ?? [], createdAt, editedAt: null, deleted: false, expiresAt: null, pinned: false, status, local: true, reactions: [],
  };
  setState((s) => { const t = s.msgs[convId] ?? { list: [], hasMore: false, loaded: true, loadingOlder: false }; return { msgs: { ...s.msgs, [convId]: { ...t, list: mergeList(t.list, [local]) } } }; });
}

export function sendMessage(convId: string, payload: { kind: string; body?: string; meta?: Record<string, unknown>; mediaId?: string; replyToId?: string | null; mentions?: string[]; _media?: any }, existingClientId?: string) {
  const clientMsgId = existingClientId ?? crypto.randomUUID();
  const { _media, ...wire } = payload;
  addLocal(convId, clientMsgId, payload);
  writeOutbox([...readOutbox().filter((i) => i.clientMsgId !== clientMsgId), { convId, clientMsgId, payload: { ...wire, _media }, createdAt: new Date().toISOString(), tries: 0 }]);
  void flushOutbox();
  return clientMsgId;
}

let flushing = false;
export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const queue = readOutbox();
      const item = queue[0];
      if (!item) break;
      const { _media, ...wire } = item.payload as any;
      try {
        const r = await api.post<{ message: Msg }>(`/api/conversations/${item.convId}/messages`, { clientMsgId: item.clientMsgId, ...wire });
        writeOutbox(readOutbox().filter((i) => i.clientMsgId !== item.clientMsgId));
        applyMessage({ ...r.message, status: 'sent' });
      } catch (e) {
        const err = e as ApiError;
        if (err.status === 0 || err.status === 429 || err.status >= 500) {
          setLocalStatus(item.convId, item.clientMsgId, 'queued');
          break; // retried on reconnect
        }
        writeOutbox(readOutbox().filter((i) => i.clientMsgId !== item.clientMsgId));
        setLocalStatus(item.convId, item.clientMsgId, 'failed');
        toast(err.message || 'Message could not be sent', 'error');
      }
    }
  } finally { flushing = false; }
}
function setLocalStatus(convId: string, clientMsgId: string, status: Msg['status']) {
  setState((s) => { const t = s.msgs[convId]; if (!t) return {}; return { msgs: { ...s.msgs, [convId]: { ...t, list: t.list.map((m) => (m.clientMsgId === clientMsgId && m.local ? { ...m, status } : m)) } } }; });
}
export function retryMessage(convId: string, clientMsgId: string) {
  const m = getState().msgs[convId]?.list.find((x) => x.clientMsgId === clientMsgId);
  if (!m) return;
  const stored = readOutbox().find((i) => i.clientMsgId === clientMsgId);
  const payload = stored?.payload ?? { kind: m.kind, body: m.body, meta: m.meta, mediaId: m.media?.id, replyToId: m.replyTo?.id };
  sendMessage(convId, payload as any, clientMsgId); // same clientMsgId: the server de-duplicates, so a retry can never double-send
}
export function discardLocal(convId: string, clientMsgId: string) {
  writeOutbox(readOutbox().filter((i) => i.clientMsgId !== clientMsgId));
  setState((s) => { const t = s.msgs[convId]; return t ? { msgs: { ...s.msgs, [convId]: { ...t, list: t.list.filter((m) => m.clientMsgId !== clientMsgId) } } } : {}; });
}

// ---------------------------------------------------------------- event reducers
export function applyMessage(m: Msg) {
  setState((s) => {
    const t = s.msgs[m.conversationId];
    const mine = m.senderId === s.me?.id;
    let msgs = s.msgs;
    if (t) msgs = { ...s.msgs, [m.conversationId]: { ...t, list: mergeList(t.list, [{ ...m, status: mine ? (m.status ?? 'sent') : undefined }]) } };
    const c = s.convs[m.conversationId];
    if (!c) return { msgs };
    const open = getHash().includes(`/chats/${m.conversationId}`) && s.focused;
    const incoming = !mine && m.kind !== 'system';
    const already = c.lastMessage?.id === m.id;
    const upd: Conv = {
      ...c, lastSeq: Math.max(c.lastSeq, m.seq), lastMessage: m.seq >= (c.lastMessage?.seq ?? 0) ? m : c.lastMessage, lastMessageAt: m.seq >= (c.lastMessage?.seq ?? 0) ? m.createdAt : c.lastMessageAt,
      unread: incoming && !open && !already ? c.unread + 1 : c.unread, unreadMentions: incoming && !open && !already && m.mentions.includes(s.me?.id ?? '') ? c.unreadMentions + 1 : c.unreadMentions,
      archived: incoming && c.archived && !c.muted ? false : c.archived,
    };
    const convs = { ...s.convs, [c.id]: upd };
    return { msgs, convs, convOrder: sortConvs(convs) };
  });
  const c = getState().convs[m.conversationId];
  if (c && m.senderId !== getState().me?.id && getHash().includes(`/chats/${m.conversationId}`) && getState().focused) markRead(m.conversationId);
  if (!getState().convs[m.conversationId]) void refreshConversation(m.conversationId);
}
function patchMessage(convId: string, id: string, fn: (m: Msg) => Msg) {
  setState((s) => {
    const t = s.msgs[convId]; const next: Partial<typeof s> = {};
    if (t) next.msgs = { ...s.msgs, [convId]: { ...t, list: t.list.map((m) => (m.id === id ? fn(m) : m)) } };
    const c = s.convs[convId];
    if (c?.lastMessage?.id === id) next.convs = { ...s.convs, [convId]: { ...c, lastMessage: fn(c.lastMessage) } };
    return next;
  });
}
const groupRefetch: Record<string, ReturnType<typeof setTimeout>> = {};

export function applyEvent(type: string, p: any) {
  const me = getState().me;
  switch (type) {
    case 'message.new': applyMessage(p.message); break;
    case 'message.update': patchMessage(p.message.conversationId, p.message.id, (m) => ({ ...m, ...p.message })); break;
    case 'message.delete': patchMessage(p.conversationId, p.messageId, (m) => ({ ...m, deleted: true, body: '', meta: {}, media: null, pinned: false, reactions: [] })); break;
    case 'message.hide': setState((s) => { const t = s.msgs[p.conversationId]; return t ? { msgs: { ...s.msgs, [p.conversationId]: { ...t, list: t.list.filter((m) => m.id !== p.messageId) } } } : {}; }); break;
    case 'message.reactions': patchMessage(p.conversationId, p.messageId, (m) => ({ ...m, reactions: p.reactions })); break;
    case 'message.star': patchMessage(p.conversationId, p.messageId, (m) => ({ ...m, starred: p.starred })); break;
    case 'poll.votes': patchMessage(p.conversationId, p.messageId, (m) => ({ ...m, votes: p.votes })); break;
    case 'receipt': {
      const c = getState().convs[p.conversationId];
      if (!c || p.userId === me?.id) break;
      if (c.kind === 'direct') setState((s) => ({ wm: { ...s.wm, [p.conversationId]: { delivered: Math.max(s.wm[p.conversationId]?.delivered ?? 0, p.deliveredSeq ?? 0), read: Math.max(s.wm[p.conversationId]?.read ?? 0, p.readSeq ?? 0) } } }));
      else { // groups: ticks advance only when everyone has it, so ask the server for the minimum
        clearTimeout(groupRefetch[p.conversationId]);
        groupRefetch[p.conversationId] = setTimeout(() => api.get(`/api/conversations/${p.conversationId}/messages?after=${c.lastSeq}&limit=1`).then((r) => setState((s) => ({ wm: { ...s.wm, [p.conversationId]: r.watermarks } }))).catch(() => {}), 400);
      }
      break;
    }
    case 'conversation.state': case 'conversation.update': refreshConversation(p.conversationId); if (p.removedUserId) setState((s) => ({ members: { ...s.members, [p.conversationId]: undefined as any } })); break;
    case 'conversation.cleared': setState((s) => { const t = s.msgs[p.conversationId]; return t ? { msgs: { ...s.msgs, [p.conversationId]: { ...t, list: t.list.filter((m) => m.seq > p.upToSeq) } } } : {}; }); refreshConversation(p.conversationId); break;
    case 'settings.update': case 'profile.update': refreshMe().catch(() => {}); break;
    case 'blocks.update': loadConversations().catch(() => {}); break;
    case 'status.new': case 'status.viewed': case 'status.reaction': loadStatus().catch(() => {}); break;
    case 'devices.update': break;
    case 'security.new_login': toast(`New sign-in on ${p.deviceName}${p.suspicious ? ' from an unfamiliar location' : ''}`); loadNotifications().catch(() => {}); break;
    case 'call.incoming': case 'call.state': void import('./rtc.ts').then((r) => r.onCallEvent(type, p)); break;
  }
}

// ---------------------------------------------------------------- conversations helpers
export async function openDirect(userId: string): Promise<string> {
  const { conversation } = await api.post<{ conversation: Conv }>('/api/conversations/direct', { userId });
  setState((s) => { const convs = { ...s.convs, [conversation.id]: conversation }; return { convs, convOrder: sortConvs(convs) }; });
  return conversation.id;
}
export async function patchState(convId: string, body: Record<string, unknown>) {
  const r = await api.patch<{ conversation: Conv }>(`/api/conversations/${convId}/state`, body);
  setState((s) => { const convs = { ...s.convs, [convId]: r.conversation }; return { convs, convOrder: sortConvs(convs) }; });
}
export const toastError = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Something went wrong', 'error');
export async function guard<T>(p: Promise<T>): Promise<T | undefined> { try { return await p; } catch (e) { toastError(e); return undefined; } }

export async function markCallsSeen() {
  const unread = getState().notifications.some((n) => n.kind === 'missed_call' && !n.read);
  if (!unread) return;
  try { await api.post('/api/notifications/read'); await loadNotifications(); } catch { /* ignore */ }
}

/** Marks every chat as read (and clears manual "unread" flags). */
export async function markAllRead() {
  const list = Object.values(getState().convs).filter((c) => c.unread > 0 || c.markedUnread);
  if (!list.length) { toast('Everything is already read'); return; }
  setState((s) => { const convs = { ...s.convs }; for (const c of list) convs[c.id] = { ...convs[c.id], unread: 0, unreadMentions: 0, markedUnread: false, lastReadSeq: c.lastSeq }; return { convs }; });
  await Promise.allSettled(list.map((c) => api.post(`/api/conversations/${c.id}/read`, { seq: c.lastSeq })));
  toast(`Marked ${list.length} ${list.length === 1 ? 'chat' : 'chats'} as read`);
}
