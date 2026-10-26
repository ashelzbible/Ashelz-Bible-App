import { useEffect } from 'react';
import { api } from './api.ts';
import { getState, setState, useStore } from './store.ts';

let queue = new Set<string>();
let scheduled = false;
const inflight = new Set<string>();

function flush() {
  scheduled = false;
  const ids = [...queue]; queue = new Set();
  if (!ids.length) return;
  ids.forEach((i) => inflight.add(i));
  api.post<{ urls: Record<string, { url: string; thumbUrl: string | null; expiresAt: number }> }>('/api/media/urls', { ids: ids.slice(0, 100) })
    .then((r) => setState((s) => ({ mediaUrls: { ...s.mediaUrls, ...r.urls } })))
    .catch(() => {})
    .finally(() => ids.forEach((i) => inflight.delete(i)));
}
/** Requests a signed URL for the asset (batched). Signed URLs are short-lived and refreshed before they expire. */
export function requestMedia(id: string) {
  const cur = getState().mediaUrls[id];
  if ((cur && cur.expiresAt - Date.now() > 45_000) || inflight.has(id)) return;
  queue.add(id);
  if (!scheduled) { scheduled = true; queueMicrotask(flush); }
}
export function useMedia(id: string | null | undefined) {
  const m = useStore((s) => (id ? s.mediaUrls[id] : undefined));
  useEffect(() => {
    if (!id) return;
    requestMedia(id);
    if (!m) return;
    const t = setTimeout(() => requestMedia(id), Math.max(1000, m.expiresAt - Date.now() - 40_000));
    return () => clearTimeout(t);
  }, [id, m?.expiresAt]);
  return m;
}
