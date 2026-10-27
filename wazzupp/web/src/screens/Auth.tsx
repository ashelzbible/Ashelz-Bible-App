import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { authenticate, logout, refreshMe } from '../lib/actions.ts';
import { useStore } from '../lib/store.ts';
import { Logo } from '../ui/Logo.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';

const FEATURES: Array<[IconName, string, string]> = [
  ['chat', 'Messaging', 'Texts, photos, videos, voice notes and documents'],
  ['phone', 'Voice & video calls', 'WebRTC calls with screen sharing on desktop'],
  ['users', 'Groups & communities', 'Roles, invite links, announcements and channels'],
  ['clock', 'Status updates', 'Share moments that disappear after 24 hours'],
  ['lock', 'Secure by design', 'Hashed passwords, device sessions, private storage'],
];

function Shell({ children, title, sub }: { children: ReactNode; title: string; sub?: string }) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="auth-brand-inner">
          <div className="row" style={{ gap: 14 }}><Logo size={64} /><span className="auth-word">Wazzupp</span></div>
          <h1>Connect. Communicate. Collaborate.</h1>
          <p className="auth-lede">One account across your phone, tablet and desktop. Message, call, share and organise your communities in one place.</p>
          <ul className="auth-features">{FEATURES.map(([i, t, d]) => <li key={t}><span><Icon name={i} size={20} /></span><div><b>{t}</b><small>{d}</small></div></li>)}</ul>
        </div>
      </aside>
      <main className="auth-form">
        <div className="auth-card">
          <div className="auth-mobile-logo"><Logo size={56} /></div>
          <h2>{title}</h2>
          {sub ? <p className="muted" style={{ marginTop: 4 }}>{sub}</p> : null}
          {children}
        </div>
        <p className="auth-legal">Wazzupp is an independent messaging service and is not affiliated with any other messaging brand.</p>
      </main>
    </div>
  );
}

function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) {
  return <label className="field"><span className="label-t">{label}</span>{children}{error ? <span className="err">{error}</span> : null}</label>;
}

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>('login');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [needMfa, setNeedMfa] = useState(false);
  const [f, setF] = useState({ identifier: '', password: '', mfaCode: '', username: '', displayName: '', email: '', phone: '', code: '', newPassword: '' });
  const [info, setInfo] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setInfo(''); setBusy(true);
    try {
      if (mode === 'login') await authenticate('/api/auth/login', { identifier: f.identifier, password: f.password, ...(needMfa ? { mfaCode: f.mfaCode } : {}) });
      else if (mode === 'register') await authenticate('/api/auth/register', { username: f.username, displayName: f.displayName, password: f.password, ...(f.email ? { email: f.email } : {}), ...(f.phone ? { phone: f.phone } : {}) });
      else if (mode === 'forgot') { await api.post('/api/auth/password/forgot', { email: f.email }); setInfo('If an account exists for that address, a reset code is on its way.'); setMode('reset'); }
      else { await api.post('/api/auth/password/reset', { email: f.email, code: f.code, newPassword: f.newPassword }); setInfo('Password changed. Sign in with your new password.'); setMode('login'); setF((p) => ({ ...p, identifier: f.email, password: '' })); }
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === 'mfa_required') { setNeedMfa(true); setErr(''); }
      else setErr(ex instanceof ApiError ? ex.message : 'Something went wrong');
    } finally { setBusy(false); }
  }

  const titles = { login: ['Welcome back', 'Sign in to continue to Wazzupp'], register: ['Create your account', 'It only takes a minute'], forgot: ['Reset your password', 'We will email you a 6-digit code'], reset: ['Choose a new password', 'Enter the code from your email'] } as const;
  return (
    <Shell title={titles[mode][0]} sub={titles[mode][1]}>
      <form className="auth-fields" onSubmit={submit} noValidate>
        {mode === 'login' && <>
          <Field label="Email, phone or username"><input className="input" autoComplete="username" autoFocus value={f.identifier} onChange={set('identifier')} required /></Field>
          <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={f.password} onChange={set('password')} required /></Field>
          {needMfa && <Field label="Authenticator code"><input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={f.mfaCode} onChange={set('mfaCode')} placeholder="6-digit code" /></Field>}
        </>}
        {mode === 'register' && <>
          <Field label="Your name"><input className="input" autoComplete="name" autoFocus value={f.displayName} onChange={set('displayName')} required /></Field>
          <Field label="Username"><input className="input" autoComplete="off" autoCapitalize="none" value={f.username} onChange={set('username')} placeholder="letters, numbers, . or _" required /></Field>
          <Field label="Email"><input className="input" type="email" autoComplete="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Phone (optional, international format)"><input className="input" type="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} placeholder="+27821234567" /></Field>
          <Field label="Password"><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} placeholder="Choose a password" required /></Field>
        </>}
        {mode === 'forgot' && <Field label="Email"><input className="input" type="email" autoFocus autoComplete="email" value={f.email} onChange={set('email')} required /></Field>}
        {mode === 'reset' && <>
          <Field label="Email"><input className="input" type="email" autoComplete="email" value={f.email} onChange={set('email')} required /></Field>
          <Field label="6-digit code"><input className="input" inputMode="numeric" maxLength={6} autoFocus value={f.code} onChange={set('code')} required /></Field>
          <Field label="New password"><input className="input" type="password" autoComplete="new-password" value={f.newPassword} onChange={set('newPassword')} required /></Field>
        </>}
        {info ? <div className="notice ok" role="status">{info}</div> : null}
        {err ? <div className="notice bad" role="alert">{err}</div> : null}
        <button className="btn btn-primary btn-block" disabled={busy} type="submit" style={{ height: 48 }}>{busy ? <span className="spinner" style={{ borderTopColor: '#fff' }} /> : { login: 'Sign in', register: 'Create account', forgot: 'Send code', reset: 'Change password' }[mode]}</button>
      </form>
      <div className="auth-links">
        {mode === 'login' && <><button onClick={() => { setMode('forgot'); setErr(''); }}>Forgot password?</button><button onClick={() => { setMode('register'); setErr(''); }}>Create an account</button></>}
        {mode !== 'login' && <button onClick={() => { setMode('login'); setErr(''); }}>Back to sign in</button>}
      </div>
    </Shell>
  );
}

/** Shown to signed-in users whose email/phone is not yet verified (the server refuses messaging until then). */
export function VerifyGate() {
  const me = useStore((s) => s.me)!;
  const kind: 'email' | 'phone' = me.email ? 'email' : 'phone';
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [dev, setDev] = useState<string | null>(null);
  useEffect(() => { api.get('/api/dev/outbox').then((r) => { const b = r.messages?.[0]?.body as string | undefined; const m = b && /(\d{6})/.exec(b); if (m) setDev(m[1]); }).catch(() => {}); }, [sent]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.post('/api/auth/verify', { kind, code }); await refreshMe(); } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'Verification failed'); } finally { setBusy(false); }
  }
  return (
    <Shell title="Verify your account" sub={`Enter the 6-digit code we sent to ${kind === 'email' ? me.email : me.phone}.`}>
      <form className="auth-fields" onSubmit={submit}>
        <Field label="Verification code"><input className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
        {err ? <div className="notice bad" role="alert">{err}</div> : null}
        {dev ? <div className="notice dev">Development mail outbox (not shown in production): code <b>{dev}</b> <button type="button" className="link" onClick={() => setCode(dev)}>use it</button></div> : null}
        <button className="btn btn-primary btn-block" style={{ height: 48 }} disabled={busy || code.length !== 6}>Verify</button>
      </form>
      <div className="auth-links">
        <button onClick={async () => { await api.post('/api/auth/verify/resend', { kind }).catch(() => {}); setSent(true); }}>{sent ? 'Code sent again' : 'Resend code'}</button>
        <button onClick={() => logout()}>Sign out</button>
      </div>
    </Shell>
  );
}
