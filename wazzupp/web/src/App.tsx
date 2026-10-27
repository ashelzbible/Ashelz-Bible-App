import { useEffect } from 'react';
import { boot, flushOutbox } from './lib/actions.ts';
import { resumeActiveCall } from './lib/rtc.ts';
import { useStore } from './lib/store.ts';
import { go, useLayout, useRoute } from './lib/route.ts';
import { applyAppearance } from './lib/theme.ts';
import { AuthScreen, VerifyGate } from './screens/Auth.tsx';
import { ConnBanner, Rail } from './screens/Frame.tsx';
import { ChatList } from './screens/ChatList.tsx';
import { Conversation } from './screens/Conversation.tsx';
import { CallDetail, CallOverlay, CallsList } from './screens/Calls.tsx';
import { CommunityDetail, CommunityList } from './screens/Communities.tsx';
import { StatusEmpty, StatusList, StatusViewer } from './screens/Status.tsx';
import { SettingsMenu, SettingsPage } from './screens/Settings.tsx';
import { Admin } from './screens/Admin.tsx';
import { Logo } from './ui/Logo.tsx';
import { Icon } from './ui/Icon.tsx';
import { Toasts } from './ui/Misc.tsx';
import { api } from './lib/api.ts';
import { toast } from './lib/store.ts';
import { loadConversations } from './lib/actions.ts';

function JoinHandler({ code }: { code: string }) {
  useEffect(() => {
    api.post(`/api/invites/${code}/join`).then(async (r) => { await loadConversations(); toast('Joined'); go(r.conversationId ? `chats/${r.conversationId}` : r.communityId ? `communities/${r.communityId}` : 'chats'); }).catch((e) => { toast(e.message || 'This invite link is not valid', 'error'); go('chats'); });
  }, [code]);
  return <div className="splash"><div className="spinner" /></div>;
}

function Main() {
  const route = useRoute(); const layout = useLayout();
  const desktop = layout === 'desktop';
  const hasDetail = !!route.id && route.tab !== 'admin';
  const jump = route.sub === 'm' ? Number(route.rest) : undefined;
  
  const left = route.tab === 'chats' ? <ChatList /> : route.tab === 'calls' ? <CallsList /> : route.tab === 'communities' ? <CommunityList /> : route.tab === 'status' ? <StatusList /> : route.tab === 'settings' ? <SettingsMenu /> : <ChatList />;
  const main = route.tab === 'chats' ? (route.id === 'join' ? <JoinHandler code={route.sub ?? ''} /> : route.id ? <Conversation key={route.id} id={route.id} jumpSeq={jump} /> : <Welcome />)
    : route.tab === 'calls' ? <CallDetail id={route.id} />
    : route.tab === 'communities' ? (route.id ? <CommunityDetail key={route.id} id={route.id} /> : <Welcome text="Select a community to see its groups and announcements." />)
    : route.tab === 'status' ? (route.id && route.id !== 'new' ? <StatusViewer key={route.id} userId={route.id} /> : <StatusEmpty />)
    : route.tab === 'settings' ? <SettingsPage section={route.id} />
    : <Admin />;

  if (route.tab === 'admin') return <div className="app admin-app"><Admin /></div>;
  if (route.id === 'join') return <JoinHandler code={route.sub ?? ''} />;
  // Phones show one pane at a time.
  if (layout === 'mobile') {
    const showMain = hasDetail && !(route.tab === 'status' && route.id === 'new');
    return <div className="app mobile"><ConnBanner />{showMain ? <div className="mobile-main">{main}</div> : left}</div>;
  }
  return (
    <div className={`app desktop tab-${route.tab}`}>
      <Rail /><section className="left-col"><ConnBanner />{left}</section>
      <main className="main-pane">{main}</main>
    </div>
  );
}

function Welcome({ text }: { text?: string }) {
  const keep = useStore((s) => s.me?.settings);
  void keep;
  return (
    <div className="welcome">
      <div className="welcome-art" aria-hidden="true"><div className="laptop"><div className="laptop-screen"><Logo size={92} /></div><div className="laptop-base" /></div></div>
      <h2>Wazzupp Web</h2>
      <p>{text ?? 'Send and receive messages from any browser, with your chats, calls and updates kept in sync across all your devices.'}</p>
      <hr />
      <span className="welcome-note"><Icon name="shield" size={14} /> Connect. Communicate. Collaborate.</span>
    </div>
  );
}

export function App() {
  const booted = useStore((s) => s.booted); const me = useStore((s) => s.me);
  useEffect(() => { void boot(); }, []);
  useEffect(() => { if (me) { applyAppearance(me.settings.appearance); void resumeActiveCall(); } }, [me?.id]);  
  useEffect(() => { const on = () => void flushOutbox(); window.addEventListener('online', on); return () => window.removeEventListener('online', on); }, []);
  const unread = useStore((s) => Object.values(s.convs).reduce((n, c) => n + (c.muted || c.archived ? 0 : c.unread), 0));
  useEffect(() => { document.title = unread ? `(${unread}) Wazzupp` : 'Wazzupp'; }, [unread]);
  let body;
  if (!booted) body = <div className="splash"><Logo size={96} /><div className="spinner" /></div>;
  else if (!me) body = <AuthScreen />;
  else if (!me.emailVerified && !me.phoneVerified) body = <VerifyGate />;
  else body = <><Main /><CallOverlay /></>;
  return <>{body}<Toasts /></>;
}
