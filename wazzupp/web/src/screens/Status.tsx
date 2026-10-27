import { useEffect, useRef, useState } from 'react';
import { api, uploadWithProgress } from '../lib/api.ts';
import { ago, clock, listTime } from '../lib/format.ts';
import { back, go, useLayout, useRoute } from '../lib/route.ts';
import { getState, toast, useStore } from '../lib/store.ts';
import type { StatusGroup, StatusItem } from '../lib/types.ts';
import { guard, loadConversations, loadStatus, toastError } from '../lib/actions.ts';
import { ChannelIntroSheet, NewCommunityDialog } from './Dialogs.tsx';
import { useMedia } from '../lib/mediaCache.ts';
import { Avatar, StatusAvatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Empty } from '../ui/Misc.tsx';
import { Dialog, useMenu } from '../ui/Overlay.tsx';
import { PaneFrame } from './Frame.tsx';
import { BGS, FONTS, StatusCreate } from './StatusEditor.tsx';



export function StatusStrip() {
  const feed = useStore((s) => s.statusFeed); const me = useStore((s) => s.me!); const mine = useStore((s) => s.myStatus);
  return (
    <div className="status-strip" aria-label="Status updates">
      <button onClick={() => (mine.length ? go('status/me') : go('status/new'))}><Avatar id={me.id} name={me.displayName} mediaId={me.avatarMediaId} size={58} ring={mine.length > 0} />{!mine.length ? <i className="plus-badge"><Icon name="plus" size={14} stroke={3} /></i> : null}<span>My Status</span></button>
      {feed.filter((g) => !g.muted).map((g) => <button key={g.userId} onClick={() => go(`status/${g.userId}`)}><Avatar id={g.userId} name={g.displayName} mediaId={g.avatarMediaId} size={58} ring seen={g.allViewed} /><span className="truncate">{g.displayName.split(' ')[0]}</span></button>)}
    </div>
  );
}

export function StatusList() {
  const feed = useStore((s) => s.statusFeed); const me = useStore((s) => s.me!); const mine = useStore((s) => s.myStatus); const route = useRoute(); const layout = useLayout();
  const convs = useStore((s) => s.convs);
  const [creating, setCreating] = useState<null | 'text' | 'camera' | 'media'>(null); const [captured, setCaptured] = useState<File | null>(null); const [searching, setSearching] = useState(false); const [q, setQ] = useState('');
  const [dlg, setDlg] = useState<null | 'channel' | 'channel-form' | 'privacy' | 'explore'>(null);
  const menu = useMenu();
  useEffect(() => { void loadStatus(); }, []);
  useEffect(() => { if (route.id === 'new') setCreating(route.sub === 'camera' ? 'camera' : 'media'); }, [route.id, route.sub]);
  const match = (g: StatusGroup) => !q || g.displayName.toLowerCase().includes(q.toLowerCase());
  const recent = feed.filter((g) => !g.allViewed && !g.muted && match(g)); const viewed = feed.filter((g) => g.allViewed && !g.muted && match(g)); const muted = feed.filter((g) => g.muted && match(g));
  const channels = Object.values(convs).filter((c) => c.kind === 'channel' && (!q || (c.title ?? '').toLowerCase().includes(q.toLowerCase())));
  const seenCount = (g: StatusGroup) => g.items.filter((i) => i.viewed).length;
  const Row = (g: StatusGroup) => (
    <li key={g.userId}><button className={`conv-row ${route.tab === 'status' && route.id === g.userId && layout !== 'mobile' ? 'sel' : ''}`} onClick={() => go(`status/${g.userId}`)}>
      <StatusAvatar id={g.userId} name={g.displayName} mediaId={g.avatarMediaId} size={50} total={g.items.length} viewed={seenCount(g)} />
      <span className="conv-main"><span className="conv-name truncate">{g.displayName}</span><span className="conv-prev">{listTime(g.latestAt)}</span></span></button></li>);
  const actions = (<>
    <button className="icon-btn on-dark" aria-label="Search updates" onClick={() => setSearching((v) => !v)}><Icon name="search" /></button>
    <button className="icon-btn on-dark" aria-label="More options" onClick={(e) => menu.open([
      { label: 'Create channel', icon: 'megaphone', onClick: () => setDlg('channel') },
      { label: 'Status privacy', icon: 'lock', onClick: () => go('settings/status-privacy') },
      { label: 'Starred', icon: 'star', onClick: () => go('settings/starred') },
      { label: 'Settings', icon: 'settings', onClick: () => go('settings') },
    ], e)}><Icon name="more" /></button></>);
  const fabs = layout !== 'desktop' ? (<>
    <button className="fab fab-small" onClick={() => setCreating('text')} aria-label="Write a text status"><Icon name="pen" size={22} /></button>
    <button className="fab" onClick={() => setCreating('camera')} aria-label="Add photo or video status"><span className="fab-ico"><Icon name="camera" size={26} /><i>+</i></span></button></>) : undefined;
  const close = () => { const viaRoute = route.id === 'new'; setCreating(null); if (viaRoute) { if (route.sub === 'camera') back(); else go('status'); } };
  return (
    <PaneFrame title="Updates" plain actions={actions} overlay={fabs}>
      {searching ? <div className="m-search call-search"><Icon name="search" size={18} /><input autoFocus placeholder="Search updates" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search updates" /></div> : null}
      <h2 className="section-h">Status</h2>
      <ul className="conv-list">
        <li><button className="conv-row" onClick={() => (mine.length ? go('status/me') : setCreating('media'))}>
          <span style={{ position: 'relative', display: 'inline-flex' }}><StatusAvatar id={me.id} name={me.displayName} mediaId={me.avatarMediaId} size={50} total={mine.length} viewed={mine.length} />{!mine.length ? <i className="plus-badge"><Icon name="plus" size={14} stroke={3} /></i> : null}</span>
          <span className="conv-main"><span className="conv-name">My status</span><span className="conv-prev">{mine.length ? listTime(mine[mine.length - 1].createdAt) : 'Tap to add status update'}</span></span></button></li>
      </ul>
      {recent.length ? <><h4 className="list-sub plain">Recent updates</h4><ul className="conv-list">{recent.map(Row)}</ul></> : null}
      {viewed.length ? <><h4 className="list-sub plain">Viewed updates</h4><ul className="conv-list">{viewed.map(Row)}</ul></> : null}
      {muted.length ? <><h4 className="list-sub plain">Muted updates</h4><ul className="conv-list">{muted.map(Row)}</ul></> : null}
      {!feed.length ? <p className="help pad">Updates from your contacts disappear after 24 hours.</p> : null}
      <div className="section-head-row"><h2 className="section-h">Channels</h2><button className="btn btn-soft btn-sm" onClick={() => setDlg('explore')}>Explore</button></div>
      {channels.length ? <ul className="conv-list">{channels.map((c) => <li key={c.id}><button className="conv-row" onClick={() => go(`chats/${c.id}`)}><Avatar id={c.id} name={c.title ?? 'Channel'} mediaId={c.avatarMediaId} size={50} group /><span className="conv-main"><span className="conv-name truncate">{c.title}</span><span className="conv-prev">{c.memberCount} subscribers</span></span></button></li>)}</ul>
        : <p className="help pad">Channels are one-way broadcasts from people and organisations. Explore to find some, or create your own from the menu.</p>}
      {menu.node}
      {creating ? <StatusCreate presetFile={captured} startText={creating === 'text'} onClose={() => { setCaptured(null); close(); }} /> : null}
      {dlg === 'channel' ? <ChannelIntroSheet onClose={() => setDlg(null)} onContinue={() => setDlg('channel-form')} /> : null}
      {dlg === 'channel-form' ? <NewCommunityDialog initial="channel" onClose={() => setDlg(null)} /> : null}
      {dlg === 'explore' ? <ExploreChannelsDialog onClose={() => setDlg(null)} /> : null}
    </PaneFrame>
  );
}

function ExploreChannelsDialog({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState(''); const [res, setRes] = useState<{ channels: Array<{ id: string; title: string; members: number; avatarMediaId: string | null }> } | null>(null);
  useEffect(() => { const t = setTimeout(() => api.get(`/api/communities/discover?q=${encodeURIComponent(q.trim())}`).then(setRes).catch(() => setRes({ channels: [] })), 250); return () => clearTimeout(t); }, [q]);
  return (
    <Dialog title="Explore channels" onClose={onClose}>
      <div className="m-search light"><Icon name="search" size={18} /><input autoFocus placeholder="Search channels" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search channels" /></div>
      <div className="stack-sm">{res?.channels.map((c) => (
        <div key={c.id} className="person"><Avatar id={c.id} name={c.title} mediaId={c.avatarMediaId} size={44} group /><span className="grow" style={{ textAlign: 'left' }}><b className="truncate" style={{ display: 'block' }}>{c.title}</b><small className="muted">{c.members.toLocaleString()} subscribers</small></span>
          <button className="btn btn-soft btn-sm" onClick={async () => { const r = await guard(api.post(`/api/channels/${c.id}/subscribe`)); if (r) { await loadConversations(); onClose(); go(`chats/${c.id}`); } }}>Subscribe</button></div>))}
        {res && !res.channels.length ? <p className="help">No public channels found.</p> : null}</div>
    </Dialog>
  );
}

export function StatusEmpty() { return <div className="conv-empty dark"><div className="empty"><div className="empty-art"><Icon name="dashed" size={38} stroke={1.6} /></div><h3>View status updates</h3><p>Click a contact to see their update. Updates last 24 hours.</p></div></div>; }

function StatusSong({ id, paused, title }: { id: string; paused: boolean; title?: string }) {
  const m = useMedia(id); const a = useRef<HTMLAudioElement>(null);
  useEffect(() => { const el = a.current; if (!el) return; if (paused) el.pause(); else void el.play().catch(() => {}); }, [paused, m?.url]);
  return <>{m ? <audio ref={a} src={m.url} autoPlay loop /> : null}<span className="story-song"><Icon name="music" size={14} /> {title || 'Music'}</span></>;
}

function Slide({ item, paused, onDone, onProgress }: { item: StatusItem; paused: boolean; onDone: () => void; onProgress: (p: number) => void }) {
  const m = useMedia(item.mediaId);
  const acc = useRef(0); const last = useRef(performance.now()); const raf = useRef(0); const video = useRef<HTMLVideoElement>(null); const audio = useRef<HTMLAudioElement>(null);
  const DUR = item.kind === 'text' ? Math.min(12000, 4000 + item.body.length * 40) : 5500;
  useEffect(() => {
    acc.current = 0; last.current = performance.now(); onProgress(0);
    if (item.kind === 'video' || item.kind === 'voice') return;
    const tick = (t: number) => { const dt = t - last.current; last.current = t; if (!paused && (item.kind === 'text' || m)) acc.current += dt; onProgress(Math.min(1, acc.current / DUR)); if (acc.current >= DUR) { onDone(); return; } raf.current = requestAnimationFrame(tick); };
    raf.current = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf.current);
  }, [item.id, paused, !!m]);  
  useEffect(() => { const v = video.current ?? audio.current; if (!v) return; if (paused) v.pause(); else void v.play().catch(() => {}); }, [paused]);
  if (item.kind === 'text') return <div className="slide text" style={{ background: item.background ?? BGS[0] }}><p style={{ fontFamily: FONTS[item.font ?? 0] }}>{item.body}</p></div>;
  if (item.kind === 'voice') return <div className="slide text" style={{ background: item.background ?? BGS[1] }}>{m ? <div className="voice-slide"><Icon name="mic" size={56} /><audio ref={audio} src={m.url} controls autoPlay onEnded={onDone} onTimeUpdate={(e) => onProgress(e.currentTarget.currentTime / (e.currentTarget.duration || 1))} /></div> : <div className="spinner" style={{ borderTopColor: '#fff' }} />}</div>;
  if (!m) return <div className="slide"><div className="spinner" style={{ borderTopColor: '#fff' }} /></div>;
  return <div className="slide">{item.audioMediaId ? <StatusSong id={item.audioMediaId} paused={paused} title={item.audioTitle} /> : null}{item.kind === 'image' ? <img src={m.url} alt={item.caption || 'Status'} /> : <video ref={video} src={m.url} autoPlay playsInline onEnded={onDone} onTimeUpdate={(e) => onProgress(e.currentTarget.currentTime / (e.currentTarget.duration || 1))} />}</div>;
}

export function StatusViewer({ userId }: { userId: string }) {
  const layout = useLayout();
  const feed = useStore((s) => s.statusFeed); const mineItems = useStore((s) => s.myStatus); const me = useStore((s) => s.me!);
  const isMine = userId === 'me';
  const group: StatusGroup | undefined = isMine ? { userId: me.id, username: me.username, displayName: 'My status', avatarMediaId: me.avatarMediaId, muted: false, allViewed: true, latestAt: '', items: mineItems.map((x: any) => ({ ...x, viewed: true, reaction: null })) } : feed.find((g) => g.userId === userId);
  const [i, setI] = useState(0); const [p, setP] = useState(0); const [hold, setHold] = useState(false); const [typing, setTyping] = useState(false); const [reply, setReply] = useState(''); const [viewers, setViewers] = useState(false);
  const menu = useMenu();
  useEffect(() => { setI(0); }, [userId]);
  const item = group?.items[i];
  useEffect(() => { if (item && !isMine && !item.viewed) { api.post(`/api/status/${item.id}/view`).catch(() => {}); } }, [item?.id]);  
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft') prev(); if (e.key === 'Escape') close(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); });  
  if (!group || !item) return <div className="conv-empty dark"><Empty icon="dashed" title="Status unavailable" text="This update has expired or is no longer shared with you." action={<button className="btn btn-soft" onClick={() => go('status')}>Back</button>} /></div>;
  const idx = feed.findIndex((g) => g.userId === userId);
  const close = () => { void loadStatus(); if (layout === 'mobile') back(); else go('status'); };
  const next = () => { if (i < group.items.length - 1) setI(i + 1); else if (!isMine && idx >= 0 && idx < feed.length - 1) { void loadStatus(); go(`status/${feed[idx + 1].userId}`); } else close(); };
  const prev = () => { if (i > 0) setI(i - 1); };
  const mineItem: any = isMine ? mineItems[i] : null;
  return (
    <div className="story" onPointerDown={() => setHold(true)} onPointerUp={() => setHold(false)} onPointerLeave={() => setHold(false)}>
      <Slide key={item.id} item={item} paused={hold || typing || viewers} onDone={next} onProgress={setP} />
      <div className="story-top">
        <div className="bars">{group.items.map((_, k) => <i key={k}><b style={{ width: k < i ? '100%' : k === i ? `${p * 100}%` : '0' }} /></i>)}</div>
        <div className="row" style={{ gap: 10 }}>
          <button className="icon-btn on-dark" onClick={close} aria-label="Close"><Icon name="back" /></button>
          <Avatar id={group.userId} name={group.displayName} mediaId={group.avatarMediaId} size={38} />
          <span className="grow"><b>{group.displayName}</b><small>{ago(item.createdAt)} · {clock(item.createdAt)}</small></span>
          <button className="icon-btn on-dark" aria-label="More" onClick={(e) => menu.open(isMine ? [{ label: 'Delete update', icon: 'trash', danger: true, onClick: async () => { await guard(api.del(`/api/status/${item.id}`)); await loadStatus(); if (group.items.length <= 1) close(); else setI(0); } }] : [{ label: group.muted ? 'Unmute' : 'Mute updates', icon: 'bell-off', onClick: async () => { await guard(api.put(`/api/status/mute/${group.userId}`, { muted: !group.muted })); await loadStatus(); } }, { label: 'Report', icon: 'flag', onClick: async () => { await guard(api.post('/api/reports', { userId: group.userId, reason: 'abuse' })); toast('Report sent'); } }], e)}><Icon name="more" /></button>
        </div>
      </div>
      <button className="story-nav l" onClick={prev} aria-label="Previous update" /><button className="story-nav r" onClick={next} aria-label="Next update" />
      {item.kind !== 'text' && item.kind !== 'voice' && item.caption ? <p className="story-cap">{item.caption}</p> : null}
      <div className="story-foot" onPointerDown={(e) => e.stopPropagation()}>
        {isMine ? <button className="viewed-by" onClick={() => setViewers(true)}><Icon name="eye" size={18} />{mineItem?.viewers?.length ?? 0} {(mineItem?.viewers?.length ?? 0) === 1 ? 'view' : 'views'}</button>
          : <form className="story-reply" onSubmit={async (e) => { e.preventDefault(); if (!reply.trim()) return; const r = await guard(api.post(`/api/status/${item.id}/reply`, { body: reply.trim() })); if (r) { setReply(''); toast('Reply sent', undefined, { label: 'Open chat', run: () => go(`chats/${r.conversationId}`) }); } }}>
            <input placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} onFocus={() => setTyping(true)} onBlur={() => setTyping(false)} aria-label="Reply to status" />
            {['❤️', '😂', '😮', '😢', '🙏', '👍'].map((em) => <button type="button" key={em} className={item.reaction === em ? 'on' : ''} aria-label={`React ${em}`}
              onClick={async () => { // like the phone apps: the emoji goes straight to their chat, on top of a card showing the status, and is also recorded as a reaction
                const r = await guard(api.post(`/api/status/${item.id}/reply`, { body: em })); if (!r) return;
                await api.post(`/api/status/${item.id}/react`, { emoji: em }).catch(() => {}); void loadStatus();
                toast(`Sent ${em}`, undefined, { label: 'Open chat', run: () => go(`chats/${r.conversationId}`) });
              }}>{em}</button>)}</form>}
      </div>
      {viewers ? <Dialog title={`Viewed by ${mineItem?.viewers?.length ?? 0}`} onClose={() => setViewers(false)}>
        {(mineItem?.viewers ?? []).length ? <ul className="stack-sm">{mineItem.viewers.map((v: any) => <li key={v.userId} className="row"><Avatar id={v.userId} name={v.displayName} size={40} /><span className="grow"><b>{v.displayName}</b><small className="muted" style={{ display: 'block' }}>{new Date(v.viewedAt).getTime() > 1000 ? ago(v.viewedAt) : 'Viewed'}</small></span>{v.reaction ? <span style={{ fontSize: 22 }}>{v.reaction}</span> : null}</li>)}</ul> : <p className="muted">No views yet.</p>}
      </Dialog> : null}
      {menu.node}
    </div>
  );
}

