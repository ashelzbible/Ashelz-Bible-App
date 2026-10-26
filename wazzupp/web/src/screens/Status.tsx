import { useEffect, useRef, useState } from 'react';
import { api, uploadWithProgress } from '../lib/api.ts';
import { ago, clock } from '../lib/format.ts';
import { back, go, useLayout, useRoute } from '../lib/route.ts';
import { getState, toast, useStore } from '../lib/store.ts';
import type { StatusGroup, StatusItem } from '../lib/types.ts';
import { guard, loadStatus, toastError } from '../lib/actions.ts';
import { useMedia } from '../lib/mediaCache.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Empty } from '../ui/Misc.tsx';
import { Dialog, useMenu } from '../ui/Overlay.tsx';
import { PaneFrame } from './Frame.tsx';

const BGS = ['#003B32', '#0B6E5C', '#1B5E8A', '#6A3A8C', '#B34A2E', '#8C6A1B', '#2E2E2E'];

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
  const [creating, setCreating] = useState(false);
  useEffect(() => { void loadStatus(); }, []);
  useEffect(() => { if (route.id === 'new') setCreating(true); }, [route.id]);
  const recent = feed.filter((g) => !g.allViewed && !g.muted); const viewed = feed.filter((g) => g.allViewed && !g.muted); const muted = feed.filter((g) => g.muted);
  const Row = (g: StatusGroup) => (
    <li key={g.userId}><button className={`conv-row ${route.tab === 'status' && route.id === g.userId && layout !== 'mobile' ? 'sel' : ''}`} onClick={() => go(`status/${g.userId}`)}>
      <Avatar id={g.userId} name={g.displayName} mediaId={g.avatarMediaId} size={50} ring seen={g.allViewed} />
      <span className="conv-main"><span className="conv-name truncate">{g.displayName}</span><span className="conv-prev">{ago(g.latestAt)}</span></span></button></li>);
  return (
    <PaneFrame title="Status" actions={<button className="icon-btn on-dark" onClick={() => setCreating(true)} aria-label="Add status"><Icon name="plus" /></button>}>
      <ul className="conv-list">
        <li><button className="conv-row" onClick={() => (mine.length ? go('status/me') : setCreating(true))}>
          <span style={{ position: 'relative' }}><Avatar id={me.id} name={me.displayName} mediaId={me.avatarMediaId} size={52} ring={mine.length > 0} />{!mine.length ? <i className="plus-badge"><Icon name="plus" size={14} stroke={3} /></i> : null}</span>
          <span className="conv-main"><span className="conv-name">My status</span><span className="conv-prev">{mine.length ? `${mine.length} update${mine.length > 1 ? 's' : ''} · ${ago(mine[mine.length - 1].createdAt)}` : 'Tap to add status update'}</span></span></button></li>
      </ul>
      {recent.length ? <><h4 className="list-sub">Recent updates</h4><ul className="conv-list">{recent.map(Row)}</ul></> : null}
      {viewed.length ? <><h4 className="list-sub">Viewed updates</h4><ul className="conv-list">{viewed.map(Row)}</ul></> : null}
      {muted.length ? <><h4 className="list-sub">Muted updates</h4><ul className="conv-list">{muted.map(Row)}</ul></> : null}
      {!feed.length ? <Empty icon="dashed" title="No updates yet" text="Status updates from your contacts disappear after 24 hours." /> : null}
      {creating ? <StatusCreate onClose={() => { setCreating(false); if (route.id === 'new') go('status'); }} /> : null}
    </PaneFrame>
  );
}

export function StatusEmpty() { return <div className="conv-empty dark"><div className="empty"><div className="empty-art"><Icon name="dashed" size={38} stroke={1.6} /></div><h3>View status updates</h3><p>Click a contact to see their update. Updates last 24 hours.</p></div></div>; }

function Slide({ item, paused, onDone, onProgress }: { item: StatusItem; paused: boolean; onDone: () => void; onProgress: (p: number) => void }) {
  const m = useMedia(item.mediaId);
  const acc = useRef(0); const last = useRef(performance.now()); const raf = useRef(0); const video = useRef<HTMLVideoElement>(null);
  const DUR = item.kind === 'text' ? Math.min(12000, 4000 + item.body.length * 40) : 5500;
  useEffect(() => {
    acc.current = 0; last.current = performance.now(); onProgress(0);
    if (item.kind === 'video') return;
    const tick = (t: number) => { const dt = t - last.current; last.current = t; if (!paused && (item.kind === 'text' || m)) acc.current += dt; onProgress(Math.min(1, acc.current / DUR)); if (acc.current >= DUR) { onDone(); return; } raf.current = requestAnimationFrame(tick); };
    raf.current = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf.current);
  }, [item.id, paused, !!m]); // eslint-disable-line
  useEffect(() => { const v = video.current; if (!v) return; if (paused) v.pause(); else void v.play().catch(() => {}); }, [paused]);
  if (item.kind === 'text') return <div className="slide text" style={{ background: item.background ?? BGS[0] }}><p>{item.body}</p></div>;
  if (!m) return <div className="slide"><div className="spinner" style={{ borderTopColor: '#fff' }} /></div>;
  return <div className="slide">{item.kind === 'image' ? <img src={m.url} alt={item.caption || 'Status'} /> : <video ref={video} src={m.url} autoPlay playsInline onEnded={onDone} onTimeUpdate={(e) => onProgress(e.currentTarget.currentTime / (e.currentTarget.duration || 1))} />}</div>;
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
  useEffect(() => { if (item && !isMine && !item.viewed) { api.post(`/api/status/${item.id}/view`).catch(() => {}); } }, [item?.id]); // eslint-disable-line
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft') prev(); if (e.key === 'Escape') close(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }); // eslint-disable-line
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
      {item.kind !== 'text' && item.caption ? <p className="story-cap">{item.caption}</p> : null}
      <div className="story-foot" onPointerDown={(e) => e.stopPropagation()}>
        {isMine ? <button className="viewed-by" onClick={() => setViewers(true)}><Icon name="eye" size={18} />{mineItem?.viewers?.length ?? 0} {(mineItem?.viewers?.length ?? 0) === 1 ? 'view' : 'views'}</button>
          : <form className="story-reply" onSubmit={async (e) => { e.preventDefault(); if (!reply.trim()) return; const r = await guard(api.post(`/api/status/${item.id}/reply`, { body: reply.trim() })); if (r) { setReply(''); toast('Reply sent'); } }}>
            <input placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} onFocus={() => setTyping(true)} onBlur={() => setTyping(false)} aria-label="Reply to status" />
            {['❤️', '😂', '🔥', '👏'].map((em) => <button type="button" key={em} className={item.reaction === em ? 'on' : ''} onClick={async () => { await guard(api.post(`/api/status/${item.id}/react`, { emoji: em })); void loadStatus(); }} aria-label={`React ${em}`}>{em}</button>)}</form>}
      </div>
      {viewers ? <Dialog title={`Viewed by ${mineItem?.viewers?.length ?? 0}`} onClose={() => setViewers(false)}>
        {(mineItem?.viewers ?? []).length ? <ul className="stack-sm">{mineItem.viewers.map((v: any) => <li key={v.userId} className="row"><Avatar id={v.userId} name={v.displayName} size={40} /><span className="grow"><b>{v.displayName}</b><small className="muted" style={{ display: 'block' }}>{new Date(v.viewedAt).getTime() > 1000 ? ago(v.viewedAt) : 'Viewed'}</small></span>{v.reaction ? <span style={{ fontSize: 22 }}>{v.reaction}</span> : null}</li>)}</ul> : <p className="muted">No views yet.</p>}
      </Dialog> : null}
      {menu.node}
    </div>
  );
}

export function StatusCreate({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'text' | 'media'>('text'); const [text, setText] = useState(''); const [bg, setBg] = useState(BGS[0]); const [file, setFile] = useState<File | null>(null); const [caption, setCaption] = useState('');
  const [progress, setProgress] = useState(0); const [busy, setBusy] = useState(false); const [aud, setAud] = useState<'contacts' | 'except' | 'only'>(getState().me!.settings.privacy.statusAudience as any); const [picked, setPicked] = useState<Set<string>>(new Set());
  const contacts = useStore((s) => s.contacts); const fileRef = useRef<HTMLInputElement>(null); const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => { if (!file) { setPreview(null); return; } const u = URL.createObjectURL(file); setPreview(u); return () => URL.revokeObjectURL(u); }, [file]);
  async function post() {
    setBusy(true);
    try {
      let body: any = { kind: 'text', body: text.trim(), background: bg, audience: aud, audienceIds: [...picked] };
      if (mode === 'media' && file) {
        const kind = file.type.startsWith('video/') ? 'video' : 'image';
        const up = uploadWithProgress(file, file.name, kind, {}, setProgress);
        const r = await up.promise;
        body = { kind, mediaId: r.media.id, caption: caption.trim(), audience: aud, audienceIds: [...picked] };
      }
      await api.post('/api/status', body); await loadStatus(); toast('Status posted'); onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  }
  const ok = mode === 'text' ? text.trim().length > 0 : !!file;
  return (
    <Dialog title="New status" onClose={onClose} width={480} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!ok || busy} onClick={post}>{busy ? (progress > 0 && progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Posting…') : 'Post'}</button></>}>
      <div className="seg"><button className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>Text</button><button className={mode === 'media' ? 'on' : ''} onClick={() => { setMode('media'); if (!file) fileRef.current?.click(); }}>Photo / video</button></div>
      {mode === 'text' ? <>
        <div className="status-compose" style={{ background: bg }}><textarea autoFocus maxLength={700} placeholder="Type a status" value={text} onChange={(e) => setText(e.target.value)} aria-label="Status text" /></div>
        <div className="swatches">{BGS.map((c) => <button key={c} style={{ background: c }} className={bg === c ? 'on' : ''} onClick={() => setBg(c)} aria-label={`Background ${c}`} />)}</div>
      </> : <>
        <div className="status-compose media" onClick={() => fileRef.current?.click()}>{preview ? (file!.type.startsWith('video/') ? <video src={preview} muted playsInline /> : <img src={preview} alt="Selected" />) : <span className="muted"><Icon name="image" size={30} /><br />Choose a photo or video</span>}</div>
        <input className="input" placeholder="Add a caption" maxLength={700} value={caption} onChange={(e) => setCaption(e.target.value)} />
        <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      </>}
      <div className="field"><span className="label-t">Who can see this</span>
        <select aria-label="Who can see this" className="select" value={aud} onChange={(e) => setAud(e.target.value as any)}><option value="contacts">My contacts</option><option value="except">My contacts except…</option><option value="only">Only share with…</option></select></div>
      {aud !== 'contacts' ? <div className="stack-sm" style={{ maxHeight: 160, overflow: 'auto' }}>{contacts.map((c) => <label key={c.id} className="check-row"><input type="checkbox" checked={picked.has(c.id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />{c.displayName}</label>)}{!contacts.length ? <p className="help">Add contacts to choose an audience.</p> : null}</div> : null}
      <p className="help">Updates disappear after 24 hours.</p>
    </Dialog>
  );
}
