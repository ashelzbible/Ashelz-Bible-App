import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { toast, useStore } from '../lib/store.ts';
import { guard, loadContacts, openDirect } from '../lib/actions.ts';
import { startCall } from '../lib/rtc.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Dialog } from '../ui/Overlay.tsx';
import { go } from '../lib/route.ts';

async function callContact(userId: string, kind: 'audio' | 'video') { const cid = await guard(openDirect(userId)); if (cid) void startCall(cid, kind); }

/** "Call": pick a contact and start a voice or video call. */
export function NewCallDialog({ onClose }: { onClose: () => void }) {
  const contacts = useStore((s) => s.contacts); const [q, setQ] = useState('');
  useEffect(() => { void loadContacts(); }, []);
  const list = contacts.filter((c) => c.displayName.toLowerCase().includes(q.toLowerCase()) || c.username.toLowerCase().includes(q.toLowerCase()));
  return (
    <Dialog title="New call" onClose={onClose}>
      <div className="m-search light"><Icon name="search" size={18} /><input autoFocus placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" /></div>
      <div className="stack-sm" style={{ maxHeight: 360, overflow: 'auto' }}>
        {list.map((c) => (
          <div key={c.id} className="person"><Avatar id={c.id} name={c.displayName} mediaId={c.avatarMediaId} size={44} /><span className="grow" style={{ textAlign: 'left' }}><b className="truncate" style={{ display: 'block' }}>{c.displayName}</b><small className="muted">@{c.username}</small></span>
            <button className="icon-btn" aria-label={`Voice call ${c.displayName}`} onClick={() => { onClose(); void callContact(c.id, 'audio'); }}><Icon name="phone" /></button>
            <button className="icon-btn" aria-label={`Video call ${c.displayName}`} onClick={() => { onClose(); void callContact(c.id, 'video'); }}><Icon name="video" /></button></div>))}
        {!list.length ? <p className="help">{contacts.length ? 'No contacts match.' : 'Add contacts from New chat, then call them here.'}</p> : null}
      </div>
    </Dialog>
  );
}

/** Keypad: dial a phone number. Works only for people who registered that number and allow being found by it. */
export function KeypadDialog({ onClose }: { onClose: () => void }) {
  const [num, setNum] = useState(''); const [busy, setBusy] = useState(false);
  const press = (d: string) => setNum((n) => (n + d).slice(0, 16));
  const dial = async (kind: 'audio' | 'video') => {
    const n = num.startsWith('+') ? num : `+${num}`;
    if (!/^\+[1-9]\d{6,14}$/.test(n)) { toast('Enter the full number including the country code', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.get(`/api/users/search?q=${encodeURIComponent(n)}`);
      if (!r.users.length) { toast('No Wazzupp account was found for that number. People must allow being found by phone.', 'error'); return; }
      onClose(); await callContact(r.users[0].id, kind);
    } catch { toast('Could not look up that number', 'error'); } finally { setBusy(false); }
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '0', '⌫'];
  return (
    <Dialog title="Keypad" onClose={onClose} width={360}>
      <div className="dial-display" aria-live="polite">{num || <span className="muted">Number with country code</span>}</div>
      <div className="dial-grid">{keys.map((k) => <button key={k} aria-label={k === '⌫' ? 'Delete' : k} onClick={() => (k === '⌫' ? setNum((n) => n.slice(0, -1)) : press(k))}>{k === '⌫' ? <Icon name="back" size={22} /> : k}</button>)}</div>
      <div className="row" style={{ justifyContent: 'center', gap: 16 }}>
        <button className="btn btn-primary" disabled={!num || busy} onClick={() => dial('audio')}><Icon name="phone" size={18} />Call</button>
        <button className="btn btn-outline" disabled={!num || busy} onClick={() => dial('video')}><Icon name="video" size={18} />Video</button>
      </div>
    </Dialog>
  );
}

/** Favourites: contacts you call often, one tap away. */
export function FavouritesDialog({ onClose }: { onClose: () => void }) {
  const contacts = useStore((s) => s.contacts);
  useEffect(() => { void loadContacts(); }, []);
  const fav = contacts.filter((c) => c.favorite); const rest = contacts.filter((c) => !c.favorite);
  const toggle = async (id: string, favorite: boolean) => { await guard(api.put(`/api/contacts/${id}`, { favorite })); await loadContacts(); };
  return (
    <Dialog title="Favourites" onClose={onClose}>
      <div className="stack-sm">
        {fav.map((c) => (
          <div key={c.id} className="person"><Avatar id={c.id} name={c.displayName} mediaId={c.avatarMediaId} size={44} /><b className="grow truncate" style={{ textAlign: 'left' }}>{c.displayName}</b>
            <button className="icon-btn" aria-label={`Voice call ${c.displayName}`} onClick={() => { onClose(); void callContact(c.id, 'audio'); }}><Icon name="phone" /></button>
            <button className="icon-btn" aria-label={`Video call ${c.displayName}`} onClick={() => { onClose(); void callContact(c.id, 'video'); }}><Icon name="video" /></button>
            <button className="icon-btn" aria-label={`Remove ${c.displayName} from favourites`} onClick={() => toggle(c.id, false)}><Icon name="heart" fill style={{ color: 'var(--danger)' }} /></button></div>))}
        {!fav.length ? <p className="help">No favourites yet. Tap the heart next to a contact below.</p> : null}
        {rest.length ? <h4 className="list-sub" style={{ paddingInline: 0 }}>Add to favourites</h4> : null}
        {rest.map((c) => (
          <div key={c.id} className="person"><Avatar id={c.id} name={c.displayName} mediaId={c.avatarMediaId} size={40} /><span className="grow truncate" style={{ textAlign: 'left' }}>{c.displayName}</span>
            <button className="icon-btn" aria-label={`Add ${c.displayName} to favourites`} onClick={() => toggle(c.id, true)}><Icon name="heart" /></button></div>))}
      </div>
    </Dialog>
  );
}

interface Sched { id: string; conversationId: string; createdByMe: boolean; kind: 'audio' | 'video'; startsAt: string; note: string; other: { id: string; displayName: string; username: string } }

/** Schedule a call with a contact; both people get a reminder when it is time. */
export function ScheduleCallDialog({ onClose, onDone }: { onClose: () => void; onDone?: () => void }) {
  const contacts = useStore((s) => s.contacts);
  const [who, setWho] = useState(''); const [kind, setKind] = useState<'audio' | 'video'>('audio'); const [when, setWhen] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void loadContacts(); }, []);
  useEffect(() => { if (!who && contacts[0]) setWho(contacts[0].id); }, [contacts, who]);
  return (
    <Dialog title="Schedule a call" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!who || !when || busy} onClick={async () => {
      setBusy(true);
      try { const cid = await openDirect(who); await api.post('/api/calls/scheduled', { conversationId: cid, kind, startsAt: new Date(when).toISOString(), note }); toast('Call scheduled. You will both get a reminder.'); onDone?.(); onClose(); }
      catch (e: any) { toast(e.message ?? 'Could not schedule the call', 'error'); } finally { setBusy(false); }
    }}>Schedule</button></>}>
      <label className="field"><span className="label-t">With</span>
        <select className="select" value={who} onChange={(e) => setWho(e.target.value)}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}</select></label>
      <div className="seg" role="group" aria-label="Call type"><button className={kind === 'audio' ? 'on' : ''} onClick={() => setKind('audio')}>Voice</button><button className={kind === 'video' ? 'on' : ''} onClick={() => setKind('video')}>Video</button></div>
      <label className="field"><span className="label-t">Date and time</span><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
      <label className="field"><span className="label-t">Note (optional)</span><input className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is it about?" /></label>
      {!contacts.length ? <p className="help">Add a contact first.</p> : null}
    </Dialog>
  );
}

export function ScheduledCallsDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Sched[] | null>(null); const [adding, setAdding] = useState(false);
  const load = () => api.get('/api/calls/scheduled').then((r) => setList(r.scheduled)).catch(() => setList([]));
  useEffect(() => { void load(); }, []);
  if (adding) return <ScheduleCallDialog onClose={() => setAdding(false)} onDone={() => void load()} />;
  return (
    <Dialog title="Scheduled calls" onClose={onClose}>
      {!list ? <div className="spinner" /> : list.length ? <ul className="stack-sm">{list.map((s) => (
        <li key={s.id} className="person"><span className="action-ico"><Icon name={s.kind === 'video' ? 'video' : 'phone'} size={20} /></span>
          <span className="grow" style={{ textAlign: 'left' }}><b className="truncate" style={{ display: 'block' }}>{s.other.displayName}</b><small className="muted">{new Date(s.startsAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{s.note ? ` · ${s.note}` : ''}</small></span>
          <button className="btn btn-soft btn-sm" onClick={() => { onClose(); void callContact(s.other.id, s.kind); }}>Call now</button>
          <button className="icon-btn" aria-label={`Cancel call with ${s.other.displayName}`} onClick={async () => { await guard(api.del(`/api/calls/scheduled/${s.id}`)); await load(); }}><Icon name="trash" size={18} /></button></li>))}</ul>
        : <p className="muted">Nothing scheduled.</p>}
      <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="cal-clock" size={18} />Schedule a call</button>
    </Dialog>
  );
}
void go;
