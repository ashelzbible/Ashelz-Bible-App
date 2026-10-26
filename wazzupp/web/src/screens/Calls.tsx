import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { duration, listTime, clock } from '../lib/format.ts';
import { go, useLayout, useRoute } from '../lib/route.ts';
import { useStore } from '../lib/store.ts';
import type { CallHistory } from '../lib/types.ts';
import { acceptCall, declineCall, getCallMedia, hangUp, setMicrophone, setSpeaker, startCall, subscribeCallMedia, switchCamera, toggleCamera, toggleMute, toggleScreenShare } from '../lib/rtc.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Empty } from '../ui/Misc.tsx';
import { useMenu } from '../ui/Overlay.tsx';
import { PaneFrame } from './Frame.tsx';
import { markCallsSeen } from '../lib/actions.ts';
import { openDirect } from '../lib/actions.ts';

type F = 'all' | 'missed' | 'incoming' | 'outgoing';
const stateLabel = (c: CallHistory) => c.state === 'missed' ? (c.direction === 'incoming' ? 'Missed' : 'No answer') : c.state === 'declined' ? 'Declined' : c.state === 'cancelled' ? 'Cancelled' : c.state === 'failed' ? 'Failed' : c.direction === 'incoming' ? 'Incoming' : 'Outgoing';

export function CallsList() {
  const calls = useStore((s) => s.calls); const route = useRoute(); const layout = useLayout();
  const [f, setF] = useState<F>('all');
  useEffect(() => { void markCallsSeen(); }, []);
  const list = calls.filter((c) => f === 'all' || (f === 'missed' ? c.state === 'missed' && c.direction === 'incoming' : f === c.direction));
  const call = async (c: CallHistory) => { const id = await openDirect(c.other.id); void startCall(id, c.kind); };
  const filters = (['all', 'missed', 'incoming', 'outgoing'] as F[]).map((x) => <button key={x} className="chip" aria-pressed={f === x} onClick={() => setF(x)}>{x[0].toUpperCase() + x.slice(1)}</button>);
  return (
    <PaneFrame title="Calls" filters={filters}>
      {list.length ? <ul className="conv-list">{list.map((c) => {
        const missed = c.state === 'missed' && c.direction === 'incoming';
        return (
          <li key={c.id}><div className={`conv-row call-row ${route.tab === 'calls' && route.id === c.id && layout !== 'mobile' ? 'sel' : ''}`}>
            <button className="call-open" onClick={() => go(`calls/${c.id}`)}>
              <Avatar id={c.other.id} name={c.other.displayName} mediaId={c.other.avatarMediaId} size={layout === 'mobile' ? 52 : 46} />
              <span className="conv-main"><span className="conv-line"><span className={`conv-name truncate ${missed ? 'missed' : ''}`}>{c.other.displayName}</span></span>
                <span className="conv-prev"><Icon name={missed ? 'phone-missed' : c.direction === 'incoming' ? 'phone-in' : 'phone-out'} size={15} className={`inl ${missed ? 'red' : 'green'}`} /><span className={missed ? 'red' : ''}>{stateLabel(c)}</span><span> · {listTime(c.createdAt) === clock(c.createdAt) ? clock(c.createdAt) : listTime(c.createdAt)}{c.durationSec ? ` · ${duration(c.durationSec)}` : ''}</span></span></span>
            </button>
            <button className="call-btn" onClick={() => call(c)} aria-label={`${c.kind === 'video' ? 'Video' : 'Voice'} call ${c.other.displayName}`}><Icon name={c.kind === 'video' ? 'video' : 'phone'} size={20} /></button>
          </div></li>);
      })}</ul> : <Empty icon="phone" title="No calls yet" text="Your voice and video call history will appear here." />}
    </PaneFrame>
  );
}

export function CallDetail({ id }: { id?: string }) {
  const calls = useStore((s) => s.calls); const layout = useLayout();
  const c = calls.find((x) => x.id === id);
  if (!c) return <div className="conv-empty"><div className="empty"><div className="empty-art"><Icon name="phone" size={38} stroke={1.6} /></div><h3>Calls</h3><p>Select a call to see details, or start a call from any chat.</p></div></div>;
  const hist = calls.filter((x) => x.other.id === c.other.id);
  const go2 = async (kind: 'audio' | 'video') => { const cid = await openDirect(c.other.id); void startCall(cid, kind); };
  return (
    <div className="call-detail">
      {layout !== 'desktop' ? <button className="icon-btn" onClick={() => go('calls')} aria-label="Back"><Icon name="back" /></button> : null}
      <Avatar id={c.other.id} name={c.other.displayName} mediaId={c.other.avatarMediaId} size={120} />
      <h2>{c.other.displayName}</h2><span className="muted">@{c.other.username}</span>
      <div className="info-actions big"><button onClick={() => go2('audio')}><Icon name="phone" /><span>Voice call</span></button><button onClick={() => go2('video')}><Icon name="video" /><span>Video call</span></button><button onClick={async () => { const cid = await openDirect(c.other.id); go(`chats/${cid}`); }}><Icon name="chat" /><span>Message</span></button></div>
      <ul className="call-history">{hist.map((h) => <li key={h.id}><Icon name={h.state === 'missed' && h.direction === 'incoming' ? 'phone-missed' : h.direction === 'incoming' ? 'phone-in' : 'phone-out'} size={18} className={h.state === 'missed' && h.direction === 'incoming' ? 'red' : 'green'} /><span className="grow">{stateLabel(h)} {h.kind} call</span><small className="muted">{new Date(h.createdAt).toLocaleString()}{h.durationSec ? ` · ${duration(h.durationSec)}` : ''}</small></li>)}</ul>
    </div>
  );
}

function useCallMedia() { return useSyncExternalStore(subscribeCallMedia, getCallMedia, getCallMedia); }

export function CallOverlay() {
  const call = useStore((s) => s.activeCall); const layout = useLayout();
  const media = useCallMedia();
  const peerId = useStore((s) => { const c = s.activeCall; if (!c) return null; const conv = s.convs[c.conversationId]; return conv?.other ?? null; });
  const [minimized, setMin] = useState(false);
  const remoteRef = useRef<HTMLVideoElement>(null); const localRef = useRef<HTMLVideoElement>(null);
  const menu = useMenu();
  useEffect(() => { if (remoteRef.current) remoteRef.current.srcObject = media.remote; }, [media.remote, call?.id]);
  useEffect(() => { if (localRef.current) localRef.current.srcObject = media.local; }, [media.local, call?.id, minimized]);
  useEffect(() => { const v = remoteRef.current as any; if (v?.setSinkId && media.speakerId) v.setSinkId(media.speakerId).catch(() => {}); }, [media.speakerId]);
  useEffect(() => { if (call) setMin(false); }, [call?.id]);
  if (!call) return null;
  const name = peerId?.displayName ?? 'Unknown';
  const incoming = !!call.incoming && call.state === 'ringing';
  const ended = ['declined', 'missed', 'ended', 'failed', 'cancelled'].includes(call.state);
  const hasRemoteVideo = media.remote?.getVideoTracks().some((t) => t.readyState === 'live') && call.kind === 'video' || (media.remote?.getVideoTracks().length ?? 0) > 0;
  const status = ended ? ({ declined: 'Call declined', missed: 'No answer', ended: 'Call ended', failed: 'Connection failed', cancelled: 'Cancelled' } as Record<string, string>)[call.state]
    : incoming ? `Incoming ${call.kind} call` : media.reconnecting ? 'Reconnecting…' : call.state === 'ringing' ? 'Ringing…' : call.state === 'connecting' ? 'Connecting…' : duration(media.seconds);
  if (minimized && !ended) return createPortal(<button className="call-pill" onClick={() => setMin(false)}><Icon name="phone-call" size={18} />Return to call · {call.state === 'connected' ? duration(media.seconds) : status}</button>, document.body);
  const sink = (e: React.MouseEvent<HTMLElement>) => menu.open([
    ...media.devices.audioOut.map((d) => ({ label: d.label || 'Speaker', icon: 'volume' as const, selected: media.speakerId === d.deviceId, onClick: () => setSpeaker(d.deviceId) })),
    ...media.devices.audioIn.map((d) => ({ label: `Mic: ${d.label || 'Microphone'}`, icon: 'mic' as const, onClick: () => void setMicrophone(d.deviceId) })),
  ].slice(0, 10), e.currentTarget);
  return createPortal(
    <div className={`call-overlay ${layout}`} role="dialog" aria-label="Call">
      <video ref={remoteRef} autoPlay playsInline className={hasRemoteVideo ? 'call-remote' : 'call-remote hidden'} />
      <div className="call-top">
        <button className="icon-btn on-dark" onClick={() => setMin(true)} aria-label="Minimize call"><Icon name="down" /></button>
        <span className="grow" />
        {call.state === 'connected' ? <span className={`quality ${media.quality}`} title={`Connection: ${media.quality}`}><i /><i /><i /></span> : null}
      </div>
      <div className="call-center">
        {!hasRemoteVideo || incoming ? <Avatar id={peerId?.id} name={name} mediaId={peerId?.avatarMediaId} size={layout === 'mobile' ? 150 : 176} ring className="call-avatar" /> : null}
        <h2>{name}</h2><p className="call-status" aria-live="polite">{status}</p>
        {media.error ? <p className="err">{media.error}</p> : null}
      </div>
      {call.kind === 'video' || media.local?.getVideoTracks().length ? <video ref={localRef} autoPlay playsInline muted className={`call-local ${media.cameraOff ? 'off' : ''}`} /> : null}
      {incoming ? (
        <div className="call-actions two"><div><button className="call-round end" onClick={() => declineCall()} aria-label="Decline"><Icon name="phone-off" size={30} /></button><span>Decline</span></div><div><button className="call-round accept" onClick={() => acceptCall()} aria-label="Accept"><Icon name={call.kind === 'video' ? 'video' : 'phone'} size={30} /></button><span>Accept</span></div></div>
      ) : ended ? null : (
        <div className="call-actions">
          <div className="call-opts">
            <div><button className="call-opt" onClick={sink} aria-label="Audio output"><Icon name="volume" size={26} /></button><span>Speaker</span></div>
            <div><button className={`call-opt ${media.muted ? 'on' : ''}`} onClick={toggleMute} aria-pressed={media.muted} aria-label="Mute"><Icon name={media.muted ? 'mic-off' : 'mic'} size={26} /></button><span>{media.muted ? 'Unmute' : 'Mute'}</span></div>
            <div><button className={`call-opt ${media.cameraOff ? 'on' : ''}`} onClick={() => toggleCamera()} aria-pressed={!media.cameraOff} aria-label="Camera"><Icon name={media.cameraOff ? 'video-off' : 'video'} size={26} /></button><span>Camera</span></div>
            {call.kind === 'video' && !media.cameraOff && (media.devices.videoIn.length > 1 || layout === 'mobile') ? <div><button className="call-opt" onClick={() => switchCamera()} aria-label="Switch camera"><Icon name="switch-camera" size={26} /></button><span>Flip</span></div> : null}
            {layout !== 'mobile' && 'getDisplayMedia' in (navigator.mediaDevices ?? {}) && call.state === 'connected' ? <div><button className={`call-opt ${media.sharing ? 'on' : ''}`} onClick={() => toggleScreenShare()} aria-pressed={media.sharing} aria-label="Share screen"><Icon name="screen-share" size={26} /></button><span>{media.sharing ? 'Stop' : 'Share'}</span></div> : null}
          </div>
          <button className="call-round end" onClick={() => hangUp()} aria-label="End call"><Icon name="phone-off" size={30} /></button>
        </div>
      )}
      {media.sharing ? <div className="sharing-bar"><Icon name="screen-share" size={18} />You are sharing your screen<button className="btn btn-danger btn-sm" onClick={() => toggleScreenShare()}>Stop sharing</button></div> : null}
      {menu.node}
    </div>, document.body);
}
