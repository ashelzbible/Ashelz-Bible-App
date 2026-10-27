import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { duration } from '../lib/format.ts';
import { Icon } from '../ui/Icon.tsx';

const FILTERS: Array<[string, string]> = [['Original', 'none'], ['Mono', 'grayscale(1) contrast(1.1)'], ['Warm', 'sepia(.35) saturate(1.3) hue-rotate(-8deg)'], ['Cool', 'saturate(1.1) hue-rotate(12deg) brightness(1.03)'], ['Vivid', 'saturate(1.7) contrast(1.08)']];
const MAX_VIDEO_S = 60;

/**
 * Full-screen camera: photo and video capture, flash (torch where the device has one), front/back flip, filters, and a gallery picker.
 * Calls onCapture with a File. If the camera is unavailable or blocked, the gallery picker still works.
 */
export function CameraCapture({ onCapture, onClose, allowNote, onSwitch, initialMode }: { onCapture: (f: File, opts?: { note?: boolean }) => void; onClose: () => void; allowNote?: boolean; onSwitch?: (to: 'text' | 'voice') => void; initialMode?: 'photo' | 'video' }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<{ mr: MediaRecorder; chunks: Blob[]; t0: number; timer: ReturnType<typeof setInterval> } | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'photo' | 'video' | 'note'>(initialMode ?? 'photo');
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [torch, setTorch] = useState(false); const [canTorch, setCanTorch] = useState(false);
  const [filter, setFilter] = useState(0); const [showFilters, setShowFilters] = useState(false);
  const [err, setErr] = useState(''); const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(0); // elapsed seconds while recording
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null);
  const [recent, setRecent] = useState<Array<{ file: File; url: string }>>([]);

  const stop = useCallback(() => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; }, []);
  useEffect(() => {
    if (shot) return; // the preview screen does not need the camera
    let alive = true; setReady(false); setErr('');
    (async () => {
      stop();
      if (!navigator.mediaDevices?.getUserMedia) { setErr('The camera needs a secure (HTTPS) connection and a supported browser.'); return; }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: mode !== 'photo' });
        if (!alive) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s; if (video.current) video.current.srcObject = s;
        const caps: any = s.getVideoTracks()[0]?.getCapabilities?.() ?? {}; setCanTorch(!!caps.torch); setTorch(false); setReady(true);
      } catch (e: any) {
        setErr(e?.name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in your browser settings, or choose a photo from your gallery.' : e?.name === 'NotFoundError' ? 'No camera was found. You can choose a photo or video from your gallery instead.' : 'The camera could not be started. You can choose from your gallery instead.');
      }
    })();
    return () => { alive = false; };
  }, [facing, mode, shot, stop]);
  useEffect(() => () => { stop(); if (rec.current) { clearInterval(rec.current.timer); rec.current = null; } }, [stop]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const toggleTorch = async () => {
    const t = stream.current?.getVideoTracks()[0]; if (!t) return;
    try { await t.applyConstraints({ advanced: [{ torch: !torch } as any] }); setTorch(!torch); } catch { /* not supported on this camera */ }
  };
  const keep = (file: File) => { const url = URL.createObjectURL(file); setShot({ file, url }); setRecent((r) => [{ file, url }, ...r].slice(0, 8)); };

  function takePhoto(tries = 0) {
    const v = video.current; if (!v) return;
    if (!v.videoWidth) { if (tries < 20) setTimeout(() => takePhoto(tries + 1), 150); return; } // frames not flowing yet
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d')!; ctx.filter = FILTERS[filter][1];
    if (facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); } // un-mirror to match what the preview shows
    ctx.drawImage(v, 0, 0);
    c.toBlob((b) => { if (b) keep(new File([b], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' })); }, 'image/jpeg', 0.92);
  }
  function toggleRecord() {
    if (rec.current) { rec.current.mr.stop(); return; }
    const s = stream.current; if (!s || typeof MediaRecorder === 'undefined') { setErr('Video recording is not supported here. Choose a video from your gallery instead.'); return; }
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(s, type ? { mimeType: type } : undefined); const chunks: Blob[] = []; const t0 = Date.now();
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      const r = rec.current; if (r) clearInterval(r.timer); rec.current = null; setRecording(0);
      const mime = (mr.mimeType || 'video/webm').split(';')[0]; const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      if (chunks.length) keep(new File([new Blob(chunks, { type: mime })], `video-${Date.now()}.${ext}`, { type: mime }));
    };
    const timer = setInterval(() => { const sec = Math.floor((Date.now() - t0) / 1000); setRecording(sec + 1); if (sec >= MAX_VIDEO_S) mr.stop(); }, 250);
    rec.current = { mr, chunks, t0, timer }; mr.start(500); setRecording(1);
  }
  const shutter = () => (mode === 'photo' ? takePhoto(0) : toggleRecord());
  const setModeTo = (m: 'photo' | 'video' | 'note') => { if (recording) return; setMode(m); if (m === 'note') setFacing('user'); };

  const body = shot ? (
    <div className="cam cam-review">
      <button className="cam-btn tl" onClick={() => { URL.revokeObjectURL(shot.url); setShot(null); }} aria-label="Retake"><Icon name="back" size={24} /></button>
      <div className="cam-stage">{shot.file.type.startsWith('video/') ? <video src={shot.url} controls autoPlay loop playsInline className={mode === 'note' ? 'note' : ''} /> : <img src={shot.url} alt="Captured" />}</div>
      <div className="cam-review-bar"><button className="btn btn-outline" onClick={() => { URL.revokeObjectURL(shot.url); setShot(null); }}>Retake</button><button className="btn btn-primary" onClick={() => onCapture(shot.file, mode === 'note' && shot.file.type.startsWith('video/') ? { note: true } : undefined)}><Icon name="check" size={18} />Use {mode === 'note' && shot.file.type.startsWith('video/') ? 'video note' : shot.file.type.startsWith('video/') ? 'video' : 'photo'}</button></div>
    </div>
  ) : (
    <div className="cam" role="dialog" aria-label="Camera">
      <video ref={video} className={`cam-video ${facing === 'user' ? 'mirror' : ''} ${mode === 'note' ? 'note' : ''}`} style={{ filter: FILTERS[filter][1] }} autoPlay playsInline muted />
      {err ? <div className="cam-err"><Icon name="camera" size={40} /><p>{err}</p></div> : null}
      <button className="cam-btn tl" onClick={onClose} aria-label="Close camera"><Icon name="x" size={26} /></button>
      <button className="cam-btn tr" onClick={toggleTorch} disabled={!canTorch} aria-label={torch ? 'Turn flash off' : 'Turn flash on'} aria-pressed={torch}><Icon name={torch ? 'flash' : 'flash-off'} size={24} /></button>
      {recording ? <div className="cam-timer"><i />{duration(recording - 1)}</div> : null}
      {showFilters ? <div className="cam-filters" role="listbox" aria-label="Filters">{FILTERS.map(([n], i) => <button key={n} role="option" aria-selected={filter === i} className={filter === i ? 'on' : ''} onClick={() => setFilter(i)}>{n}</button>)}</div> : null}
      <div className="cam-bottom">
        <div className="cam-strip" aria-label="Recent captures">
          <span className="cam-grip" />
          {recent.map((r, i) => <button key={i} onClick={() => setShot(r)} aria-label="Open recent capture">{r.file.type.startsWith('video/') ? <video src={r.url} muted /> : <img src={r.url} alt="" />}</button>)}
          {!recent.length ? <small>Photos and videos you take appear here</small> : null}
        </div>
        <div className="cam-controls">
          <button className="cam-btn" onClick={() => pick.current?.click()} aria-label="Choose from gallery"><Icon name="image" size={26} /></button>
          <button className={`cam-btn small ${showFilters ? 'on' : ''}`} onClick={() => setShowFilters((v) => !v)} aria-label="Filters" aria-pressed={showFilters}><Icon name="wand" size={22} /></button>
          <button className={`shutter ${mode === 'photo' ? 'photo' : 'video'} ${recording ? 'rec' : ''}`} onClick={shutter} disabled={!ready && !recording} aria-label={mode === 'photo' ? 'Take photo' : recording ? 'Stop recording' : 'Start recording'}><i /></button>
          <button className="cam-btn" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))} disabled={!!recording} aria-label="Switch camera"><Icon name="switch-camera" size={26} /></button>
        </div>
        <div className="cam-modes" role="tablist" aria-label="Capture mode">
          <button role="tab" aria-selected={mode === 'video'} className={mode === 'video' ? 'on' : ''} onClick={() => setModeTo('video')}>Video</button>
          <button role="tab" aria-selected={mode === 'photo'} className={mode === 'photo' ? 'on' : ''} onClick={() => setModeTo('photo')}>Photo</button>
          {onSwitch ? <><button role="tab" aria-selected={false} onClick={() => onSwitch('text')}>Text</button><button role="tab" aria-selected={false} onClick={() => onSwitch('voice')}>Voice</button></> : null}
          {allowNote ? <button role="tab" aria-selected={mode === 'note'} className={mode === 'note' ? 'on' : ''} onClick={() => setModeTo('note')}>Video note</button> : null}
        </div>
      </div>
      <input ref={pick} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onCapture(f); }} />
    </div>
  );
  return createPortal(body, document.body);
}
