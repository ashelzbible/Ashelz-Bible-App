import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, uploadWithProgress } from '../lib/api.ts';
import { duration } from '../lib/format.ts';
import { getState, toast, useStore } from '../lib/store.ts';
import { loadStatus, toastError } from '../lib/actions.ts';
import { Icon } from '../ui/Icon.tsx';
import { Dialog } from '../ui/Overlay.tsx';
import { CameraCapture } from './Camera.tsx';
import { ColorSlider, MusicSheet, OverlayView, StickerSheet, TEXT_FONTS, drawOverlay, type CatalogTrack, type Overlay, type Track } from './StatusTools.tsx';

export const BGS = ['#003B32', '#0B6E5C', '#1B5E8A', '#6A3A8C', '#B34A2E', '#8C6A1B', '#2E2E2E', '#AD8B73', '#C2185B', '#37474F'];
export const FONTS = ['system-ui, sans-serif', 'Georgia, "Times New Roman", serif', 'ui-monospace, Menlo, Consolas, monospace', '"Brush Script MT", "Segoe Script", cursive', '"Arial Narrow", "Roboto Condensed", Impact, sans-serif'];
const FILTERS: Array<[string, string]> = [['None', 'none'], ['Pop', 'saturate(1.6) contrast(1.12)'], ['B&W', 'grayscale(1) contrast(1.1)'], ['Cool', 'saturate(1.1) hue-rotate(14deg) brightness(1.04)'], ['Chrome', 'contrast(1.25) saturate(1.3) hue-rotate(-12deg)'], ['Warm', 'sepia(.35) saturate(1.3)'], ['Fade', 'contrast(.85) brightness(1.1) saturate(.8)']];
const ASPECTS: Array<[string, number | null]> = [['Original', null], ['1:1', 1], ['4:5', 4 / 5], ['9:16', 9 / 16], ['16:9', 16 / 9]];

type Aud = 'contacts' | 'except' | 'only';
interface Stroke { color: string; w: number; alpha: number; erase: boolean; pts: Array<[number, number]> }

/** Status composer: camera → editor (photo: filters, crop/rotate, stickers, text, drawing; video: caption), or a text or voice status. */
export function StatusCreate({ onClose, presetFile, startText }: { onClose: () => void; presetFile?: File | null; startText?: boolean }) {
  const [view, setView] = useState<'cam' | 'text' | 'voice'>(startText ? 'text' : presetFile ? 'cam' : 'cam');
  const [camMode, setCamMode] = useState<'photo' | 'video'>('photo');
  const [file, setFile] = useState<File | null>(presetFile ?? null);
  const [aud, setAud] = useState<{ kind: Aud; ids: string[] }>(() => { const p = getState().me!.settings.privacy; return { kind: p.statusAudience as Aud, ids: ((p.statusAudience === 'except' ? p.statusExcept : p.statusOnly) ?? []) as string[] }; });
  const [pickAud, setPickAud] = useState(false);

  const post = async (body: Record<string, unknown>) => { await api.post('/api/status', { audience: aud.kind, audienceIds: aud.ids, ...body }); await loadStatus(); toast('Status posted'); onClose(); };
  const audLabel = aud.kind === 'contacts' ? 'Status (Contacts)' : aud.kind === 'except' ? `Status (Contacts except ${aud.ids.length})` : `Status (Only ${aud.ids.length})`;
  const chip = <button className="st-aud" onClick={() => setPickAud(true)} aria-label={`Who can see this: ${audLabel}`}><Icon name="updates" size={18} />{audLabel}<span className="plus">+</span></button>;
  const tabs = (cur: string) => (
    <div className="st-tabs" role="tablist">
      {([['video', 'Video'], ['photo', 'Photo'], ['text', 'Text'], ['voice', 'Voice']] as const).map(([id, label]) => (
        <button key={id} role="tab" aria-selected={cur === id} className={cur === id ? 'on' : ''} onClick={() => { if (id === 'text' || id === 'voice') setView(id); else { setCamMode(id); setView('cam'); } }}>{label}</button>))}
    </div>);

  let body;
  if (file) body = <MediaEditor file={file} chip={chip} onBack={() => setFile(null)} onReplace={setFile} post={post} onClose={onClose} />;
  else if (view === 'text') body = <TextStatus chip={chip} tabs={tabs('text')} post={post} onClose={onClose} />;
  else if (view === 'voice') body = <VoiceStatus chip={chip} tabs={tabs('voice')} post={post} onClose={onClose} />;
  else return <CameraCapture key={camMode} initialMode={camMode} onSwitch={(t) => setView(t)} onClose={onClose} onCapture={(f) => setFile(f)} />;
  return <>{createPortal(<div className="st-edit" role="dialog" aria-label="New status">{body}</div>, document.body)}{pickAud ? <AudienceDialog value={aud} onChange={setAud} onClose={() => setPickAud(false)} /> : null}</>;
}

function AudienceDialog({ value, onChange, onClose }: { value: { kind: Aud; ids: string[] }; onChange: (v: { kind: Aud; ids: string[] }) => void; onClose: () => void }) {
  const contacts = useStore((s) => s.contacts);
  const [kind, setKind] = useState<Aud>(value.kind); const [ids, setIds] = useState<Set<string>>(new Set(value.ids));
  const ok = kind === 'contacts' || (kind === 'except' || ids.size > 0);
  return (
    <Dialog title="Status privacy" onClose={onClose} footer={<button className="btn btn-primary" disabled={!ok} onClick={() => { onChange({ kind, ids: kind === 'contacts' ? [] : [...ids] }); onClose(); }}>Done</button>}>
      <div className="stack-sm">{([['contacts', 'My contacts'], ['except', 'My contacts except…'], ['only', 'Only share with…']] as const).map(([k, l]) => <label key={k} className="check-row"><input type="radio" name="aud" checked={kind === k} onChange={() => setKind(k)} />{l}</label>)}</div>
      {kind !== 'contacts' ? <div className="stack-sm" style={{ maxHeight: 220, overflow: 'auto', marginTop: 10 }}>{contacts.map((c) => <label key={c.id} className="check-row"><input type="checkbox" checked={ids.has(c.id)} onChange={() => setIds((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />{c.displayName}</label>)}{!contacts.length ? <p className="help">Add contacts first.</p> : null}</div> : null}
      <p className="help">This choice applies to this update only. Change your default under Settings → Privacy → Status.</p>
    </Dialog>
  );
}

function TextStatus({ chip, tabs, post, onClose }: { chip: React.ReactNode; tabs: React.ReactNode; post: (b: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState(''); const [bg, setBg] = useState(7); const [font, setFont] = useState(0); const [busy, setBusy] = useState(false);
  const send = async () => { setBusy(true); try { await post({ kind: 'text', body: text.trim(), background: BGS[bg], font }); } catch (e) { toastError(e); setBusy(false); } };
  return (
    <div className="st-text" style={{ background: BGS[bg] }}>
      <div className="st-top"><button className="st-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={26} /></button><span className="grow" />
        <button className="st-btn" onClick={() => setFont((f) => (f + 1) % FONTS.length)} aria-label="Change font"><b style={{ fontFamily: FONTS[(font + 1) % FONTS.length] }}>Aa</b></button>
        <button className="st-btn" onClick={() => setBg((b) => (b + 1) % BGS.length)} aria-label="Change background colour"><Icon name="palette" size={24} /></button></div>
      <div className="st-text-body"><textarea autoFocus maxLength={700} placeholder="Type a status" value={text} onChange={(e) => setText(e.target.value)} aria-label="Status text" style={{ fontFamily: FONTS[font] }} /></div>
      {text.trim() ? <div className="st-send-row">{chip}<button className="st-send" onClick={() => void send()} disabled={busy} aria-label="Post status"><Icon name="send" size={22} fill /></button></div> : null}
      <div className="st-tabsbar">{tabs}</div>
    </div>
  );
}

function VoiceStatus({ chip, tabs, post, onClose }: { chip: React.ReactNode; tabs: React.ReactNode; post: (b: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const [state, setState] = useState<'idle' | 'rec' | 'done'>('idle'); const [ms, setMs] = useState(0); const [busy, setBusy] = useState(false);
  const [bg] = useState(1); const [blob, setBlob] = useState<Blob | null>(null); const [url, setUrl] = useState('');
  const r = useRef<{ mr: MediaRecorder; stream: MediaStream; t0: number; timer: ReturnType<typeof setInterval>; chunks: Blob[] } | null>(null);
  useEffect(() => () => { if (r.current) { clearInterval(r.current.timer); r.current.stream.getTracks().forEach((t) => t.stop()); } }, []);
  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast('Voice recording is not supported in this browser', 'error'); return; }
    let stream: MediaStream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast('Allow microphone access to record a voice status', 'error'); return; }
    const mr = new MediaRecorder(stream); const chunks: Blob[] = []; const t0 = Date.now();
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()); const b = new Blob(chunks, { type: mr.mimeType || 'audio/webm' }); setBlob(b); setUrl(URL.createObjectURL(b)); setState('done'); };
    const timer = setInterval(() => { const d = Date.now() - t0; setMs(d); if (d >= 60000) stop(); }, 200);
    r.current = { mr, stream, t0, timer, chunks }; mr.start(250); setState('rec');
  }
  function stop() { const c = r.current; if (!c) return; clearInterval(c.timer); setMs(Date.now() - c.t0); c.mr.stop(); r.current = null; }
  async function send() {
    if (!blob) return; setBusy(true);
    try { const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'; const up = await uploadWithProgress(blob, `voice-status.${ext}`, 'voice', { durationMs: String(ms) }, () => {}).promise; await post({ kind: 'voice', mediaId: up.media.id, background: BGS[bg] }); }
    catch (e) { toastError(e); setBusy(false); }
  }
  return (
    <div className="st-text" style={{ background: BGS[bg] }}>
      <div className="st-top"><button className="st-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={26} /></button></div>
      <div className="st-voice">
        <div className="st-timer">{duration(ms / 1000)}</div>
        {state === 'idle' ? <button className="st-mic" onClick={() => void start()} aria-label="Start recording"><Icon name="mic" size={40} /></button> : state === 'rec' ? <button className="st-mic rec" onClick={stop} aria-label="Stop recording"><Icon name="stop" size={34} fill /></button> : <audio src={url} controls />}
        <p>{state === 'idle' ? 'Tap to record a voice status (up to 60 seconds)' : state === 'rec' ? 'Recording… tap to stop' : 'Listen, then post or record again'}</p>
        {state === 'done' ? <button className="btn btn-outline" style={{ color: '#fff', borderColor: '#fff8' }} onClick={() => { setBlob(null); setMs(0); setState('idle'); }}>Record again</button> : null}
      </div>
      {state === 'done' ? <div className="st-send-row">{chip}<button className="st-send" onClick={() => void send()} disabled={busy} aria-label="Post status"><Icon name="send" size={22} fill /></button></div> : null}
      <div className="st-tabsbar">{tabs}</div>
    </div>
  );
}

type PenKind = 'pen' | 'marker' | 'highlighter' | 'eraser';
const PENS: Record<PenKind, { w: number; alpha: number }> = { pen: { w: 0.006, alpha: 1 }, marker: { w: 0.014, alpha: 1 }, highlighter: { w: 0.03, alpha: 0.45 }, eraser: { w: 0.03, alpha: 1 } };

function MediaEditor({ file, chip, onBack, onReplace, post, onClose }: { file: File; chip: React.ReactNode; onBack: () => void; onReplace: (f: File) => void; post: (b: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const isVideo = file.type.startsWith('video/');
  const contacts = useStore((s) => s.contacts);
  const [url, setUrl] = useState(''); const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [filter, setFilter] = useState(0); const [rot, setRot] = useState(0); const [aspect, setAspect] = useState<number | null>(null);
  const [tool, setTool] = useState<null | 'crop' | 'sticker' | 'music' | 'text' | 'draw'>(null); const [filters, setFilters] = useState(false);
  const [overlays, setOverlays] = useState<Overlay[]>([]); const [sel, setSel] = useState<string | null>(null); const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [pen, setPen] = useState<PenKind>('pen'); const [hue, setHue] = useState(0); const [color, setColor] = useState('#FFFFFF');
  const [textDraft, setTextDraft] = useState<{ id?: string; text: string; font: number; align: 'left' | 'center' | 'right'; hl: boolean } | null>(null);
  const [track, setTrack] = useState<Track | null>(null); const [song, setSong] = useState<CatalogTrack | null>(null); const [caption, setCaption] = useState(''); const [busy, setBusy] = useState(false); const [mention, setMention] = useState(false);
  const base = useRef<HTMLCanvasElement>(null); const ink = useRef<HTMLCanvasElement>(null); const pick = useRef<HTMLInputElement>(null); const stage = useRef<HTMLDivElement>(null);
  const drawing = useRef<Stroke | null>(null); const moved = useRef(false);

  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); if (!isVideo) { const i = new Image(); i.onload = () => setImg(i); i.src = u; } return () => URL.revokeObjectURL(u); }, [file, isVideo]);
  const renderBase = useCallback((c: HTMLCanvasElement, max: number) => {
    if (!img) return;
    const swap = rot % 180 !== 0; const sw = swap ? img.naturalHeight : img.naturalWidth; const sh = swap ? img.naturalWidth : img.naturalHeight;
    let cw = sw, ch = sh; if (aspect) { if (sw / sh > aspect) cw = sh * aspect; else ch = sw / aspect; }
    const k = Math.min(1, max / Math.max(cw, ch)); c.width = Math.round(cw * k); c.height = Math.round(ch * k);
    const x = c.getContext('2d')!; x.filter = FILTERS[filter][1]; x.translate(c.width / 2, c.height / 2); x.rotate((rot * Math.PI) / 180); x.scale(k, k);
    x.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  }, [img, rot, aspect, filter]);
  useEffect(() => { if (base.current) { renderBase(base.current, 1280); if (ink.current) { ink.current.width = base.current.width; ink.current.height = base.current.height; paintInk(ink.current, strokes); } } }, [renderBase]);  // eslint-disable-line
  useEffect(() => { if (ink.current) paintInk(ink.current, strokes); }, [strokes]);

  const pt = (e: React.PointerEvent): [number, number] => { const r = ink.current!.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const down = (e: React.PointerEvent) => { if (tool !== 'draw') return; (e.target as Element).setPointerCapture(e.pointerId); const p = PENS[pen]; drawing.current = { color, w: p.w, alpha: p.alpha, erase: pen === 'eraser', pts: [pt(e)] }; };
  const move = (e: React.PointerEvent) => { const s = drawing.current; if (!s || !ink.current) return; s.pts.push(pt(e)); paintInk(ink.current, [...strokes, s]); };
  const up = () => { const s = drawing.current; drawing.current = null; if (s && s.pts.length > 1) setStrokes((l) => [...l, s]); };

  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const startDrag = (e: React.PointerEvent, o: Overlay) => { e.stopPropagation(); const r = stage.current!.getBoundingClientRect(); (e.target as Element).setPointerCapture?.(e.pointerId); moved.current = false; setSel(o.id); drag.current = { id: o.id, dx: (e.clientX - r.left) / r.width - o.x, dy: (e.clientY - r.top) / r.height - o.y }; };
  const moveDrag = (e: React.PointerEvent) => { const d = drag.current; if (!d) return; moved.current = true; const r = stage.current!.getBoundingClientRect(); setOverlays((l) => l.map((o) => (o.id === d.id ? { ...o, x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width - d.dx)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height - d.dy)) } : o))); };
  const endDrag = (o?: Overlay) => { drag.current = null; if (o && !moved.current && o.kind === 'text') { setTextDraft({ id: o.id, text: o.text, font: o.font ?? 0, align: o.align ?? 'center', hl: !!o.hl }); setColor(o.color); setTool('text'); } };
  const addOverlay = (o: Partial<Overlay>) => { const n: Overlay = { id: crypto.randomUUID(), kind: 'text', text: '', x: 0.5, y: 0.5, color: '#FFFFFF', size: 0.07, ...o }; setOverlays((l) => [...l, n]); setSel(n.id); };
  const selected = overlays.find((o) => o.id === sel);

  const doneText = () => {
    const d = textDraft; setTextDraft(null); setTool(null); if (!d) return;
    if (!d.text.trim()) { if (d.id) setOverlays((l) => l.filter((o) => o.id !== d.id)); return; }
    if (d.id) setOverlays((l) => l.map((o) => (o.id === d.id ? { ...o, text: d.text, font: d.font, align: d.align, hl: d.hl, color } : o)));
    else addOverlay({ kind: 'text', text: d.text, font: d.font, align: d.align, hl: d.hl, color, size: 0.07 });
  };

  async function send() {
    setBusy(true);
    try {
      let f = file;
      if (!isVideo && img) {
        const c = document.createElement('canvas'); renderBase(c, 1920);
        const x = c.getContext('2d')!; x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none';
        const ic = document.createElement('canvas'); ic.width = c.width; ic.height = c.height; paintInk(ic, strokes); x.drawImage(ic, 0, 0);
        const imgs = new Map<string, HTMLImageElement>();
        await Promise.all(overlays.filter((o) => o.kind === 'image' && o.src).map((o) => new Promise<void>((res) => { const im = new Image(); im.onload = () => { imgs.set(o.id, im); res(); }; im.onerror = () => res(); im.src = o.src!; })));
        for (const o of overlays) drawOverlay(x, o, c.width, c.height, imgs);
        const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.9)); if (blob) f = new File([blob], `status-${Date.now()}.jpg`, { type: 'image/jpeg' });
      }
      const kind = isVideo ? 'video' : 'image'; const up = await uploadWithProgress(f, f.name, kind, {}, () => {}).promise;
      await post({ kind, mediaId: up.media.id, caption: caption.trim(), ...(track ? { audioMediaId: track.mediaId, audioTitle: `${track.title}${track.artist ? ' · ' + track.artist : ''}` } : {}) });
    } catch (e) { toastError(e); setBusy(false); }
  }

  const imageTools = !isVideo; const editing = tool === 'draw' || tool === 'text';
  const stageEl = (
    <div className="st-stage" ref={stage} onPointerMove={moveDrag} onPointerUp={() => endDrag()} onPointerDown={() => setSel(null)} style={textDraft ? { filter: 'brightness(.45)' } : undefined}>
      {isVideo ? <video src={url} controls playsInline /> : <><canvas ref={base} className="st-base" /><canvas ref={ink} className={`st-ink ${tool === 'draw' ? 'on' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} /></>}
      {imageTools ? overlays.map((o) => <span key={o.id} className={`st-ov ${sel === o.id ? 'sel' : ''}`} style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, color: o.color, fontSize: `${o.size * 100}cqh` }} onPointerDown={(e) => startDrag(e, o)} onPointerUp={(e) => { e.stopPropagation(); endDrag(o); }}><OverlayView o={o} /></span>) : null}
    </div>);
  return (
    <div className="st-media">
      {tool === 'draw' ? <div className="st-top"><button className="st-pill" onClick={() => setTool(null)}>Done</button><span className="grow" /><span className="st-btn green"><Icon name="edit" size={24} /></span></div>
        : tool === 'text' ? <div className="st-top"><button className="st-pill" onClick={doneText}>Done</button><span className="grow" />
          <button className="st-btn" onClick={() => setTextDraft((d) => d && { ...d, align: d.align === 'center' ? 'left' : d.align === 'left' ? 'right' : 'center' })} aria-label="Text alignment"><Icon name="menu-lines" size={22} /></button>
          <button className={`st-btn ${textDraft?.hl ? 'on' : ''}`} onClick={() => setTextDraft((d) => d && { ...d, hl: !d.hl })} aria-label="Text highlight"><b>A<sup>+</sup></b></button></div>
        : <div className="st-top"><button className="st-btn" onClick={onBack} aria-label="Close editor"><Icon name="x" size={26} /></button><span className="grow" />
          {<button className={`st-btn ${track || song ? 'on' : ''}`} onClick={() => setTool('music')} aria-label="Add music"><Icon name="music" size={22} /></button>}
          {imageTools ? <>
            <button className={`st-btn ${tool === 'crop' ? 'on' : ''}`} onClick={() => setTool(tool === 'crop' ? null : 'crop')} aria-label="Crop and rotate"><Icon name="crop" size={22} /></button>
            <button className="st-btn" onClick={() => setTool('sticker')} aria-label="Stickers"><Icon name="sticker" size={22} /></button>
            <button className="st-btn" onClick={() => { setTextDraft({ text: '', font: 0, align: 'center', hl: false }); setTool('text'); }} aria-label="Add text"><b>Aa</b></button>
            <button className="st-btn" onClick={() => setTool('draw')} aria-label="Draw"><Icon name="edit" size={22} /></button></> : null}
        </div>}
      {(track || song) && !editing ? <div className="st-track">{song?.artUrl ? <img src={song.artUrl} alt="" /> : <Icon name="music" size={16} />}<button className="st-track-t" onClick={() => setTool('music')} aria-label="Change song"><span className="truncate">{(track ?? song)!.title}{(track ?? song)!.artist ? ` · ${(track ?? song)!.artist}` : ''}</span></button><button onClick={() => { setTrack(null); setSong(null); }} aria-label="Remove music"><Icon name="x" size={14} /></button></div> : null}
      <div className="st-stage-wrap">{stageEl}
        {tool === 'text' && textDraft ? <textarea className="st-text-edit" autoFocus value={textDraft.text} onChange={(e) => setTextDraft({ ...textDraft, text: e.target.value })} placeholder="Add text" maxLength={200} aria-label="Overlay text" style={{ fontFamily: TEXT_FONTS[textDraft.font], textAlign: textDraft.align, color: textDraft.hl ? (color === '#FFFFFF' ? '#000' : '#fff') : color, background: textDraft.hl ? color : 'transparent' }} /> : null}
        {editing ? <ColorSlider value={hue} onChange={(t, c) => { setHue(t); setColor(c); }} /> : null}
        {selected && !editing ? <div className="st-selbar"><button onClick={() => setOverlays((l) => l.map((o) => (o.id === selected.id ? { ...o, size: Math.max(0.03, o.size * 0.85) } : o)))} aria-label="Smaller">−</button><button onClick={() => setOverlays((l) => l.map((o) => (o.id === selected.id ? { ...o, size: Math.min(0.6, o.size * 1.18) } : o)))} aria-label="Larger">+</button><button onClick={() => { setOverlays((l) => l.filter((o) => o.id !== selected.id)); setSel(null); }} aria-label="Remove item"><Icon name="trash" size={18} /></button></div> : null}
      </div>
      {tool === 'crop' ? <div className="st-bar"><button onClick={() => setRot((r) => (r + 270) % 360)} aria-label="Rotate left"><Icon name="undo" size={20} /></button><button onClick={() => setRot((r) => (r + 90) % 360)} aria-label="Rotate right"><Icon name="refresh" size={20} /></button>{ASPECTS.map(([l, a]) => <button key={l} className={aspect === a ? 'on' : ''} onClick={() => setAspect(a)}>{l}</button>)}</div> : null}
      {tool === 'text' && textDraft ? <div className="st-fonts">{TEXT_FONTS.map((f, i) => <button key={i} className={textDraft.font === i ? 'on' : ''} style={{ fontFamily: f }} onClick={() => setTextDraft({ ...textDraft, font: i })} aria-label={`Font ${i + 1}`}>Aa</button>)}</div> : null}
      {tool === 'draw' ? <div className="st-pens">{(['pen', 'marker', 'highlighter', 'eraser'] as PenKind[]).map((p) => <button key={p} className={pen === p ? 'on' : ''} onClick={() => setPen(p)} aria-label={p === 'highlighter' ? 'Highlighter' : p[0].toUpperCase() + p.slice(1)}><svg viewBox="0 0 40 24" width="40" height="24"><path d="M3 18 C10 2 14 22 20 10 S34 6 37 14" fill="none" stroke={p === 'eraser' ? '#aaa' : color} strokeWidth={p === 'pen' ? 2.5 : p === 'marker' ? 5 : p === 'highlighter' ? 9 : 6} strokeLinecap="round" strokeDasharray={p === 'eraser' ? '2 4' : undefined} opacity={p === 'highlighter' ? 0.6 : 1} /></svg></button>)}<button onClick={() => setStrokes((l) => l.slice(0, -1))} disabled={!strokes.length} aria-label="Undo stroke"><Icon name="undo" size={20} /></button></div> : null}
      {!editing && tool !== 'crop' ? (imageTools ? (filters
        ? <div className="st-filters"><button className="st-chev" onClick={() => setFilters(false)} aria-label="Hide filters"><Icon name="down" size={22} /></button><div className="st-filter-row">{FILTERS.map(([n, f], i) => <button key={n} className={filter === i ? 'on' : ''} onClick={() => setFilter(i)}><span className="thumb">{url ? <img src={url} alt="" style={{ filter: f }} /> : null}</span><span>{n}</span></button>)}</div></div>
        : <button className="st-filters-open" onClick={() => setFilters(true)}><Icon name="down" size={22} className="flip" /><span>Filters</span></button>) : <div style={{ height: 28 }} />) : null}
      {!editing ? <>
        <div className="st-caption"><button className="st-ic" onClick={() => pick.current?.click()} aria-label="Change photo or video"><Icon name="image-plus" size={26} /></button>
          <input value={caption} maxLength={700} onChange={(e) => setCaption(e.target.value)} placeholder="Add a caption…" aria-label="Caption" />
          <button className="st-ic" onClick={() => setMention((v) => !v)} aria-label="Mention a contact"><Icon name="mention" size={26} /></button></div>
        {mention ? <div className="st-bar wrap">{contacts.slice(0, 12).map((c) => <button key={c.id} onClick={() => { setCaption((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@${c.username} `); setMention(false); }}>@{c.username}</button>)}{!contacts.length ? <span className="muted">No contacts yet</span> : null}</div> : null}
        <div className="st-send-row">{chip}<button className="st-send" onClick={() => void send()} disabled={busy} aria-label="Post status">{busy ? <span className="spinner" style={{ borderTopColor: '#fff' }} /> : <Icon name="send" size={22} fill />}</button></div></> : null}
      {tool === 'sticker' ? <StickerSheet onClose={() => setTool(null)} onAdd={addOverlay} onMusic={() => setTool('music')} /> : null}
      {tool === 'music' ? <MusicSheet onClose={() => setTool(null)} onPick={(t) => { setTrack(t); setSong(null); setTool(null); }} onPickCatalog={(t) => { setSong(t); setTrack(null); setTool(null); }} /> : null}
      <input ref={pick} type="file" hidden accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onReplace(f); }} />
      <button hidden onClick={onClose} aria-hidden="true" tabIndex={-1} />
    </div>
  );
}

function paintInk(c: HTMLCanvasElement, strokes: Stroke[]) {
  const x = c.getContext('2d')!; x.clearRect(0, 0, c.width, c.height); x.lineCap = 'round'; x.lineJoin = 'round';
  for (const s of strokes) {
    x.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'; x.globalAlpha = s.alpha; x.strokeStyle = s.color; x.lineWidth = s.w * c.height;
    x.beginPath(); s.pts.forEach(([px, py], i) => (i ? x.lineTo(px * c.width, py * c.height) : x.moveTo(px * c.width, py * c.height))); x.stroke();
  }
  x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
}
