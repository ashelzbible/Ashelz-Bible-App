import { useCallback, useEffect, useRef, useState } from 'react';
import { api, uploadWithProgress } from '../lib/api.ts';
import { duration } from '../lib/format.ts';
import { realtime } from '../lib/realtime.ts';
import { getState, toast, useStore } from '../lib/store.ts';
import type { Conv, Msg } from '../lib/types.ts';
import { guard, sendMessage, toastError } from '../lib/actions.ts';
import { Icon } from '../ui/Icon.tsx';
import { useMenu } from '../ui/Overlay.tsx';
import { EmojiPicker } from './Emoji.tsx';
import { ContactPicker, EventDialog, PollDialog, ScheduleDialog } from './Dialogs.tsx';

interface Pending { id: string; file: File; kind: 'image' | 'video' | 'document' | 'audio'; preview?: string; progress: number; error?: string; abort?: () => void }
const kindOf = (f: File): Pending['kind'] => (f.type.startsWith('image/') && f.type !== 'image/svg+xml' ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'document');

export function Composer({ conv, reply, editing, onClearReply, onCancelEdit, onSent, files, clearFiles }: {
  conv: Conv; reply: Msg | null; editing: Msg | null; onClearReply: () => void; onCancelEdit: () => void; onSent: () => void; files: File[]; clearFiles: () => void;
}) {
  const me = useStore((s) => s.me!);
  const [text, setText] = useState(conv.draft ?? '');
  const [emoji, setEmoji] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dlg, setDlg] = useState<null | 'poll' | 'event' | 'contact' | 'schedule'>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null); const docRef = useRef<HTMLInputElement>(null); const camRef = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const typingAt = useRef(0); const pauseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const menu = useMenu();
  const convId = conv.id;

  // Draft persistence (local + server so it follows you to other devices)
  useEffect(() => { setText(editing ? editing.body : (getState().convs[convId]?.draft ?? '')); }, [convId, editing?.id]);
  useEffect(() => () => clearTimeout(draftTimer.current), []);
  const saveDraft = (v: string) => {
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { if (!editing) api.put(`/api/conversations/${convId}/draft`, { draft: v || null }).catch(() => {}); }, 700);
  };
  useEffect(() => { const el = ta.current; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; }, [text]);
  useEffect(() => { if (reply || editing) ta.current?.focus(); }, [reply, editing]);

  const onType = (v: string) => {
    setText(v); saveDraft(v);
    const now = Date.now();
    if (v && now - typingAt.current > 3000) { typingAt.current = now; realtime.send({ t: 'typing', conversationId: convId, state: 'composing' }); }
    clearTimeout(pauseTimer.current);
    pauseTimer.current = setTimeout(() => { typingAt.current = 0; realtime.send({ t: 'typing', conversationId: convId, state: 'paused' }); }, 4000);
  };

  // ---- attachments ----
  const addFiles = useCallback((list: File[]) => {
    const next: Pending[] = list.slice(0, 10).map((f) => ({ id: crypto.randomUUID(), file: f, kind: kindOf(f), preview: f.type.startsWith('image/') && f.type !== 'image/svg+xml' ? URL.createObjectURL(f) : undefined, progress: 0 }));
    setPending((p) => [...p, ...next].slice(0, 10));
  }, []);
  useEffect(() => { if (files.length) { addFiles(files); clearFiles(); } }, [files, addFiles, clearFiles]);
  useEffect(() => () => pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), []);  

  async function uploadAll(caption: string) {
    const items = pending.slice();
    let ok = 0;
    for (const [i, it] of items.entries()) {
      const up = uploadWithProgress(it.file, it.file.name, it.kind, {}, (pr) => setPending((p) => p.map((x) => (x.id === it.id ? { ...x, progress: pr } : x))));
      setPending((p) => p.map((x) => (x.id === it.id ? { ...x, abort: up.abort, error: undefined } : x)));
      try {
        const r = await up.promise;
        sendMessage(convId, { kind: it.kind, mediaId: r.media.id, body: i === 0 ? caption : '', replyToId: i === 0 ? reply?.id : null, _media: r.media });
        setPending((p) => p.filter((x) => x.id !== it.id)); ok++;
        if (it.preview) URL.revokeObjectURL(it.preview);
      } catch (e: any) { setPending((p) => p.map((x) => (x.id === it.id ? { ...x, error: e.message, progress: 0 } : x))); }
    }
    return ok;
  }

  async function send() {
    const body = text.trim();
    if (editing) {
      if (!body || body === editing.body) { onCancelEdit(); return; }
      await guard(api.patch(`/api/messages/${editing.id}`, { body }));
      onCancelEdit(); setText(''); return;
    }
    if (pending.length) {
      const ok = await uploadAll(body);
      if (ok) { setText(''); saveDraft(''); onClearReply(); onSent(); }
      return;
    }
    if (!body) return;
    const mentions = [...body.matchAll(/@([\p{L}\p{N}_.]+)/gu)].map((m) => m[1].toLowerCase());
    const memberList = getState().members[convId] ?? [];
    const ids = memberList.filter((m) => mentions.includes(m.username.toLowerCase()) || mentions.includes(m.displayName.split(' ')[0].toLowerCase())).map((m) => m.id);
    sendMessage(convId, { kind: 'text', body, replyToId: reply?.id ?? null, mentions: ids });
    setText(''); saveDraft(''); onClearReply(); onSent();
    clearTimeout(pauseTimer.current); realtime.send({ t: 'typing', conversationId: convId, state: 'paused' }); typingAt.current = 0;
  }

  // ---- voice notes ----
  const [rec, setRec] = useState<null | { state: 'recording' | 'preview'; ms: number; levels: number[]; url?: string; blob?: Blob }>(null);
  const recRef = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; t0: number; timer: ReturnType<typeof setInterval>; levels: number[]; ctx: AudioContext; raf: number } | null>(null);
  async function startRec() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast('Voice notes are not supported in this browser', 'error'); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { toast('Allow microphone access to record voice notes', 'error'); return; }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = []; const levels: number[] = [];
    const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 256; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    let last = 0; let raf = 0;
    const tick = (ts: number) => { an.getByteTimeDomainData(buf); if (ts - last > 90) { last = ts; let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128)); levels.push(Math.min(1, peak / 80)); setRec((r) => (r ? { ...r, levels: levels.slice(-48) } : r)); } raf = requestAnimationFrame(tick); if (recRef.current) recRef.current.raf = raf; };
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const t0 = Date.now();
    const timer = setInterval(() => setRec((r) => (r && r.state === 'recording' ? { ...r, ms: Date.now() - t0 } : r)), 200);
    recRef.current = { mr, stream, chunks, t0, timer, levels, ctx, raf: 0 };
    mr.start(250); raf = requestAnimationFrame(tick);
    realtime.send({ t: 'typing', conversationId: convId, state: 'recording' });
    setRec({ state: 'recording', ms: 0, levels: [] });
  }
  function cleanupRec() { const r = recRef.current; if (!r) return; clearInterval(r.timer); cancelAnimationFrame(r.raf); r.stream.getTracks().forEach((t) => t.stop()); r.ctx.close().catch(() => {}); recRef.current = null; }
  function stopRec() {
    const r = recRef.current; if (!r) return;
    r.mr.onstop = () => { const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' }); const ms = Date.now() - r.t0; cleanupRec(); setRec({ state: 'preview', ms, levels: r.levels, url: URL.createObjectURL(blob), blob }); };
    r.mr.stop();
    realtime.send({ t: 'typing', conversationId: convId, state: 'paused' });
  }
  function cancelRec() { const r = recRef.current; if (r) { r.mr.onstop = null; try { r.mr.stop(); } catch { /* already stopped */ } } cleanupRec(); if (rec?.url) URL.revokeObjectURL(rec.url); setRec(null); }
  async function sendRec() {
    if (!rec?.blob) return;
    const ext = rec.blob.type.includes('ogg') ? 'ogg' : rec.blob.type.includes('mp4') ? 'm4a' : 'webm';
    const bins = 40; const src = rec.levels.length ? rec.levels : [0.3]; const wave = Array.from({ length: bins }, (_, i) => { const a = Math.floor((i / bins) * src.length), b = Math.max(a + 1, Math.floor(((i + 1) / bins) * src.length)); return Math.round((src.slice(a, b).reduce((s, v) => Math.max(s, v), 0) || 0.08) * 100) / 100; });
    const blob = rec.blob; const ms = rec.ms;
    try {
      const up = uploadWithProgress(blob, `voice-${Date.now()}.${ext}`, 'voice', { durationMs: String(ms), waveform: JSON.stringify(wave) }, () => {});
      const r = await up.promise;
      sendMessage(convId, { kind: 'voice', mediaId: r.media.id, replyToId: reply?.id ?? null, _media: r.media });
      if (rec.url) URL.revokeObjectURL(rec.url); setRec(null); onClearReply(); onSent();
    } catch (e) { toastError(e); } // upload recovery: the recording stays in preview so it can be retried
  }
  useEffect(() => () => { cleanupRec(); }, []);  

  async function shareLocation() {
    if (!navigator.geolocation) { toast('Location is not available on this device', 'error'); return; }
    navigator.geolocation.getCurrentPosition((p) => sendMessage(convId, { kind: 'location', meta: { lat: p.coords.latitude, lng: p.coords.longitude, label: 'My location' } }), () => toast('Allow location access to share it', 'error'), { enableHighAccuracy: true, timeout: 10000 });
  }

  const attach = (e: React.MouseEvent<HTMLElement>) => menu.open([
    { label: 'Photos & videos', icon: 'image', onClick: () => fileRef.current?.click() },
    { label: 'Camera', icon: 'camera', onClick: () => camRef.current?.click() },
    { label: 'Document', icon: 'doc', onClick: () => docRef.current?.click() },
    { label: 'Location', icon: 'map-pin', onClick: shareLocation },
    { label: 'Contact', icon: 'user', onClick: () => setDlg('contact') },
    { label: 'Poll', icon: 'bar-chart', onClick: () => setDlg('poll') },
    { label: 'Event', icon: 'calendar', onClick: () => setDlg('event') },
    { label: 'Schedule message', icon: 'clock', onClick: () => setDlg('schedule') },
  ], e.currentTarget);

  const can = text.trim().length > 0 || pending.length > 0;
  const uploading = pending.some((p) => p.progress > 0 && p.progress < 1);

  if (rec) {
    return (
      <div className="composer rec">
        <button className="icon-btn" onClick={cancelRec} aria-label="Cancel recording"><Icon name="trash" /></button>
        {rec.state === 'recording' ? <>
          <span className="rec-dot" /><span className="rec-time">{duration(rec.ms / 1000)}</span>
          <div className="rec-wave" aria-hidden="true">{rec.levels.map((l, i) => <i key={i} style={{ height: `${Math.max(10, l * 100)}%` }} />)}</div>
          <button className="send-btn" onClick={stopRec} aria-label="Stop recording"><Icon name="check" size={22} stroke={2.6} /></button>
        </> : <>
          <audio src={rec.url} controls className="rec-audio" />
          <button className="send-btn" onClick={sendRec} aria-label="Send voice message"><Icon name="send" size={21} fill /></button>
        </>}
      </div>
    );
  }
  return (
    <div className="composer-wrap">
      {reply || editing ? (
        <div className="ctx-bar"><Icon name={editing ? 'edit' : 'reply'} size={18} /><div className="grow"><b>{editing ? 'Edit message' : `Replying to ${reply!.senderId === me.id ? 'yourself' : getState().members[convId]?.find((m) => m.id === reply!.senderId)?.displayName ?? getState().convs[convId]?.other?.displayName ?? ''}`}</b><span className="truncate" style={{ display: 'block' }}>{(editing ?? reply)!.body || (editing ?? reply)!.kind}</span></div><button className="icon-btn" onClick={editing ? onCancelEdit : onClearReply} aria-label="Cancel"><Icon name="x" size={18} /></button></div>
      ) : null}
      {pending.length ? (
        <div className="tray" aria-label="Attachments">{pending.map((p) => (
          <div className="tray-item" key={p.id}>
            {p.preview ? <img src={p.preview} alt="" /> : <span className="tray-doc"><Icon name={p.kind === 'video' ? 'video' : p.kind === 'audio' ? 'headphones' : 'doc'} size={26} /><small className="truncate">{p.file.name}</small></span>}
            {p.progress > 0 && p.progress < 1 ? <i className="tray-progress" style={{ width: `${p.progress * 100}%` }} /> : null}
            {p.error ? <span className="tray-err" title={p.error}><Icon name="info" size={16} /></span> : null}
            <button className="tray-x" onClick={() => { p.abort?.(); setPending((l) => l.filter((x) => x.id !== p.id)); }} aria-label="Remove"><Icon name="x" size={14} /></button>
          </div>))}
        </div>
      ) : null}
      {emoji ? <EmojiPicker onPick={(e) => { const el = ta.current; const s = el?.selectionStart ?? text.length, en = el?.selectionEnd ?? text.length; const v = text.slice(0, s) + e + text.slice(en); onType(v); requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(s + e.length, s + e.length); }); }} /> : null}
      <div className="composer">
        <button className={`icon-btn ${emoji ? 'on' : ''}`} onClick={() => setEmoji((v) => !v)} aria-label="Emoji" aria-pressed={emoji}><Icon name="smile" /></button>
        <button className="icon-btn" onClick={attach} aria-label="Attach"><Icon name="attach" /></button>
        <textarea ref={ta} className="composer-input" rows={1} placeholder={pending.length ? 'Add a caption…' : 'Type a message'} value={text} aria-label="Message"
          onChange={(e) => onType(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (matchMedia('(pointer:fine)').matches || e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } if (e.key === 'Escape') { setEmoji(false); if (editing) onCancelEdit(); else onClearReply(); } if (e.key === 'ArrowUp' && !text) { const mine = [...(getState().msgs[convId]?.list ?? [])].reverse().find((m) => m.senderId === me.id && m.kind === 'text' && !m.deleted && !m.local); if (mine) { e.preventDefault(); document.dispatchEvent(new CustomEvent('wz-edit', { detail: mine })); } } }}
          onPaste={(e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); addFiles(fs); } }} />
        {!text.trim() && !pending.length ? <button className="icon-btn hide-sm" onClick={() => camRef.current?.click()} aria-label="Camera"><Icon name="camera" /></button> : null}
        {can ? <button className="send-btn" onClick={() => void send()} disabled={uploading} aria-label={editing ? 'Save edit' : 'Send'}>{uploading ? <span className="spinner" style={{ borderTopColor: '#fff' }} /> : <Icon name={editing ? 'check' : 'send'} size={21} fill={!editing} stroke={editing ? 2.6 : 1.9} />}</button>
          : <button className="send-btn" onClick={startRec} aria-label="Record voice message"><Icon name="mic" size={22} /></button>}
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      <input ref={camRef} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      <input ref={docRef} type="file" hidden multiple onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      {menu.node}
      {dlg === 'poll' ? <PollDialog convId={convId} onClose={() => setDlg(null)} /> : null}
      {dlg === 'event' ? <EventDialog convId={convId} onClose={() => setDlg(null)} /> : null}
      {dlg === 'contact' ? <ContactPicker convId={convId} onClose={() => setDlg(null)} /> : null}
      {dlg === 'schedule' ? <ScheduleDialog convId={convId} initial={text} onClose={() => setDlg(null)} onDone={() => { setText(''); saveDraft(''); }} /> : null}
    </div>
  );
}
