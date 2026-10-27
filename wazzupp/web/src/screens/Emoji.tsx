import { useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadWithProgress } from '../lib/api.ts';
import { EMOJI } from '../lib/emoji.ts';
import { useMedia } from '../lib/mediaCache.ts';
import { toast } from '../lib/store.ts';
import { toastError } from '../lib/actions.ts';
import { Icon } from '../ui/Icon.tsx';

export interface GifItem { id: string; url: string; preview: string; width: number; height: number }

const ls = {
  get<T>(k: string, d: T): T { try { return JSON.parse(localStorage.getItem(k) ?? '') as T; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const KEYWORDS: Record<string, string> = {
  smile: '😀😃😄😊🙂', happy: '😀😄😊🥳', laugh: '😂🤣😆', cry: '😢😭🥹😥', sad: '😢😞😔😭', love: '❤️😍🥰😘💕', heart: '❤️🧡💛💚💙💜🖤🤍💔', kiss: '😘😗😙😚💋', angry: '😠😡🤬', thumbs: '👍👎', pray: '🙏', clap: '👏', fire: '🔥', party: '🥳🎉🎊', cake: '🎂🍰', dog: '🐶🐕', cat: '🐱🐈', food: '🍕🍔🍟🌮', pizza: '🍕', coffee: '☕', beer: '🍺🍻', sun: '☀️🌞', moon: '🌙', star: '⭐🌟', money: '💰💵🤑', car: '🚗🚕', home: '🏠🏡', flag: '🏁🚩🏳️', ok: '👌🆗', hand: '👋🤚✋', wave: '👋', sleep: '😴💤', think: '🤔', cool: '😎', eyes: '👀', rain: '🌧️☔', flower: '🌸🌷🌹', birthday: '🎂🎉🎁', gift: '🎁', phone: '📱☎️', music: '🎵🎶🎧', ball: '⚽🏀🏈', 
};
const bar: Array<{ id: string; icon: string; label: string }> = [{ id: 'recent', icon: '🕘', label: 'Recents' }, ...EMOJI.map((c) => ({ id: c.id, icon: c.icon, label: c.label }))];

/** Emoji, GIF and sticker tabs in one panel (like the phone apps): search, recents, category bar, backspace. */
export function EmojiPanel({ onEmoji, onBackspace, onGif, onSticker, onClose }: {
  onEmoji: (e: string) => void; onBackspace: () => void; onGif: (g: GifItem) => void; onSticker: (s: { mediaId: string } | { file: File; kind: 'sticker' }) => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<'emoji' | 'gif' | 'sticker'>('emoji');
  const [q, setQ] = useState(''); const [searching, setSearching] = useState(false);
  return (
    <div className="emoji-panel" role="dialog" aria-label="Emoji, GIF and sticker picker">
      <div className="ep-grip" />
      <div className="ep-head">
        <button className={`icon-btn ${searching ? 'on' : ''}`} aria-label="Search" onClick={() => { setSearching((v) => !v); setQ(''); }}><Icon name="search" /></button>
        <div className="ep-seg" role="tablist">
          <button role="tab" aria-selected={tab === 'emoji'} className={tab === 'emoji' ? 'on' : ''} onClick={() => setTab('emoji')} aria-label="Emoji"><Icon name="smile" size={26} /></button>
          <button role="tab" aria-selected={tab === 'gif'} className={tab === 'gif' ? 'on' : ''} onClick={() => setTab('gif')} aria-label="GIF"><b>GIF</b></button>
          <button role="tab" aria-selected={tab === 'sticker'} className={tab === 'sticker' ? 'on' : ''} onClick={() => setTab('sticker')} aria-label="Stickers"><Icon name="sticker" size={26} /></button>
        </div>
        {tab === 'emoji' ? <button className="icon-btn" aria-label="Backspace" onClick={onBackspace}><Icon name="backspace" /></button> : <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>}
      </div>
      {searching ? <input className="ep-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'emoji' ? 'Search emoji (e.g. heart, laugh)' : tab === 'gif' ? 'Search GIFs' : 'Search stickers'} aria-label="Search" /> : null}
      {tab === 'emoji' ? <EmojiTab q={q} onPick={onEmoji} /> : tab === 'gif' ? <GifTab q={q} onGif={onGif} /> : <StickerTab onSticker={onSticker} />}
    </div>
  );
}

export function EmojiTab({ q, onPick }: { q: string; onPick: (e: string) => void }) {
  const [recent, setRecent] = useState<string[]>(() => ls.get('wz.emoji.recent', []));
  const [cat, setCat] = useState(() => (ls.get<string[]>('wz.emoji.recent', []).length ? 'recent' : EMOJI[0].id));
  const sc = useRef<HTMLDivElement>(null);
  const pick = (e: string) => { const next = [e, ...recent.filter((x) => x !== e)].slice(0, 32); setRecent(next); ls.set('wz.emoji.recent', next); onPick(e); };
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase(); if (!t) return null;
    const out = new Set<string>();
    for (const [k, v] of Object.entries(KEYWORDS)) if (k.includes(t) || t.includes(k)) for (const e of v.match(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*|[🇦-🇿]{2}/gu) ?? []) out.add(e);
    for (const c of EMOJI) if (c.label.toLowerCase().includes(t)) c.items.forEach((e) => out.add(e));
    for (const c of EMOJI) for (const e of c.items) if (e === q.trim()) out.add(e);
    return [...out];
  }, [q]);
  const shown = hits ?? (cat === 'recent' ? recent : EMOJI.find((c) => c.id === cat)!.items);
  useEffect(() => { sc.current?.scrollTo({ top: 0 }); }, [cat, q]);
  return (
    <>
      <div className="ep-body" ref={sc}>
        <h4 className="ep-title">{hits ? 'Results' : cat === 'recent' ? 'Recents' : EMOJI.find((c) => c.id === cat)!.label}</h4>
        {shown.length ? <div className="ep-grid">{shown.map((e) => <button key={e} onClick={() => pick(e)}>{e}</button>)}</div> : <p className="ep-empty">{hits ? 'No emoji found' : 'Emoji you use appear here'}</p>}
      </div>
      <div className="ep-cats">{bar.map((c) => <button key={c.id} className={!hits && cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)} aria-label={c.label} title={c.label}>{c.icon}</button>)}</div>
    </>
  );
}

function GifTab({ q, onGif }: { q: string; onGif: (g: GifItem) => void }) {
  const [state, setState] = useState<{ loading: boolean; configured: boolean; items: GifItem[]; error?: string }>({ loading: true, configured: true, items: [] });
  useEffect(() => {
    let alive = true; setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api.get<{ configured: boolean; results: GifItem[] }>(`/api/gifs?q=${encodeURIComponent(q.trim())}`)
        .then((r) => alive && setState({ loading: false, configured: r.configured, items: r.results }))
        .catch((e) => alive && setState({ loading: false, configured: true, items: [], error: e.message }));
    }, q ? 350 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  if (!state.loading && !state.configured) return <div className="ep-body"><p className="ep-empty">GIF search is not set up on this server.<br />Your administrator can turn it on by adding a Tenor API key. Meanwhile you can send any GIF from your device with the paperclip.</p></div>;
  return (
    <div className="ep-body gif">
      {state.loading ? <p className="ep-empty">Loading…</p> : state.error ? <p className="ep-empty">{state.error}</p> : !state.items.length ? <p className="ep-empty">No GIFs found</p>
        : <div className="gif-cols">{state.items.map((g) => <button key={g.id} onClick={() => onGif(g)} aria-label="Send GIF"><img src={g.preview} alt="GIF" loading="lazy" style={{ aspectRatio: `${g.width}/${g.height}` }} /></button>)}</div>}
    </div>
  );
}

/** Stickers you made (kept as your own uploaded images) plus a starter pack of emoji stickers. */
const PACK = ['😂', '😍', '🥹', '😭', '😎', '🤯', '🥳', '😴', '🤔', '🙏', '👍', '❤️', '🔥', '💯', '🎉', '👏', '😡', '🤗'];
function StickerTab({ onSticker }: { onSticker: (s: { mediaId: string } | { file: File; kind: 'sticker' }) => void }) {
  const [mine, setMine] = useState<string[]>(() => ls.get('wz.stickers', []));
  const pick = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function create(file: File) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { toast('Choose a PNG, JPEG, WebP or GIF image', 'error'); return; }
    setBusy(true);
    try {
      const r = await uploadWithProgress(file, file.name, 'sticker', {}, () => {}).promise;
      const next = [r.media.id, ...mine].slice(0, 60); setMine(next); ls.set('wz.stickers', next); toast('Sticker created');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  }
  async function sendEmoji(e: string) {
    const c = document.createElement('canvas'); c.width = c.height = 512; const x = c.getContext('2d')!;
    x.font = '400px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(e, 256, 280);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
    if (blob) onSticker({ file: new File([blob], `sticker-${Date.now()}.png`, { type: 'image/png' }), kind: 'sticker' });
  }
  return (
    <div className="ep-body">
      <div className="st-row">
        <button className="st-create" onClick={() => pick.current?.click()} disabled={busy}><span><Icon name="wand" size={26} /></span>{busy ? 'Creating…' : 'Create sticker'}</button>
        {mine.slice(0, 4).map((id) => <StickerThumb key={id} id={id} onPick={() => onSticker({ mediaId: id })} />)}
      </div>
      {mine.length > 4 ? <><h4 className="ep-title">Your stickers</h4><div className="st-grid">{mine.slice(4).map((id) => <StickerThumb key={id} id={id} onPick={() => onSticker({ mediaId: id })} />)}</div></> : null}
      <h4 className="ep-title">Emoji stickers</h4>
      <div className="st-grid">{PACK.map((e) => <button key={e} className="st-emoji" onClick={() => void sendEmoji(e)} aria-label={`Send ${e} sticker`}>{e}</button>)}</div>
      <input ref={pick} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void create(f); }} />
    </div>
  );
}
function StickerThumb({ id, onPick }: { id: string; onPick: () => void }) {
  const m = useMedia(id);
  return <button className="st-thumb" onClick={onPick} aria-label="Send sticker">{m ? <img src={m.thumbUrl ?? m.url} alt="Sticker" /> : <span className="skel" />}</button>;
}
