import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { bytes, clock, duration, initials, systemText } from '../lib/format.ts';
import { useMedia } from '../lib/mediaCache.ts';
import { useStore } from '../lib/store.ts';
import type { Msg } from '../lib/types.ts';
import { Icon } from '../ui/Icon.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import { guard, openDirect } from '../lib/actions.ts';
import { go } from '../lib/route.ts';

export function Ticks({ status, size = 17 }: { status: 'sending' | 'queued' | 'failed' | 'sent' | 'delivered' | 'read'; size?: number }) {
  if (status === 'sending' || status === 'queued') return <Icon name="clock" size={size - 3} className="tick pending" stroke={2} />;
  if (status === 'failed') return <Icon name="info" size={size} className="tick failed" stroke={2.2} />;
  if (status === 'sent') return <Icon name="check" size={size} className="tick" stroke={2.2} />;
  return <Icon name="check-check" size={size} className={`tick ${status === 'read' ? 'read' : ''}`} stroke={2.2} />;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
function plain(text: string, meName: string, k: { n: number }): ReactNode[] {
  const out: ReactNode[] = []; let last = 0;
  const mention = (s: string) => s.split(/(@[\p{L}\p{N}_.]+)/u).map((p, i) => p.startsWith('@') ? <span key={i} className={`mention ${p.slice(1).toLowerCase() === meName.toLowerCase() ? 'me' : ''}`}>{p}</span> : p);
  for (const m of text.matchAll(URL_RE)) {
    if (m.index! > last) out.push(<span key={k.n++}>{mention(text.slice(last, m.index))}</span>);
    out.push(<a key={k.n++} href={m[0]} target="_blank" rel="noopener noreferrer nofollow ugc" className="link">{m[0]}</a>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(<span key={k.n++}>{mention(text.slice(last))}</span>);
  return out;
}
// *bold*  _italic_  ~strike~  `code` — the marker must hug the text (no space inside) and sit at a word edge, as in WhatsApp.
const INLINE = /(^|[\s([{>])(?:`([^`\n]+)`|\*([^\s*](?:[^*\n]*[^\s*])?)\*|_([^\s_](?:[^_\n]*[^\s_])?)_|~([^\s~](?:[^~\n]*[^\s~])?)~)(?=$|[\s)\]}.,;:!?])/gu;
function inline(text: string, meName: string, k: { n: number }, depth = 0): ReactNode[] {
  const out: ReactNode[] = []; let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index! + m[1].length;
    if (start > last) out.push(...plain(text.slice(last, start), meName, k));
    const [, , code, bold, ital, strike] = m;
    if (code !== undefined) out.push(<code key={k.n++} className="fmt-code">{code}</code>);
    else { const inner = depth < 3 ? inline((bold ?? ital ?? strike)!, meName, k, depth + 1) : plain((bold ?? ital ?? strike)!, meName, k); out.push(bold !== undefined ? <strong key={k.n++}>{inner}</strong> : ital !== undefined ? <em key={k.n++}>{inner}</em> : <s key={k.n++}>{inner}</s>); }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(...plain(text.slice(last), meName, k));
  return out;
}
/** WhatsApp-style formatting: inline styles, ``` monospace blocks, "- " / "* " bullets, "1. " numbers and "> " quotes. */
function linkify(text: string, meName: string): ReactNode[] {
  const k = { n: 0 }; const out: ReactNode[] = [];
  const fences = text.split(/```/);
  if (fences.length < 3) return block(text, meName, k);
  fences.forEach((part, i) => {
    if (i % 2 === 1 && i < fences.length - 1) out.push(<code key={k.n++} className="fmt-block">{part.replace(/^\n|\n$/g, '')}</code>);
    else if (part) out.push(...block(i % 2 === 1 ? '```' + part : part, meName, k));
  });
  return out;
}
function block(text: string, meName: string, k: { n: number }): ReactNode[] {
  const lines = text.split('\n'); const out: ReactNode[] = []; let i = 0;
  while (i < lines.length) {
    const ln = lines[i]; let m: RegExpMatchArray | null;
    if ((m = ln.match(/^\s*[-*] (.+)/))) { const items: string[] = []; while (i < lines.length && (m = lines[i].match(/^\s*[-*] (.+)/))) { items.push(m[1]); i++; } out.push(<ul key={k.n++} className="fmt-list">{items.map((t) => <li key={k.n++}>{inline(t, meName, k)}</li>)}</ul>); }
    else if ((m = ln.match(/^\s*\d+\. (.+)/))) { const items: string[] = []; while (i < lines.length && (m = lines[i].match(/^\s*\d+\. (.+)/))) { items.push(m[1]); i++; } out.push(<ol key={k.n++} className="fmt-list">{items.map((t) => <li key={k.n++}>{inline(t, meName, k)}</li>)}</ol>); }
    else if (/^> ?/.test(ln)) { const qs: string[] = []; while (i < lines.length && /^> ?/.test(lines[i])) { qs.push(lines[i].replace(/^> ?/, '')); i++; } out.push(<blockquote key={k.n++} className="fmt-quote">{inline(qs.join('\n'), meName, k)}</blockquote>); }
    else { const para: string[] = []; while (i < lines.length && !/^\s*([-*] |\d+\. )\S/.test(lines[i]) && !/^> ?/.test(lines[i])) { para.push(lines[i]); i++; } out.push(<span key={k.n++}>{inline(para.join('\n'), meName, k)}{i < lines.length ? '\n' : ''}</span>); }
  }
  return out;
}
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s){1,6}$/u;

export function MediaImage({ id, w, h, alt, onOpen }: { id: string; w: number | null; h: number | null; alt: string; onOpen?: () => void }) {
  const m = useMedia(id);
  const [loaded, setLoaded] = useState(false);
  const ratio = w && h ? Math.min(Math.max(w / h, 0.5), 2) : 4 / 3;
  return (
    <button className="media-img" style={{ aspectRatio: String(ratio) }} onClick={onOpen} aria-label={`Open ${alt}`}>
      {!loaded ? <span className="skel" style={{ position: 'absolute', inset: 0, borderRadius: 0 }} /> : null}
      {m ? <img src={m.thumbUrl ?? m.url} alt={alt} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} style={{ opacity: loaded ? 1 : 0 }} /> : null}
    </button>
  );
}

function Voice({ m }: { m: Msg }) {
  const media = useMedia(m.media!.id);
  const a = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [rate, setRate] = useState(1);
  const total = (m.media!.durationMs ?? 0) / 1000;
  const wave = m.media!.waveform?.length ? m.media!.waveform : Array.from({ length: 36 }, (_, i) => 0.25 + 0.5 * Math.abs(Math.sin(i * 1.7)));
  const progress = total ? Math.min(1, t / total) : 0;
  useEffect(() => { if (a.current) a.current.playbackRate = rate; }, [rate]);
  return (
    <div className="voice">
      <button className="voice-play" aria-label={playing ? 'Pause' : 'Play voice message'} disabled={!media} onClick={() => { const el = a.current!; if (el.paused) void el.play(); else el.pause(); }}><Icon name={playing ? 'pause' : 'play'} size={20} fill /></button>
      <div className="voice-body">
        <div className="wave" role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(t)} tabIndex={0}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (a.current && total) a.current.currentTime = ((e.clientX - r.left) / r.width) * total; }}>
          {wave.map((v, i) => <i key={i} className={i / wave.length <= progress ? 'on' : ''} style={{ height: `${Math.max(14, v * 100)}%` }} />)}
        </div>
        <span className="voice-time">{duration(playing || t ? t : total)}</span>
      </div>
      <button className="voice-rate" onClick={() => setRate((r) => (r === 1 ? 1.5 : r === 1.5 ? 2 : 1))} aria-label="Playback speed">{rate}×</button>
      {media ? <audio ref={a} src={media.url} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setT(0); }} onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} /> : null}
    </div>
  );
}

function DocCard({ m }: { m: Msg }) {
  const media = useMedia(m.media!.id);
  const ext = (m.media!.name?.split('.').pop() ?? 'file').slice(0, 4).toUpperCase();
  return (
    <a className="doc-card" href={media ? `${media.url}&dl=1` : undefined} download={m.media!.name ?? true} aria-label={`Download ${m.media!.name}`}>
      <span className={`doc-ico ${ext === 'PDF' ? 'pdf' : ''}`}>{ext}</span>
      <span className="grow"><b className="truncate" style={{ display: 'block' }}>{m.media!.name}</b><small>{bytes(m.media!.size)}</small></span>
      <Icon name="download" size={20} />
    </a>
  );
}

function Poll({ m }: { m: Msg }) {
  const me = useStore((s) => s.me!.id);
  const votes = m.votes ?? [];
  const opts: string[] = m.meta.options ?? [];
  const mine = new Set(votes.filter((v) => v.userId === me).map((v) => v.option));
  const voters = new Set(votes.map((v) => v.userId)).size;
  const vote = (i: number) => {
    const next = m.meta.multi ? (mine.has(i) ? [...mine].filter((x) => x !== i) : [...mine, i]) : (mine.has(i) ? [] : [i]);
    void guard(api.post(`/api/messages/${m.id}/vote`, { options: next }));
  };
  return (
    <div className="poll">
      <b>{m.meta.question}</b><small className="muted">{m.meta.multi ? 'Select one or more' : 'Select one'}</small>
      {opts.map((o, i) => {
        const n = votes.filter((v) => v.option === i).length; const pct = voters ? Math.round((n / voters) * 100) : 0;
        return <button key={i} className="poll-opt" onClick={() => vote(i)} disabled={m.local} aria-pressed={mine.has(i)}>
          <span className={`poll-check ${mine.has(i) ? 'on' : ''}`}>{mine.has(i) ? <Icon name="check" size={13} stroke={3} /> : null}</span>
          <span className="poll-label"><span>{o}</span><span>{n}</span></span><span className="poll-bar"><i style={{ width: `${pct}%` }} /></span>
        </button>;
      })}
      <small className="muted">{voters} {voters === 1 ? 'vote' : 'votes'}</small>
    </div>
  );
}

function Location({ m }: { m: Msg }) {
  const { lat, lng, label } = m.meta;
  return (
    <a className="loc-card" href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`} target="_blank" rel="noopener noreferrer">
      <span className="loc-map" aria-hidden="true"><svg viewBox="0 0 200 90" preserveAspectRatio="xMidYMid slice"><rect width="200" height="90" fill="#E4EBDD" /><path d="M-10 60 Q50 30 100 55 T210 40" stroke="#fff" strokeWidth="9" fill="none" /><path d="M40 -5 L70 95" stroke="#fff" strokeWidth="6" /><path d="M0 20 H200" stroke="#F4F1E6" strokeWidth="5" /><rect x="120" y="58" width="50" height="26" rx="4" fill="#CFE3C4" /><circle cx="100" cy="42" r="14" fill="rgba(0,168,132,.18)" /></svg><Icon name="map-pin" size={30} className="loc-pin" fill /></span>
      <span className="loc-info"><b>{label || 'Shared location'}</b><small>{Number(lat).toFixed(5)}, {Number(lng).toFixed(5)} · Open in maps</small></span>
    </a>
  );
}

function ContactCard({ m }: { m: Msg }) {
  const c = m.meta;
  return (
    <div className="contact-card">
      <div className="row"><Avatar name={c.name} id={c.userId ?? c.name} size={44} /><span className="grow"><b>{c.name}</b>{c.phone ? <small className="muted" style={{ display: 'block' }}>{c.phone}</small> : null}</span></div>
      <div className="contact-actions">
        {c.userId ? <button onClick={async () => { const id = await guard(openDirect(c.userId)); if (id) go(`chats/${id}`); }}>Message</button> : null}
        <button onClick={() => navigator.clipboard?.writeText(`${c.name}${c.phone ? ' ' + c.phone : ''}`)}>Copy</button>
      </div>
    </div>
  );
}

function EventCard({ m }: { m: Msg }) {
  const e = m.meta; const d = new Date(e.startsAt);
  const ics = () => {
    const f = (x: Date) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wazzupp//EN', 'BEGIN:VEVENT', `UID:${m.id}@wazzupp`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(d)}`, `DTEND:${f(new Date(d.getTime() + 3600000))}`, `SUMMARY:${String(e.title).replace(/[\r\n]/g, ' ')}`, e.location ? `LOCATION:${String(e.location).replace(/[\r\n]/g, ' ')}` : '', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' })); a.download = 'event.ics'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return (
    <div className="event-card">
      <span className="event-date"><b>{d.toLocaleDateString(undefined, { day: 'numeric' })}</b><small>{d.toLocaleDateString(undefined, { month: 'short' })}</small></span>
      <span className="grow"><b>{e.title}</b><small className="muted" style={{ display: 'block' }}>{d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}{e.location ? ` · ${e.location}` : ''}</small></span>
      <button className="btn btn-soft btn-sm" onClick={ics}>Add to calendar</button>
    </div>
  );
}

function Body({ m, onOpenMedia, nameOf }: { m: Msg; onOpenMedia: (m: Msg) => void; nameOf: (id: string) => string }) {
  const meName = useStore((s) => s.me!.username);
  const meId = useStore((s) => s.me!.id);
  if (m.deleted) return <span className="deleted"><Icon name="ban" size={15} /> {m.senderId === meId ? 'You deleted this message' : 'This message was deleted'}</span>;
  switch (m.kind) {
    case 'image': case 'sticker': return <>{m.media ? <MediaImage id={m.media.id} w={m.media.width} h={m.media.height} alt={m.media.name ?? 'Photo'} onOpen={() => onOpenMedia(m)} /> : null}{m.body ? <div className="txt cap">{linkify(m.body, meName)}</div> : null}</>;
    case 'video': return <>{m.media ? <VideoPlayer id={m.media.id} note={!!m.meta.note} /> : null}{m.body ? <div className="txt cap">{linkify(m.body, meName)}</div> : null}</>;
    case 'voice': return m.media ? <Voice m={m} /> : null;
    case 'audio': return m.media ? <AudioFile id={m.media.id} name={m.media.name} /> : null;
    case 'document': return <>{m.media ? <DocCard m={m} /> : null}{m.body ? <div className="txt cap">{linkify(m.body, meName)}</div> : null}</>;
    case 'location': return <Location m={m} />;
    case 'contact': return <ContactCard m={m} />;
    case 'poll': return <Poll m={m} />;
    case 'event': return <EventCard m={m} />;
    case 'gif': return <a className="gif-msg" href={m.meta.url} target="_blank" rel="noopener noreferrer"><img src={m.meta.preview ?? m.meta.url} alt="GIF" loading="lazy" style={{ aspectRatio: m.meta.width && m.meta.height ? `${m.meta.width}/${m.meta.height}` : undefined }} /></a>;
    default: return <>{m.meta.statusReply ? <StatusReply m={m} nameOf={nameOf} meId={meId} /> : null}<div className={`txt ${EMOJI_ONLY.test(m.body) ? 'big-emoji' : ''}`}>{linkify(m.body, meName)}</div></>;
  }
}
function VideoPlayer({ id, note }: { id: string; note?: boolean }) { const m = useMedia(id); return m ? <video className={`media-video ${note ? 'note' : ''}`} src={m.url} controls preload="metadata" playsInline /> : <div className={`skel media-video ${note ? 'note' : ''}`} />; }

/** The card shown above a reply to someone's status: who, what kind, a snippet and a thumbnail. */
function StatusReply({ m, nameOf, meId }: { m: Msg; nameOf: (id: string) => string; meId: string }) {
  const r = m.meta.statusReply as { ownerId: string; kind: string; text: string; mediaId?: string | null };
  const thumb = useMedia(r.mediaId ?? '');
  const mine = r.ownerId === meId;
  return (
    <div className={`status-quote ${mine ? 'own' : ''}`}>
      <span className="grow"><b>{mine ? 'You' : nameOf(r.ownerId)} <i>•</i> Status</b><span className="sq-line"><Icon name={r.kind === 'video' ? 'video' : 'image'} size={14} /><span className="truncate">{r.text}</span></span></span>
      {r.kind !== 'text' ? <span className="sq-thumb">{r.mediaId && thumb ? <img src={thumb.thumbUrl ?? thumb.url} alt="" /> : null}</span> : null}
    </div>
  );
}
function AudioFile({ id, name }: { id: string; name: string | null }) { const m = useMedia(id); return <div><small className="muted">{name}</small>{m ? <audio controls preload="none" src={m.url} style={{ width: 240, maxWidth: '100%' }} /> : null}</div>; }

export interface BubbleProps {
  m: Msg; mine: boolean; showSender: boolean; senderName: string; senderId?: string; senderAvatar?: string | null; first: boolean; last: boolean;
  status: 'sending' | 'queued' | 'failed' | 'sent' | 'delivered' | 'read' | null; meId: string;
  onMenu: (e: { clientX: number; clientY: number }, m: Msg) => void; onReact: (m: Msg, emoji: string) => void; onReplyJump: (id: string) => void; onOpenMedia: (m: Msg) => void; onRetry: (m: Msg) => void;
  onSwipeReply: (m: Msg) => void; highlight?: boolean; nameOf: (id: string) => string; isGroup: boolean;
}

export const Bubble = memo(function Bubble(p: BubbleProps) {
  const { m, mine } = p;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);
  const grouped = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const r of m.reactions ?? []) g.set(r.emoji, [...(g.get(r.emoji) ?? []), r.userId]);
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [m.reactions]);

  if (m.kind === 'system') {
    const txt = m.meta.event === 'call' ? systemText(m.meta, p.meId, p.nameOf) : systemText(m.meta, p.meId, p.nameOf);
    return <div className="sys-msg" data-seq={m.seq}><span>{m.meta.event === 'call' ? <Icon name={m.meta.callKind === 'video' ? 'video' : 'phone'} size={14} /> : null}{txt}</span></div>;
  }
  const bare = (m.kind === 'sticker' || (m.kind === 'text' && EMOJI_ONLY.test(m.body) && !m.meta.statusReply)) && !m.replyTo && !m.deleted;
  const mediaOnly = (m.kind === 'image' || m.kind === 'video' || m.kind === 'gif') && !m.body && !m.deleted && !m.replyTo;
  return (
    <div className={`msg-row ${mine ? 'out' : 'in'} ${p.first ? 'first' : ''} ${p.highlight ? 'hl' : ''}`} data-id={m.id} data-seq={m.seq}
      onContextMenu={(e) => { e.preventDefault(); p.onMenu(e, m); }}
      onDoubleClick={() => !m.local && p.onReact(m, '👍')}
      onTouchStart={(e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; timer.current = setTimeout(() => { navigator.vibrate?.(8); p.onMenu({ clientX: t.clientX, clientY: t.clientY }, m); touch.current = null; }, 480); }}
      onTouchMove={(e) => { const s = touch.current; if (!s) return; const d = e.touches[0].clientX - s.x; if (Math.abs(e.touches[0].clientY - s.y) > 14) { clearTimeout(timer.current); return; } if (Math.abs(d) > 10) clearTimeout(timer.current); if (d > 0 && d < 90) setDx(d); }}
      onTouchEnd={() => { clearTimeout(timer.current); if (dx > 60) p.onSwipeReply(m); setDx(0); touch.current = null; }}>
      {!mine && p.isGroup ? <span className="msg-av">{p.last ? <Avatar id={p.senderId} name={p.senderName} mediaId={p.senderAvatar} size={30} /> : null}</span> : null}
      <div className="msg-col" style={dx ? { transform: `translateX(${dx}px)` } : undefined}>
        <div className={`bubble ${bare ? 'bare' : ''} ${mediaOnly ? 'media-only' : ''} ${p.first ? 'tail' : ''} ${m.deleted ? 'is-deleted' : ''}`}>
          {!mine && p.showSender && !m.deleted ? <span className="sender" style={{ color: `hsl(${[...(p.senderId ?? p.senderName)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 55% 38%)` }}>{p.senderName}</span> : null}
          {m.forwarded && !m.deleted ? <span className="fwd"><Icon name="forward" size={13} /> Forwarded</span> : null}
          {m.replyTo && !m.deleted ? (
            <button className="quote" onClick={() => p.onReplyJump(m.replyTo!.id)}><b>{m.replyTo.senderId === p.meId ? 'You' : p.nameOf(m.replyTo.senderId ?? '')}</b><span className="truncate">{m.replyTo.deleted ? 'Deleted message' : m.replyTo.kind === 'text' ? m.replyTo.body : `📎 ${m.replyTo.kind}`}</span></button>
          ) : null}
          <Body m={m} onOpenMedia={p.onOpenMedia} nameOf={p.nameOf} />
          <span className="meta">
            {m.pinned ? <Icon name="pin" size={12} /> : null}{m.starred ? <Icon name="star" size={12} fill /> : null}{m.expiresAt ? <Icon name="clock" size={12} /> : null}
            {m.editedAt && !m.deleted ? <span>Edited</span> : null}
            <time>{clock(m.createdAt)}</time>
            {mine && p.status && !m.deleted ? <Ticks status={p.status} /> : null}
          </span>
        </div>
        {grouped.length ? <div className="reacts">{grouped.map(([e, u]) => <button key={e} className={u.includes(p.meId) ? 'mine' : ''} onClick={() => p.onReact(m, e)} aria-label={`${e} ${u.length}`}>{e}{u.length > 1 ? <span>{u.length}</span> : null}</button>)}</div> : null}
        {m.local && m.status === 'failed' ? <button className="retry" onClick={() => p.onRetry(m)}><Icon name="refresh" size={14} /> Not sent. Tap to retry</button> : null}
        {m.local && m.status === 'queued' ? <span className="queued-note">Waiting for network…</span> : null}
      </div>
    </div>
  );
});
void initials;
