import { api, ApiError } from './api.ts';
import { getState, setState, toast } from './store.ts';
import { realtime } from './realtime.ts';
import type { CallRec } from './types.ts';
import { loadCalls } from './actions.ts';

export type Quality = 'good' | 'fair' | 'poor' | 'unknown';
export interface CallMediaState {
  local: MediaStream | null; remote: MediaStream | null; muted: boolean; cameraOff: boolean; sharing: boolean; quality: Quality; reconnecting: boolean;
  seconds: number; facing: 'user' | 'environment'; error: string | null; devices: { audioIn: MediaDeviceInfo[]; audioOut: MediaDeviceInfo[]; videoIn: MediaDeviceInfo[] }; speakerId: string;
}
const blank = (): CallMediaState => ({ local: null, remote: null, muted: false, cameraOff: false, sharing: false, quality: 'unknown', reconnecting: false, seconds: 0, facing: 'user', error: null, devices: { audioIn: [], audioOut: [], videoIn: [] }, speakerId: '' });

let media: CallMediaState = blank();
const subs = new Set<() => void>();
export const getCallMedia = () => media;
export const subscribeCallMedia = (cb: () => void) => { subs.add(cb); return () => subs.delete(cb); };
function setMedia(p: Partial<CallMediaState>) { media = { ...media, ...p }; subs.forEach((s) => s()); }

let pc: RTCPeerConnection | null = null;
let iceServers: RTCIceServer[] = [];
let polite = false;
let makingOffer = false;
let pendingCandidates: RTCIceCandidateInit[] = [];
let timers: ReturnType<typeof setInterval>[] = [];
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartedOnce = false;
let reported = false;
let ringtone: { stop: () => void } | null = null;
const TERMINAL = new Set(['declined', 'missed', 'ended', 'failed', 'cancelled']);

function ring(kind: 'incoming' | 'outgoing') {
  ringtone?.stop();
  try {
    const ctx = new AudioContext(); let on = true;
    const beep = () => {
      if (!on || ctx.state === 'closed') return;
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = kind === 'incoming' ? 523 : 440; g.gain.value = 0.04; o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + (kind === 'incoming' ? 0.35 : 0.9));
    };
    beep(); const id = setInterval(beep, kind === 'incoming' ? 1400 : 3000);
    ringtone = { stop: () => { on = false; clearInterval(id); ctx.close().catch(() => {}); ringtone = null; } };
  } catch { /* autoplay policy: silent */ }
}
export function stopRing() { ringtone?.stop(); }

async function getLocal(kind: 'audio' | 'video'): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need a secure (HTTPS) connection and a supported browser.');
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: kind === 'video' ? { facingMode: media.facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false });
  } catch (e: any) {
    const name = e?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error(`Allow ${kind === 'video' ? 'camera and ' : ''}microphone access in your browser settings to make calls.`);
    if (name === 'NotFoundError') throw new Error(`No ${kind === 'video' ? 'camera or ' : ''}microphone found.`);
    throw new Error('Could not access your microphone/camera.');
  }
}
async function refreshDevices() {
  try {
    const d = await navigator.mediaDevices.enumerateDevices();
    setMedia({ devices: { audioIn: d.filter((x) => x.kind === 'audioinput'), audioOut: d.filter((x) => x.kind === 'audiooutput'), videoIn: d.filter((x) => x.kind === 'videoinput') } });
  } catch { /* ignore */ }
}

function createPc() {
  closePc();
  pendingCandidates = []; restartedOnce = false; reported = false; makingOffer = false;
  const p = new RTCPeerConnection({ iceServers });
  pc = p;
  const remote = new MediaStream();
  setMedia({ remote });
  p.ontrack = (e) => { e.streams[0]?.getTracks().forEach((t) => { if (!remote.getTracks().includes(t)) remote.addTrack(t); }); if (!e.streams[0] && !remote.getTracks().includes(e.track)) remote.addTrack(e.track); setMedia({ remote: new MediaStream(remote.getTracks()) }); };
  p.onicecandidate = (e) => { const id = getState().activeCall?.id; if (e.candidate && id) realtime.send({ t: 'call.signal', callId: id, signal: { type: 'candidate', candidate: e.candidate.toJSON() } }); };
  p.onnegotiationneeded = async () => {
    const id = getState().activeCall?.id; if (!id) return;
    try {
      makingOffer = true;
      await p.setLocalDescription();
      realtime.send({ t: 'call.signal', callId: id, signal: { type: 'offer', sdp: p.localDescription!.sdp } });
    } catch { /* renegotiation raced with teardown */ } finally { makingOffer = false; }
  };
  p.onconnectionstatechange = () => {
    const st = p.connectionState;
    if (st === 'connected') {
      if (restartTimer) clearTimeout(restartTimer);
      setMedia({ reconnecting: false });
      if (!reported) { reported = true; const id = getState().activeCall?.id; if (id) api.post(`/api/calls/${id}/media_up`).catch(() => {}); }
    } else if (st === 'disconnected') {
      setMedia({ reconnecting: true });
      restartTimer = setTimeout(() => tryRestart(), 3500);
    } else if (st === 'failed') {
      tryRestart();
    }
  };
  timers.push(setInterval(pollStats, 2000));
  return p;
}
async function tryRestart() {
  const p = pc; const call = getState().activeCall;
  if (!p || !call || TERMINAL.has(call.state)) return;
  if (p.connectionState === 'connected') return;
  if (!restartedOnce) { restartedOnce = true; setMedia({ reconnecting: true }); p.restartIce(); return; } // reconnect after a temporary network loss
  if (p.connectionState === 'failed') { await api.post(`/api/calls/${call.id}/failed`).catch(() => {}); }
}
async function pollStats() {
  if (!pc || pc.connectionState !== 'connected') return;
  try {
    const stats = await pc.getStats(); let rtt = 0, lost = 0, recv = 0;
    stats.forEach((r: any) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && r.currentRoundTripTime) rtt = r.currentRoundTripTime * 1000;
      if (r.type === 'inbound-rtp' && !r.isRemote) { lost += r.packetsLost ?? 0; recv += r.packetsReceived ?? 0; }
    });
    const loss = recv + lost > 0 ? lost / (recv + lost) : 0;
    setMedia({ quality: rtt > 400 || loss > 0.1 ? 'poor' : rtt > 200 || loss > 0.03 ? 'fair' : 'good' });
  } catch { /* ignore */ }
}

function closePc() {
  timers.forEach(clearInterval); timers = [];
  if (restartTimer) clearTimeout(restartTimer);
  if (pc) { pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = pc.onconnectionstatechange = null; pc.close(); pc = null; }
}
function teardown() {
  stopRing();
  closePc();
  media.local?.getTracks().forEach((t) => t.stop());
  setMedia({ ...blank(), devices: media.devices });
}

function attachLocal() {
  if (!pc || !media.local) return;
  for (const t of media.local.getTracks()) if (!pc.getSenders().some((s) => s.track === t)) pc.addTrack(t, media.local);
}

realtime.signalHandlers.add(async (m) => {
  const call = getState().activeCall;
  if (!call || m.callId !== call.id || !pc) return;
  const sig = m.signal;
  try {
    if (sig.type === 'offer') {
      const collision = makingOffer || pc.signalingState !== 'stable';
      if (collision && !polite) return; // impolite peer ignores colliding offers
      await pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
      attachLocal();
      await pc.setLocalDescription();
      realtime.send({ t: 'call.signal', callId: call.id, signal: { type: 'answer', sdp: pc.localDescription!.sdp } });
      for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (sig.type === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
      for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (sig.type === 'candidate') {
      if (pc.remoteDescription) await pc.addIceCandidate(sig.candidate).catch(() => {}); else pendingCandidates.push(sig.candidate);
    }
  } catch (e) { console.warn('signal handling failed', e); }
});

// ---------------------------------------------------------------- public API
export async function startCall(conversationId: string, kind: 'audio' | 'video') {
  if (getState().activeCall) { toast('You are already in a call', 'error'); return; }
  try {
    const local = await getLocal(kind);
    setMedia({ ...blank(), local, cameraOff: kind === 'audio' });
    void refreshDevices();
    const r = await api.post<{ call: CallRec; iceServers: RTCIceServer[] }>('/api/calls', { conversationId, kind });
    iceServers = r.iceServers; polite = false;
    setState({ activeCall: { ...r.call, incoming: false } });
    ring('outgoing');
  } catch (e: any) {
    media.local?.getTracks().forEach((t) => t.stop()); setMedia(blank());
    toast(e instanceof ApiError ? (e.code === 'busy' ? 'They are on another call' : e.message) : e.message, 'error');
  }
}

export async function acceptCall() {
  const call = getState().activeCall; if (!call) return;
  stopRing();
  try {
    const local = await getLocal(call.kind);
    setMedia({ ...blank(), local, cameraOff: call.kind === 'audio' });
    void refreshDevices();
    const r = await api.post<{ call: CallRec; iceServers: RTCIceServer[] }>(`/api/calls/${call.id}/accept`);
    iceServers = r.iceServers; polite = true;
    setState({ activeCall: { ...call, ...r.call, incoming: true } });
    createPc(); attachLocal();
  } catch (e: any) {
    toast(e.message ?? 'Could not answer', 'error');
    await api.post(`/api/calls/${call.id}/decline`).catch(() => {});
  }
}
export async function declineCall() { const c = getState().activeCall; if (!c) return; stopRing(); await api.post(`/api/calls/${c.id}/decline`).catch(() => {}); }
export async function hangUp() {
  const c = getState().activeCall; if (!c) return;
  const action = c.state === 'ringing' && !c.incoming ? 'cancel' : 'end';
  await api.post(`/api/calls/${c.id}/${action}`).catch(() => {});
  finish(c.id);
}
function finish(id: string) {
  if (getState().activeCall?.id !== id) return;
  teardown(); setState({ activeCall: null }); void loadCalls().catch(() => {});
}

export async function onCallEvent(type: string, p: any) {
  const me = getState().me?.id;
  const call: CallRec = p.call;
  if (type === 'call.incoming') {
    if (call.initiatorId === me) { // my other device started it: only show on the device that is placing it
      return;
    }
    if (getState().activeCall) return;
    setState({ activeCall: { ...call, incoming: true } });
    ring('incoming');
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Incoming call', { body: call.kind === 'video' ? 'Video call' : 'Voice call', tag: call.id });
    return;
  }
  const cur = getState().activeCall;
  if (!cur || cur.id !== call.id) { if (TERMINAL.has(call.state)) void loadCalls().catch(() => {}); return; }
  setState({ activeCall: { ...cur, ...call } });
  if (TERMINAL.has(call.state)) { stopRing(); setTimeout(() => finish(call.id), cur.state === 'ringing' ? 900 : 700); return; }
  if (call.state === 'connecting' && !cur.incoming && !pc) { // callee accepted: caller builds the connection and sends the offer
    stopRing(); createPc(); attachLocal();
  }
  if (call.state === 'connected') {
    stopRing();
    const start = call.connectedAt ? new Date(call.connectedAt).getTime() : Date.now();
    timers.push(setInterval(() => setMedia({ seconds: Math.max(0, Math.round((Date.now() - start) / 1000)) }), 500));
  }
}

export function toggleMute() { const t = media.local?.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled; setMedia({ muted: !t.enabled }); }
export async function toggleCamera() {
  if (!media.local) return;
  let v = media.local.getVideoTracks()[0];
  if (!v) { // audio call upgraded to video
    try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); v = s.getVideoTracks()[0]; media.local.addTrack(v); pc?.addTrack(v, media.local); setMedia({ local: new MediaStream(media.local.getTracks()), cameraOff: false }); } catch { toast('Camera unavailable', 'error'); }
    return;
  }
  v.enabled = !v.enabled; setMedia({ cameraOff: !v.enabled });
}
export async function switchCamera() {
  if (!media.local) return;
  const facing = media.facing === 'user' ? 'environment' : 'user';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
    const nv = s.getVideoTracks()[0]; const old = media.local.getVideoTracks()[0];
    const sender = pc?.getSenders().find((x) => x.track?.kind === 'video');
    if (sender) await sender.replaceTrack(nv);
    if (old) { media.local.removeTrack(old); old.stop(); }
    media.local.addTrack(nv); setMedia({ local: new MediaStream(media.local.getTracks()), facing });
  } catch { toast('Could not switch camera', 'error'); }
}
export async function toggleScreenShare() {
  if (!pc || !media.local) return;
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
  if (media.sharing) {
    const cam = media.local.getVideoTracks()[0];
    if (sender && cam) await sender.replaceTrack(cam);
    setMedia({ sharing: false }); return;
  }
  if (!navigator.mediaDevices.getDisplayMedia) { toast('Screen sharing is not supported on this device', 'error'); return; }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const t = s.getVideoTracks()[0];
    t.onended = () => { if (media.sharing) void toggleScreenShare(); };
    if (sender) await sender.replaceTrack(t); else pc.addTrack(t, s);
    setMedia({ sharing: true });
  } catch { /* user cancelled the picker */ }
}
export function setSpeaker(id: string) { setMedia({ speakerId: id }); }
export async function setMicrophone(deviceId: string) {
  if (!media.local) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    const nt = s.getAudioTracks()[0]; const old = media.local.getAudioTracks()[0];
    const sender = pc?.getSenders().find((x) => x.track?.kind === 'audio');
    if (sender) await sender.replaceTrack(nt);
    if (old) { media.local.removeTrack(old); old.stop(); }
    media.local.addTrack(nt); setMedia({ local: new MediaStream(media.local.getTracks()), muted: false });
  } catch { toast('Could not use that microphone', 'error'); }
}
export async function resumeActiveCall() {
  try { const { call } = await api.get('/api/calls/active'); if (call && !getState().activeCall) await onCallEvent('call.incoming', { call }); } catch { /* ignore */ }
}
