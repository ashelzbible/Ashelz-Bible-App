import type { ReactNode } from 'react';
import { Logo } from '../ui/Logo.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { go, useLayout, useRoute, type Route } from '../lib/route.ts';
import { useStore } from '../lib/store.ts';

export const TABS: Array<{ id: Route['tab']; label: string; icon: IconName }> = [
  { id: 'chats', label: 'Chats', icon: 'chat' },
  { id: 'calls', label: 'Calls', icon: 'phone' },
  { id: 'status', label: 'Status', icon: 'dashed' },
  { id: 'communities', label: 'Communities', icon: 'users' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
const MOBILE_ORDER: Route['tab'][] = ['chats', 'calls', 'communities', 'status', 'settings'];

function useChatBadge() { return useStore((s) => Object.values(s.convs).reduce((n, c) => n + (c.muted || c.archived ? 0 : c.unread + (c.markedUnread && !c.unread ? 1 : 0)), 0)); }
function useMissed() { return useStore((s) => s.notifications.filter((n) => n.kind === 'missed_call' && !n.read).length); }

export function Rail() {
  const route = useRoute();
  const badge = useChatBadge(); const missed = useMissed();
  const role = useStore((s) => s.me?.role);
  return (
    <nav className="rail" aria-label="Main">
      <button className="rail-top" onClick={() => { go('chats'); window.dispatchEvent(new CustomEvent('wz-archived')); }} aria-label="Archived chats" title="Archived chats"><Icon name="archive" size={22} stroke={1.8} /></button>
      {TABS.map((t) => (
        <button key={t.id} className={`rail-item ${route.tab === t.id ? 'active' : ''}`} onClick={() => go(t.id)} aria-current={route.tab === t.id ? 'page' : undefined}>
          <span className="rail-ico"><Icon name={t.icon} size={22} stroke={1.8} />{t.id === 'chats' && badge ? <i className="rail-dot">{badge > 99 ? '99+' : badge}</i> : null}{t.id === 'calls' && missed ? <i className="rail-dot">{missed}</i> : null}</span>
          <span>{t.label}</span>
        </button>
      ))}
      {role && role !== 'user' ? <button className={`rail-item ${route.tab === 'admin' ? 'active' : ''}`} onClick={() => go('admin')}><span className="rail-ico"><Icon name="shield-check" size={22} stroke={1.8} /></span><span>Admin</span></button> : null}
    </nav>
  );
}

export function BottomNav() {
  const route = useRoute();
  const badge = useChatBadge(); const missed = useMissed();
  return (
    <nav className="bottom-nav" aria-label="Main">
      {MOBILE_ORDER.map((id) => {
        const t = TABS.find((x) => x.id === id)!;
        const on = route.tab === id;
        return (
          <button key={id} className={on ? 'active' : ''} onClick={() => go(id)} aria-current={on ? 'page' : undefined}>
            <span className="bn-ico"><Icon name={t.icon} size={24} stroke={on ? 2.1 : 1.7} fill={on && (id === 'chats')} />{id === 'chats' && badge ? <i className="badge alert">{badge > 99 ? '99+' : badge}</i> : null}{id === 'calls' && missed ? <i className="badge alert">{missed}</i> : null}</span>
            <span>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** The left pane: dark emerald header with search on desktop, white title header on tablets, deep-green app bar on phones. */
export function PaneFrame({ title, search, actions, strip, children, filters, onBack, sub }: { title: string; search?: ReactNode; actions?: ReactNode; strip?: ReactNode; children: ReactNode; filters?: ReactNode; onBack?: () => void; sub?: string }) {
  const layout = useLayout();
  if (layout === 'desktop') {
    return (
      <>
        <div className="pane-top">{search ?? <h2 className="pane-title">{title}</h2>}<div className="row" style={{ gap: 2 }}>{actions}</div></div>
        <div className="list-card">{filters ? <div className="filters">{filters}</div> : null}{children}</div>
      </>
    );
  }
  if (layout === 'tablet') {
    return (
      <div className="pane-tablet">
        <header className="pane-head-t"><div className="row" style={{ gap: 8 }}>{onBack ? <button className="icon-btn" onClick={onBack} aria-label="Back"><Icon name="back" /></button> : null}<div className="grow"><h1>{title}</h1>{sub ? <small className="muted">{sub}</small> : null}</div>{actions}</div>{search}{filters ? <div className="filters">{filters}</div> : null}</header>
        <div className="pane-scroll">{strip}{children}</div>
        <BottomNav />
      </div>
    );
  }
  return (
    <div className="pane-mobile">
      <header className="app-bar"><div className="app-bar-row">{onBack ? <button className="icon-btn on-dark" onClick={onBack} aria-label="Back"><Icon name="back" /></button> : null}<h1 className="grow">{title}</h1>{actions}</div>{search}</header>
      <div className="pane-scroll">{strip}{filters ? <div className="filters">{filters}</div> : null}{children}</div>
      <BottomNav />
    </div>
  );
}

export function BrandBar() {
  const conn = useStore((s) => s.conn);
  return (
    <div className="brand-bar">
      <Logo size={40} /><span className="brand-word">Wazzupp</span>
      {conn !== 'online' ? <span className={`conn-pill ${conn}`}><Icon name="wifi-off" size={14} />{conn === 'connecting' ? 'Connecting…' : 'Offline'}</span> : null}
    </div>
  );
}
export function ConnBanner() {
  const conn = useStore((s) => s.conn); const layout = useLayout();
  if (conn === 'online' || layout === 'desktop') return null;
  return <div className={`conn-banner ${conn}`}><Icon name="wifi-off" size={15} />{conn === 'connecting' ? 'Connecting…' : 'Waiting for network. Messages will send when you reconnect.'}</div>;
}
