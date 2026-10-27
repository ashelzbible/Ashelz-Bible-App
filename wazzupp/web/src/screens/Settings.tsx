import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { bytes, ago, convTitle } from '../lib/format.ts';
import { back, go, useLayout, useRoute } from '../lib/route.ts';
import { getState, setState, toast, useStore } from '../lib/store.ts';
import type { Msg, Settings as S } from '../lib/types.ts';
import { guard, loadFolders, logout, refreshMe, toastError, loadContacts } from '../lib/actions.ts';
import { applyAppearance } from '../lib/theme.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Confirm, Dialog } from '../ui/Overlay.tsx';
import { Row, Section, Toggle } from '../ui/Misc.tsx';
import { AccessibilityPage, ChatsPage, EventsPage, HelpFeedbackPage, LanguagePage, StarredPage, StatusPrivacyPage } from './SettingsHome.tsx';
import { uploadWithProgress } from '../lib/api.ts';

export async function saveSettings(patch: Record<string, any>) {
  const me = getState().me!;
  const merge = (a: any, b: any): any => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a?.[k] ?? {}, v) : v; return o; };
  const optimistic = merge(me.settings, patch);
  setState({ me: { ...me, settings: optimistic } });
  if (patch.appearance) applyAppearance(optimistic.appearance);
  try {
    const r = await api.patch('/api/me/settings', { baseVersion: me.settingsVersion, patch });
    setState((s) => ({ me: { ...s.me!, settings: r.settings, settingsVersion: r.version } }));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'version_conflict') { // another device changed settings: take theirs, re-apply this change on top
      const cur = e.details; setState((s) => ({ me: { ...s.me!, settings: cur.settings, settingsVersion: cur.version } }));
      try { const r = await api.patch('/api/me/settings', { baseVersion: cur.version, patch }); setState((s) => ({ me: { ...s.me!, settings: r.settings, settingsVersion: r.version } })); } catch (e2) { toastError(e2); await refreshMe(); }
    } else { toastError(e); await refreshMe(); }
  }
}

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  const layout = useLayout();
  return <div className="settings-page"><header className="page-head">{layout !== 'desktop' ? <button className="icon-btn on-head" onClick={() => back()} aria-label="Back"><Icon name="back" /></button> : null}<h2>{title}</h2></header><div className="page-body">{children}</div></div>;
}

const AUD = [['everyone', 'Everyone'], ['contacts', 'My contacts'], ['nobody', 'Nobody']] as const;
function Select({ value, options, onChange, label }: { value: string; options: ReadonlyArray<readonly [string, string]>; onChange: (v: string) => void; label: string }) {
  return <select className="select compact" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
}

export function SettingsPage({ section }: { section?: string }) {
  switch (section) {
    case 'profile': return <ProfilePage />;
    case 'account': return <AccountPage />;
    case 'privacy': return <PrivacyPage />;
    case 'blocked': return <BlockedPage />;
    case 'notifications': return <NotificationsPage />;
    case 'appearance': return <AppearancePage />;
    case 'folders': return <FoldersPage />;
    case 'starred': return <StarredPage />;
    case 'status-privacy': return <StatusPrivacyPage />;
    case 'events': return <EventsPage />;
    case 'chats': return <ChatsPage />;
    case 'accessibility': return <AccessibilityPage />;
    case 'language': return <LanguagePage />;
    case 'storage': return <StoragePage />;
    case 'devices': return <DevicesPage />;
    case 'backup': return <BackupPage />;
    case 'help': return <HelpFeedbackPage />;
    case 'legal': return <LegalPage />;
    default: return <div className="conv-empty"><div className="empty"><div className="empty-art"><Icon name="settings" size={38} stroke={1.6} /></div><h3>Settings</h3><p>Choose a category on the left.</p></div></div>;
  }
}

function ProfilePage() {
  const me = useStore((s) => s.me!);
  const [name, setName] = useState(me.displayName); const [bio, setBio] = useState(me.bio); const [about, setAbout] = useState(me.statusText); const [uname, setUname] = useState(me.username); const [busy, setBusy] = useState(false);
  const pick = async (f?: File) => {
    if (!f) return;
    try { const r = await uploadWithProgress(f, f.name, 'avatar', {}, () => {}).promise; await api.patch('/api/me', { avatarMediaId: r.media.id }); await refreshMe(); toast('Profile photo updated'); } catch (e) { toastError(e); }
  };
  return (
    <Page title="Profile"><div className="form-narrow">
      <div className="avatar-edit"><Avatar id={me.id} name={me.displayName} mediaId={me.avatarMediaId} size={112} /><label className="btn btn-soft btn-sm"><Icon name="camera" size={16} />Change photo<input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} /></label>
        {me.avatarMediaId ? <button className="btn btn-danger-ghost btn-sm" onClick={async () => { await guard(api.patch('/api/me', { avatarMediaId: null })); await refreshMe(); }}>Remove</button> : null}</div>
      <label className="field"><span className="label-t">Name</span><input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span className="label-t">Username</span><input className="input" value={uname} maxLength={32} onChange={(e) => setUname(e.target.value)} /><span className="help">People can find you by username.</span></label>
      <label className="field"><span className="label-t">About</span><input className="input" value={about} maxLength={140} onChange={(e) => setAbout(e.target.value)} /></label>
      <label className="field"><span className="label-t">Biography</span><textarea className="textarea" value={bio} maxLength={300} onChange={(e) => setBio(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { await api.patch('/api/me', { displayName: name.trim(), statusText: about, bio, ...(uname !== me.username ? { username: uname } : {}) }); await refreshMe(); toast('Profile saved'); } catch (e) { toastError(e); } finally { setBusy(false); } }}>Save changes</button>
    </div></Page>
  );
}

function AccountPage() {
  const me = useStore((s) => s.me!);
  const [dlg, setDlg] = useState<null | 'pw' | 'mfa' | 'mfa-off' | 'delete'>(null);
  return (
    <Page title="Account & security"><div className="form-narrow">
      <Section title="Sign-in">
        <Row icon="mail" title="Email" sub={me.email ? `${me.email} ${me.emailVerified ? '· verified' : '· not verified'}` : 'Not set'} />
        <Row icon="phone" title="Phone" sub={me.phone ? `${me.phone} ${me.phoneVerified ? '· verified' : '· not verified'}` : 'Not set'} />
        <Row icon="key" title="Change password" sub="Signs you out of other devices" onClick={() => setDlg('pw')} />
        <Row icon="shield-check" title="Two-step verification" sub={me.mfaEnabled ? 'On: authenticator app' : 'Add an extra layer of protection'} onClick={() => setDlg(me.mfaEnabled ? 'mfa-off' : 'mfa')} right={<span className={`pill ${me.mfaEnabled ? 'on' : ''}`}>{me.mfaEnabled ? 'On' : 'Off'}</span>} />
      </Section>
      <Section title="Danger zone"><Row icon="trash" danger title="Delete my account" sub="Permanently removes your profile and erases your messages" onClick={() => setDlg('delete')} /></Section>
      {dlg === 'pw' ? <PasswordDialog onClose={() => setDlg(null)} /> : null}
      {dlg === 'mfa' ? <MfaSetup onClose={() => setDlg(null)} /> : null}
      {dlg === 'mfa-off' ? <MfaOff onClose={() => setDlg(null)} /> : null}
      {dlg === 'delete' ? <DeleteAccount onClose={() => setDlg(null)} /> : null}
    </div></Page>
  );
}
function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [a, setA] = useState(''); const [b, setB] = useState('');
  return <Dialog title="Change password" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!a || b.length < 10} onClick={async () => { await guard(api.post('/api/me/password', { currentPassword: a, newPassword: b })); toast('Password changed'); onClose(); }}>Change</button></>}>
    <label className="field"><span className="label-t">Current password</span><input className="input" type="password" autoComplete="current-password" value={a} onChange={(e) => setA(e.target.value)} /></label>
    <label className="field"><span className="label-t">New password</span><input className="input" type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} placeholder="At least 10 characters" /></label></Dialog>;
}
function MfaSetup({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<{ secret: string; otpauthUri: string } | null>(null); const [code, setCode] = useState('');
  useEffect(() => { api.post('/api/me/mfa/setup').then(setS).catch((e) => { toastError(e); onClose(); }); }, []);  
  return <Dialog title="Two-step verification" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={code.length !== 6} onClick={async () => { const r = await guard(api.post('/api/me/mfa/enable', { code })); if (r) { await refreshMe(); toast('Two-step verification is on'); onClose(); } }}>Turn on</button></>}>
    <p className="muted">Add this key to an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code.</p>
    {s ? <><code className="secret">{s.secret.match(/.{1,4}/g)?.join(' ')}</code><a className="link" href={s.otpauthUri}>Open in authenticator app</a></> : <div className="spinner" />}
    <input className="input code-input" inputMode="numeric" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-label="Authenticator code" />
  </Dialog>;
}
function MfaOff({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState(''); const [code, setCode] = useState('');
  return <Dialog title="Turn off two-step verification" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-danger" disabled={!pw || code.length !== 6} onClick={async () => { const r = await guard(api.post('/api/me/mfa/disable', { password: pw, code })); if (r) { await refreshMe(); onClose(); } }}>Turn off</button></>}>
    <label className="field"><span className="label-t">Password</span><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
    <label className="field"><span className="label-t">Authenticator code</span><input className="input code-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label></Dialog>;
}
function DeleteAccount({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState(''); const [c, setC] = useState('');
  return <Dialog title="Delete account" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-danger" disabled={!pw || c !== 'DELETE'} onClick={async () => { const r = await guard(api.del('/api/me', { password: pw, confirm: 'DELETE' }).then(() => true)); if (r) await logout(false); }}>Delete forever</button></>}>
    <p className="muted">This removes your profile, contacts, statuses and devices, and erases every message you sent. It cannot be undone. Consider exporting your data first.</p>
    <label className="field"><span className="label-t">Password</span><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
    <label className="field"><span className="label-t">Type DELETE to confirm</span><input className="input" value={c} onChange={(e) => setC(e.target.value)} /></label></Dialog>;
}

function PrivacyPage() {
  const p = useStore((s) => s.me!.settings.privacy);
  const set = (k: keyof S['privacy'], v: any) => saveSettings({ privacy: { [k]: v } });
  return (
    <Page title="Privacy"><div className="form-narrow">
      <Section title="Who can see my personal info">
        <Row title="Last seen & online" right={<Select label="Last seen" value={p.lastSeen} options={AUD} onChange={(v) => set('lastSeen', v)} />} />
        <Row title="Profile photo" right={<Select label="Profile photo" value={p.profilePhoto} options={AUD} onChange={(v) => set('profilePhoto', v)} />} />
        <Row title="About" right={<Select label="About" value={p.about} options={AUD} onChange={(v) => set('about', v)} />} />
        <Row title="Phone number" right={<Select label="Phone number" value={p.phoneVisible} options={AUD} onChange={(v) => set('phoneVisible', v)} />} />
        <Row title="Status updates" sub="Default audience for new updates" right={<Select label="Status audience" value={p.statusAudience} options={[['contacts', 'My contacts'], ['except', 'Contacts except…'], ['only', 'Only share with…']]} onChange={(v) => set('statusAudience', v)} />} />
      </Section>
      <Section title="Messaging">
        <Row title="Read receipts" sub="If turned off, you won't send or show blue ticks and status views" right={<Toggle checked={p.readReceipts} label="Read receipts" onChange={(v) => set('readReceipts', v)} />} />
        <Row title="Who can add me to groups" right={<Select label="Group invites" value={p.groupInvites} options={AUD} onChange={(v) => set('groupInvites', v)} />} />
        <Row title="Link previews" sub="Fetch a title and description for links you send" right={<Toggle checked={p.linkPreviews} label="Link previews" onChange={(v) => set('linkPreviews', v)} />} />
      </Section>
      <Section title="Discovery"><Row title="Let people find me by email or phone" sub="Off by default. When off, nobody can learn whether your email or phone is registered" right={<Toggle checked={p.discoverable} label="Discoverable" onChange={(v) => set('discoverable', v)} />} /></Section>
    </div></Page>
  );
}

function BlockedPage() {
  const [list, setList] = useState<Array<{ id: string; username: string; displayName: string }> | null>(null);
  const load = () => api.get('/api/blocks').then((r) => setList(r.blocked)).catch(() => setList([]));
  useEffect(() => { void load(); }, []);
  return <Page title="Blocked contacts"><div className="form-narrow">{!list ? <div className="spinner" /> : list.length ? <Section>{list.map((b) => <Row key={b.id} title={b.displayName} sub={`@${b.username}`} right={<button className="btn btn-outline btn-sm" onClick={async () => { await guard(api.del(`/api/blocks/${b.id}`)); await load(); }}>Unblock</button>} />)}</Section> : <p className="muted">You haven&apos;t blocked anyone.</p>}</div></Page>;
}

export async function enablePush(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast('Push notifications are not supported in this browser', 'error'); return false; }
  const cfg = await api.get('/api/push/config');
  if (!cfg.webPush) { toast('This server has no push keys configured (see docs/DEPLOYMENT.md)', 'error'); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications were blocked in your browser', 'error'); return false; }
  const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
  const b64 = cfg.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)); const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const j = sub.toJSON();
  await api.post('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
  return true;
}
function NotificationsPage() {
  const n = useStore((s) => s.me!.settings.notifications);
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const set = (k: keyof S['notifications'], v: any) => saveSettings({ notifications: { [k]: v } });
  const qh = n.quietHours;
  return (
    <Page title="Notifications"><div className="form-narrow">
      <Section title="This device">
        <Row icon="bell" title="Push notifications" sub={perm === 'granted' ? 'Enabled in this browser' : perm === 'denied' ? 'Blocked in browser settings' : perm === 'unsupported' ? 'Not supported here' : 'Get alerts when Wazzupp is closed'} right={perm !== 'granted' && perm !== 'unsupported' ? <button className="btn btn-soft btn-sm" onClick={async () => { const ok = await enablePush().catch((e) => { toastError(e); return false; }); setPerm(Notification.permission); if (ok) toast('Push notifications enabled'); }}>Enable</button> : undefined} />
      </Section>
      <Section title="Alerts">
        <Row title="Message notifications" right={<Toggle checked={n.messages} label="Messages" onChange={(v) => set('messages', v)} />} />
        <Row title="Group notifications" right={<Toggle checked={n.groups} label="Groups" onChange={(v) => set('groups', v)} />} />
        <Row title="Call notifications" right={<Toggle checked={n.calls} label="Calls" onChange={(v) => set('calls', v)} />} />
        <Row title="Show message previews" sub="When off, notifications only say “New message”" right={<Toggle checked={n.previews} label="Previews" onChange={(v) => set('previews', v)} />} />
        <Row title="Sounds" right={<Toggle checked={n.sound} label="Sounds" onChange={(v) => set('sound', v)} />} />
      </Section>
      <Section title="Quiet hours">
        <Row title="Pause push notifications" right={<Toggle checked={qh.enabled} label="Quiet hours" onChange={(v) => set('quietHours', { enabled: v, utcOffsetMinutes: -new Date().getTimezoneOffset() })} />} />
        {qh.enabled ? <div className="set-row"><span className="grow">From</span><input className="input compact" type="time" value={qh.start} onChange={(e) => set('quietHours', { start: e.target.value })} /><span>to</span><input className="input compact" type="time" value={qh.end} onChange={(e) => set('quietHours', { end: e.target.value })} /></div> : null}
      </Section>
    </div></Page>
  );
}

function AppearancePage() {
  const a = useStore((s) => s.me!.settings.appearance);
  const set = (k: keyof S['appearance'], v: any) => saveSettings({ appearance: { [k]: v } });
  return (
    <Page title="Chats & appearance"><div className="form-narrow">
      <Section title="Theme">
        <div className="theme-pick">{([['system', 'System', 'laptop'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']] as const).map(([v, l, i]) => <button key={v} className={a.theme === v ? 'on' : ''} onClick={() => set('theme', v)} aria-pressed={a.theme === v}><Icon name={i} size={22} /><span>{l}</span></button>)}</div>
      </Section>
      <Section title="Text size">
        <div className="theme-pick">{([['sm', 'Small'], ['md', 'Default'], ['lg', 'Large']] as const).map(([v, l]) => <button key={v} className={a.fontSize === v ? 'on' : ''} onClick={() => set('fontSize', v)} aria-pressed={a.fontSize === v}><span style={{ fontSize: v === 'sm' ? 14 : v === 'lg' ? 20 : 17, fontWeight: 600 }}>Aa</span><span>{l}</span></button>)}</div>
      </Section>
      <Section title="Chat wallpaper">
        <div className="theme-pick">{([['doodle', 'Doodle'], ['plain', 'Plain'], ['emerald', 'Emerald']] as const).map(([v, l]) => <button key={v} className={`wp-${v} ${a.wallpaper === v ? 'on' : ''}`} onClick={() => set('wallpaper', v)} aria-pressed={a.wallpaper === v}><span className="wp-swatch" /><span>{l}</span></button>)}</div>
      </Section>
      <Section title="Language"><Row title="App language" sub="Only English is available in this release" right={<Select label="Language" value={a.language} options={[['en', 'English']]} onChange={(v) => set('language', v)} />} /></Section>
    </div></Page>
  );
}

function FoldersPage() {
  const folders = useStore((s) => s.folders); const [name, setName] = useState('');
  return <Page title="Chat folders"><div className="form-narrow"><p className="muted">Folders appear as filters above your chat list. Move a chat into a folder from its context menu.</p>
    <Section>{folders.map((f) => <Row key={f.id} icon="folder" title={f.name} right={<button className="icon-btn" aria-label={`Delete folder ${f.name}`} onClick={async () => { await guard(api.del(`/api/folders/${f.id}`)); await loadFolders(); }}><Icon name="trash" size={18} /></button>} />)}{!folders.length ? <div className="set-row muted">No folders yet</div> : null}</Section>
    <form className="row" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; await guard(api.post('/api/folders', { name: name.trim() })); setName(''); await loadFolders(); }}><input className="input" placeholder="New folder (e.g. Work)" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /><button className="btn btn-primary">Add</button></form></div></Page>;
}

function StoragePage() {
  const m = useStore((s) => s.me!.settings.media); const [u, setU] = useState<any>(null);
  useEffect(() => { api.get('/api/storage/usage').then(setU).catch(() => {}); }, []);
  const set = (k: keyof S['media'], v: boolean) => saveSettings({ media: { [k]: v } });
  const pct = u ? Math.min(100, (u.usedBytes / u.quotaBytes) * 100) : 0;
  return (
    <Page title="Storage & data"><div className="form-narrow">
      <Section title="Your storage">{u ? <div className="set-row col"><div className="meter"><i style={{ width: `${pct}%` }} /></div><span className="muted">{bytes(u.usedBytes)} of {bytes(u.quotaBytes)} used</span>{u.byKind.map((k: any) => <div key={k.kind} className="row" style={{ width: '100%' }}><span className="grow" style={{ textTransform: 'capitalize' }}>{k.kind}</span><span className="muted">{k.count} · {bytes(Number(k.bytes))}</span></div>)}</div> : <div className="set-row"><div className="spinner" /></div>}</Section>
      <Section title="Media auto-download">
        <Row title="Photos" right={<Toggle checked={m.autoDownloadImages} label="Photos" onChange={(v) => set('autoDownloadImages', v)} />} />
        <Row title="Videos" right={<Toggle checked={m.autoDownloadVideos} label="Videos" onChange={(v) => set('autoDownloadVideos', v)} />} />
        <Row title="Documents" right={<Toggle checked={m.autoDownloadDocuments} label="Documents" onChange={(v) => set('autoDownloadDocuments', v)} />} />
        <Row title="Data saver" sub="Use smaller previews on slow connections" right={<Toggle checked={m.dataSaver} label="Data saver" onChange={(v) => set('dataSaver', v)} />} />
      </Section>
    </div></Page>
  );
}

function DevicesPage() {
  const [list, setList] = useState<any[] | null>(null); const [rev, setRev] = useState<any>(null);
  const load = () => api.get('/api/devices').then((r) => setList(r.devices)).catch(() => setList([]));
  useEffect(() => { void load(); }, []);
  const ico = (p: string): IconName => (p === 'android' || p === 'ios' ? 'phone-device' : p === 'web' ? 'globe' : 'laptop');
  return (
    <Page title="Linked devices"><div className="form-narrow"><p className="muted">Your chats stay in sync on every signed-in device. Sign out any device you don&apos;t recognise.</p>
      {!list ? <div className="spinner" /> : <Section>{list.map((d) => <Row key={d.id} icon={ico(d.platform)} title={<>{d.name}{d.current ? <span className="pill on" style={{ marginLeft: 8 }}>This device</span> : null}</>} sub={`${d.platform} · ${d.current ? 'active now' : `last active ${ago(d.lastSeenAt)}`}${d.ip ? ` · ${d.ip}` : ''}`} right={!d.current ? <button className="btn btn-danger-ghost btn-sm" onClick={() => setRev(d)}>Sign out</button> : undefined} />)}</Section>}
      {rev ? <Confirm title="Sign out this device?" text={`${rev.name} will be signed out immediately.`} confirm="Sign out" danger onConfirm={async () => { await api.del(`/api/devices/${rev.id}`); await load(); }} onClose={() => setRev(null)} /> : null}
    </div></Page>
  );
}

function BackupPage() {
  return <Page title="Backup & recovery"><div className="form-narrow">
    <Section title="Your data"><Row icon="download" title="Export my data" sub="Download your profile, contacts and the messages you sent as JSON" onClick={async () => { try { const r = await fetch('/api/me/export', { headers: { authorization: `Bearer ${(await import('../lib/api.ts')).getToken()}` } }); const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'wazzupp-export.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); } catch (e) { toastError(e); } }} /></Section>
    <Section title="How your messages are kept"><div className="set-row col muted"><p>Your messages live on the Wazzupp server and sync to every signed-in device. There is no separate device backup to restore: sign in on a new device and your history appears.</p><p>End-to-end encrypted backups are part of the planned E2EE milestone (see docs/SECURITY.md).</p></div></Section>
  </div></Page>;
}
function LegalPage() {
  return <Page title="Terms & privacy policy"><div className="form-narrow legal">
    <p className="help">This is a plain-language summary, not a substitute for legal terms. Operators must publish their own reviewed Terms of Service and Privacy Policy before launch.</p>
    <h3>What we store</h3><p>Your account details, profile, contacts, messages, media and call logs, so that your chats work across devices. Passwords are hashed with Argon2id and are never readable.</p>
    <h3>What moderators can see</h3><p>Moderators cannot browse conversations. They see only content that a participant reports, plus account metadata.</p>
    <h3>Your choices</h3><p>You can export your data, delete your account, control who sees your profile and status, and turn off read receipts at any time.</p>
    <h3>Not affiliated</h3><p>Wazzupp is an independent service and is not affiliated with or endorsed by any other messaging product.</p>
  </div></Page>;
}
void loadContacts;
