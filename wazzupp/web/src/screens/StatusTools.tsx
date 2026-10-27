import { useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadWithProgress } from '../lib/api.ts';
import { duration } from '../lib/format.ts';
import { useMedia } from '../lib/mediaCache.ts';
import { toast } from '../lib/store.ts';
import { toastError } from '../lib/actions.ts';
import { Icon } from '../ui/Icon.tsx';
import { EmojiTab } from './Emoji.tsx';

/* ---------------- overlays (text, emoji, shapes, chips, photos) ---------------- */
export type ShapeName = 'arrow' | 'circle' | 'square' | 'cloud' | 'bubble' | 'rect' | 'clock';
export interface Overlay {
  id: string; kind: 'text' | 'emoji' | 'shape' | 'chip' | 'image'; text: string; x: number; y: number; color: string; size: number;
  font?: number; align?: 'left' | 'center' | 'right'; hl?: boolean; shape?: ShapeName; icon?: string; src?: string;
}
export const TEXT_FONTS = ['system-ui, sans-serif', 'Georgia, serif', '"Brush Script MT", "Segoe Script", cursive', '"Arial Black", Impact, sans-serif', '"Courier New", monospace', '"Trebuchet MS", sans-serif', '"Palatino Linotype", serif', '"Arial Narrow", sans-serif'];
export const SHAPES: ShapeName[] = ['arrow', 'circle', 'square', 'cloud', 'bubble', 'rect'];
const GREEN = '#25F29A';

export function hueColor(t: number): string { // 0..1 down the slider: white → grey → black → rainbow
  if (t < 0.06) return '#FFFFFF'; if (t < 0.12) return '#9E9E9E'; if (t < 0.17) return '#000000';
  return `hsl(${Math.round(((t - 0.17) / 0.83) * 330)} 90% 55%)`;
}
export function ColorSlider({ value, onChange }: { value: number; onChange: (t: number, color: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const set = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); const t = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)); onChange(t, hueColor(t)); };
  return <div className="st-slider" ref={ref} role="slider" aria-label="Colour" aria-valuenow={Math.round(value * 100)} tabIndex={0}
    onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); set(e); }} onPointerMove={(e) => { if (e.buttons) set(e); }}
    onKeyDown={(e) => { if (e.key === 'ArrowDown') onChange(Math.min(1, value + 0.03), hueColor(Math.min(1, value + 0.03))); if (e.key === 'ArrowUp') onChange(Math.max(0, value - 0.03), hueColor(Math.max(0, value - 0.03))); }}>
    <i style={{ top: `${value * 100}%`, background: hueColor(value) }} /></div>;
}

const SHAPE_PATH: Record<Exclude<ShapeName, 'clock'>, string> = {
  arrow: 'M6 94 L90 10 M48 8 L92 8 L92 52', circle: 'M50 6 a44 44 0 1 0 .01 0 Z', square: 'M8 8 H92 V92 H8 Z',
  cloud: 'M25 70 a18 18 0 0 1 4-35 a22 22 0 0 1 42 4 a16 16 0 0 1 2 31 Z', bubble: 'M12 20 Q12 8 30 8 H70 Q88 8 88 20 V50 Q88 62 70 62 H48 L30 80 L34 62 H30 Q12 62 12 50 Z', rect: 'M8 10 H92 V62 H44 L28 82 L30 62 H8 Z',
};
export function OverlayView({ o }: { o: Overlay }) {
  if (o.kind === 'text') return <span style={{ fontFamily: TEXT_FONTS[o.font ?? 0], color: o.hl ? (o.color === '#FFFFFF' ? '#000' : '#fff') : o.color, background: o.hl ? o.color : 'transparent', textAlign: o.align, padding: o.hl ? '.1em .35em' : 0, borderRadius: '.25em', display: 'block', whiteSpace: 'pre-wrap' }}>{o.text}</span>;
  if (o.kind === 'emoji') return <span>{o.text}</span>;
  if (o.kind === 'chip') return <span className="st-chip">{o.icon ? <i>{o.icon}</i> : null}{o.text}</span>;
  if (o.kind === 'image') return <img src={o.src} alt="" draggable={false} style={{ height: `${o.size * 100}cqh`, borderRadius: 8 }} />;
  if (o.shape === 'clock') return <ClockFace size={`${o.size * 100}cqh`} />;
  const filled = o.shape === 'cloud' || o.shape === 'bubble' || o.shape === 'rect';
  return <svg viewBox="0 0 100 100" style={{ height: `${o.size * 100}cqh`, width: `${o.size * 100}cqh`, overflow: 'visible' }}><path d={SHAPE_PATH[o.shape as Exclude<ShapeName, 'clock'>]} fill={filled ? '#FFFDE6' : 'none'} stroke={GREEN} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ClockFace({ size }: { size: string }) {
  const d = new Date(); const h = ((d.getHours() % 12) + d.getMinutes() / 60) * 30; const m = d.getMinutes() * 6;
  return <svg viewBox="0 0 100 100" style={{ height: size, width: size }}><circle cx="50" cy="50" r="46" fill="#fff" stroke="#ddd" strokeWidth="3" />{[...Array(12)].map((_, i) => <line key={i} x1="50" y1="10" x2="50" y2={i % 3 ? 14 : 18} stroke="#555" strokeWidth="2" transform={`rotate(${i * 30} 50 50)`} />)}<line x1="50" y1="50" x2="50" y2="28" stroke="#222" strokeWidth="4" strokeLinecap="round" transform={`rotate(${h} 50 50)`} /><line x1="50" y1="50" x2="50" y2="16" stroke="#222" strokeWidth="3" strokeLinecap="round" transform={`rotate(${m} 50 50)`} /><circle cx="50" cy="50" r="3" fill="#D33" /></svg>;
}

/** Bakes an overlay into the exported canvas (positions are fractions of the canvas, sizes fractions of its height). */
export function drawOverlay(x: CanvasRenderingContext2D, o: Overlay, W: number, H: number, imgs: Map<string, HTMLImageElement>) {
  const px = o.x * W, py = o.y * H, fs = o.size * H;
  x.save(); x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = o.kind === 'text' || o.kind === 'emoji' ? fs * 0.1 : 0; x.textBaseline = 'middle';
  if (o.kind === 'text') {
    x.font = `700 ${fs}px ${TEXT_FONTS[o.font ?? 0]}`; const lines = o.text.split('\n'); const lh = fs * 1.2; const w = Math.max(...lines.map((l) => x.measureText(l).width));
    const ax = o.align === 'left' ? px - w / 2 : o.align === 'right' ? px + w / 2 : px; x.textAlign = o.align ?? 'center';
    lines.forEach((l, i) => { const y = py + (i - (lines.length - 1) / 2) * lh; if (o.hl) { const lw = x.measureText(l).width; x.shadowBlur = 0; x.fillStyle = o.color; const bx = o.align === 'left' ? ax : o.align === 'right' ? ax - lw : ax - lw / 2; x.beginPath(); x.roundRect(bx - fs * 0.25, y - lh / 2 + fs * 0.05, lw + fs * 0.5, lh * 0.95, fs * 0.25); x.fill(); x.fillStyle = o.color === '#FFFFFF' ? '#000' : '#fff'; } else x.fillStyle = o.color; x.fillText(l, ax, y); });
  } else if (o.kind === 'emoji') { x.font = `${fs}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`; x.textAlign = 'center'; x.fillText(o.text, px, py); }
  else if (o.kind === 'chip') {
    x.font = `600 ${fs * 0.55}px system-ui, sans-serif`; const label = `${o.icon ? o.icon + ' ' : ''}${o.text}`; const w = x.measureText(label).width + fs * 0.9; const h = fs * 0.95;
    x.fillStyle = '#fff'; x.beginPath(); x.roundRect(px - w / 2, py - h / 2, w, h, h / 2); x.fill(); x.fillStyle = '#111'; x.textAlign = 'center'; x.fillText(label, px, py + 1);
  } else if (o.kind === 'image') { const im = imgs.get(o.id); if (im) { const h = fs, w = (im.naturalWidth / im.naturalHeight) * h; x.drawImage(im, px - w / 2, py - h / 2, w, h); } }
  else if (o.shape === 'clock') {
    const r = fs / 2, d = new Date(); x.fillStyle = '#fff'; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill(); x.strokeStyle = '#222'; x.lineCap = 'round';
    const hand = (ang: number, len: number, w: number) => { x.lineWidth = w; x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.sin(ang) * len, py - Math.cos(ang) * len); x.stroke(); };
    hand((((d.getHours() % 12) + d.getMinutes() / 60) * Math.PI) / 6, r * 0.5, r * 0.08); hand((d.getMinutes() * Math.PI) / 30, r * 0.75, r * 0.05);
  } else if (o.shape) {
    const s = fs / 100; x.translate(px - fs / 2, py - fs / 2); x.scale(s, s); const p = new Path2D(SHAPE_PATH[o.shape as Exclude<ShapeName, 'clock'>]);
    if (o.shape === 'cloud' || o.shape === 'bubble' || o.shape === 'rect') { x.fillStyle = '#FFFDE6'; x.fill(p); } x.strokeStyle = GREEN; x.lineWidth = 5; x.lineCap = 'round'; x.lineJoin = 'round'; x.stroke(p);
  }
  x.restore();
}

/* ---------------- sticker sheet ---------------- */
export function StickerSheet({ onClose, onAdd, onMusic }: { onClose: () => void; onAdd: (o: Partial<Overlay>) => void; onMusic: () => void }) {
  const [tab, setTab] = useState<'emoji' | 'sticker'>('sticker'); const [q, setQ] = useState(''); const [searching, setSearching] = useState(false);
  const photo = useRef<HTMLInputElement>(null);
  const now = new Date(); const hhmm = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const chip = (text: string, icon?: string) => { onAdd({ kind: 'chip', text, icon, size: 0.075 }); onClose(); };
  const location = () => {
    const done = (label: string) => chip(label, '📍');
    if (!navigator.geolocation) { done('Location'); return; }
    navigator.geolocation.getCurrentPosition((p) => done(`${p.coords.latitude.toFixed(3)}, ${p.coords.longitude.toFixed(3)}`), () => { toast('Allow location access to add it', 'error'); }, { timeout: 8000 });
  };
  const mine = useMemo<string[]>(() => { try { return JSON.parse(localStorage.getItem('wz.stickers') ?? '[]'); } catch { return []; } }, []);
  return (
    <div className="st-sheet-wrap">
      <div className="st-sheet-top"><button className="st-btn" onClick={onClose} aria-label="Back"><Icon name="back" size={24} /></button><span className="st-btn green" aria-hidden="true"><Icon name="sticker" size={24} /></span></div>
      <div className="st-sheet" role="dialog" aria-label="Stickers">
        <div className="ep-grip" />
        <div className="ep-head">
          <button className={`icon-btn ${searching ? 'on' : ''}`} onClick={() => { setSearching((v) => !v); setQ(''); }} aria-label="Search"><Icon name="search" /></button>
          <div className="ep-seg" role="tablist"><button role="tab" aria-selected={tab === 'emoji'} className={tab === 'emoji' ? 'on' : ''} onClick={() => setTab('emoji')} aria-label="Emoji"><Icon name="smile" size={26} /></button><button role="tab" aria-selected={tab === 'sticker'} className={tab === 'sticker' ? 'on' : ''} onClick={() => setTab('sticker')} aria-label="Stickers"><Icon name="sticker" size={26} /></button></div>
          <span style={{ width: 40 }} />
        </div>
        {searching ? <input className="ep-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search stickers" /> : null}
        {tab === 'emoji' ? <EmojiTab q={q} onPick={(e) => { onAdd({ kind: 'emoji', text: e, size: 0.14 }); onClose(); }} /> : (
          <div className="ep-body">
            <div className="stk-chips">
              <button className="stk" onClick={() => chip('Add yours', '📷')}><i>📷</i>Add yours</button>
              <button className="stk time" onClick={() => chip(hhmm)}>{hhmm}</button>
              <button className="stk clock" onClick={() => { onAdd({ kind: 'shape', shape: 'clock', size: 0.13 }); onClose(); }} aria-label="Clock sticker"><ClockFace size="52px" /></button>
              <button className="stk" onClick={location}><i>📍</i>Location</button>
              <button className="stk" onClick={() => photo.current?.click()}><i>🖼️</i>Photo</button>
              <button className="stk" onClick={onMusic}><i>🎵</i>Music</button>
              <button className="stk" onClick={() => chip('Ask me a question', '❓')}><i>❓</i>Question</button>
              <button className="stk" onClick={() => chip('React to this', '😀')}><i>😀</i>Reaction</button>
            </div>
            <h4 className="ep-title">Shapes</h4>
            <div className="stk-shapes">{SHAPES.map((s) => <button key={s} onClick={() => { onAdd({ kind: 'shape', shape: s, size: 0.2 }); onClose(); }} aria-label={`${s} shape`}><OverlayView o={{ id: s, kind: 'shape', shape: s, text: '', x: 0, y: 0, color: '', size: 0.1 }} /></button>)}</div>
            {mine.length ? <><h4 className="ep-title">Your stickers</h4><div className="st-grid">{mine.map((id) => <MyStickerThumb key={id} id={id} onPick={(src) => { onAdd({ kind: 'image', src, size: 0.22 }); onClose(); }} />)}</div></> : null}
            <h4 className="ep-title">Emoji stickers</h4>
            <div className="st-grid">{['😂', '😍', '🥹', '😭', '😎', '🤯', '🥳', '😴', '🤔', '🙏', '👍', '❤️', '🔥', '💯', '🎉', '👏'].map((e) => <button key={e} className="st-emoji" onClick={() => { onAdd({ kind: 'emoji', text: e, size: 0.22 }); onClose(); }}>{e}</button>)}</div>
          </div>)}
        <input ref={photo} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { onAdd({ kind: 'image', src: URL.createObjectURL(f), size: 0.3 }); onClose(); } }} />
      </div>
    </div>
  );
}
function MyStickerThumb({ id, onPick }: { id: string; onPick: (src: string) => void }) {
  const m = useMedia(id);
  return <button className="st-thumb" disabled={!m} onClick={() => m && onPick(m.thumbUrl ?? m.url)}>{m ? <img src={m.thumbUrl ?? m.url} alt="Sticker" /> : <span className="skel" />}</button>;
}

/* ---------------- music library ---------------- */
export interface Track { id: string; mediaId: string; title: string; artist: string; mood: string; genre: string; starred: boolean; durationMs: number | null }
const cover = (t: string) => { const h = [...t].reduce((a, c) => a + c.charCodeAt(0), 0) % 360; return `linear-gradient(135deg, hsl(${h} 55% 38%), hsl(${(h + 50) % 360} 60% 22%))`; };

export function MusicSheet({ onClose, onPick }: { onClose: () => void; onPick: (t: Track) => void }) {
  const [tab, setTab] = useState<'suggested' | 'mood' | 'genre' | 'starred'>('suggested'); const [q, setQ] = useState('');
  const [data, setData] = useState<{ tracks: Track[]; moods: string[]; genres: string[] } | null>(null); const [adding, setAdding] = useState<File | null>(null);
  const [playing, setPlaying] = useState<string | null>(null); const audio = useRef<HTMLAudioElement>(null); const file = useRef<HTMLInputElement>(null);
  const load = () => api.get(`/api/music?tab=${tab}&q=${encodeURIComponent(q.trim())}`).then(setData).catch(toastError);
  useEffect(() => { const t = setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t); }, [tab, q]);  // eslint-disable-line
  const star = async (t: Track) => { await api.patch(`/api/music/${t.id}`, { starred: !t.starred }).catch(toastError); void load(); };
  const del = async (t: Track) => { await api.del(`/api/music/${t.id}`).catch(toastError); void load(); };
  const ph = { suggested: 'Search moods', mood: 'Search genres', genre: 'Search artists', starred: 'Search songs' }[tab]; // the placeholders the phone app uses per tab
  const tracks = data?.tracks ?? [];
  const row = (t: Track) => <TrackRow key={t.id} t={t} playing={playing === t.id} onPlay={() => setPlaying(playing === t.id ? null : t.id)} onStar={() => void star(t)} onPick={() => onPick(t)} onDelete={() => void del(t)} audioRef={audio} />;
  const groups = (keys: string[], by: 'mood' | 'genre') => keys.map((k) => ({ k, items: tracks.filter((t) => t[by] === k) })).filter((g) => g.items.length);
  const other = (by: 'mood' | 'genre') => tracks.filter((t) => !t[by]);
  return (
    <div className="st-sheet-wrap music">
      <div className="st-sheet full" role="dialog" aria-label="Music">
        <div className="ep-grip" /><div className="mus-head"><button className="icon-btn" onClick={onClose} aria-label="Close music"><Icon name="back" /></button>
          <label className="mus-search"><Icon name="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={ph} aria-label="Search music" /></label><button className="mus-add" onClick={() => file.current?.click()} aria-label="Add song"><Icon name="plus" size={22} /></button></div>
        <div className="mus-tabs" role="tablist">{(['suggested', 'mood', 'genre', 'starred'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
        <div className="mus-body">
          {!data ? <p className="ep-empty">Loading…</p> : !tracks.length ? (
            <div className="mus-empty"><span className="star-ring"><Icon name={tab === 'starred' ? 'star' : 'updates'} size={34} /></span><p>{tab === 'starred' ? 'Star your favourite audio so you can easily find it later.' : q ? 'No songs match your search.' : 'Add songs from your device to use them in your updates. Wazzupp has no built-in catalogue, so use music you have the right to share.'}</p>{tab !== 'starred' && !q ? <button className="btn btn-primary" onClick={() => file.current?.click()}>Add a song</button> : null}</div>
          ) : tab === 'suggested' ? <>
            <div className="mus-carousel">{tracks.slice(0, 5).map((t) => <div key={t.id} className="mus-feat" style={{ background: `linear-gradient(135deg, hsl(${[...t.title].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 35% 35%), #7a4560)` }}><span className="cover" style={{ background: cover(t.title) }}>{t.title[0]}</span><span className="grow"><b className="truncate">{t.title}</b><small className="truncate">{t.artist || 'Unknown artist'}</small></span><button className="mus-star" onClick={() => void star(t)} aria-label={t.starred ? 'Unstar' : 'Star'}><Icon name="star" size={26} fill={t.starred} /></button><button className="mus-go" onClick={() => onPick(t)} aria-label={`Use ${t.title}`}><Icon name="send" size={20} /></button></div>)}</div>
            <div className="mus-dots">{tracks.slice(0, 5).map((t, i) => <i key={t.id} className={i === 0 ? 'on' : ''} />)}</div>
            {tracks.map(row)}</>
          : tab === 'starred' ? tracks.map(row)
          : <>{groups(tab === 'mood' ? data.moods : data.genres, tab).map((g) => <section key={g.k}><div className="mus-sec"><h3>{g.k}</h3><button className="btn btn-soft btn-sm" onClick={() => setQ(g.k)}>See all</button></div>{g.items.slice(0, 3).map(row)}</section>)}{other(tab).length ? <section><div className="mus-sec"><h3>Other</h3></div>{other(tab).map(row)}</section> : null}</>}
        </div>
        <audio ref={audio} onEnded={() => setPlaying(null)} />
        <input ref={file} type="file" hidden accept="audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/webm,audio/x-m4a" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setAdding(f); }} />
        {adding ? <AddSong file={adding} moods={data?.moods ?? []} genres={data?.genres ?? []} onClose={() => setAdding(null)} onDone={() => { setAdding(null); void load(); }} /> : null}
      </div>
    </div>
  );
}
function TrackRow({ t, playing, onPlay, onStar, onPick, onDelete, audioRef }: { t: Track; playing: boolean; onPlay: () => void; onStar: () => void; onPick: () => void; onDelete: () => void; audioRef: React.RefObject<HTMLAudioElement | null> }) {
  const m = useMedia(playing ? t.mediaId : null);
  useEffect(() => { const a = audioRef.current; if (!a) return; if (playing && m) { a.src = m.url; void a.play().catch(() => {}); } else a.pause(); }, [playing, m?.url]);  // eslint-disable-line
  return (
    <div className="mus-row">
      <button className="cover" style={{ background: cover(t.title) }} onClick={onPlay} aria-label={playing ? `Pause ${t.title}` : `Play ${t.title}`}><Icon name={playing ? 'pause' : 'play'} size={22} fill /></button>
      <span className="grow"><b className="truncate">{t.title}</b><small className="truncate">{t.artist || 'Unknown artist'}{t.durationMs ? ` · ${duration(t.durationMs / 1000)}` : ''}</small></span>
      <button className="mus-star" onClick={onStar} aria-label={t.starred ? `Unstar ${t.title}` : `Star ${t.title}`}><Icon name="star" size={26} fill={t.starred} /></button>
      <button className="mus-go" onClick={onPick} aria-label={`Use ${t.title}`}><Icon name="send" size={20} /></button>
      <button className="mus-del" onClick={onDelete} aria-label={`Remove ${t.title}`}><Icon name="trash" size={18} /></button>
    </div>
  );
}
function AddSong({ file, moods, genres, onClose, onDone }: { file: File; moods: string[]; genres: string[]; onClose: () => void; onDone: () => void }) {
  const base = file.name.replace(/\.[^.]+$/, ''); const [title, setTitle] = useState(base.replace(/[_]+/g, ' ')); const [artist, setArtist] = useState(''); const [mood, setMood] = useState(''); const [genre, setGenre] = useState(''); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { const up = await uploadWithProgress(file, file.name, 'audio', {}, () => {}).promise; await api.post('/api/music', { mediaId: up.media.id, title: title.trim(), artist: artist.trim(), mood, genre }); toast('Song added'); onDone(); }
    catch (e) { toastError(e); setBusy(false); }
  }
  return (
    <div className="mus-form" role="dialog" aria-label="Add song"><h3>Add song</h3>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></label>
      <label>Artist<input value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={120} placeholder="Optional" /></label>
      <label>Mood<select value={mood} onChange={(e) => setMood(e.target.value)}><option value="">None</option>{moods.map((m) => <option key={m}>{m}</option>)}</select></label>
      <label>Genre<select value={genre} onChange={(e) => setGenre(e.target.value)}><option value="">None</option>{genres.map((g) => <option key={g}>{g}</option>)}</select></label>
      <p className="muted">Only add music you have the right to share.</p>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!title.trim() || busy} onClick={() => void save()}>{busy ? 'Adding…' : 'Add'}</button></div></div>
  );
}
