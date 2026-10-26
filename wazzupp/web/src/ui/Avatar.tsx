import type { CSSProperties } from 'react';
import { useMedia } from '../lib/mediaCache.ts';
import { avatarColors, initials } from '../lib/format.ts';
import { Icon } from './Icon.tsx';

interface Props { id?: string; name?: string; mediaId?: string | null; size?: number; ring?: boolean; seen?: boolean; group?: boolean; online?: boolean; className?: string }

export function Avatar({ id = '', name = '?', mediaId, size = 48, ring, seen, group, online, className = '' }: Props) {
  const m = useMedia(mediaId);
  const [c1, c2] = avatarColors(id || name);
  const style = { '--sz': `${size}px`, '--av-bg': `linear-gradient(145deg, ${c1}, ${c2})` } as CSSProperties;
  return (
    <span className={`avatar ${group ? 'group-av' : ''} ${ring ? 'ring' : ''} ${seen ? 'seen' : ''} ${className}`} style={style} role="img" aria-label={name}>
      {group ? <Icon name="users" size={size * 0.5} stroke={1.8} /> : initials(name)}
      {m?.thumbUrl || m?.url ? <img src={m.thumbUrl ?? m.url} alt="" loading="lazy" decoding="async" draggable={false} /> : null}
      {online ? <i className="presence" /> : null}
    </span>
  );
}
