import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { bytes, convTitle, lastSeenLabel } from '../lib/format.ts';
import { go, useLayout } from '../lib/route.ts';
import { useMedia } from '../lib/mediaCache.ts';
import { getState, setState, toast, useStore } from '../lib/store.ts';
import type { Conv, Member, Msg } from '../lib/types.ts';
import { guard, loadContacts, loadConversations, patchState, refreshConversation } from '../lib/actions.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Confirm, Dialog, useMenu } from '../ui/Overlay.tsx';
import { Row, Section, Toggle } from '../ui/Misc.tsx';
import { MediaImage } from './Bubble.tsx';
import { MediaViewer } from './Viewer.tsx';

const DISAPPEAR: Array<[string, number | null]> = [['24 hours', 86400], ['7 days', 604800], ['90 days', 7776000], ['Off', null]];

export function InfoPanel({ conv, members, onClose, embedded }: { conv: Conv; members?: Member[]; onClose: () => void; embedded: boolean }) {
  const layout = useLayout();
  const me = useStore((s) => s.me!);
  const online = useStore((s) => (conv.other ? !!s.online[conv.other.id] : false));
  const contacts = useStore((s) => s.contacts);
  const [gallery, setGallery] = useState<null | 'media' | 'docs' | 'links'>(null);
  const [thumbs, setThumbs] = useState<Array<{ messageId: string; media: any }>>([]);
  const [counts, setCounts] = useState({ media: 0, starred: 0 });
  const [dlg, setDlg] = useState<null | 'disappear' | 'invite' | 'add' | 'leave' | 'block' | 'edit'>(null);
  const menu = useMenu();
  const isGroup = conv.kind !== 'direct';
  const staff = conv.role === 'owner' || conv.role === 'admin';
  const title = convTitle(conv);
  const isContact = !!conv.other && contacts.some((c) => c.id === conv.other!.id);

  useEffect(() => {
    let alive = true;
    api.get(`/api/media?conversationId=${conv.id}&kind=image&limit=100`).then((r) => { if (alive) { setThumbs(r.items.slice(0, 5)); setCounts((c) => ({ ...c, media: r.items.length })); } }).catch(() => {});
    api.get('/api/starred').then((r) => { if (alive) setCounts((c) => ({ ...c, starred: r.messages.filter((m: Msg) => m.conversationId === conv.id).length })); }).catch(() => {});
    return () => { alive = false; };
  }, [conv.id, conv.lastSeq]);

  if (gallery) return <Gallery convId={conv.id} tab={gallery} setTab={setGallery} onBack={() => setGallery(null)} embedded={embedded} />;

  const sub = isGroup ? (conv.kind === 'channel' ? `Channel · ${conv.memberCount} subscribers` : `Group · ${conv.memberCount} members`) : online ? 'online' : conv.other?.lastSeenAt ? lastSeenLabel(conv.other.lastSeenAt) : '';
  return (
    <aside className={`info ${embedded ? 'embedded' : 'full'}`} aria-label="Conversation info">
      {!embedded ? <header className="info-bar"><button className="icon-btn on-head" onClick={onClose} aria-label="Back"><Icon name="back" /></button><b>{isGroup ? 'Group info' : 'Contact info'}</b></header> : <button className="icon-btn info-x" onClick={onClose} aria-label="Close info"><Icon name="x" /></button>}
      <div className="info-scroll">
        <div className="info-hero">
          <Avatar id={conv.other?.id ?? conv.id} name={title} mediaId={isGroup ? conv.avatarMediaId : conv.other?.avatarMediaId} size={layout === 'desktop' ? 124 : 112} group={isGroup} />
          <h2>{title}</h2><span className={`muted ${online ? 'online-txt' : ''}`}>{sub}</span>
          {conv.other?.statusText ? <p className="about">{conv.other.statusText}</p> : null}
          {isGroup && conv.description ? <p className="about">{conv.description}</p> : null}
          {!isGroup && conv.other ? <div className="info-actions">
            <button onClick={() => import('../lib/rtc.ts').then((r) => r.startCall(conv.id, 'audio'))}><Icon name="phone" /><span>Audio</span></button>
            <button onClick={() => import('../lib/rtc.ts').then((r) => r.startCall(conv.id, 'video'))}><Icon name="video" /><span>Video</span></button>
            <button onClick={() => (embedded ? document.querySelector<HTMLButtonElement>('[aria-label="Search in chat"]')?.click() : go(`chats/${conv.id}`))}><Icon name="search" /><span>Search</span></button>
          </div> : null}
        </div>

        <div className="info-card">
          <button className="info-row" onClick={() => setGallery('media')}><Icon name="image" size={20} /><span className="grow">Media, links and docs</span><span className="muted">{counts.media}</span><Icon name="right" size={16} className="muted" /></button>
          {thumbs.length ? <div className="thumbs">{thumbs.map((t) => <Thumb key={t.messageId} id={t.media.id} onClick={() => setGallery('media')} />)}</div> : null}
        </div>
        <div className="info-card">
          <button className="info-row" onClick={() => go('settings/starred')}><Icon name="star" size={20} /><span className="grow">Starred messages</span><span className="muted">{counts.starred}</span><Icon name="right" size={16} className="muted" /></button>
          <div className="info-row"><Icon name="bell" size={20} /><span className="grow">Mute notifications</span><Toggle checked={conv.muted} label="Mute notifications" onChange={(v) => guard(patchState(conv.id, { mutedUntil: v ? 'forever' : null }))} /></div>
          <button className="info-row" onClick={() => setDlg('disappear')}><Icon name="clock" size={20} /><span className="grow">Disappearing messages</span><span className="muted">{conv.disappearingSeconds ? DISAPPEAR.find((d) => d[1] === conv.disappearingSeconds)?.[0] ?? 'On' : 'Off'}</span><Icon name="right" size={16} className="muted" /></button>
          {!isGroup ? <div className="info-row"><Icon name="star" size={20} /><span className="grow">Favourite</span><Toggle checked={conv.favorite} label="Favourite" onChange={(v) => guard(patchState(conv.id, { favorite: v }))} /></div> : null}
        </div>
        <div className="info-card">
          <div className="info-row top"><Icon name="lock" size={20} /><span className="grow"><b>Privacy and security</b><small className="muted" style={{ display: 'block', lineHeight: 1.4 }}>Messages are encrypted in transit (TLS) and protected by server-side access control. End-to-end encryption is not enabled yet, so Wazzupp&apos;s servers can technically read message content.</small></span></div>
        </div>

        {isGroup ? <div className="info-card">
          <div className="info-head"><b>{conv.kind === 'channel' ? 'Subscribers' : 'Members'} ({conv.memberCount})</b></div>
          {(staff || conv.membersCanInvite) ? <>
            <button className="info-row" onClick={() => setDlg('add')}><span className="action-ico sm"><Icon name="user-plus" size={18} /></span><span className="grow">Add {conv.kind === 'channel' ? 'subscribers' : 'members'}</span></button>
            <button className="info-row" onClick={() => setDlg('invite')}><span className="action-ico sm"><Icon name="link" size={18} /></span><span className="grow">Invite via link</span></button></> : null}
          {(members ?? []).slice(0, 50).map((m) => (
            <button key={m.id} className="info-row person-row" onClick={(e) => m.id === me.id ? undefined : menu.open([
              { label: 'Message', icon: 'chat', onClick: async () => { const { openDirect } = await import('../lib/actions.ts'); const id = await guard(openDirect(m.id)); if (id) go(`chats/${id}`); } },
              { label: m.role === 'admin' ? 'Dismiss as admin' : 'Make admin', icon: 'shield', hidden: !(conv.role === 'owner') || m.role === 'owner', onClick: () => guard(api.patch(`/api/conversations/${conv.id}/members/${m.id}`, { role: m.role === 'admin' ? 'member' : 'admin' }).then(() => { setState((s) => ({ members: { ...s.members, [conv.id]: undefined as any } })); })) },
              { label: 'Remove from group', icon: 'x', danger: true, hidden: !staff || m.role === 'owner' || (m.role === 'admin' && conv.role !== 'owner'), onClick: () => guard(api.del(`/api/conversations/${conv.id}/members/${m.id}`).then(() => { setState((s) => ({ members: { ...s.members, [conv.id]: undefined as any } })); refreshConversation(conv.id); })) },
            ], e)}>
              <Avatar id={m.id} name={m.displayName} mediaId={m.avatarMediaId} size={40} /><span className="grow" style={{ textAlign: 'left' }}><b className="truncate" style={{ display: 'block' }}>{m.id === me.id ? 'You' : m.displayName}</b><small className="muted truncate" style={{ display: 'block' }}>{m.statusText}</small></span>
              {m.role !== 'member' && m.role !== 'subscriber' ? <span className="role-tag">{m.role === 'owner' ? 'Owner' : 'Admin'}</span> : null}
            </button>))}
        </div> : null}

        {isGroup && staff ? <div className="info-card">
          <div className="info-head"><b>Group settings</b></div>
          <div className="info-row"><Icon name="megaphone" size={20} /><span className="grow">Only admins can send messages</span><Toggle checked={conv.announceOnly} label="Announcement mode" disabled={conv.kind !== 'group'} onChange={(v) => guard(api.patch(`/api/conversations/${conv.id}`, { announceOnly: v }))} /></div>
          <div className="info-row"><Icon name="edit" size={20} /><span className="grow">Members can edit group info</span><Toggle checked={conv.membersCanEditInfo} label="Members edit info" onChange={(v) => guard(api.patch(`/api/conversations/${conv.id}`, { membersCanEditInfo: v }))} /></div>
          <div className="info-row"><Icon name="user-plus" size={20} /><span className="grow">Members can add others</span><Toggle checked={conv.membersCanInvite} label="Members invite" onChange={(v) => guard(api.patch(`/api/conversations/${conv.id}`, { membersCanInvite: v }))} /></div>
          {(staff || conv.membersCanEditInfo) ? <button className="info-row" onClick={() => setDlg('edit')}><Icon name="edit" size={20} /><span className="grow">Edit name and description</span><Icon name="right" size={16} className="muted" /></button> : null}
        </div> : null}

        <div className="info-card danger-zone">
          {!isGroup && conv.other ? <>
            <button className="info-row" onClick={async () => { if (isContact) await guard(api.del(`/api/contacts/${conv.other!.id}`)); else await guard(api.put(`/api/contacts/${conv.other!.id}`, {})); await loadContacts(); toast(isContact ? 'Removed from contacts' : 'Added to contacts'); }}><Icon name={isContact ? 'user' : 'user-plus'} size={20} /><span className="grow">{isContact ? 'Remove from contacts' : 'Add to contacts'}</span></button>
            <button className="info-row danger" onClick={() => conv.other!.blockedByMe ? guard(api.del(`/api/blocks/${conv.other!.id}`).then(() => refreshConversation(conv.id))) : setDlg('block')}><Icon name="ban" size={20} /><span className="grow">{conv.other.blockedByMe ? `Unblock ${conv.other.displayName}` : `Block ${conv.other.displayName}`}</span></button>
            <button className="info-row danger" onClick={async () => { await guard(api.post('/api/reports', { userId: conv.other!.id, reason: 'abuse' })); toast('Report sent'); }}><Icon name="flag" size={20} /><span className="grow">Report contact</span></button>
          </> : <button className="info-row danger" onClick={() => setDlg('leave')}><Icon name="logout" size={20} /><span className="grow">{conv.kind === 'channel' ? 'Unsubscribe' : 'Exit group'}</span></button>}
        </div>
      </div>
      {menu.node}
      {dlg === 'disappear' ? <Dialog title="Disappearing messages" onClose={() => setDlg(null)} width={380}>
        <p className="muted">New messages in this chat will disappear after the selected time.</p>
        <div className="radio-list">{DISAPPEAR.map(([label, sec]) => <button key={label} className="radio" aria-pressed={conv.disappearingSeconds === sec || (!conv.disappearingSeconds && sec === null)} onClick={async () => { await guard(api.patch(`/api/conversations/${conv.id}`, { disappearingSeconds: sec })); setDlg(null); }}><span className="radio-dot" />{label}</button>)}</div>
      </Dialog> : null}
      {dlg === 'block' && conv.other ? <Confirm title={`Block ${conv.other.displayName}?`} text="Blocked contacts cannot message or call you, or see your profile. They are not told that you blocked them." confirm="Block" danger onConfirm={async () => { await api.put(`/api/blocks/${conv.other!.id}`); await refreshConversation(conv.id); }} onClose={() => setDlg(null)} /> : null}
      {dlg === 'leave' ? <Confirm title={conv.kind === 'channel' ? 'Unsubscribe?' : 'Exit group?'} text="You will stop receiving messages from this conversation." confirm="Leave" danger onConfirm={async () => { await api.post(`/api/conversations/${conv.id}/leave`); setState((s) => { const convs = { ...s.convs }; delete convs[conv.id]; return { convs, convOrder: s.convOrder.filter((i) => i !== conv.id) }; }); go('chats'); }} onClose={() => setDlg(null)} /> : null}
      {dlg === 'invite' ? <InviteDialog convId={conv.id} staff={staff} onClose={() => setDlg(null)} /> : null}
      {dlg === 'add' ? <AddMembers conv={conv} existing={members ?? []} onClose={() => setDlg(null)} /> : null}
      {dlg === 'edit' ? <EditGroup conv={conv} onClose={() => setDlg(null)} /> : null}
    </aside>
  );
}

function Thumb({ id, onClick }: { id: string; onClick: () => void }) { const m = useMedia(id); return <button className="thumb" onClick={onClick} aria-label="Open media">{m ? <img src={m.thumbUrl ?? m.url} alt="" loading="lazy" /> : null}</button>; }

function Gallery({ convId, tab, setTab, onBack, embedded }: { convId: string; tab: 'media' | 'docs' | 'links'; setTab: (t: 'media' | 'docs' | 'links') => void; onBack: () => void; embedded: boolean }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [viewer, setViewer] = useState<Msg | null>(null);
  useEffect(() => {
    setItems(null);
    const kinds = tab === 'media' ? ['image', 'video'] : tab === 'docs' ? ['document', 'audio'] : ['links'];
    Promise.all(kinds.map((k) => api.get(`/api/media?conversationId=${convId}&kind=${k}&limit=100`))).then((rs) => setItems(rs.flatMap((r) => r.items).sort((a, b) => b.seq - a.seq))).catch(() => setItems([]));
  }, [convId, tab]);
  return (
    <aside className={`info ${embedded ? 'embedded' : 'full'}`}>
      <header className="info-bar"><button className="icon-btn on-head" onClick={onBack} aria-label="Back"><Icon name="back" /></button><b>Media, links and docs</b></header>
      <div className="tabs" role="tablist">{([['media', 'Media'], ['docs', 'Docs'], ['links', 'Links']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="info-scroll">
        {!items ? <div className="spinner" style={{ margin: 24 }} /> : !items.length ? <div className="empty"><p>Nothing shared yet</p></div>
          : tab === 'media' ? <div className="grid-media">{items.map((it) => it.media.kind === 'image'
            ? <MediaImage key={it.messageId} id={it.media.id} w={1} h={1} alt={it.media.name ?? 'Photo'} onOpen={() => { const m = getState().msgs[convId]?.list.find((x) => x.id === it.messageId); if (m) setViewer(m); else toast('Open the chat and scroll to view this photo'); }} />
            : <VideoTile key={it.messageId} id={it.media.id} />)}</div>
          : tab === 'docs' ? <ul>{items.map((it) => <DocRow key={it.messageId} it={it} />)}</ul>
          : <ul>{items.map((it) => it.urls.map((u: string) => <li key={it.messageId + u}><a className="link-row" href={u} target="_blank" rel="noopener noreferrer nofollow"><Icon name="link" size={18} /><span className="truncate">{u}</span></a></li>))}</ul>}
      </div>
      {viewer ? <MediaViewer convId={convId} start={viewer} onClose={() => setViewer(null)} /> : null}
    </aside>
  );
}
function VideoTile({ id }: { id: string }) { const m = useMedia(id); return <div className="media-img" style={{ aspectRatio: '1' }}>{m ? <video src={m.url} preload="metadata" controls /> : null}</div>; }
function DocRow({ it }: { it: any }) { const m = useMedia(it.media.id); return <li><a className="link-row" href={m ? `${m.url}&dl=1` : undefined} download><Icon name="doc" size={20} /><span className="grow truncate">{it.media.name}</span><small className="muted">{bytes(it.media.size)}</small></a></li>; }

function InviteDialog({ convId, staff, onClose }: { convId: string; staff: boolean; onClose: () => void }) {
  const [link, setLink] = useState<{ id: string; url: string; exp: string | null } | null>(null);
  const [list, setList] = useState<any[]>([]);
  const load = () => staff ? api.get(`/api/conversations/${convId}/invites`).then((r) => setList(r.invites.filter((i: any) => !i.revoked_at))).catch(() => {}) : undefined;
  useEffect(() => { void load(); }, []);  
  const make = async () => { const r = await guard(api.post(`/api/conversations/${convId}/invites`, { expiresInHours: 168 })); if (r) { setLink({ id: r.id, url: `${location.origin}/#/join/${r.code}`, exp: r.expiresAt }); void load(); } };
  return (
    <Dialog title="Invite via link" onClose={onClose}>
      <p className="muted">Anyone with the link can join. Links expire after 7 days and can be revoked at any time. The link is shown once.</p>
      {link ? <div className="stack-sm"><input className="input" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
        <div className="row"><button className="btn btn-primary" onClick={() => navigator.clipboard.writeText(link.url).then(() => toast('Link copied'))}><Icon name="copy" size={18} />Copy link</button>
          {navigator.share ? <button className="btn btn-outline" onClick={() => navigator.share({ title: 'Join me on Wazzupp', url: link.url }).catch(() => {})}><Icon name="share" size={18} />Share</button> : null}</div></div>
        : <button className="btn btn-primary" onClick={make}><Icon name="link" size={18} />Create invite link</button>}
      {list.length ? <div className="stack-sm"><h4 className="list-sub">Active links</h4>{list.map((i) => <div key={i.id} className="row"><span className="grow"><small>Created {new Date(i.created_at).toLocaleDateString()} · {i.uses} used{i.max_uses ? ` of ${i.max_uses}` : ''}</small></span><button className="btn btn-danger-ghost btn-sm" onClick={async () => { await guard(api.del(`/api/invites/${i.id}`)); if (link?.id === i.id) setLink(null); void load(); }}>Revoke</button></div>)}</div> : null}
    </Dialog>
  );
}

function AddMembers({ conv, existing, onClose }: { conv: Conv; existing: Member[]; onClose: () => void }) {
  const contacts = useStore((s) => s.contacts); const [sel, setSel] = useState<Set<string>>(new Set());
  const have = new Set(existing.map((m) => m.id)); const list = contacts.filter((c) => !have.has(c.id));
  return (
    <Dialog title="Add members" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!sel.size} onClick={async () => {
      const r = await guard(api.post(`/api/conversations/${conv.id}/members`, { userIds: [...sel] }));
      if (r) { if (r.skipped.length) toast(`${r.skipped.length} could not be added (privacy settings or blocked)`); setState((s) => ({ members: { ...s.members, [conv.id]: undefined as any } })); await loadConversations(); onClose(); }
    }}>Add</button></>}>
      <div className="stack-sm" style={{ maxHeight: 340, overflow: 'auto' }}>{list.length ? list.map((u) => <button key={u.id} className={`person ${sel.has(u.id) ? 'sel' : ''}`} onClick={() => setSel((s) => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })}><Avatar id={u.id} name={u.displayName} mediaId={u.avatarMediaId} size={40} /><span className="grow" style={{ textAlign: 'left' }}><b>{u.displayName}</b></span>{sel.has(u.id) ? <span className="pick"><Icon name="check" size={15} stroke={3} /></span> : null}</button>) : <p className="help">All your contacts are already here.</p>}</div>
    </Dialog>
  );
}
function EditGroup({ conv, onClose }: { conv: Conv; onClose: () => void }) {
  const [t, setT] = useState(conv.title ?? ''); const [d, setD] = useState(conv.description);
  return <Dialog title="Edit group" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!t.trim()} onClick={async () => { await guard(api.patch(`/api/conversations/${conv.id}`, { title: t.trim(), description: d })); onClose(); }}>Save</button></>}>
    <label className="field"><span className="label-t">Name</span><input className="input" value={t} maxLength={100} onChange={(e) => setT(e.target.value)} /></label>
    <label className="field"><span className="label-t">Description</span><textarea className="textarea" value={d} maxLength={500} onChange={(e) => setD(e.target.value)} /></label>
  </Dialog>;
}
void Row; void Section;
