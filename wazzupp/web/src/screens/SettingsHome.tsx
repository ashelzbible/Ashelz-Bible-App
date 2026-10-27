import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api } from '../lib/api.ts';
import { APP_VERSION } from '../lib/version.ts';
import { clock, convTitle } from '../lib/format.ts';
import { back, go, useLayout, useRoute } from '../lib/route.ts';
import { toast, useStore } from '../lib/store.ts';
import type { Msg, Settings as S } from '../lib/types.ts';
import { guard, logout, patchState, toastError } from '../lib/actions.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Dialog } from '../ui/Overlay.tsx';
import { Row, Section, Toggle } from '../ui/Misc.tsx';
import { PaneFrame } from './Frame.tsx';
import { BroadcastDialog } from './Dialogs.tsx';
import { saveSettings } from './Settings.tsx';
import { MUSIC_CHANGED, addSongs, type UploadItem } from '../lib/music.ts';
import { useMedia } from '../lib/mediaCache.ts';
import type { Track } from './StatusTools.tsx';

export const profileLink = (username: string) => `${location.origin}/#/chats/u/${username}`;

/* ---------- home ---------- */
const ITEMS: Array<[string, string, IconName, string, boolean?]> = [
  ['devices', 'Linked devices', 'laptop', 'Phones, tablets and computers'], ['account', 'Account', 'key', 'Security, password, delete account'], ['privacy', 'Privacy', 'lock', 'Who can see your info, receipts, blocked contacts'],
  ['folders', 'Lists', 'folder', 'Organise your chats into folders'], ['chats', 'Chats', 'chat', 'Archive, clear, export'], ['appearance', 'Appearance', 'palette', 'Theme, text size, wallpaper'],
  ['music', 'My music', 'music', 'Add songs for your status updates'], ['broadcasts', 'Broadcasts', 'megaphone', 'Send one message to many people'], ['events', 'Events', 'calendar', 'Plans shared in your chats', true], ['notifications', 'Notifications', 'bell', 'Messages, calls, quiet hours'],
  ['storage', 'Storage and data', 'disk', 'Usage and media auto-download'], ['accessibility', 'Accessibility', 'eye', 'Contrast and motion'], ['language', 'App language', 'translate', 'English'],
  ['help', 'Help and feedback', 'help', 'FAQs, contact us, report a problem'], ['invite', 'Invite a friend', 'user-plus', 'Share your profile link'], ['updates', 'App updates', 'refresh', `Version ${APP_VERSION}`],
];

export function SettingsMenu() {
  const me = useStore((s) => s.me!); const route = useRoute(); const layout = useLayout();
  const [dlg, setDlg] = useState<null | 'qr' | 'mood' | 'broadcast' | 'invite' | 'updates'>(null); const [q, setQ] = useState<string | null>(null);
  const shown = ITEMS.filter(([, t, , s]) => !q || (t + ' ' + s).toLowerCase().includes(q.toLowerCase()));
  const open = (id: string) => { if (id === 'broadcasts') setDlg('broadcast'); else if (id === 'invite') setDlg('invite'); else if (id === 'updates') setDlg('updates'); else go(`settings/${id}`); };
  return (
    <PaneFrame title="Settings" plain overlay={null}>
      <div className="set-hero wallpaper">
        <div className="set-hero-tools">
          <button className="icon-btn" onClick={() => setQ(q === null ? '' : null)} aria-label="Search settings"><Icon name="search" /></button><span className="grow" />
          <button className="icon-btn" onClick={() => setDlg('qr')} aria-label="My QR code"><Icon name="qr" /></button>
          <button className="icon-btn" onClick={() => go('settings/profile')} aria-label="Edit profile"><Icon name="edit" /></button>
        </div>
        <div className="set-hero-av"><Avatar id={me.id} name={me.displayName} mediaId={me.avatarMediaId} size={92} />
          <button className="mood-bubble" onClick={() => setDlg('mood')} aria-label="Edit current mood">{me.statusText || 'Current mood'}</button></div>
        <button className="set-hero-name" onClick={() => go('settings/profile')}><b>{me.displayName}</b><Icon name="right" size={18} /></button>
        <small>@{me.username}</small>
      </div>
      {q !== null ? <div className="m-search call-search"><Icon name="search" size={18} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" aria-label="Search settings" /></div> : null}
      <ul className="conv-list">{shown.map(([id, title, icon, sub, isNew]) => (
        <li key={id}><button className={`conv-row set-menu ${route.tab === 'settings' && route.id === id && layout !== 'mobile' ? 'sel' : ''}`} onClick={() => open(id)}>
          <span className="set-ico"><Icon name={icon} size={20} /></span>
          <span className="conv-main"><span className="conv-name">{title}{isNew ? <em className="new-pill">New</em> : null}</span><span className="conv-prev">{id === 'language' ? languageName(me.settings.appearance.language) : sub}</span></span></button></li>))}
        {!shown.length ? <li className="help pad">No settings match “{q}”.</li> : null}
        <li><button className="conv-row set-menu" onClick={() => logout()}><span className="set-ico danger"><Icon name="logout" size={20} /></span><span className="conv-main"><span className="conv-name" style={{ color: 'var(--danger)' }}>Sign out</span></span></button></li>
      </ul>
      {dlg === 'qr' ? <QrDialog onClose={() => setDlg(null)} /> : null}
      {dlg === 'mood' ? <MoodDialog onClose={() => setDlg(null)} /> : null}
      {dlg === 'broadcast' ? <BroadcastDialog onClose={() => setDlg(null)} /> : null}
      {dlg === 'invite' ? <InviteDialog onClose={() => setDlg(null)} /> : null}
      {dlg === 'updates' ? <UpdatesDialog onClose={() => setDlg(null)} /> : null}
    </PaneFrame>
  );
}
const LANGS: Array<[string, string]> = [['en', 'English'], ['af', 'Afrikaans'], ['zu', 'isiZulu'], ['xh', 'isiXhosa'], ['st', 'Sesotho'], ['fr', 'Français'], ['pt', 'Português'], ['es', 'Español'], ['de', 'Deutsch'], ['sw', 'Kiswahili'], ['ar', 'العربية']];
const languageName = (c: string) => LANGS.find(([k]) => k === c)?.[1] ?? c;

function MoodDialog({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me!); const [v, setV] = useState(me.statusText);
  return <Dialog title="Current mood" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={async () => { const r = await guard(api.patch('/api/me', { statusText: v.trim() })); if (r !== undefined) { const { refreshMe } = await import('../lib/actions.ts'); await refreshMe(); onClose(); } }}>Save</button></>}>
    <label className="field"><span className="label-t">What’s on your mind?</span><input className="input" autoFocus maxLength={140} value={v} onChange={(e) => setV(e.target.value)} placeholder="Feeling grateful 🙏" /></label>
    <div className="row wrap" style={{ gap: 8 }}>{['Available', 'At work', 'In a meeting', 'Busy', 'Feeling grateful 🙏', 'Out and about'].map((m) => <button key={m} className="chip" onClick={() => setV(m)}>{m}</button>)}</div>
  </Dialog>;
}

export function QrDialog({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me!); const link = profileLink(me.username);
  const svg = useMemo(() => { const q = qrcode(0, 'M'); q.addData(link); q.make(); return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }, [link]);
  return <Dialog title="My QR code" onClose={onClose} footer={<button className="btn btn-primary" onClick={() => { navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => toast(link)); }}>Copy link</button>}>
    <div className="qr-card"><Avatar id={me.id} name={me.displayName} mediaId={me.avatarMediaId} size={56} /><b>{me.displayName}</b><small className="muted">@{me.username}</small><div className="qr" dangerouslySetInnerHTML={{ __html: svg }} /></div>
    <p className="help">Anyone who scans this code, or opens the link, can start a chat with you. It only contains your username.</p></Dialog>;
}
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me!); const link = profileLink(me.username); const text = `Chat with me on Wazzupp: ${link}`;
  return <Dialog title="Invite a friend" onClose={onClose} footer={<>{typeof navigator.share === 'function' ? <button className="btn btn-outline" onClick={() => navigator.share({ title: 'Wazzupp', text, url: link }).catch(() => {})}>Share…</button> : null}<button className="btn btn-primary" onClick={() => { navigator.clipboard?.writeText(text).then(() => toast('Invite copied'), () => toast(link)); }}>Copy invite</button></>}>
    <p>Send this link to a friend. When they open it and sign in or sign up, they can message you straight away.</p><input className="input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" /></Dialog>;
}
export function UpdatesDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<'idle' | 'checking' | 'latest' | 'ready' | 'unsupported'>('idle');
  async function check() {
    setState('checking');
    try {
      const reg = await navigator.serviceWorker?.getRegistration(); if (!reg) { setState('unsupported'); return; }
      await reg.update(); setState(reg.waiting || reg.installing ? 'ready' : 'latest');
    } catch { setState('latest'); }
  }
  return <Dialog title="App updates" onClose={onClose} footer={state === 'ready' ? <button className="btn btn-primary" onClick={() => location.reload()}>Restart to update</button> : <button className="btn btn-primary" onClick={() => void check()} disabled={state === 'checking'}>{state === 'checking' ? 'Checking…' : 'Check for updates'}</button>}>
    <p><b>Wazzupp {APP_VERSION}</b></p>
    <p className="muted">{state === 'latest' ? 'You’re up to date.' : state === 'ready' ? 'A new version is ready. Restart to use it.' : state === 'unsupported' ? 'Updates are applied automatically whenever you open the app in this browser.' : 'The web app updates itself in the background; check here to update right now.'}</p></Dialog>;
}

/* ---------- pages ---------- */
function Page({ title, children, actions, search }: { title: string; children: React.ReactNode; actions?: React.ReactNode; search?: React.ReactNode }) {
  const layout = useLayout();
  return <div className="settings-page"><header className="page-head">{layout !== 'desktop' ? <button className="icon-btn on-head" onClick={() => back()} aria-label="Back"><Icon name="back" /></button> : null}<h2 className="grow">{title}</h2>{actions}</header>{search}<div className="page-body">{children}</div></div>;
}

export function StatusPrivacyPage() {
  const p = useStore((s) => s.me!.settings.privacy); const contacts = useStore((s) => s.contacts);
  const [pick, setPick] = useState<null | 'statusExcept' | 'statusOnly'>(null);
  const opt = (k: S['privacy']['statusAudience'], title: string, icon: IconName, sub?: React.ReactNode) => (
    <button key={k} className="radio-row" onClick={() => void saveSettings({ privacy: { statusAudience: k } })} role="radio" aria-checked={p.statusAudience === k}>
      <span className="set-ico"><Icon name={icon} size={20} /></span><span className="grow" style={{ textAlign: 'left' }}><b>{title}</b>{sub ? <span className="set-s">{sub}</span> : null}</span><span className={`radio ${p.statusAudience === k ? 'on' : ''}`} /></button>);
  const ex = (p.statusExcept ?? []).length, on = (p.statusOnly ?? []).length;
  return (
    <Page title="Status privacy"><div className="form-narrow">
      <p className="muted pad">Who can see my status updates</p>
      <div className="set-card" role="radiogroup">
        {opt('contacts', 'My contacts', 'users')}
        {opt('except', 'My contacts except…', 'user', <button className="link-btn" onClick={(e) => { e.stopPropagation(); setPick('statusExcept'); }}>{ex} excluded · Edit ›</button>)}
        {opt('only', 'Only share with…', 'user-plus', <button className="link-btn" onClick={(e) => { e.stopPropagation(); setPick('statusOnly'); }}>{on} included · Edit ›</button>)}
      </div>
      <p className="help pad">Changes to your privacy settings won’t affect status updates that you’ve already sent.</p>
      <Section><Row icon="share" title="Allow sharing" sub="Let people who can see your updates forward them to their chats" right={<Toggle checked={p.statusSharing !== false} label="Allow sharing" onChange={(v) => void saveSettings({ privacy: { statusSharing: v } })} />} /></Section>
      <p className="help pad">Status updates you share with other people can be forwarded by them when this is on. Each update remembers the setting it was posted with.</p>
      {pick ? <ContactListDialog title={pick === 'statusExcept' ? 'Hide my status from' : 'Share my status only with'} value={(p[pick] ?? []) as string[]} contacts={contacts} onClose={() => setPick(null)} onSave={(ids) => { void saveSettings({ privacy: { [pick]: ids } }); setPick(null); }} /> : null}
    </div></Page>
  );
}
function ContactListDialog({ title, value, contacts, onClose, onSave }: { title: string; value: string[]; contacts: Array<{ id: string; displayName: string; username: string }>; onClose: () => void; onSave: (ids: string[]) => void }) {
  const [sel, setSel] = useState(new Set(value)); const [q, setQ] = useState('');
  const list = contacts.filter((c) => !q || c.displayName.toLowerCase().includes(q.toLowerCase()) || c.username.includes(q.toLowerCase()));
  return <Dialog title={title} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => onSave([...sel])}>Done{sel.size ? ` (${sel.size})` : ''}</button></>}>
    <input className="input" placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" />
    <div className="stack-sm" style={{ maxHeight: 340, overflow: 'auto', marginTop: 8 }}>{list.map((c) => <label key={c.id} className="check-row"><input type="checkbox" checked={sel.has(c.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} /><Avatar id={c.id} name={c.displayName} size={36} />{c.displayName}</label>)}{!list.length ? <p className="help">No contacts found.</p> : null}</div></Dialog>;
}

export function StarredPage() {
  const [list, setList] = useState<Array<Msg & { senderName?: string; chat?: { kind: string; title: string | null } }> | null>(null); const meId = useStore((s) => s.me!.id); const convs = useStore((s) => s.convs);
  const [q, setQ] = useState<string | null>(null); const [menu, setMenu] = useState(false);
  const load = () => api.get('/api/starred').then((r) => setList(r.messages)).catch(() => setList([]));
  useEffect(() => { void load(); }, []);
  const rows = (list ?? []).filter((m) => !q || m.body.toLowerCase().includes(q.toLowerCase()));
  const dayOf = (d: string) => new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const unstarAll = async () => { await Promise.all((list ?? []).map((m) => api.put(`/api/messages/${m.id}/star`, { starred: false }).catch(() => {}))); setMenu(false); void load(); };
  return (
    <Page title="Starred" actions={<><button className="icon-btn" onClick={() => setQ(q === null ? '' : null)} aria-label="Search starred"><Icon name="search" /></button><span className="rel"><button className="icon-btn" onClick={() => setMenu((v) => !v)} aria-label="More options"><Icon name="more" /></button>{menu ? <div className="mini-menu"><button onClick={() => void unstarAll()} disabled={!list?.length}>Unstar all</button></div> : null}</span></>}
      search={q !== null ? <div className="m-search call-search"><Icon name="search" size={18} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search starred messages" aria-label="Search starred messages" /></div> : undefined}>
      {!list ? <div className="spinner" /> : rows.length ? <ul className="starred-list">{rows.map((m) => {
        const mine = m.senderId === meId; const chat = m.chat?.title ?? (convs[m.conversationId] ? convTitle(convs[m.conversationId]) : 'Chat');
        return <li key={m.id}><button onClick={() => go(`chats/${m.conversationId}/m/${m.seq}`)}>
          <span className="st-meta"><b>{mine ? 'You' : m.senderName ?? 'Someone'}</b> <Icon name="right" size={12} /> <b>{mine ? chat : 'You'}</b><time>{dayOf(m.createdAt)}</time></span>
          <span className={`st-bub ${mine ? 'out' : ''}`}>{m.body || `📎 ${m.kind}`}<small><Icon name="star" size={11} fill /> {clock(m.createdAt)}</small></span></button></li>; })}</ul>
        : <div className="empty pad"><div className="empty-art"><Icon name="star" size={38} stroke={1.6} /></div><h3>{q ? 'Nothing found' : 'No starred messages'}</h3><p>Tap and hold any message, then choose Star, to find it here later.</p></div>}
    </Page>
  );
}

export function EventsPage() {
  const [list, setList] = useState<Array<Msg & { chat: { id: string; title: string | null } }> | null>(null);
  useEffect(() => { api.get('/api/events').then((r) => setList(r.events)).catch((e) => { toastError(e); setList([]); }); }, []);
  const ics = (m: Msg) => { const e = m.meta; const d = new Date(e.startsAt); const f = (x: Date) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wazzupp//EN', 'BEGIN:VEVENT', `UID:${m.id}@wazzupp`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(d)}`, `DTEND:${f(new Date(d.getTime() + 3600000))}`, `SUMMARY:${String(e.title).replace(/[\r\n]/g, ' ')}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' })); a.download = 'event.ics'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  return <Page title="Events"><div className="form-narrow">
    <p className="muted">Events shared in your chats. To plan one, open a chat and choose Attach → Event.</p>
    {!list ? <div className="spinner" /> : list.length ? <ul className="stack-sm">{list.map((m) => { const d = new Date(m.meta.startsAt); return <li key={m.id} className="event-card"><span className="event-date"><b>{d.getDate()}</b><small>{d.toLocaleDateString(undefined, { month: 'short' })}</small></span><span className="grow"><b>{m.meta.title}</b><small className="muted" style={{ display: 'block' }}>{d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}{m.meta.location ? ` · ${m.meta.location}` : ''} · {m.chat.title ?? 'Chat'}</small></span>
      <button className="btn btn-soft btn-sm" onClick={() => ics(m)}>Add to calendar</button><button className="btn btn-outline btn-sm" onClick={() => go(`chats/${m.conversationId}/m/${m.seq}`)}>Open</button></li>; })}</ul>
      : <div className="empty pad"><div className="empty-art"><Icon name="calendar" size={38} stroke={1.6} /></div><h3>No upcoming events</h3><p>Events you or your contacts create in chats will show up here.</p></div>}
  </div></Page>;
}

export function ChatsPage() {
  const convs = useStore((s) => s.convs); const [dlg, setDlg] = useState<null | 'archive' | 'clear'>(null);
  const ids = Object.keys(convs); const active = ids.filter((i) => !convs[i].archived);
  const run = async (kind: 'archive' | 'clear') => {
    const list = kind === 'archive' ? active : ids;
    await Promise.all(list.map((id) => (kind === 'archive' ? patchState(id, { archived: true }) : api.post(`/api/conversations/${id}/clear`)).catch(() => {})));
    toast(kind === 'archive' ? 'All chats archived' : 'All chats cleared'); setDlg(null);
  };
  return <Page title="Chats"><div className="form-narrow">
    <Section title="Look and feel"><Row icon="palette" title="Theme, wallpaper and text size" onClick={() => go('settings/appearance')} /><Row icon="folder" title="Lists" sub="Organise chats into folders" onClick={() => go('settings/folders')} /></Section>
    <Section title="Chat history"><Row icon="cloud" title="Export my data" sub="Download everything Wazzupp holds about you" onClick={() => go('settings/backup')} /><Row icon="archive" title="Archive all chats" onClick={() => setDlg('archive')} /><Row icon="trash" danger title="Clear all chats" sub="Removes the messages from your view only" onClick={() => setDlg('clear')} /></Section>
    {dlg ? <Dialog title={dlg === 'archive' ? 'Archive all chats?' : 'Clear all chats?'} onClose={() => setDlg(null)} footer={<><button className="btn btn-ghost" onClick={() => setDlg(null)}>Cancel</button><button className={`btn ${dlg === 'clear' ? 'btn-danger' : 'btn-primary'}`} onClick={() => void run(dlg)}>{dlg === 'archive' ? 'Archive' : 'Clear'}</button></>}><p>{dlg === 'archive' ? 'Your chats move to Archived. New messages bring them back.' : 'All messages are removed from your view on this account. Other people keep their copies.'}</p></Dialog> : null}
  </div></Page>;
}

export function AccessibilityPage() {
  const a = useStore((s) => s.me!.settings.appearance);
  return <Page title="Accessibility"><div className="form-narrow"><Section>
    <Row icon="eye" title="High contrast" sub="Stronger borders and text for easier reading" right={<Toggle checked={!!a.highContrast} label="High contrast" onChange={(v) => void saveSettings({ appearance: { highContrast: v } })} />} />
    <Row icon="play" title="Reduce motion" sub="Fewer animations and transitions" right={<Toggle checked={!!a.reduceMotion} label="Reduce motion" onChange={(v) => void saveSettings({ appearance: { reduceMotion: v } })} />} />
    <Row icon="doc" title="Text size" sub="Make messages and menus larger" right={<select className="select compact" aria-label="Text size" value={a.fontSize} onChange={(e) => void saveSettings({ appearance: { fontSize: e.target.value } })}><option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option></select>} />
  </Section></div></Page>;
}
export function LanguagePage() {
  const lang = useStore((s) => s.me!.settings.appearance.language);
  return <Page title="App language"><div className="form-narrow"><p className="muted pad">Choose your preferred language. Wazzupp’s screens are currently in English; your choice is saved to your account and used as translations are added.</p><div className="set-card" role="radiogroup">{LANGS.map(([k, n]) => <button key={k} className="radio-row" role="radio" aria-checked={lang === k} onClick={() => void saveSettings({ appearance: { language: k } })}><span className="grow" style={{ textAlign: 'left' }}><b>{n}</b></span><span className={`radio ${lang === k ? 'on' : ''}`} /></button>)}</div></div></Page>;
}

export function HelpFeedbackPage() {
  const [kind, setKind] = useState<'feedback' | 'bug' | 'idea'>('feedback'); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const faq: Array<[string, string]> = [['How do I verify my account?', 'Enter the 6-digit code sent to your email or phone when you register. You can request another code from the verification screen.'], ['Can I use Wazzupp on several devices?', 'Yes. Sign in with the same account on each device; chats, read state and settings stay in sync.'], ['Are my messages end-to-end encrypted?', 'Not yet. Messages are protected in transit and with server-side access control; Wazzupp’s servers can technically read them.'], ['How do status updates work?', 'Updates disappear after 24 hours and are shown only to the audience you choose.']];
  return <Page title="Help and feedback"><div className="form-narrow">
    <Section title="Common questions">{faq.map(([q, a]) => <details key={q} className="faq"><summary>{q}</summary><p>{a}</p></details>)}</Section>
    <Section title="Contact us"><div className="pad stack-sm">
      <div className="seg">{(['feedback', 'bug', 'idea'] as const).map((k) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'bug' ? 'Report a problem' : k === 'idea' ? 'Suggest an idea' : 'Feedback'}</button>)}</div>
      <textarea className="textarea" rows={5} maxLength={4000} placeholder="Tell us what happened or what you’d like to see" value={text} onChange={(e) => setText(e.target.value)} aria-label="Your message" />
      <button className="btn btn-primary" disabled={busy || text.trim().length < 5} onClick={async () => { setBusy(true); try { await api.post('/api/feedback', { kind, message: text.trim(), appVersion: APP_VERSION }); setText(''); toast('Thanks, we received your message'); } catch (e) { toastError(e); } finally { setBusy(false); } }}>Send</button></div></Section>
    <Section><Row icon="doc" title="Terms and privacy policy" onClick={() => go('settings/legal')} /></Section>
  </div></Page>;
}

/* ---------- My music: add songs in bulk, edit, star, delete. Lives on the server, so it syncs to every device. ---------- */
export function MyMusicPage() {
  const [data, setData] = useState<{ tracks: Track[]; moods: string[]; genres: string[] } | null>(null);
  const [q, setQ] = useState(''); const [sel, setSel] = useState<Set<string> | null>(null); const [queue, setQueue] = useState<UploadItem[]>([]);
  const [edit, setEdit] = useState<Track | null>(null); const [bulk, setBulk] = useState(false); const [over, setOver] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null); const audio = useRef<HTMLAudioElement>(null); const pick = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api.get(`/api/music?tab=suggested&q=${encodeURIComponent(q.trim())}`).then(setData).catch(toastError), [q]);
  useEffect(() => { const t = setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { window.addEventListener(MUSIC_CHANGED, load); return () => window.removeEventListener(MUSIC_CHANGED, load); }, [load]); // another device changed the library
  const upload = async (files: File[]) => {
    const audioFiles = files.filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|wav|flac|webm)$/i.test(f.name));
    if (!audioFiles.length) { toast('Choose audio files (MP3, M4A, WAV, OGG…)', 'error'); return; }
    if (audioFiles.length < files.length) toast(`${files.length - audioFiles.length} file(s) skipped: not audio`);
    const n = await addSongs(audioFiles, setQueue); toast(n === audioFiles.length ? `${n} song${n === 1 ? '' : 's'} added` : `${n} of ${audioFiles.length} added`, n ? undefined : 'error'); void load();
  };
  const tracks = data?.tracks ?? [];
  const toggle = (id: string) => setSel((s) => { const n = new Set(s ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const removeSel = async () => { const ids = [...(sel ?? [])]; await Promise.all(ids.map((id) => api.del(`/api/music/${id}`).catch(() => {}))); setSel(null); void load(); toast(`${ids.length} removed`); };
  return (
    <Page title="My music" actions={tracks.length ? <button className="btn btn-ghost btn-sm" onClick={() => setSel(sel ? null : new Set())}>{sel ? 'Done' : 'Select'}</button> : undefined}>
      <div className="form-narrow" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); void upload([...e.dataTransfer.files]); }}>
        <div className={`drop-zone ${over ? 'over' : ''}`}>
          <Icon name="music" size={30} /><b>Add songs to use in your status updates</b>
          <p className="muted">Pick as many files as you like, or drop them here. They sync automatically to all your devices. Only add music you have the right to share.</p>
          <button className="btn btn-primary" onClick={() => pick.current?.click()}><Icon name="plus" size={18} />Add songs</button>
          <input ref={pick} type="file" multiple hidden accept="audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac" onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) void upload(fs); }} />
        </div>
        {queue.length ? <Section title={`Uploading ${queue.filter((i) => i.state === 'done').length} of ${queue.length}`}>{queue.map((i) => (
          <Row key={i.id} icon={i.state === 'done' ? 'check' : i.state === 'failed' ? 'info' : 'music'} title={<span className="truncate" style={{ display: 'block' }}>{i.name}</span>} sub={i.state === 'failed' ? i.error : i.state === 'done' ? 'Added' : i.state === 'uploading' ? `${Math.round(i.progress * 100)}%` : 'Waiting'}
            right={i.state === 'failed' ? <button className="btn btn-outline btn-sm" onClick={() => void upload([i.file])}>Retry</button> : undefined} />))}
          {queue.every((i) => i.state === 'done' || i.state === 'failed') ? <Row title="Clear this list" onClick={() => setQueue([])} /> : null}</Section> : null}
        {data ? <input className="input" placeholder={`Search your ${tracks.length || ''} songs`.replace('  ', ' ')} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search my music" style={{ marginTop: 12 }} /> : <div className="spinner" />}
        {sel ? <div className="row" style={{ gap: 8, margin: '10px 0' }}><span className="grow muted">{sel.size} selected</span><button className="btn btn-soft btn-sm" onClick={() => setSel(new Set(tracks.map((t) => t.id)))}>All</button><button className="btn btn-soft btn-sm" disabled={!sel.size} onClick={() => setBulk(true)}>Set mood / genre</button><button className="btn btn-danger-ghost btn-sm" disabled={!sel.size} onClick={() => void removeSel()}>Delete</button></div> : null}
        {data && !tracks.length ? <p className="help pad">{q ? 'No songs match.' : 'No songs yet. Add some above.'}</p> : null}
        <Section>{tracks.map((t) => (
          <div key={t.id} className="set-row">
            {sel ? <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.title}`} /> : null}
            <PlayBtn t={t} playing={playing === t.id} onToggle={() => setPlaying(playing === t.id ? null : t.id)} audio={audio} />
            <span className="grow" style={{ textAlign: 'left', minWidth: 0 }}><span className="set-t truncate" style={{ display: 'block' }}>{t.title}</span><span className="set-s truncate" style={{ display: 'block' }}>{[t.artist, t.mood, t.genre].filter(Boolean).join(' · ') || 'No details'}</span></span>
            <button className="icon-btn" aria-label={t.starred ? `Unstar ${t.title}` : `Star ${t.title}`} onClick={async () => { await api.patch(`/api/music/${t.id}`, { starred: !t.starred }).catch(toastError); void load(); }}><Icon name="star" size={20} fill={t.starred} /></button>
            <button className="icon-btn" aria-label={`Edit ${t.title}`} onClick={() => setEdit(t)}><Icon name="edit" size={20} /></button>
            <button className="icon-btn" aria-label={`Delete ${t.title}`} onClick={async () => { await api.del(`/api/music/${t.id}`).catch(toastError); void load(); }}><Icon name="trash" size={20} /></button>
          </div>))}</Section>
        <audio ref={audio} onEnded={() => setPlaying(null)} />
      </div>
      {edit ? <EditSong t={edit} moods={data?.moods ?? []} genres={data?.genres ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} /> : null}
      {bulk ? <BulkTags ids={[...(sel ?? [])]} moods={data?.moods ?? []} genres={data?.genres ?? []} onClose={() => setBulk(false)} onSaved={() => { setBulk(false); setSel(null); void load(); }} /> : null}
    </Page>
  );
}
function PlayBtn({ t, playing, onToggle, audio }: { t: Track; playing: boolean; onToggle: () => void; audio: React.RefObject<HTMLAudioElement | null> }) {
  const m = useMedia(playing ? t.mediaId : null);
  useEffect(() => { const a = audio.current; if (!a) return; if (playing && m) { a.src = m.url; void a.play().catch(() => {}); } else a.pause(); }, [playing, m?.url]);  // eslint-disable-line
  return <button className="icon-btn" onClick={onToggle} aria-label={playing ? `Pause ${t.title}` : `Play ${t.title}`}><Icon name={playing ? 'pause' : 'play'} size={20} fill /></button>;
}
function EditSong({ t, moods, genres, onClose, onSaved }: { t: Track; moods: string[]; genres: string[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(t.title); const [artist, setArtist] = useState(t.artist); const [mood, setMood] = useState(t.mood); const [genre, setGenre] = useState(t.genre);
  return <Dialog title="Edit song" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!title.trim()} onClick={async () => { await guard(api.patch(`/api/music/${t.id}`, { title: title.trim(), artist: artist.trim(), mood, genre })); onSaved(); }}>Save</button></>}>
    <label className="field"><span className="label-t">Title</span><input className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
    <label className="field"><span className="label-t">Artist</span><input className="input" value={artist} maxLength={120} onChange={(e) => setArtist(e.target.value)} /></label>
    <label className="field"><span className="label-t">Mood</span><select className="select" value={mood} onChange={(e) => setMood(e.target.value)}><option value="">None</option>{moods.map((m) => <option key={m}>{m}</option>)}</select></label>
    <label className="field"><span className="label-t">Genre</span><select className="select" value={genre} onChange={(e) => setGenre(e.target.value)}><option value="">None</option>{genres.map((g) => <option key={g}>{g}</option>)}</select></label>
  </Dialog>;
}
function BulkTags({ ids, moods, genres, onClose, onSaved }: { ids: string[]; moods: string[]; genres: string[]; onClose: () => void; onSaved: () => void }) {
  const [mood, setMood] = useState('-'); const [genre, setGenre] = useState('-'); // "-" means leave unchanged
  return <Dialog title={`Set tags for ${ids.length} song${ids.length === 1 ? '' : 's'}`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={async () => { await Promise.all(ids.map((id) => api.patch(`/api/music/${id}`, { ...(mood !== '-' ? { mood } : {}), ...(genre !== '-' ? { genre } : {}) }).catch(() => {}))); onSaved(); }}>Apply</button></>}>
    <label className="field"><span className="label-t">Mood</span><select className="select" value={mood} onChange={(e) => setMood(e.target.value)}><option value="-">Leave as is</option><option value="">Clear</option>{moods.map((m) => <option key={m}>{m}</option>)}</select></label>
    <label className="field"><span className="label-t">Genre</span><select className="select" value={genre} onChange={(e) => setGenre(e.target.value)}><option value="-">Leave as is</option><option value="">Clear</option>{genres.map((g) => <option key={g}>{g}</option>)}</select></label>
  </Dialog>;
}
