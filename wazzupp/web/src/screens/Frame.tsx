import type { ReactNode } from 'react';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import { go, useLayout, useRoute, type Route } from '../lib/route.ts';
import { useStore } from '../lib/store.ts';

export const TABS: Array<{ id: Route['tab']; label: string; icon: IconName }> = [
  { id: 'chats', label: 'Chats', icon: 'chat' },
  { id: 'calls', label: 'Calls', icon: 'phone' },
  { id: 'status', label: 'Status', icon: 'dashed' },
  { id: 'communities', label: 'Communities', icon: 'users' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
const MOBILE_ORDER: Route['tab'][] = ['chats', 'status', 'communities', 'calls'];

function useChatBadge() { return useStore((s) => Object.values(s.convs).reduce((n, c) => n + (c.muted || c.archived ? 0 : c.unread + (c.markedUnread && !c.unread ? 1 : 0)), 0)); }
function useMissed() { return useStore((s) => s.notifications.filter((n) => n.kind === 'missed_call' && !n.read).length); }

export function Rail() {
  const route = useRoute();
  const badge = useChatBadge(); const missed = useMissed();
  const me = useStore((s) => s.me); const role = me?.role;
  const main = TABS.filter((t) => t.id !== 'settings');
  const item = (id: Route['tab'], label: string, icon: IconName, extra?: ReactNode) => (
    <button key={id + label} className={`rail-item ${route.tab === id ? 'active' : ''}`} onClick={() => go(id)} aria-label={label} title={label} aria-current={route.tab === id ? 'page' : undefined}>
      <span className="rail-ico"><Icon name={icon} size={22} stroke={1.8} />{extra}</span>
    </button>);
  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-group">
        {main.map((t) => item(t.id, t.label, t.id === 'status' ? 'updates' : t.icon, t.id === 'chats' && badge ? <i className="rail-dot">{badge > 99 ? '99+' : badge}</i> : t.id === 'calls' && missed ? <i className="rail-dot">{missed}</i> : null))}
        {role && role !== 'user' ? item('admin', 'Admin', 'shield-check') : null}
      </div>
      <div className="rail-group bottom">
        <button className="rail-item" onClick={() => go('settings/starred')} aria-label="Starred messages" title="Starred messages"><span className="rail-ico"><Icon name="star" size={22} stroke={1.8} /></span></button>
        <button className="rail-item" onClick={() => { go('chats'); window.dispatchEvent(new CustomEvent('wz-archived')); }} aria-label="Archived chats" title="Archived chats"><span className="rail-ico"><Icon name="archive" size={22} stroke={1.8} /></span></button>
        {item('settings', 'Settings', 'settings')}
        {me ? <button className="rail-me" onClick={() => go('settings/profile')} aria-label="Your profile" title="Your profile"><Avatar id={me.id} name={me.displayName} mediaId={me.avatarMediaId} size={32} /></button> : null}
      </div>
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
        const on = route.tab === id || (id === 'chats' && route.tab === 'settings');
        const label = id === 'status' ? 'Updates' : t.label;
        return (
          <button key={id} className={on ? 'active' : ''} onClick={() => go(id)} aria-current={on ? 'page' : undefined}>
            <span className="bn-ico"><Icon name={id === 'status' ? 'updates' : t.icon} size={24} stroke={on ? 2.2 : 1.7} fill={on && (id === 'chats' || id === 'communities')} />{id === 'chats' && badge ? <i className="badge alert">{badge > 99 ? '99+' : badge}</i> : null}{id === 'calls' && missed ? <i className="badge alert">{missed}</i> : null}</span>
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** The left pane: dark emerald header with search on desktop, white title header on tablets, deep-green app bar on phones. */
export function PaneFrame({ title, search, actions, strip, children, filters, onBack, sub, plain, overlay }: { title: string; search?: ReactNode; actions?: ReactNode; strip?: ReactNode; children: ReactNode; filters?: ReactNode; onBack?: () => void; sub?: string; plain?: boolean; overlay?: ReactNode }) {
  const layout = useLayout();
  if (layout === 'desktop') {
    return (
      <>
        <div className="pane-top"><h2 className="pane-title">{title}</h2><div className="row" style={{ gap: 2 }}>{actions}</div></div>
        {search ? <div className="pane-search">{search}</div> : null}
        <div className="list-card">{filters ? <div className="filters">{filters}</div> : null}{children}</div>
      </>
    );
  }
  return (
    <div className="pane-mobile">
      <header className={`app-bar ${plain ? 'plain' : ''}`}><div className="app-bar-row">{onBack ? <button className="icon-btn on-dark" onClick={onBack} aria-label="Back"><Icon name="back" /></button> : null}<h1 className="grow">{title}</h1>{actions}</div>{search}</header>
      <div className="pane-scroll">{strip}{filters ? <div className="filters">{filters}</div> : null}{children}</div>
      {overlay}
      <BottomNav />
    </div>
  );
}

export function ConnBanner() {
  const conn = useStore((s) => s.conn); const layout = useLayout();
  if (conn === 'online') return null;
  return <div className={`conn-banner ${conn}`}><Icon name="wifi-off" size={15} />{conn === 'connecting' ? 'Connecting…' : 'Waiting for network. Messages will send when you reconnect.'}</div>;
}
