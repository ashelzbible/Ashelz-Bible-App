import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { clock, convTitle, dayLabel, lastSeenLabel } from '../lib/format.ts';
import { QUICK_REACTIONS } from '../lib/emoji.ts';
import { back, go, useLayout, useWide } from '../lib/route.ts';
import { getHash } from '../lib/nav.ts';
import { getState, toast, useStore } from '../lib/store.ts';
import type { Conv, Member, Msg } from '../lib/types.ts';
import { discardLocal, guard, loadMessages, markRead, patchState, retryMessage, refreshConversation } from '../lib/actions.ts';
import { startCall } from '../lib/rtc.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Confirm, Dialog, useMenu } from '../ui/Overlay.tsx';
import { Bubble } from './Bubble.tsx';
import { Composer } from './Composer.tsx';
import { ForwardDialog } from './Dialogs.tsx';
import { InfoPanel } from './InfoPanel.tsx';
import { MediaViewer } from './Viewer.tsx';
import { useMedia } from '../lib/mediaCache.ts';

function useMembers(conv: Conv | undefined) {
  const id = conv?.id; const members = useStore((s) => (id ? s.members[id] : undefined));
  useEffect(() => {
    if (!id || conv!.kind === 'direct' || members) return;
    api.get<{ members: Member[] }>(`/api/conversations/${id}/members`).then((r) => { import('../lib/store.ts').then((m) => m.setState((s) => ({ members: { ...s.members, [id]: r.members } }))); }).catch(() => {});
  }, [id, members, conv?.memberCount]);
  return members;
}

export function Conversation({ id, jumpSeq }: { id: string; jumpSeq?: number }) {
  const conv = useStore((s) => s.convs[id]);
  const layout = useLayout(); const wide = useWide();
  const me = useStore((s) => s.me!);
  const thread = useStore((s) => s.msgs[id]);
  const wm = useStore((s) => s.wm[id]);
  const typingKey = useStore((s) => Object.entries(s.typing[id] ?? {}).filter(([u, exp]) => u !== me.id && exp > Date.now()).map(([u]) => u).join(','));
  const typingUsers = typingKey ? typingKey.split(',') : [];
  const online = useStore((s) => (conv?.other ? !!s.online[conv.other.id] : false));
  const lastSeen = useStore((s) => (conv?.other ? s.lastSeen[conv.other.id] ?? conv.other.lastSeenAt : null));
  const members = useMembers(conv);
  const [reply, setReply] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [fwd, setFwd] = useState<Msg | null>(null);
  const [viewer, setViewer] = useState<Msg | null>(null);
  const [confirmDel, setConfirmDel] = useState<Msg | null>(null);
  const [history, setHistory] = useState<Msg | null>(null);
  const [searching, setSearching] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [dropFiles, setDropFiles] = useState<File[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [unreadFrom, setUnreadFrom] = useState<number | null>(null);
  const [unreadN, setUnreadN] = useState(0);
  const [reportMsg, setReportMsg] = useState<Msg | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const menu = useMenu(); const headMenu = useMenu();
  const stick = useRef(true);
  const prevHeight = useRef(0);

  const route = getHash().split('/');
  const infoRoute = route[3] === 'info';
  useEffect(() => { setShowInfo(infoRoute || (wide && layout === 'desktop' && localStorage.getItem('wz.info') !== '0')); }, [infoRoute, wide, layout, id]);

  // load, mark read, remember where the unread boundary was when opening
  useEffect(() => {
    setReply(null); setEditing(null); setSearching(false); setUnreadFrom(null); setUnreadN(0);
    let alive = true;
    (async () => {
      const c = getState().convs[id]; const first = c?.lastReadSeq ?? 0; const unread = c?.unread ?? 0;
      if (jumpSeq) await jump(jumpSeq); else await guard(loadMessages(id));
      if (!alive) return;
      if (unread > 0) { setUnreadFrom(first); setUnreadN(unread); }
      markRead(id);
    })();
    return () => { alive = false; };
  }, [id]);  
  useEffect(() => { const h = (e: Event) => setEditing((e as CustomEvent).detail); document.addEventListener('wz-edit', h); return () => document.removeEventListener('wz-edit', h); }, []);

  const list = thread?.list ?? [];
  const lastKey = list.length ? list[list.length - 1].id + list[list.length - 1].status : '';
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    if (prevHeight.current && !stick.current) { el.scrollTop += el.scrollHeight - prevHeight.current; prevHeight.current = 0; return; }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [lastKey, thread?.loaded, list.length === 0]);
  useEffect(() => { if (document.hasFocus() && atBottom && conv && conv.unread > 0) markRead(id); }, [conv?.unread, atBottom]);  

  const onScroll = () => {
    const el = scroller.current; if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near; setAtBottom(near);
    if (el.scrollTop < 120 && thread?.hasMore && !thread.loadingOlder) { prevHeight.current = el.scrollHeight; void loadMessages(id, { older: true }); }
  };

  async function jump(seq: number) {
    const r = await api.get(`/api/conversations/${id}/messages?after=${Math.max(0, seq - 25)}&limit=50`);
    const { setState } = await import('../lib/store.ts'); const { mergeList } = await import('../lib/actions.ts');
    setState((s) => ({ msgs: { ...s.msgs, [id]: { list: mergeList(s.msgs[id]?.list.filter((m) => m.local) ?? [], r.messages), hasMore: true, loaded: true, loadingOlder: false } }, wm: { ...s.wm, [id]: r.watermarks } }));
    stick.current = false;
    requestAnimationFrame(() => scrollTo(r.messages.find((m: Msg) => m.seq >= seq)?.id));
  }
  function scrollTo(msgId?: string) {
    if (!msgId) return;
    const el = scroller.current?.querySelector(`[data-id="${msgId}"]`) as HTMLElement | null;
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setHighlight(msgId); setTimeout(() => setHighlight(null), 1800); }
    else void api.get(`/api/conversations/${id}/messages?after=0&limit=1`);
  }
  const nameOf = useCallback((uid: string) => (uid === me.id ? 'You' : members?.find((m) => m.id === uid)?.displayName ?? (conv?.other?.id === uid ? conv.other.displayName : 'Someone')), [members, conv?.other, me.id]);

  const react = useCallback((m: Msg, emoji: string) => {
    const mine = m.reactions?.find((r) => r.userId === me.id);
    void guard(api.put(`/api/messages/${m.id}/reaction`, { emoji: mine?.emoji === emoji ? null : emoji }));
  }, [me.id]);

  const openMenu = useCallback((e: { clientX: number; clientY: number }, m: Msg) => {
    const mine = m.senderId === me.id;
    const c = getState().convs[id]; const staff = c && c.kind !== 'direct' && (c.role === 'owner' || c.role === 'admin');
    if (m.deleted || m.local) { if (m.local) menu.open([{ label: 'Discard', icon: 'trash', danger: true, onClick: () => discardLocal(id, m.clientMsgId) }, { label: 'Retry', icon: 'refresh', onClick: () => retryMessage(id, m.clientMsgId) }], e); return; }
    const items: Array<{ label: string; icon?: IconName; onClick?: () => void; danger?: boolean; hidden?: boolean; divider?: boolean }> = [
      { label: 'Reply', icon: 'reply', onClick: () => setReply(m) },
      { label: 'Copy', icon: 'copy', hidden: !m.body, onClick: () => navigator.clipboard?.writeText(m.body).then(() => toast('Copied')) },
      { label: 'Forward', icon: 'forward', hidden: m.kind === 'poll', onClick: () => setFwd(m) },
      { label: m.starred ? 'Remove star' : 'Star', icon: 'star', onClick: () => void guard(api.put(`/api/messages/${m.id}/star`, { starred: !m.starred })) },
      { label: m.pinned ? 'Unpin' : 'Pin', icon: 'pin', hidden: c?.kind !== 'direct' && !staff, onClick: () => void guard(api.put(`/api/messages/${m.id}/pin`, { pinned: !m.pinned })) },
      { label: 'Edit', icon: 'edit', hidden: !(mine && ['text', 'image', 'video', 'document'].includes(m.kind)) || Date.now() - +new Date(m.createdAt) > 15 * 60000, onClick: () => setEditing(m) },
      { label: 'Edit history', icon: 'clock', hidden: !m.editedAt, onClick: () => setHistory(m) },
      { label: 'Report', icon: 'flag', hidden: mine, onClick: () => setReportMsg(m) },
      { divider: true, label: '' },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => setConfirmDel(m) },
    ];
    const mineReact = m.reactions?.find((r) => r.userId === me.id)?.emoji;
    (menu.open as any)(items, e, (close: () => void) => <div className="react-bar">{QUICK_REACTIONS.map((em) => <button key={em} className={mineReact === em ? 'on' : ''} onClick={() => { close(); react(m, em); }} aria-label={`React ${em}`}>{em}</button>)}</div>);
  }, [id, me.id, react]);  

  const openMedia = useCallback((m: Msg) => setViewer(m), []);
  const retry = useCallback((m: Msg) => retryMessage(id, m.clientMsgId), [id]);
  const swipe = useCallback((m: Msg) => setReply(m), []);
  const jumpTo = useCallback((mid: string) => { const t = getState().msgs[id]?.list.find((x) => x.id === mid); if (t) scrollTo(mid); }, [id]);  

  const rows = useMemo(() => {
    const out: Array<{ key: string; type: 'day' | 'unread' | 'msg'; label?: string; m?: Msg; first?: boolean; last?: boolean }> = [];
    let day = ''; let prev: Msg | null = null; let unreadShown = false;
    for (const [i, m] of list.entries()) {
      const d = new Date(m.createdAt).toDateString();
      if (d !== day) { day = d; out.push({ key: 'd' + d, type: 'day', label: dayLabel(m.createdAt) }); prev = null; }
      if (!unreadShown && unreadFrom !== null && m.seq > unreadFrom && m.senderId !== me.id && !m.local && m.kind !== 'system') { unreadShown = true; out.push({ key: 'unread', type: 'unread', label: `${unreadN} unread message${unreadN === 1 ? '' : 's'}` }); prev = null; }
      const next = list[i + 1];
      const sameAsPrev = prev && prev.senderId === m.senderId && prev.kind !== 'system' && m.kind !== 'system' && +new Date(m.createdAt) - +new Date(prev.createdAt) < 5 * 60000;
      const sameAsNext = next && next.senderId === m.senderId && next.kind !== 'system' && m.kind !== 'system' && new Date(next.createdAt).toDateString() === d && +new Date(next.createdAt) - +new Date(m.createdAt) < 5 * 60000;
      out.push({ key: m.clientMsgId || m.id, type: 'msg', m, first: !sameAsPrev, last: !sameAsNext });
      prev = m;
    }
    return out;
  }, [list, unreadFrom, unreadN, me.id]);

  if (!conv) return <div className="conv-empty"><div className="spinner" /></div>;
  const title = convTitle(conv);
  const isGroup = conv.kind !== 'direct';
  const canPost = conv.kind === 'channel' || conv.kind === 'announcement' || conv.announceOnly ? conv.role === 'owner' || conv.role === 'admin' : true;
  const blocked = conv.other?.blockedByMe;
  const subtitle = typingUsers.length ? <span className="typing-txt">{isGroup ? `${nameOf(typingUsers[0]).split(' ')[0]} is typing…` : 'typing…'}</span>
    : isGroup ? <span className="truncate">{conv.kind === 'channel' ? `${conv.memberCount} subscribers` : members ? members.slice(0, 5).map((m) => (m.id === me.id ? 'You' : m.displayName.split(' ')[0])).join(', ') + (members.length > 5 ? '…' : '') : `${conv.memberCount} members`}</span>
    : online ? <span className="online-txt">online</span> : lastSeen ? <span>{lastSeenLabel(lastSeen)}</span> : null;

  const statusOf = (m: Msg): 'sending' | 'queued' | 'failed' | 'sent' | 'delivered' | 'read' | null => {
    if (m.senderId !== me.id) return null;
    if (m.local) return (m.status as any) ?? 'sending';
    if (m.undelivered) return 'sent';
    return wm && m.seq <= wm.read ? 'read' : wm && m.seq <= wm.delivered ? 'delivered' : 'sent';
  };
  const pinned = list.filter((m) => m.pinned && !m.deleted);
  const memberOf = (uid: string | null) => members?.find((m) => m.id === uid);

  const header = searching ? <SearchBar convId={id} onClose={() => setSearching(false)} onPick={(seq) => void jump(seq)} /> : (
    <header className="conv-head">
      {layout !== 'desktop' ? <button className="icon-btn on-head" onClick={() => back()} aria-label="Back"><Icon name="back" /></button> : null}
      <button className="head-id" onClick={() => (layout === 'desktop' ? setShowInfo((v) => { localStorage.setItem('wz.info', v ? '0' : '1'); return !v; }) : go(`chats/${id}/info`))} aria-label="Conversation info">
        <Avatar id={conv.other?.id ?? conv.id} name={title} mediaId={isGroup ? conv.avatarMediaId : conv.other?.avatarMediaId} size={layout === 'desktop' ? 42 : 40} group={isGroup} />
        <span className="head-text"><b className="truncate">{title}</b><small className="truncate">{subtitle}</small></span>
      </button>
      <div className="head-actions">
        {conv.kind === 'direct' ? <><button className="icon-btn on-head" onClick={() => startCall(id, 'video')} aria-label="Video call" title="Video call"><Icon name="video" /></button>
          <button className="icon-btn on-head" onClick={() => startCall(id, 'audio')} aria-label="Voice call" title="Voice call"><Icon name="phone" /></button></> : null}
        <button className={`icon-btn on-head ${layout === 'mobile' ? 'hide-sm' : ''}`} onClick={() => setSearching(true)} aria-label="Search in chat" title="Search"><Icon name="search" /></button>
        <button className="icon-btn on-head" aria-label="More" onClick={(e) => headMenu.open([
          { label: 'Search', icon: 'search', hidden: layout !== 'mobile', onClick: () => setSearching(true) },
          { label: 'Contact info', icon: 'info', onClick: () => (layout === 'desktop' ? setShowInfo(true) : go(`chats/${id}/info`)) },
          { label: 'Select chat media', icon: 'image', onClick: () => go(`chats/${id}/info`) },
          { label: conv.muted ? 'Unmute' : 'Mute notifications', icon: conv.muted ? 'bell' : 'bell-off', onClick: () => guard(patchState(id, { mutedUntil: conv.muted ? null : 'forever' })) },
          { label: conv.archived ? 'Unarchive' : 'Archive chat', icon: 'archive', onClick: () => guard(patchState(id, { archived: !conv.archived })) },
          { label: 'Clear chat', icon: 'trash', onClick: () => void guard(api.post(`/api/conversations/${id}/clear`)) },
          { label: 'Close chat', icon: 'x', onClick: () => go('chats') },
        ], e)}><Icon name="more" /></button>
      </div>
    </header>
  );

  return (
    <div className="conv-wrap">
      <section className="conv" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false); }}
        onDrop={(e) => { e.preventDefault(); setDropping(false); if (e.dataTransfer.files.length) setDropFiles([...e.dataTransfer.files]); }}>
        {header}
        {pinned.length ? <button className="pin-bar" onClick={() => { scrollTo(pinned[pinned.length - 1].id); }}><Icon name="pin" size={16} /><span className="grow"><b>Pinned message{pinned.length > 1 ? ` (${pinned.length})` : ''}</b><span className="truncate" style={{ display: 'block' }}>{pinned[pinned.length - 1].body || pinned[pinned.length - 1].kind}</span></span></button> : null}
        <div className="thread wallpaper" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label="Messages">
          {thread?.loadingOlder ? <div className="older"><span className="spinner" /></div> : null}
          {!thread?.loaded ? <div className="thread-loading"><div className="spinner" /></div> : null}
          {thread?.loaded && !list.length ? <div className="thread-empty"><Icon name="lock" size={16} /><span>{isGroup ? 'Say hello to the group' : `No messages yet. Say hello to ${title}`}</span></div> : null}
          {thread?.loaded && !thread.hasMore && list.length ? <div className="enc-note"><Icon name="shield" size={14} />Messages are protected in transit (TLS) and stored with access controls. End-to-end encryption is not enabled yet.</div> : null}
          {rows.map((r) => r.type === 'day' ? <div className="day-sep" key={r.key}><span>{r.label}</span></div>
            : r.type === 'unread' ? <div className="unread-sep" key={r.key}><span>{r.label}</span></div>
            : <Bubble key={r.key} m={r.m!} mine={r.m!.senderId === me.id} showSender={isGroup && conv.kind !== 'channel' && !!r.first && r.m!.senderId !== me.id} senderName={memberOf(r.m!.senderId)?.displayName ?? 'Someone'} senderId={r.m!.senderId ?? undefined}
                senderAvatar={memberOf(r.m!.senderId)?.avatarMediaId} first={!!r.first} last={!!r.last} status={statusOf(r.m!)} meId={me.id} onMenu={openMenu} onReact={react} onReplyJump={jumpTo} onOpenMedia={openMedia} onRetry={retry} onSwipeReply={swipe}
                highlight={highlight === r.m!.id} nameOf={nameOf} isGroup={isGroup && conv.kind !== 'channel'} />)}
          {typingUsers.length ? <div className="typing-bubble" aria-hidden="true"><i /><i /><i /></div> : null}
        </div>
        {!atBottom ? <button className="to-bottom" onClick={() => { const el = scroller.current!; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); if (thread?.hasMore && list[list.length - 1]?.seq < conv.lastSeq) void loadMessages(id); }} aria-label="Scroll to latest">{conv.unread ? <span className="badge">{conv.unread}</span> : null}<Icon name="down" size={22} /></button> : null}
        {dropping ? <div className="drop-overlay"><Icon name="download" size={38} /><b>Drop files to send</b></div> : null}
        {!canPost ? <div className="locked-bar"><Icon name="lock" size={16} />Only admins can send messages here</div>
          : blocked ? <div className="locked-bar">You blocked this contact. <button className="link" onClick={() => void guard(api.del(`/api/blocks/${conv.other!.id}`).then(() => refreshConversation(id)))}>Unblock</button> to send messages.</div>
          : conv.kind === 'direct' && !conv.other ? <div className="locked-bar">This account was deleted</div>
          : <Composer conv={conv} reply={reply} editing={editing} onClearReply={() => setReply(null)} onCancelEdit={() => setEditing(null)} onSent={() => { stick.current = true; }} files={dropFiles} clearFiles={() => setDropFiles([])} />}
      </section>
      {showInfo ? <InfoPanel conv={conv} members={members} onClose={() => { if (infoRoute) back(); else { setShowInfo(false); localStorage.setItem('wz.info', '0'); } }} embedded={layout === 'desktop' && !infoRoute} /> : null}
      {menu.node}
      {headMenu.node}
      {fwd ? <ForwardDialog msg={fwd} onClose={() => setFwd(null)} /> : null}
      {viewer ? <MediaViewer convId={id} start={viewer} onClose={() => setViewer(null)} /> : null}
      {confirmDel ? <DeleteDialog msg={confirmDel} mine={confirmDel.senderId === me.id} staff={isGroup && (conv.role === 'owner' || conv.role === 'admin')} onClose={() => setConfirmDel(null)} /> : null}
      {history ? <HistoryDialog msg={history} onClose={() => setHistory(null)} /> : null}
      {reportMsg ? <ReportDialog msg={reportMsg} onClose={() => setReportMsg(null)} /> : null}
    </div>
  );
}

function DeleteDialog({ msg, mine, staff, onClose }: { msg: Msg; mine: boolean; staff: boolean; onClose: () => void }) {
  const recent = Date.now() - +new Date(msg.createdAt) < 48 * 3600000;
  const del = async (scope: 'me' | 'all') => { await guard(api.del(`/api/messages/${msg.id}?scope=${scope}`)); onClose(); };
  return (
    <Dialog title="Delete message?" onClose={onClose} width={400}>
      <div className="stack">
        {(mine && recent) || staff ? <button className="btn btn-danger btn-block" onClick={() => del('all')}>Delete for everyone</button> : null}
        <button className="btn btn-outline btn-block" onClick={() => del('me')}>Delete for me</button>
        <button className="btn btn-ghost btn-block" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  );
}
function HistoryDialog({ msg, onClose }: { msg: Msg; onClose: () => void }) {
  const [h, setH] = useState<{ current: string; edits: Array<{ body: string; editedAt: string }> } | null>(null);
  useEffect(() => { api.get(`/api/messages/${msg.id}/edits`).then(setH).catch(() => onClose()); }, [msg.id]);  
  return <Dialog title="Edit history" onClose={onClose}>{h ? <ul className="stack">{[...h.edits.map((e) => ({ t: e.body, at: e.editedAt, cur: false })).reverse(), { t: h.current, at: msg.editedAt!, cur: true }].reverse().map((e, i) => <li key={i} className="hist"><small className="muted">{e.cur ? 'Current' : `Replaced ${clock(e.at)}`}</small><p>{e.t}</p></li>)}</ul> : <div className="spinner" />}</Dialog>;
}
function ReportDialog({ msg, onClose }: { msg: Msg; onClose: () => void }) {
  const [reason, setReason] = useState('spam'); const [details, setDetails] = useState('');
  return (
    <Dialog title="Report message" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-danger" onClick={async () => { await guard(api.post('/api/reports', { messageId: msg.id, reason, details })); toast('Report sent. Moderators will review the reported message.'); onClose(); }}>Report</button></>}>
      <p className="muted">Only this message is shared with moderators. The sender is not told.</p>
      <select className="select" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">{['spam', 'abuse', 'harassment', 'illegal', 'impersonation', 'other'].map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select>
      <textarea className="textarea" placeholder="Details (optional)" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} />
    </Dialog>
  );
}

function SearchBar({ convId, onClose, onPick }: { convId: string; onClose: () => void; onPick: (seq: number) => void }) {
  const [q, setQ] = useState(''); const [hits, setHits] = useState<Msg[]>([]); const [i, setI] = useState(0);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => api.get(`/api/search?q=${encodeURIComponent(q.trim())}&type=messages&conversationId=${convId}&limit=50`).then((r) => { setHits(r.messages); setI(0); if (r.messages[0]) onPick(r.messages[0].seq); }).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [q]);  
  const step = (d: number) => { if (!hits.length) return; const n = (i + d + hits.length) % hits.length; setI(n); onPick(hits[n].seq); };
  return (
    <header className="conv-head search-head">
      <button className="icon-btn on-head" onClick={onClose} aria-label="Close search"><Icon name="back" /></button>
      <input autoFocus className="head-search" placeholder="Search in this chat" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') step(e.shiftKey ? -1 : 1); if (e.key === 'Escape') onClose(); }} />
      <small className="muted">{q.trim().length >= 2 ? (hits.length ? `${i + 1} of ${hits.length}` : 'No results') : ''}</small>
      <button className="icon-btn on-head" onClick={() => step(-1)} aria-label="Previous"><Icon name="down" style={{ transform: 'rotate(180deg)' }} /></button>
      <button className="icon-btn on-head" onClick={() => step(1)} aria-label="Next"><Icon name="down" /></button>
    </header>
  );
}
void useMedia; void Confirm;
