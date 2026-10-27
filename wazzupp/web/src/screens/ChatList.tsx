import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { useStore } from '../lib/store.ts';
import type { Conv, Msg } from '../lib/types.ts';
import { convTitle, listTime, preview } from '../lib/format.ts';
import { go, useLayout, useRoute } from '../lib/route.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Empty, ListSkeleton } from '../ui/Misc.tsx';
import { useMenu, type MenuItem } from '../ui/Overlay.tsx';
import { PaneFrame } from './Frame.tsx';
import { patchState, guard, markAllRead } from '../lib/actions.ts';
import { Ticks } from './Bubble.tsx';
import { NewChatDialog, NewGroupDialog, NewCommunityDialog, BroadcastDialog } from './Dialogs.tsx';
import { StatusStrip } from './Status.tsx';

function lastPreview(c: Conv, meId: string, nameOf: (id: string) => string) {
  const m = c.lastMessage;
  if (c.draft) return { draft: true, text: c.draft, icon: undefined as string | undefined };
  if (!m) return { text: c.kind === 'direct' ? 'Say hello 👋' : 'No messages yet', icon: undefined as string | undefined };
  const p = preview(m);
  const prefix = c.kind !== 'direct' && m.kind !== 'system' && m.senderId ? (m.senderId === meId ? 'You: ' : `${nameOf(m.senderId)}: `) : '';
  return { text: `${prefix}${p.text}`, icon: p.icon, draft: false };
}

export function ConvRow({ c, selected, onOpen, onMenu, query }: { c: Conv; selected: boolean; onOpen: () => void; onMenu: (e: React.MouseEvent | { clientX: number; clientY: number }, c: Conv) => void; query?: string }) {
  const meId = useStore((s) => s.me!.id);
  const members = useStore((s) => s.members[c.id]);
  const online = useStore((s) => (c.other ? !!s.online[c.other.id] : false));
  const typing = useStore((s) => Object.entries(s.typing[c.id] ?? {}).some(([u, exp]) => u !== meId && exp > Date.now()));
  const status = useStore((s) => s.wm[c.id]);
  const nameOf = (id: string) => members?.find((m) => m.id === id)?.displayName.split(' ')[0] ?? c.lastMessage?.senderName?.split(' ')[0] ?? 'Someone';
  const p = lastPreview(c, meId, nameOf);
  const title = convTitle(c);
  const lm = c.lastMessage;
  const mine = lm && lm.senderId === meId && lm.kind !== 'system';
  const st = mine ? (lm!.status === 'sending' || lm!.status === 'queued' || lm!.status === 'failed' ? lm!.status : status && lm!.seq <= status.read ? 'read' : status && lm!.seq <= status.delivered ? 'delivered' : 'sent') : null;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hasUnread = c.unread > 0 || c.markedUnread;
  const hl = (t: string) => {
    if (!query) return t; const i = t.toLowerCase().indexOf(query.toLowerCase()); if (i < 0) return t;
    return <>{t.slice(0, i)}<mark>{t.slice(i, i + query.length)}</mark>{t.slice(i + query.length)}</>;
  };
  return (
    <li>
      <button className={`conv-row ${selected ? 'sel' : ''}`} onClick={onOpen} onContextMenu={(e) => { e.preventDefault(); onMenu(e, c); }}
        onTouchStart={(e) => { const t = e.touches[0]; timer.current = setTimeout(() => onMenu({ clientX: t.clientX, clientY: t.clientY }, c), 520); }} onTouchEnd={() => clearTimeout(timer.current)} onTouchMove={() => clearTimeout(timer.current)}>
        <Avatar id={c.other?.id ?? c.id} name={title} mediaId={c.kind === 'direct' ? c.other?.avatarMediaId : c.avatarMediaId} size={52} group={c.kind !== 'direct'} online={online} />
        <span className="conv-main">
          <span className="conv-line">
            <span className={`conv-name truncate ${hasUnread ? 'strong' : ''}`}>{hl(title)}{c.kind === 'channel' ? <Icon name="megaphone" size={14} className="inl" /> : null}</span>
            <span className={`conv-time ${hasUnread ? 'unread' : ''}`}>{listTime(c.lastMessageAt)}</span>
          </span>
          <span className="conv-line">
            <span className="conv-prev truncate">
              {typing ? <span className="typing-txt">typing…</span> : <>
                {p.draft ? <span className="draft">Draft: </span> : st ? <Ticks status={st as any} size={16} /> : null}
                {!p.draft && p.icon ? <Icon name={p.icon as any} size={15} className="inl" /> : null}
                <span>{p.text}</span></>}
            </span>
            <span className="conv-badges">
              {c.muted ? <Icon name="bell-off" size={15} className="muted" /> : null}
              {c.pinned ? <Icon name="pin" size={15} className="muted" /> : null}
              {c.unreadMentions > 0 ? <span className="badge" aria-label="mention">@</span> : null}
              {c.unread > 0 ? <span className={`badge ${c.muted ? 'muted' : ''}`} aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span> : c.markedUnread ? <span className="dot" aria-label="marked unread" /> : null}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

export function ConvContextMenu() {
  const m = useMenu();
  const folders = useStore((s) => s.folders);
  const open = (e: any, c: Conv) => {
    const items: MenuItem[] = [
      { label: c.pinned ? 'Unpin chat' : 'Pin chat', icon: c.pinned ? 'unpin' : 'pin', onClick: () => guard(patchState(c.id, { pinned: !c.pinned })) },
      { label: c.muted ? 'Unmute notifications' : 'Mute notifications', icon: c.muted ? 'bell' : 'bell-off', onClick: () => guard(patchState(c.id, { mutedUntil: c.muted ? null : 'forever' })) },
      { label: c.archived ? 'Unarchive' : 'Archive', icon: 'archive', onClick: () => guard(patchState(c.id, { archived: !c.archived })) },
      { label: c.markedUnread || c.unread ? 'Mark as read' : 'Mark as unread', icon: 'eye', onClick: () => guard(patchState(c.id, { markedUnread: !(c.markedUnread || c.unread > 0) })) },
      { label: c.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star', onClick: () => guard(patchState(c.id, { favorite: !c.favorite })) },
      ...folders.map((f): MenuItem => ({ label: c.folder === f.name ? `Remove from ${f.name}` : `Move to ${f.name}`, icon: 'folder', onClick: () => guard(patchState(c.id, { folder: c.folder === f.name ? null : f.name })) })),
    ];
    m.open(items, e);
  };
  return { open, node: m.node };
}

type Filter = 'all' | 'unread' | 'favorites' | 'groups' | `f:${string}`;

export function ChatList() {
  const route = useRoute(); const layout = useLayout();
  const order = useStore((s) => s.convOrder);
  const convs = useStore((s) => s.convs);
  const loaded = useStore((s) => s.booted && (order.length > 0 || Object.keys(s.convs).length > 0 || s.conn === 'online'));
  const folders = useStore((s) => s.folders);
  const me = useStore((s) => s.me!);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dlg, setDlg] = useState<null | 'chat' | 'group' | 'community' | 'broadcast'>(null);
  const [hits, setHits] = useState<Msg[] | null>(null);
  const ctx = ConvContextMenu();
  const menu = useMenu();
  useEffect(() => { const h = () => setShowArchived((v) => !v); window.addEventListener('wz-archived', h); return () => window.removeEventListener('wz-archived', h); }, []);
  const archivedCount = order.filter((id) => convs[id]?.archived).length;

  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return; }
    const t = setTimeout(() => api.get(`/api/search?q=${encodeURIComponent(q.trim())}&type=messages&limit=20`).then((r) => setHits(r.messages)).catch(() => setHits([])), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return order.map((id) => convs[id]).filter(Boolean).filter((c) => {
      if (term) return convTitle(c).toLowerCase().includes(term);
      if (showArchived) return c.archived;
      if (c.archived) return false;
      if (filter === 'unread') return c.unread > 0 || c.markedUnread;
      if (filter === 'favorites') return c.favorite;
      if (filter === 'groups') return c.kind !== 'direct';
      if (filter.startsWith('f:')) return c.folder === filter.slice(2);
      return true;
    });
  }, [order, convs, q, filter, showArchived]);

  const open = (id: string) => go(`chats/${id}`);
  const search = (
    <div className={layout === 'desktop' ? 'rail-search' : 'm-search'}>
      <Icon name="search" size={18} /><input autoFocus={layout === 'mobile'} aria-label="Search chats" placeholder={layout === 'desktop' ? 'Search or start new chat' : 'Search'} value={q} onChange={(e) => setQ(e.target.value)} />
      {q ? <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear search"><Icon name="x" size={16} /></button> : null}
    </div>
  );
  const actions = (<>
    {layout === 'desktop' ? <button className="icon-btn on-dark" onClick={() => setDlg('chat')} aria-label="New chat" title="New chat"><Icon name="chat-plus" /></button> : null}
    {layout === 'mobile' ? <button className="icon-btn on-dark" onClick={() => setSearchOpen((v) => !v)} aria-label="Search"><Icon name="search" /></button> : null}
    {layout !== 'desktop' ? <button className="icon-btn on-dark" onClick={() => go('status/new/camera')} aria-label="Camera" title="Camera: post a photo or video status"><Icon name="camera" /></button> : null}
    <button className="icon-btn on-dark" aria-label="More options" onClick={(e) => menu.open([
      { label: 'New group', icon: 'users', onClick: () => setDlg('group') },
      { label: 'Broadcast lists', icon: 'megaphone', onClick: () => setDlg('broadcast') },
      { label: 'Linked devices', icon: 'laptop', onClick: () => go('settings/devices') },
      { label: 'Starred', icon: 'star', onClick: () => go('settings/starred') },
      { label: 'Read all', icon: 'check-check', onClick: () => void markAllRead() },
      { label: 'Settings', icon: 'settings', onClick: () => go('settings') },
    ], e)}><Icon name="more" /></button>
    {layout === 'tablet' ? null : null}
  </>);
  const filters = (<>
    {(['all', 'unread', 'favorites', 'groups'] as const).map((f) => <button key={f} className="chip" aria-pressed={filter === f && !showArchived} onClick={() => { setFilter(f); setShowArchived(false); }}>{f[0].toUpperCase() + f.slice(1)}</button>)}
    {folders.map((f) => <button key={f.id} className="chip" aria-pressed={filter === `f:${f.name}`} onClick={() => { setFilter(`f:${f.name}`); setShowArchived(false); }}><Icon name="folder" size={14} />{f.name}</button>)}
  </>);

  const body = !loaded ? <ListSkeleton /> : (
    <>
      {archivedCount > 0 && !showArchived && !q && filter === 'all' ? <button className="archived-row" onClick={() => setShowArchived(true)}><Icon name="archive" size={20} /><span>Archived</span><span className="muted">{archivedCount}</span></button> : null}
      {showArchived ? <button className="archived-row" onClick={() => setShowArchived(false)}><Icon name="back" size={20} /><span>Archived chats</span></button> : null}
      {list.length ? <ul className="conv-list">{list.map((c) => <ConvRow key={c.id} c={c} selected={route.tab === 'chats' && route.id === c.id} onOpen={() => open(c.id)} onMenu={ctx.open} query={q.trim()} />)}</ul>
        : <Empty icon="chat" title={q ? 'No chats found' : filter !== 'all' ? 'Nothing here yet' : 'No conversations yet'} text={q ? 'Try another name.' : filter !== 'all' ? 'Chats matching this filter will appear here.' : 'Start a chat with a friend, or create a group.'} action={!q && filter === 'all' ? <button className="btn btn-primary" onClick={() => setDlg('chat')}><Icon name="chat-plus" size={18} />New chat</button> : undefined} />}
      {hits && hits.length ? <><h4 className="list-sub">Messages</h4><ul className="conv-list">{hits.map((m) => {
        const c = convs[m.conversationId]; if (!c) return null;
        return <li key={m.id}><button className="conv-row" onClick={() => go(`chats/${c.id}/m/${m.seq}`)}><Avatar id={c.other?.id ?? c.id} name={convTitle(c)} mediaId={c.kind === 'direct' ? c.other?.avatarMediaId : c.avatarMediaId} size={44} group={c.kind !== 'direct'} /><span className="conv-main"><span className="conv-line"><span className="conv-name truncate">{convTitle(c)}</span><span className="conv-time">{listTime(m.createdAt)}</span></span><span className="conv-prev truncate">{m.senderId === me.id ? 'You: ' : ''}{m.body}</span></span></button></li>;
      })}</ul></> : null}
    </>
  );
  return (
    <>
      <PaneFrame title="Wazzupp" search={layout === 'mobile' && !searchOpen && !q ? undefined : search} actions={actions} filters={filters} strip={layout === 'mobile' && !q ? <StatusStrip /> : undefined}>{body}</PaneFrame>
      {layout !== 'desktop' ? <button className="fab" onClick={() => setDlg('chat')} aria-label="New chat"><Icon name="chat-plus" size={24} /></button> : null}
      {ctx.node}{menu.node}
      {dlg === 'chat' ? <NewChatDialog onClose={() => setDlg(null)} onGroup={() => setDlg('group')} onCommunity={() => setDlg('community')} /> : null}
      {dlg === 'group' ? <NewGroupDialog onClose={() => setDlg(null)} /> : null}
      {dlg === 'community' ? <NewCommunityDialog onClose={() => setDlg(null)} /> : null}
      {dlg === 'broadcast' ? <BroadcastDialog onClose={() => setDlg(null)} /> : null}
    </>
  );
}
