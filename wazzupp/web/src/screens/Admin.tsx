import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { bytes, ago } from '../lib/format.ts';
import { go } from '../lib/route.ts';
import { toast, useStore } from '../lib/store.ts';
import { guard } from '../lib/actions.ts';
import { Icon } from '../ui/Icon.tsx';
import { Toggle } from '../ui/Misc.tsx';

type Tab = 'overview' | 'users' | 'reports' | 'appeals' | 'flags' | 'audit' | 'security';

export function Admin() {
  const role = useStore((s) => s.me!.role);
  const [tab, setTab] = useState<Tab>('overview');
  if (role === 'user') return <div className="conv-empty"><div className="empty"><h3>Not available</h3><p>This area is restricted to staff.</p></div></div>;
  const tabs: Array<[Tab, string]> = [['overview', 'Overview'], ['users', 'Users'], ['reports', 'Reports'], ['appeals', 'Appeals'], ...(role === 'admin' ? [['flags', 'Feature flags'], ['audit', 'Audit log'], ['security', 'Security & queues']] as Array<[Tab, string]> : [])];
  return (
    <div className="admin">
      <header className="page-head"><button className="icon-btn" onClick={() => go('chats')} aria-label="Back to chats"><Icon name="back" /></button><h2>Administration</h2><span className="pill">{role}</span></header>
      <div className="tabs wrap" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="admin-body">
        {tab === 'overview' ? <Overview /> : tab === 'users' ? <Users role={role} /> : tab === 'reports' ? <Reports /> : tab === 'appeals' ? <Appeals /> : tab === 'flags' ? <Flags /> : tab === 'audit' ? <Audit /> : <Security />}
      </div>
    </div>
  );
}
function useLoad<T>(url: string, deps: unknown[] = []): [T | null, () => void] {
  const [d, setD] = useState<T | null>(null); const [n, setN] = useState(0);
  useEffect(() => { api.get(url).then(setD).catch(() => setD(null)); }, [url, n, ...deps]);  
  return [d, () => setN((x) => x + 1)];
}
function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) { return <div className="stat"><small>{label}</small><b>{value}</b>{sub ? <small className="muted">{sub}</small> : null}</div>; }
function Overview() {
  const [s] = useLoad<any>('/api/admin/stats');
  const [h, setH] = useState<any>(null);
  useEffect(() => { fetch('/readyz').then((r) => r.json()).then(setH).catch(() => setH({ ok: false })); }, []);
  if (!s) return <div className="spinner" />;
  return <div className="stats">
    <Stat label="Users" value={s.users.total} sub={`${s.users.active} active · ${s.users.suspended} suspended · +${s.users.new24h} today`} />
    <Stat label="Messages (24h)" value={s.messages.last24h} sub={`${s.messages.total} total`} />
    <Stat label="Media" value={s.media.files} sub={bytes(s.media.bytes)} />
    <Stat label="Open reports" value={s.reports.open} sub={`${s.appeals.open} open appeals`} />
    <Stat label="Realtime users online" value={s.realtime.onlineUsers} sub={`uptime ${Math.round(s.uptimeSec / 60)} min`} />
    <Stat label="Job queue" value={`${s.jobs.queued ?? 0} queued`} sub={`${s.jobs.failed ?? 0} failed · ${s.jobs.done ?? 0} done`} />
    <Stat label="Service health" value={h ? (h.ok ? 'Healthy' : 'Degraded') : '…'} sub={h ? `database ${h.db} · redis ${h.redis ?? 'n/a'}` : ''} />
  </div>;
}
function Users({ role }: { role: string }) {
  const [q, setQ] = useState(''); const [d, reload] = useLoad<any>(`/api/admin/users?q=${encodeURIComponent(q)}`, []);
  return <div><input className="input" placeholder="Search username, email or name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" style={{ marginBottom: 12 }} />
    <table className="tbl"><thead><tr><th>User</th><th>Status</th><th>Role</th><th>Reports</th><th>Joined</th><th /></tr></thead><tbody>{(d?.users ?? []).map((u: any) => <tr key={u.id}><td><b>{u.display_name}</b><br /><small className="muted">@{u.username} · {u.email ?? '—'}</small></td><td><span className={`pill ${u.status === 'active' ? 'on' : 'bad'}`}>{u.status}</span></td><td>{u.role}</td><td>{u.reports}</td><td>{ago(u.created_at)}</td>
      <td className="actions">{u.role === 'user' && u.status === 'active' ? <button className="btn btn-danger-ghost btn-sm" onClick={async () => { const reason = prompt('Reason for suspension (recorded in the audit log)'); if (reason && reason.length >= 3) { await guard(api.post(`/api/admin/users/${u.id}/suspend`, { reason })); reload(); } }}>Suspend</button> : null}
        {u.status === 'suspended' ? <button className="btn btn-soft btn-sm" onClick={async () => { await guard(api.post(`/api/admin/users/${u.id}/unsuspend`)); reload(); }}>Restore</button> : null}
        {role === 'admin' && u.status === 'active' ? <select className="select compact" value={u.role} aria-label="Role" onChange={async (e) => { await guard(api.post(`/api/admin/users/${u.id}/role`, { role: e.target.value })); reload(); }}>{['user', 'moderator', 'admin'].map((r) => <option key={r}>{r}</option>)}</select> : null}</td></tr>)}</tbody></table></div>;
}
function Reports() {
  const [d, reload] = useLoad<any>('/api/admin/reports');
  const act = async (id: string, action: string) => { const reason = action === 'dismiss' ? '' : prompt('Note for the audit log') ?? ''; await guard(api.post(`/api/admin/reports/${id}/action`, { action, reason })); toast('Action recorded'); reload(); };
  return <div className="stack">{!d ? <div className="spinner" /> : d.reports.length ? d.reports.map((r: any) => <div key={r.id} className="report"><div className="row"><b className="grow">{r.reason}</b><small className="muted">{ago(r.created_at)}</small></div><p className="muted">Reported user: @{r.target_username ?? 'unknown'} · by @{r.reporter_username}</p>{r.snapshot ? <blockquote>{r.snapshot.body || `[${r.snapshot.kind}]`}</blockquote> : null}{r.details ? <p>{r.details}</p> : null}
    <div className="row"><button className="btn btn-outline btn-sm" onClick={() => act(r.id, 'dismiss')}>Dismiss</button><button className="btn btn-outline btn-sm" onClick={() => act(r.id, 'warn')}>Warn</button>{r.message_id ? <button className="btn btn-outline btn-sm" onClick={() => act(r.id, 'delete_message')}>Delete message</button> : null}<button className="btn btn-danger btn-sm" onClick={() => act(r.id, 'suspend')}>Suspend user</button></div></div>) : <p className="muted">No open reports.</p>}
    <p className="help">Moderators see only the content a participant reported. There is no tool for browsing conversations.</p></div>;
}
function Appeals() {
  const [d, reload] = useLoad<any>('/api/admin/appeals');
  return <div className="stack">{!d ? <div className="spinner" /> : d.appeals.length ? d.appeals.map((a: any) => <div key={a.id} className="report"><b>@{a.username}</b><small className="muted"> suspended for: {a.suspended_reason}</small><blockquote>{a.message}</blockquote><div className="row"><button className="btn btn-primary btn-sm" onClick={async () => { await guard(api.post(`/api/admin/appeals/${a.id}/resolve`, { accept: true })); reload(); }}>Accept</button><button className="btn btn-outline btn-sm" onClick={async () => { await guard(api.post(`/api/admin/appeals/${a.id}/resolve`, { accept: false })); reload(); }}>Reject</button></div></div>) : <p className="muted">No open appeals.</p>}</div>;
}
function Flags() {
  const [d, reload] = useLoad<any>('/api/admin/flags');
  return <div className="stack">{(d?.flags ?? []).map((f: any) => <div key={f.key} className="set-row"><span className="grow"><b>{f.key}</b><small className="muted" style={{ display: 'block' }}>{f.description}</small></span><Toggle checked={f.enabled} label={f.key} onChange={async (v) => { await guard(api.put(`/api/admin/flags/${f.key}`, { enabled: v })); reload(); }} /></div>)}</div>;
}
function Audit() {
  const [d] = useLoad<any>('/api/admin/audit');
  return <table className="tbl"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>{(d?.events ?? []).map((e: any) => <tr key={e.id}><td>{new Date(e.created_at).toLocaleString()}</td><td>{e.actor ?? 'system'}</td><td>{e.action}</td><td><small>{e.target}</small></td></tr>)}</tbody></table>;
}
function Security() {
  const [s] = useLoad<any>('/api/admin/security-events'); const [j] = useLoad<any>('/api/admin/jobs');
  return <div className="stack"><div className="stats"><Stat label="Locked accounts" value={s?.lockedAccounts ?? '…'} /><Stat label="Queued jobs" value={j?.queued ?? '…'} /><Stat label="Failed jobs" value={j?.failed.length ?? '…'} /></div>
    <h4 className="list-sub">Suspicious sign-ins</h4>{(s?.events ?? []).length ? (s.events as any[]).map((e, i) => <div key={i} className="set-row"><span className="grow">@{e.username} · {e.payload.deviceName}<small className="muted" style={{ display: 'block' }}>{e.payload.ip} · {ago(e.created_at)}</small></span></div>) : <p className="muted">None recorded.</p>}
    <h4 className="list-sub">Failed jobs</h4>{(j?.failed ?? []).length ? (j.failed as any[]).map((x) => <div key={x.id} className="set-row"><span className="grow"><b>{x.kind}</b><small className="muted" style={{ display: 'block' }}>{x.last_error}</small></span></div>) : <p className="muted">None.</p>}</div>;
}
