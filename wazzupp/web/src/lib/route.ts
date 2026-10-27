import { useSyncExternalStore } from 'react';
import { backHash, getHash, replaceHash, setHash, subscribeHash } from './nav.ts';

export interface Route { tab: 'chats' | 'calls' | 'communities' | 'status' | 'settings' | 'admin'; id?: string; sub?: string; rest?: string }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const tab = (['chats', 'calls', 'communities', 'status', 'settings', 'admin'].includes(parts[0]) ? parts[0] : 'chats') as Route['tab'];
  return { tab, id: parts[1], sub: parts[2], rest: parts.slice(3).join('/') };
}
const subscribe = subscribeHash;
let cached: { hash: string; route: Route } = { hash: '\0', route: { tab: 'chats' } };
const snap = () => { const h = getHash(); if (cached.hash !== h) cached = { hash: h, route: parseRoute(h) }; return cached.route; };
export const useRoute = (): Route => useSyncExternalStore(subscribe, snap, snap);
export const go = (path: string) => setHash('#/' + path.replace(/^#?\/?/, ''));
export const replace = (path: string) => replaceHash('#/' + path.replace(/^#?\/?/, ''));
export const back = () => backHash();

export type Layout = 'mobile' | 'tablet' | 'desktop';
const q = (px: number) => window.matchMedia(`(min-width: ${px}px)`);
const layoutSub = (cb: () => void) => { const a = q(700); a.addEventListener('change', cb); return () => a.removeEventListener('change', cb); };
const layoutSnap = (): Layout => (q(700).matches ? 'desktop' : 'mobile'); // tablets and computers share one layout: rail + chat list + conversation
export const useLayout = (): Layout => useSyncExternalStore(layoutSub, layoutSnap, () => 'desktop');
const wideSub = (cb: () => void) => { const m = q(1360); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); };
export const useWide = (): boolean => useSyncExternalStore(wideSub, () => q(1360).matches, () => true);
