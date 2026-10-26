import { getState, setState } from './store.ts';
import { applyEvent, flushOutbox, lastEventId, loadConversations, resyncOpenThreads, restoreOutbox, saveEventId } from './actions.ts';
import { getToken } from './api.ts';

/** WebSocket manager: authenticates with the session token, replays missed events after reconnects, de-duplicates by event id. */
class Realtime {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private pongAt = 0;
  private stopped = true;
  private seen = new Set<number>();
  private typingTicker: ReturnType<typeof setInterval> | null = null;
  signalHandlers = new Set<(m: any) => void>();
  ackHandlers = new Map<string, (c: any) => void>();

  start() {
    this.stopped = false;
    restoreOutbox();
    window.addEventListener('online', this.nudge);
    document.addEventListener('visibilitychange', this.nudge);
    window.addEventListener('focus', this.onFocus); window.addEventListener('blur', this.onBlur);
    if (!this.typingTicker) this.typingTicker = setInterval(this.expireTyping, 1500);
    this.connect();
  }
  stop() {
    this.stopped = true;
    window.removeEventListener('online', this.nudge); document.removeEventListener('visibilitychange', this.nudge);
    window.removeEventListener('focus', this.onFocus); window.removeEventListener('blur', this.onBlur);
    if (this.timer) clearTimeout(this.timer); if (this.ping) clearInterval(this.ping); if (this.typingTicker) clearInterval(this.typingTicker);
    this.typingTicker = null; this.ws?.close(); this.ws = null; this.seen.clear();
  }
  private onFocus = () => setState({ focused: true });
  private onBlur = () => setState({ focused: false });
  private nudge = () => { if (!this.stopped && (!this.ws || this.ws.readyState > 1)) { this.attempt = 0; this.connect(); } };

  send(m: unknown): boolean { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(m)); return true; } return false; }

  private connect() {
    if (this.stopped || (this.ws && this.ws.readyState <= 1)) return;
    setState({ conn: this.attempt === 0 && getState().conn === 'online' ? 'online' : 'connecting' });
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'auth', token: getToken(), lastEventId: lastEventId() || undefined })); };
    ws.onmessage = (e) => { try { this.onMessage(JSON.parse(e.data)); } catch { /* ignore malformed */ } };
    ws.onclose = (e) => {
      if (this.ping) clearInterval(this.ping);
      setState({ conn: 'offline' });
      if (this.stopped) return;
      if (e.code === 4001 || e.code === 4401) { void import('./actions.ts').then((a) => a.logout(false)); return; }
      const delay = Math.min(30000, 800 * 2 ** this.attempt++) * (0.7 + Math.random() * 0.6);
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  private async onMessage(m: any) {
    switch (m.t) {
      case 'ready': {
        this.attempt = 0; this.pongAt = Date.now();
        setState((s) => ({ conn: 'online', online: Object.fromEntries((m.online as string[]).map((id) => [id, true])), ...(s.me ? {} : {}) }));
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => { if (Date.now() - this.pongAt > 70_000) { this.ws?.close(); return; } this.send({ t: 'ping' }); }, 25_000);
        if (!lastEventId()) saveEventId(m.latestEventId);
        if (m.resync || !lastEventId()) { await resyncOpenThreads(); if (m.resync) saveEventId(m.latestEventId); } else await loadConversations();
        void flushOutbox();
        break;
      }
      case 'pong': this.pongAt = Date.now(); break;
      case 'event': {
        if (this.seen.has(m.id)) break;
        this.seen.add(m.id); if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
        applyEvent(m.type, m.payload);
        if (m.id > lastEventId()) saveEventId(m.id);
        break;
      }
      case 'typing':
        setState((s) => ({ typing: { ...s.typing, [m.conversationId]: { ...(s.typing[m.conversationId] ?? {}), [m.userId]: m.state === 'paused' ? 0 : Date.now() + 6000 } } }));
        break;
      case 'presence':
        setState((s) => ({ online: { ...s.online, [m.userId]: m.online }, lastSeen: m.online ? s.lastSeen : { ...s.lastSeen, [m.userId]: m.lastSeenAt } }));
        break;
      case 'call.signal': this.signalHandlers.forEach((h) => h(m)); break;
      case 'call.ack': { const h = this.ackHandlers.get(m.reqId); if (h) { h(m.call); this.ackHandlers.delete(m.reqId); } break; }
      case 'error': break;
    }
  }
  private expireTyping = () => {
    const now = Date.now(); const t = getState().typing; let changed = false; const next: typeof t = {};
    for (const [c, users] of Object.entries(t)) { const keep = Object.fromEntries(Object.entries(users).filter(([, exp]) => exp > now)); if (Object.keys(keep).length !== Object.keys(users).length) changed = true; if (Object.keys(keep).length) next[c] = keep; }
    if (changed) setState({ typing: next });
  };
}
export const realtime = new Realtime();
