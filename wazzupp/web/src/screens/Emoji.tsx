import { useState } from 'react';
import { EMOJI } from '../lib/emoji.ts';

export function EmojiPicker({ onPick }: { onPick: (e: string) => void }) {
  const [cat, setCat] = useState(EMOJI[0].id);
  const c = EMOJI.find((x) => x.id === cat)!;
  return (
    <div className="emoji-picker" role="dialog" aria-label="Emoji picker">
      <div className="emoji-tabs">{EMOJI.map((x) => <button key={x.id} className={x.id === cat ? 'on' : ''} onClick={() => setCat(x.id)} aria-label={x.label} title={x.label}>{x.icon}</button>)}</div>
      <div className="emoji-grid">{c.items.map((e) => <button key={e} onClick={() => onPick(e)}>{e}</button>)}</div>
    </div>
  );
}
