import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { getState, toast, useStore } from '../lib/store.ts';
import type { Msg } from '../lib/types.ts';
import { convTitle } from '../lib/format.ts';
import { go } from '../lib/route.ts';
import { guard, loadCommunities, loadContacts, openDirect, sendMessage, toastError, loadConversations } from '../lib/actions.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Dialog } from '../ui/Overlay.tsx';
import { ChannelArt } from '../ui/Art.tsx';

const uid = () => crypto.randomUUID();
interface UserHit { id: string; username: string; displayName: string; avatarMediaId: string | null }

function useUserSearch(q: string) {
  const [hits, setHits] = useState<UserHit[]>([]); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.trim().length < 3) { setHits([]); return; }
    setBusy(true);
    const t = setTimeout(() => api.get(`/api/users/search?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.users)).catch(() => setHits([])).finally(() => setBusy(false)), 350);
    return () => clearTimeout(t);
  }, [q]);
  return { hits, busy };
}

function PersonRow({ u, onClick, right, selected }: { u: UserHit; onClick?: () => void; right?: React.ReactNode; selected?: boolean }) {
  return <button className={`person ${selected ? 'sel' : ''}`} onClick={onClick}><Avatar id={u.id} name={u.displayName} mediaId={u.avatarMediaId} size={42} /><span className="grow" style={{ textAlign: 'left' }}><b className="truncate" style={{ display: 'block' }}>{u.displayName}</b><small className="muted">@{u.username}</small></span>{right}{selected ? <span className="pick"><Icon name="check" size={15} stroke={3} /></span> : null}</button>;
}

export function NewChatDialog({ onClose, onGroup, onCommunity }: { onClose: () => void; onGroup: () => void; onCommunity: () => void }) {
  const [q, setQ] = useState('');
  const contacts = useStore((s) => s.contacts);
  const { hits, busy } = useUserSearch(q);
  const me = useStore((s) => s.me!.id);
  useEffect(() => { void loadContacts(); }, []);
  const start = async (id: string) => { const cid = await guard(openDirect(id)); if (cid) { onClose(); go(`chats/${cid}`); } };
  const filtered = contacts.filter((c) => !q || c.displayName.toLowerCase().includes(q.toLowerCase()) || c.username.toLowerCase().includes(q.toLowerCase()));
  return (
    <Dialog title="New chat" onClose={onClose}>
      <div className="m-search light"><Icon name="search" size={18} /><input autoFocus placeholder="Search by username, email or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find people" /></div>
      <div className="stack-sm">
        <button className="person" onClick={onGroup}><span className="action-ico"><Icon name="users" size={22} /></span><b>New group</b></button>
        <button className="person" onClick={onCommunity}><span className="action-ico"><Icon name="megaphone" size={22} /></span><b>New community or channel</b></button>
      </div>
      {q.trim().length >= 3 ? <div className="stack-sm"><h4 className="list-sub">{busy ? 'Searching…' : hits.length ? 'People' : 'No one found'}</h4>
        {hits.map((u) => <PersonRow key={u.id} u={u} onClick={() => start(u.id)} right={u.id !== me && !contacts.some((c) => c.id === u.id) ? <span className="btn btn-soft btn-sm" role="button" onClick={async (e) => { e.stopPropagation(); await guard(api.put(`/api/contacts/${u.id}`, {})); await loadContacts(); toast(`${u.displayName} added to contacts`); }}>Add</span> : null} />)}
        {!hits.length && !busy ? <p className="help">People appear by exact username prefix. Email and phone lookups only work for people who allow it.</p> : null}</div> : null}
      <div className="stack-sm"><h4 className="list-sub">Contacts</h4>
        {filtered.length ? filtered.map((c) => <PersonRow key={c.id} u={c} onClick={() => start(c.id)} />) : <p className="help">No contacts yet. Search for a username above and tap Add.</p>}</div>
    </Dialog>
  );
}

export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const contacts = useStore((s) => s.contacts);
  const [title, setTitle] = useState(''); const [desc, setDesc] = useState(''); const [sel, setSel] = useState<Set<string>>(new Set()); const [busy, setBusy] = useState(false);
  const [q, setQ] = useState(''); const { hits } = useUserSearch(q);
  const pool = useMemo(() => { const m = new Map<string, UserHit>(); for (const c of contacts) m.set(c.id, c); for (const h of hits) m.set(h.id, h); return [...m.values()]; }, [contacts, hits]);
  return (
    <Dialog title="New group" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!title.trim() || busy} onClick={async () => {
      setBusy(true);
      try {
        const r = await api.post('/api/groups', { title: title.trim(), description: desc.trim() || undefined, memberIds: [...sel] });
        await loadConversations(); onClose(); go(`chats/${r.conversation.id}`);
        if (r.skipped?.length) toast(`${r.skipped.length} ${r.skipped.length === 1 ? 'person was' : 'people were'} not added because of their privacy settings`);
      } catch (e) { toastError(e); } finally { setBusy(false); }
    }}>Create group</button></>}>
      <label className="field"><span className="label-t">Group name</span><input className="input" autoFocus maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span className="label-t">Description (optional)</span><input className="input" maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <div className="field"><span className="label-t">Add members ({sel.size})</span><div className="m-search light"><Icon name="search" size={18} /><input placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" /></div></div>
      <div className="stack-sm" style={{ maxHeight: 260, overflow: 'auto' }}>{pool.map((u) => <PersonRow key={u.id} u={u} selected={sel.has(u.id)} onClick={() => setSel((s) => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })} />)}
        {!pool.length ? <p className="help">Add contacts first, or search by username.</p> : null}</div>
    </Dialog>
  );
}

export function NewCommunityDialog({ onClose, initial = 'community' }: { onClose: () => void; initial?: 'community' | 'channel' }) {
  const [type, setType] = useState<'community' | 'channel'>(initial); const [name, setName] = useState(''); const [desc, setDesc] = useState(''); const [pub, setPub] = useState(initial === 'channel'); const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Create" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!name.trim() || busy} onClick={async () => {
      setBusy(true);
      try {
        if (type === 'community') { const r = await api.post('/api/communities', { name: name.trim(), description: desc.trim(), visibility: pub ? 'public' : 'private' }); await loadCommunities(); await loadConversations(); onClose(); go(`communities/${r.community.id}`); }
        else { const r = await api.post('/api/groups', { title: name.trim(), description: desc.trim(), kind: 'channel', isPublic: pub }); await loadConversations(); onClose(); go(`chats/${r.conversation.id}`); }
      } catch (e) { toastError(e); } finally { setBusy(false); }
    }}>Create</button></>}>
      <div className="seg"><button className={type === 'community' ? 'on' : ''} onClick={() => setType('community')}>Community</button><button className={type === 'channel' ? 'on' : ''} onClick={() => setType('channel')}>Channel</button></div>
      <p className="help">{type === 'community' ? 'A community brings related groups together with an announcement group only admins can post to.' : 'A channel broadcasts one-to-many. Only admins can post; subscribers can react and read.'}</p>
      <label className="field"><span className="label-t">Name</span><input className="input" autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span className="label-t">Description</span><textarea className="textarea" value={desc} maxLength={500} onChange={(e) => setDesc(e.target.value)} /></label>
      <label className="check-row"><input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} /> Public: anyone can find and join</label>
    </Dialog>
  );
}

export function ForwardDialog({ msg, onClose }: { msg: Msg; onClose: () => void }) {
  const convs = useStore((s) => s.convs); const order = useStore((s) => s.convOrder);
  const [sel, setSel] = useState<Set<string>>(new Set()); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false);
  const list = order.map((id) => convs[id]).filter((c) => c && (c.kind === 'direct' || c.kind === 'group' || c.role === 'owner' || c.role === 'admin') && convTitle(c).toLowerCase().includes(q.toLowerCase()));
  return (
    <Dialog title="Forward to…" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!sel.size || busy} onClick={async () => { setBusy(true); const r = await guard(api.post(`/api/messages/${msg.id}/forward`, { conversationIds: [...sel] })); setBusy(false); if (r) { toast(`Forwarded to ${sel.size} ${sel.size === 1 ? 'chat' : 'chats'}`); onClose(); } }}>Send</button></>}>
      <div className="m-search light"><Icon name="search" size={18} /><input autoFocus placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" /></div>
      <div className="stack-sm" style={{ maxHeight: 320, overflow: 'auto' }}>{list.map((c) => <button key={c.id} className={`person ${sel.has(c.id) ? 'sel' : ''}`} onClick={() => setSel((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else if (n.size < 10) n.add(c.id); return n; })}>
        <Avatar id={c.other?.id ?? c.id} name={convTitle(c)} mediaId={c.kind === 'direct' ? c.other?.avatarMediaId : c.avatarMediaId} size={42} group={c.kind !== 'direct'} /><span className="grow truncate" style={{ textAlign: 'left' }}><b>{convTitle(c)}</b></span>{sel.has(c.id) ? <span className="pick"><Icon name="check" size={15} stroke={3} /></span> : null}</button>)}</div>
    </Dialog>
  );
}

export function PollDialog({ convId, onClose }: { convId: string; onClose: () => void }) {
  const [question, setQ] = useState(''); const [opts, setOpts] = useState(['', '']); const [multi, setMulti] = useState(false);
  const valid = question.trim() && opts.filter((o) => o.trim()).length >= 2;
  return (
    <Dialog title="Create poll" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!valid} onClick={() => { sendMessage(convId, { kind: 'poll', meta: { question: question.trim(), options: opts.map((o) => o.trim()).filter(Boolean), multi } }); onClose(); }}>Send poll</button></>}>
      <label className="field"><span className="label-t">Question</span><input className="input" autoFocus maxLength={300} value={question} onChange={(e) => setQ(e.target.value)} placeholder="Which day works best?" /></label>
      <div className="field"><span className="label-t">Options</span>{opts.map((o, i) => <input key={i} aria-label={`Option ${i + 1}`} className="input" maxLength={100} value={o} placeholder={`Option ${i + 1}`} onChange={(e) => setOpts((l) => l.map((x, j) => (j === i ? e.target.value : x)))} style={{ marginBottom: 8 }} />)}
        {opts.length < 12 ? <button className="btn btn-soft btn-sm" onClick={() => setOpts((l) => [...l, ''])}><Icon name="plus" size={16} />Add option</button> : null}</div>
      <label className="check-row"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Allow multiple answers</label>
    </Dialog>
  );
}

export function EventDialog({ convId, onClose }: { convId: string; onClose: () => void }) {
  const [title, setTitle] = useState(''); const [when, setWhen] = useState(''); const [where, setWhere] = useState('');
  return (
    <Dialog title="Create event" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!title.trim() || !when} onClick={() => { sendMessage(convId, { kind: 'event', meta: { title: title.trim(), startsAt: new Date(when).toISOString(), ...(where.trim() ? { location: where.trim() } : {}) } }); onClose(); }}>Send event</button></>}>
      <label className="field"><span className="label-t">Title</span><input className="input" autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span className="label-t">Date and time</span><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
      <label className="field"><span className="label-t">Location (optional)</span><input className="input" value={where} maxLength={200} onChange={(e) => setWhere(e.target.value)} /></label>
    </Dialog>
  );
}

export function ContactPicker({ convId, onClose }: { convId: string; onClose: () => void }) {
  const contacts = useStore((s) => s.contacts);
  useEffect(() => { void loadContacts(); }, []);
  return (
    <Dialog title="Share a contact" onClose={onClose}>
      <div className="stack-sm">{contacts.length ? contacts.map((c) => <PersonRow key={c.id} u={c} onClick={() => { sendMessage(convId, { kind: 'contact', meta: { name: c.displayName, userId: c.id } }); onClose(); }} />) : <p className="help">Your contacts list is empty.</p>}</div>
    </Dialog>
  );
}

export function ScheduleDialog({ convId, initial, onClose, onDone }: { convId: string; initial: string; onClose: () => void; onDone: () => void }) {
  const [body, setBody] = useState(initial); const [when, setWhen] = useState('');
  const [list, setList] = useState<Array<{ id: string; conversationId: string; body: string; sendAt: string }>>([]);
  const load = () => api.get('/api/scheduled').then((r) => setList(r.scheduled.filter((s: any) => s.conversationId === convId))).catch(() => {});
  useEffect(() => { void load(); }, []);  
  return (
    <Dialog title="Schedule message" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Close</button><button className="btn btn-primary" disabled={!body.trim() || !when} onClick={async () => {
      try { await api.post(`/api/conversations/${convId}/scheduled`, { body: body.trim(), sendAt: new Date(when).toISOString() }); toast('Message scheduled'); onDone(); setBody(''); setWhen(''); await load(); }
      catch (e) { toastError(e instanceof ApiError && e.code === 'invalid_send_time' ? new ApiError(400, '', 'Pick a time in the future') : e); }
    }}>Schedule</button></>}>
      <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message" maxLength={8000} />
      <label className="field"><span className="label-t">Send at</span><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
      {list.length ? <div className="stack-sm"><h4 className="list-sub">Scheduled in this chat</h4>{list.map((s) => <div key={s.id} className="row"><span className="grow truncate">{s.body}<small className="muted" style={{ display: 'block' }}>{new Date(s.sendAt).toLocaleString()}</small></span><button className="icon-btn" aria-label="Cancel scheduled message" onClick={async () => { await guard(api.del(`/api/scheduled/${s.id}`)); await load(); }}><Icon name="trash" size={18} /></button></div>)}</div> : null}
    </Dialog>
  );
}
void getState;

// ---------------------------------------------------------------- broadcast lists
interface BList { id: string; name: string; ids: string[] }
const bKey = (me: string) => `wz.broadcast.${me}`;
const readLists = (me: string): BList[] => { try { return JSON.parse(localStorage.getItem(bKey(me)) ?? '[]'); } catch { return []; } };
const writeLists = (me: string, l: BList[]) => { try { localStorage.setItem(bKey(me), JSON.stringify(l)); } catch { /* storage unavailable: lists last for this session only */ } };
const sessionLists: Record<string, BList[]> = {};

/**
 * Broadcast lists: write one message and it is delivered to each person in the list as an ordinary private chat message
 * (recipients see a normal message from you and cannot see who else received it). Lists are stored on this device.
 */
export function BroadcastDialog({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me!.id);
  const contacts = useStore((s) => s.contacts);
  const [lists, setLists] = useState<BList[]>(() => sessionLists[me] ?? readLists(me));
  const [view, setView] = useState<null | { id: string | null }>(null);
  const [name, setName] = useState(''); const [sel, setSel] = useState<Set<string>>(new Set());
  const [text, setText] = useState(''); const [sendTo, setSendTo] = useState<BList | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { void loadContacts(); }, []);
  const save = (l: BList[]) => { setLists(l); sessionLists[me] = l; writeLists(me, l); };

  if (sendTo) {
    return (
      <Dialog title={`Broadcast to ${sendTo.name}`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={() => setSendTo(null)}>Back</button><button className="btn btn-primary" disabled={!text.trim() || busy} onClick={async () => {
        setBusy(true); let n = 0;
        for (const uid of sendTo.ids) { try { const cid = await openDirect(uid); sendMessage(cid, { kind: 'text', body: text.trim() }); n++; } catch { /* skip people who can't be reached (blocked, deleted) */ } }
        setBusy(false); toast(`Sent to ${n} of ${sendTo.ids.length} people`); onClose();
      }}>{busy ? 'Sending…' : `Send to ${sendTo.ids.length}`}</button></>}>
        <p className="muted">Each person receives this as a normal private message. They cannot see who else got it.</p>
        <textarea className="textarea" autoFocus maxLength={8000} placeholder="Type your message" value={text} aria-label="Broadcast message" onChange={(e) => setText(e.target.value)} />
      </Dialog>
    );
  }
  if (view) {
    return (
      <Dialog title={view.id ? 'Edit list' : 'New broadcast list'} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={() => setView(null)}>Back</button>
        {view.id ? <button className="btn btn-danger-ghost" onClick={() => { save(lists.filter((l) => l.id !== view.id)); setView(null); }}>Delete list</button> : null}
        <button className="btn btn-primary" disabled={!name.trim() || sel.size < 1} onClick={() => { const item = { id: view.id ?? uid(), name: name.trim(), ids: [...sel] }; save(view.id ? lists.map((l) => (l.id === view.id ? item : l)) : [...lists, item]); setView(null); }}>Save</button></>}>
        <label className="field"><span className="label-t">List name</span><input className="input" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Family updates" /></label>
        <div className="field"><span className="label-t">Recipients ({sel.size})</span>
          <div className="stack-sm" style={{ maxHeight: 260, overflow: 'auto' }}>{contacts.length ? contacts.map((c) => <PersonRow key={c.id} u={c} selected={sel.has(c.id)} onClick={() => setSel((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />) : <p className="help">Add contacts first, then build a list.</p>}</div></div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Broadcast lists" onClose={onClose}>
      <p className="muted">Send one message to many people at once. They get it as a private chat, not a group.</p>
      <div className="stack-sm">{lists.map((l) => (
        <div key={l.id} className="person"><span className="action-ico"><Icon name="megaphone" size={20} /></span>
          <span className="grow" style={{ textAlign: 'left' }}><b className="truncate" style={{ display: 'block' }}>{l.name}</b><small className="muted">{l.ids.length} recipients</small></span>
          <button className="btn btn-soft btn-sm" onClick={() => { setText(''); setSendTo(l); }}>Send</button>
          <button className="icon-btn" aria-label={`Edit ${l.name}`} onClick={() => { setName(l.name); setSel(new Set(l.ids)); setView({ id: l.id }); }}><Icon name="edit" size={18} /></button></div>))}
        {!lists.length ? <p className="help">No lists yet.</p> : null}</div>
      <button className="btn btn-primary" onClick={() => { setName(''); setSel(new Set()); setView({ id: null }); }}><Icon name="plus" size={18} />New list</button>
    </Dialog>
  );
}

/** Shown before creating a channel: what channels are and what the creator is responsible for. */
export function ChannelIntroSheet({ onContinue, onClose }: { onContinue: () => void; onClose: () => void }) {
  const rows: Array<[IconName, string, React.ReactNode]> = [
    ['globe', 'Anyone can discover your channel', 'Public channels can be found by anyone, who can then read the channel’s history.'],
    ['eye-off', 'People see your channel, not you', 'Subscribers can’t see your name, username or profile picture, but other admins can.'],
    ['shield', 'You’re responsible for your channel', <>Your channel needs to follow the community rules, and can be reported and removed by moderators.</>],
  ];
  return (
    <Dialog title="" onClose={onClose} width={460} footer={<button className="btn btn-primary btn-block" style={{ height: 52 }} onClick={onContinue}>Continue</button>}>
      <div className="intro-art"><ChannelArt /></div>
      <h2 className="intro-title">Create a channel to reach unlimited followers</h2>
      <ul className="intro-list">{rows.map(([i, t, d]) => <li key={t}><span><Icon name={i} size={26} /></span><div><b>{t}</b><p>{d}</p></div></li>)}</ul>
    </Dialog>
  );
}

/** What a community could look like, so people can see the idea before building one. */
export function CommunityExamplesDialog({ onClose, onStart }: { onClose: () => void; onStart: () => void }) {
  const ex = [['School parents', 'Announcements from the school, plus one group per class and one for the sports committee.'], ['Neighbourhood watch', 'Safety alerts to everyone, with a group for each street and a group for events.'], ['Book club', 'Monthly announcements, with a group per reading list and one for socials.'], ['Football team', 'Fixtures from the coach, a group for players and a group for supporters.']];
  return (
    <Dialog title="Example communities" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={() => { onClose(); onStart(); }}>Start your community</button></>}>
      <ul className="stack">{ex.map(([n, d]) => <li key={n} className="example"><span className="tile sm" style={{ background: 'linear-gradient(145deg,#2BC48A,#0E8A5F)' }}><Icon name="users" size={22} /></span><div><b>{n}</b><p className="muted">{d}</p></div></li>)}</ul>
      <p className="help">Every community has an announcement group that only admins can post to, and members can join any group linked to it.</p>
    </Dialog>
  );
}
