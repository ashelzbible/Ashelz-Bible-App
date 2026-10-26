import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api.ts';
import { useStore } from '../lib/store.ts';
import type { Msg } from '../lib/types.ts';
import { useMedia } from '../lib/mediaCache.ts';
import { clock } from '../lib/format.ts';
import { Icon } from '../ui/Icon.tsx';

function Full({ id, name }: { id: string; name: string }) { const m = useMedia(id); return m ? <img className="viewer-img" src={m.url} alt={name} /> : <div className="spinner" style={{ borderTopColor: '#fff' }} />; }

export function MediaViewer({ convId, start, onClose }: { convId: string; start: Msg; onClose: () => void }) {
  const thread = useStore((s) => s.msgs[convId]?.list ?? []);
  const imgs = thread.filter((m) => m.kind === 'image' && m.media && !m.deleted);
  const [i, setI] = useState(Math.max(0, imgs.findIndex((m) => m.id === start.id)));
  const cur = imgs[i] ?? start;
  const dl = useMedia(cur.media?.id);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1)); if (e.key === 'ArrowRight') setI((x) => Math.min(imgs.length - 1, x + 1)); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [imgs.length, onClose]);
  void api;
  return createPortal(
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Photo viewer">
      <div className="viewer-bar"><button className="icon-btn on-dark" onClick={onClose} aria-label="Close"><Icon name="x" /></button><span className="grow">{clock(cur.createdAt)}{cur.body ? ` · ${cur.body}` : ''}</span>{dl ? <a className="icon-btn on-dark" href={`${dl.url}&dl=1`} download={cur.media?.name ?? true} aria-label="Download"><Icon name="download" /></a> : null}</div>
      <div className="viewer-stage" onClick={onClose}>
        {i > 0 ? <button className="viewer-nav l" onClick={(e) => { e.stopPropagation(); setI(i - 1); }} aria-label="Previous"><Icon name="left" size={28} /></button> : null}
        <div onClick={(e) => e.stopPropagation()}>{cur.media ? <Full id={cur.media.id} name={cur.media.name ?? 'Photo'} /> : null}</div>
        {i < imgs.length - 1 ? <button className="viewer-nav r" onClick={(e) => { e.stopPropagation(); setI(i + 1); }} aria-label="Next"><Icon name="right" size={28} /></button> : null}
      </div>
    </div>, document.body);
}
