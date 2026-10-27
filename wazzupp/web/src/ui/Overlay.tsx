import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon.tsx';
import { useLayout } from '../lib/route.ts';

export interface MenuItem { label: string; icon?: IconName; onClick?: () => void; danger?: boolean; selected?: boolean; hidden?: boolean; divider?: boolean }

/** Popup menu anchored at a point/rect. Becomes a bottom sheet on phones. Closes on outside click, scroll, resize, and Escape. */
export function Menu({ items, at, onClose, header }: { items: MenuItem[]; at: { x: number; y: number }; onClose: () => void; header?: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const layout = useLayout();
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const el = ref.current; if (!el || layout === 'mobile') return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at.x, at.y, layout]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); window.addEventListener('resize', onClose);
    ref.current?.querySelector('button')?.focus();
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  const shown = items.filter((i) => !i.hidden);
  return createPortal(
    <>
      <div className="scrim" style={{ background: layout === 'mobile' ? undefined : 'transparent' }} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={ref} className={`menu ${layout === 'mobile' ? 'sheet-mobile' : ''}`} style={layout === 'mobile' ? undefined : pos} role="menu">
        {header ? header(onClose) : null}
        {shown.map((it, i) => it.divider ? <hr key={i} /> : (
          <button key={i} role="menuitem" className={`${it.danger ? 'danger' : ''} ${it.selected ? 'sel' : ''}`} onClick={() => { onClose(); it.onClick?.(); }}>
            {it.icon ? <Icon name={it.icon} size={19} /> : null}<span>{it.label}</span>
            {it.selected ? <Icon name="check" size={18} className="ml-auto" style={{ marginLeft: 'auto' }} /> : null}
          </button>
        ))}
      </div>
    </>, document.body);
}

export function useMenu() {
  const [menu, setMenu] = useState<{ items: MenuItem[]; at: { x: number; y: number }; header?: (close: () => void) => ReactNode } | null>(null);
  const open = (items: MenuItem[], e: { clientX?: number; clientY?: number; currentTarget?: any } | HTMLElement, header?: (close: () => void) => ReactNode) => {
    let x = 0, y = 0;
    if (e instanceof HTMLElement) { const r = e.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
    else if (e.clientX !== undefined && e.clientY !== undefined && (e.clientX || e.clientY)) { x = e.clientX; y = e.clientY; }
    else { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); x = r.right - 200; y = r.bottom + 4; }
    setMenu({ items, at: { x, y }, header });
  };
  return { open, node: menu ? <Menu items={menu.items} at={menu.at} header={menu.header} onClose={() => setMenu(null)} /> : null };
}

export function Dialog({ title, onClose, children, footer, width = 440, sheet = true }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; sheet?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className={`dialog ${sheet ? 'sheet' : ''}`} style={{ ['--w' as any]: `${width}px` }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </>, document.body);
}

export function Confirm({ title, text, confirm = 'Confirm', danger, onConfirm, onClose }: { title: string; text: string; confirm?: string; danger?: boolean; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>{confirm}</button></>}>
      <p className="muted" style={{ lineHeight: 1.5 }}>{text}</p>
    </Dialog>
  );
}
