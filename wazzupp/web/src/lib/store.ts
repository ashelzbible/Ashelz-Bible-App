import { useRef, useSyncExternalStore } from 'react';
import type { CallHistory, CallRec, Community, Contact, Conv, Me, Member, Msg, Notif, StatusGroup } from './types.ts';

export interface State {
  me: Me | null;
  booted: boolean;
  conn: 'connecting' | 'online' | 'offline';
  convs: Record<string, Conv>;
  convOrder: string[];
  msgs: Record<string, { list: Msg[]; hasMore: boolean; loaded: boolean; loadingOlder: boolean }>;
  wm: Record<string, { delivered: number; read: number } | null>;
  members: Record<string, Member[]>;
  typing: Record<string, Record<string, number>>;
  online: Record<string, boolean>;
  lastSeen: Record<string, string | null>;
  contacts: Contact[];
  calls: CallHistory[];
  activeCall: (CallRec & { peerId?: string; incoming?: boolean }) | null;
  statusFeed: StatusGroup[];
  myStatus: any[];
  communities: Community[];
  notifications: Notif[];
  folders: Array<{ id: string; name: string }>;
  mediaUrls: Record<string, { url: string; thumbUrl: string | null; expiresAt: number }>;
  toasts: Array<{ id: number; text: string; kind?: 'error'; action?: { label: string; run: () => void } }>;
  focused: boolean;
}

export const initial: State = {
  me: null, booted: false, conn: 'offline', convs: {}, convOrder: [], msgs: {}, wm: {}, members: {}, typing: {}, online: {}, lastSeen: {}, contacts: [], calls: [], activeCall: null,
  statusFeed: [], myStatus: [], communities: [], notifications: [], folders: [], mediaUrls: {}, toasts: [], focused: true,
};

let state: State = initial;
const listeners = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function resetState() { state = { ...initial, booted: true }; listeners.forEach((l) => l()); }
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

const shallowEq = (a: any, b: any) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is(a[k], b[k]));
};
/** Select a slice of state. Re-renders only when the selected value changes (shallow). */
export function useStore<T>(sel: (s: State) => T): T {
  const last = useRef<T>(undefined as T);
  const get = () => { const n = sel(state); if (last.current !== undefined && shallowEq(last.current, n)) return last.current; last.current = n; return n; };
  return useSyncExternalStore(subscribe, get, get);
}

let toastId = 1;
export function toast(text: string, kind?: 'error', action?: { label: string; run: () => void }) {
  const id = toastId++;
  setState((s) => ({ toasts: [...s.toasts, { id, text, kind, action }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action ? 7000 : 4000);
}

export const sortConvs = (convs: Record<string, Conv>): string[] =>
  Object.values(convs).sort((a, b) => (+b.pinned - +a.pinned) || (+new Date(b.lastMessageAt ?? 0) - +new Date(a.lastMessageAt ?? 0))).map((c) => c.id);
