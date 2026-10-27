import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useMedia } from '../lib/mediaCache.ts';
import { avatarColors, initials } from '../lib/format.ts';
import { Icon } from './Icon.tsx';

interface Props { id?: string; name?: string; mediaId?: string | null; size?: number; ring?: boolean; seen?: boolean; group?: boolean; online?: boolean; className?: string }

export function Avatar({ id = '', name = '?', mediaId, size = 48, ring, seen, group, online, className = '' }: Props) {
  const m = useMedia(mediaId);
  const [bad, setBad] = useState<string | null>(null); // a picture that fails to load falls back to the initials instead of a broken-image icon
  const [c1, c2] = avatarColors(id || name);
  const style = { '--sz': `${size}px`, '--av-bg': `linear-gradient(145deg, ${c1}, ${c2})` } as CSSProperties;
  return (
    <span className={`avatar ${group ? 'group-av' : ''} ${ring ? 'ring' : ''} ${seen ? 'seen' : ''} ${className}`} style={style} role="img" aria-label={name}>
      {group ? <Icon name="users" size={size * 0.5} stroke={1.8} /> : initials(name)}
      {(m?.thumbUrl || m?.url) && bad !== (m.thumbUrl ?? m.url) ? <img src={m.thumbUrl ?? m.url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBad(m.thumbUrl ?? m.url)} /> : null}
      {online ? <i className="presence" /> : null}
    </span>
  );
}

/** Avatar inside a segmented status ring: one arc per update, grey for viewed ones (first) and green for new ones. */
export function StatusAvatar({ id, name, mediaId, size = 52, total, viewed, className = '' }: { id?: string; name?: string; mediaId?: string | null; size?: number; total: number; viewed: number; className?: string }) {
  const S = size + 14; const r = S / 2 - 2.5; const c = S / 2;
  const n = Math.max(0, total); const gap = n > 1 ? 9 : 0;
  const pt = (deg: number) => { const a = (deg * Math.PI) / 180; return `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`; };
  const arcs = Array.from({ length: n }, (_, i) => {
    const a0 = -90 + (i * 360) / n + gap / 2; const a1 = -90 + ((i + 1) * 360) / n - gap / 2; const large = a1 - a0 > 180 ? 1 : 0;
    return { d: n === 1 ? '' : `M ${pt(a0)} A ${r} ${r} 0 ${large} 1 ${pt(a1)}`, seen: i < viewed };
  });
  return (
    <span className={`st-ring ${className}`} style={{ width: S, height: S }}>
      {n > 0 ? <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden="true">
        {n === 1 ? <circle cx={c} cy={c} r={r} fill="none" strokeWidth="3" className={arcs[0].seen ? 'seen' : 'new'} /> : arcs.map((a, i) => <path key={i} d={a.d} fill="none" strokeWidth="3" strokeLinecap="round" className={a.seen ? 'seen' : 'new'} />)}
      </svg> : null}
      <Avatar id={id} name={name} mediaId={mediaId} size={size} />
    </span>
  );
}
