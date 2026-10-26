import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { useStore, setState } from '../lib/store.ts';

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="toggle" onClick={() => onChange(!checked)} />;
}
export function Empty({ icon, title, text, action }: { icon: IconName; title: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-art"><Icon name={icon} size={38} stroke={1.6} /></div><h3>{title}</h3>{text ? <p style={{ maxWidth: 320 }}>{text}</p> : null}{action}</div>;
}
export function ListSkeleton({ rows = 7 }: { rows?: number }) {
  return <div aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => (
    <div key={i} className="row" style={{ padding: '12px 16px' }}><div className="skel" style={{ width: 48, height: 48, borderRadius: '50%' }} /><div className="grow" style={{ display: 'grid', gap: 8 }}><div className="skel" style={{ height: 14, width: `${50 + (i * 13) % 35}%` }} /><div className="skel" style={{ height: 12, width: `${60 + (i * 7) % 30}%` }} /></div></div>
  ))}</div>;
}
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return <div className="toasts" role="status" aria-live="polite">{toasts.map((t) => (
    <div key={t.id} className={`toast ${t.kind ?? ''}`}>{t.text}{t.action ? <button onClick={() => { t.action!.run(); setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })); }}>{t.action.label}</button> : null}</div>
  ))}</div>;
}
export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="set-section">{title ? <h3 className="set-title">{title}</h3> : null}<div className="set-card">{children}</div></section>;
}
export function Row({ icon, title, sub, right, onClick, danger, chevron }: { icon?: IconName; title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; danger?: boolean; chevron?: boolean }) {
  const inner = (<>
    {icon ? <span className={`set-ico ${danger ? 'danger' : ''}`}><Icon name={icon} size={20} /></span> : null}
    <span className="grow" style={{ textAlign: 'left' }}><span className={`set-t ${danger ? 'danger' : ''}`}>{title}</span>{sub ? <span className="set-s">{sub}</span> : null}</span>
    {right}{chevron || (onClick && !right) ? <Icon name="right" size={18} className="muted" /> : null}
  </>);
  return onClick ? <button className="set-row" onClick={onClick}>{inner}</button> : <div className="set-row">{inner}</div>;
}
