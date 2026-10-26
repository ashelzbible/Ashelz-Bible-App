import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { back, go, useLayout, useRoute } from '../lib/route.ts';
import { toast, useStore } from '../lib/store.ts';
import type { Community } from '../lib/types.ts';
import { guard, loadCommunities, loadConversations } from '../lib/actions.ts';
import { avatarColors } from '../lib/format.ts';
import { useMedia } from '../lib/mediaCache.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Empty } from '../ui/Misc.tsx';
import { Dialog } from '../ui/Overlay.tsx';
import { PaneFrame } from './Frame.tsx';
import { NewCommunityDialog } from './Dialogs.tsx';

const TILE = [['#2BC48A', '#0E8A5F'], ['#FF9A3D', '#F07412'], ['#4DA3F5', '#1E6BD6'], ['#3B64D9', '#1B3FA8'], ['#B24FC4', '#7A2791'], ['#F0556B', '#C02A44']];
export function Tile({ c, size = 52 }: { c: { id: string; name: string; avatarMediaId: string | null }; size?: number }) {
  const m = useMedia(c.avatarMediaId); const i = [...c.id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % TILE.length;
  return <span className="tile" style={{ width: size, height: size, background: `linear-gradient(145deg, ${TILE[i][0]}, ${TILE[i][1]})` }}>{m ? <img src={m.thumbUrl ?? m.url} alt="" /> : <Icon name="users" size={size * 0.5} />}</span>;
}
void avatarColors;

export function CommunityList() {
  const list = useStore((s) => s.communities); const route = useRoute(); const layout = useLayout();
  const [q, setQ] = useState(''); const [create, setCreate] = useState(false); const [disc, setDisc] = useState<{ communities: any[]; channels: any[] } | null>(null);
  useEffect(() => { void loadCommunities(); }, []);
  useEffect(() => { if (q.trim().length < 2) { setDisc(null); return; } const t = setTimeout(() => api.get(`/api/communities/discover?q=${encodeURIComponent(q.trim())}`).then(setDisc).catch(() => {}), 300); return () => clearTimeout(t); }, [q]);
  const shown = list.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  const search = <div className={layout === 'desktop' ? 'rail-search' : 'm-search'}><Icon name="search" size={18} /><input placeholder="Search communities…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search communities" /></div>;
  return (
    <PaneFrame title="Communities" search={search} actions={<button className="icon-btn on-dark" onClick={() => setCreate(true)} aria-label="New community"><Icon name="plus" /></button>}>
      {shown.length ? <ul className="conv-list">{shown.map((c) => (
        <li key={c.id}><button className={`conv-row ${route.tab === 'communities' && route.id === c.id && layout !== 'mobile' ? 'sel' : ''}`} onClick={() => go(`communities/${c.id}`)}><Tile c={c} /><span className="conv-main"><span className="conv-name truncate">{c.name}</span><span className="conv-prev">{c.groups.length} group{c.groups.length === 1 ? '' : 's'}</span></span></button></li>))}</ul>
        : !disc ? <Empty icon="users" title="No communities yet" text="Communities bring related groups together under one roof with announcements." action={<button className="btn btn-primary" onClick={() => setCreate(true)}><Icon name="plus" size={18} />Create community</button>} /> : null}
      {disc && (disc.communities.length || disc.channels.length) ? <>
        <h4 className="list-sub">Discover</h4>
        <ul className="conv-list">{disc.communities.map((c) => <li key={c.id}><div className="conv-row"><Tile c={c} /><span className="conv-main"><span className="conv-name truncate">{c.name}</span><span className="conv-prev">{c.members} members</span></span><button className="btn btn-soft btn-sm" onClick={async () => { await guard(api.post(`/api/communities/${c.id}/join`)); await loadCommunities(); await loadConversations(); go(`communities/${c.id}`); }}>Join</button></div></li>)}
          {disc.channels.map((c) => <li key={c.id}><div className="conv-row"><Avatar id={c.id} name={c.title} mediaId={c.avatarMediaId} group size={52} /><span className="conv-main"><span className="conv-name truncate">{c.title}</span><span className="conv-prev">Channel · {c.members}</span></span><button className="btn btn-soft btn-sm" onClick={async () => { const r = await guard(api.post(`/api/channels/${c.id}/subscribe`)); if (r) { await loadConversations(); go(`chats/${c.id}`); } }}>Subscribe</button></div></li>)}</ul></> : null}
      {create ? <NewCommunityDialog onClose={() => setCreate(false)} /> : null}
    </PaneFrame>
  );
}

export function CommunityDetail({ id }: { id: string }) {
  const layout = useLayout(); const me = useStore((s) => s.me!);
  const [c, setC] = useState<Community | null>(null); const [members, setMembers] = useState<any[]>([]); const [err, setErr] = useState(false);
  const [dlg, setDlg] = useState<null | 'announce' | 'link' | 'invite'>(null);
  const load = () => api.get(`/api/communities/${id}`).then((r) => setC(r.community)).catch(() => setErr(true));
  useEffect(() => { setC(null); setErr(false); void load(); api.get(`/api/communities/${id}/members`).then((r) => setMembers(r.members)).catch(() => {}); }, [id]);  
  const cover = useMedia(c?.avatarMediaId);
  if (err) return <div className="conv-empty"><Empty icon="users" title="Community not found" text="It may be private or you may no longer be a member." /></div>;
  if (!c) return <div className="conv-empty"><div className="spinner" /></div>;
  const admin = c.role === 'owner' || c.role === 'admin';
  return (
    <div className="comm-wrap"><div className="comm">
      <div className="comm-main">
        <header className="comm-head">{layout !== 'desktop' ? <button className="icon-btn" onClick={() => back()} aria-label="Back"><Icon name="back" /></button> : null}<div className="grow"><h2>{c.name}</h2><small className="muted">{c.groups.length} group{c.groups.length === 1 ? '' : 's'} · {c.members} member{c.members === 1 ? '' : 's'}</small></div>{admin ? <button className="plus-sq" onClick={() => setDlg('link')} aria-label="Add group"><Icon name="plus" size={22} stroke={2.4} /></button> : null}</header>
        <div className="comm-scroll">
          {c.description ? <p className="about pad">{c.description}</p> : null}
          {c.announcementConversationId ? <button className="comm-group" onClick={() => go(`chats/${c.announcementConversationId}`)}><span className="tile sm ann"><Icon name="megaphone" size={20} /></span><span className="grow"><b>Announcements</b><small className="muted" style={{ display: 'block' }}>{admin ? 'Only admins can post' : 'Updates from community admins'}</small></span><Icon name="right" size={16} className="muted" /></button> : null}
          {c.groups.map((g) => <button key={g.id} className="comm-group" onClick={async () => { if (!g.joined) await guard(api.post(`/api/communities/${c.id}/groups/${g.id}/join`).then(() => loadConversations())); go(`chats/${g.id}`); }}><Avatar id={g.id} name={g.title} mediaId={g.avatarMediaId} size={44} group /><span className="grow"><b>{g.title}</b><small className="muted" style={{ display: 'block' }}>{g.memberCount} members</small></span>{g.joined ? <Icon name="right" size={16} className="muted" /> : <span className="btn btn-soft btn-sm">Join</span>}</button>)}
          {!c.groups.length ? <p className="help pad">No groups linked yet.{admin ? ' Use + to add one of your groups.' : ''}</p> : null}
          <h4 className="list-sub">Members ({c.members})</h4>
          <div className="avatars-row">{members.slice(0, 12).map((m) => <Avatar key={m.id} id={m.id} name={m.displayName} mediaId={m.avatarMediaId} size={42} />)}{admin ? <button className="add-circle" onClick={() => setDlg('invite')} aria-label="Invite people"><Icon name="plus" size={20} /></button> : null}</div>
        </div>
      </div>
      <aside className="comm-side">
        <div className="comm-cover" style={cover ? { backgroundImage: `linear-gradient(transparent 35%, rgba(0,0,0,.65)), url(${cover.url})` } : undefined}><div><b>{c.name}</b><small>{c.groups.length} group{c.groups.length === 1 ? '' : 's'} · {c.members} member{c.members === 1 ? '' : 's'}</small></div></div>
        <div className="quick-actions">
          <button onClick={() => (admin ? setDlg('invite') : toast('Ask an admin for an invite link'))}><span><Icon name="user-plus" size={20} /></span>Add</button>
          <button onClick={() => c.announcementConversationId && go(`chats/${c.announcementConversationId}`)}><span><Icon name="megaphone" size={20} /></span>Announce</button>
          <button onClick={async () => { if (!confirm('Leave this community?')) return; await guard(api.post(`/api/communities/${c.id}/leave`)); await loadCommunities(); go('communities'); }}><span><Icon name="logout" size={20} /></span>Leave</button>
        </div>
        <div className="info-card flat"><div className="info-row"><Icon name="globe" size={20} /><span className="grow">Visibility</span><span className="muted" style={{ textTransform: 'capitalize' }}>{c.visibility}</span></div><div className="info-row"><Icon name="user" size={20} /><span className="grow">Your role</span><span className="muted" style={{ textTransform: 'capitalize' }}>{c.role}</span></div></div>
      </aside>
      {dlg === 'invite' ? <CommunityInvite id={c.id} onClose={() => setDlg(null)} /> : null}
      {dlg === 'link' ? <LinkGroup id={c.id} onClose={() => { setDlg(null); void load(); }} /> : null}
      <span hidden>{me.id}</span>
    </div></div>
  );
}
function CommunityInvite({ id, onClose }: { id: string; onClose: () => void }) {
  const [url, setUrl] = useState('');
  useEffect(() => { api.post(`/api/communities/${id}/invites`).then((r) => setUrl(`${location.origin}/#/join/${r.code}`)).catch(() => {}); }, [id]);
  return <Dialog title="Invite to community" onClose={onClose}><p className="muted">Share this link. It expires in 7 days.</p><input className="input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" /><button className="btn btn-primary" disabled={!url} onClick={() => navigator.clipboard.writeText(url).then(() => toast('Link copied'))}><Icon name="copy" size={18} />Copy link</button></Dialog>;
}
function LinkGroup({ id, onClose }: { id: string; onClose: () => void }) {
  const convs = useStore((s) => s.convs);
  const mine = Object.values(convs).filter((c) => c.kind === 'group' && (c.role === 'owner' || c.role === 'admin') && !c.communityId);
  return <Dialog title="Add a group" onClose={onClose}><div className="stack-sm">{mine.length ? mine.map((g) => <button key={g.id} className="person" onClick={async () => { await guard(api.post(`/api/communities/${id}/groups`, { conversationId: g.id })); toast('Group added'); onClose(); }}><Avatar id={g.id} name={g.title ?? ''} mediaId={g.avatarMediaId} group size={42} /><b className="grow" style={{ textAlign: 'left' }}>{g.title}</b></button>) : <p className="help">You are not an admin of any unlinked groups. Create one first.</p>}</div></Dialog>;
}
