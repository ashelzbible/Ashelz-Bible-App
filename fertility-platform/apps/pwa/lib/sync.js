import { NetworkError } from './api.js';

const PUSH_BATCH = 500;

/** Wire format of a locally created event (what the server's strict schema accepts). */
export function makeEvent(state, kind, op, logDate, payload) {
  const ev = {
    event_id: crypto.randomUUID(),
    device_id: state.deviceId,
    lamport: state.clock.tick(),
    client_ts: new Date().toISOString(),
    kind,
    op,
    log_date: logDate,
  };
  if (op === 'SET') ev.payload = payload;
  return ev;
}

export async function saveEvent(state, ev, pending) {
  state.events.set(ev.event_id, { event: ev, pending });
  await state.vault.put('events', ev.event_id, { event: ev, pending });
  await state.vault.put('kv', 'lamport', state.clock.now);
}

export const pendingCount = (state) => [...state.events.values()].filter((r) => r.pending).length;

async function withAuth(state, call) {
  if (!state.api.token && state.password) await state.api.login(state.email, state.password); // unlocked offline: no token yet
  let r = await call();
  if (r.status === 401 && state.password) {
    const l = await state.api.login(state.email, state.password); // token expired: sign in again silently
    if (l.ok) r = await call();
  }
  return r;
}

/**
 * Push every pending event (idempotent: retries are safe), then pull everything after the stored cursor.
 * Returns { pushed, pulled, offline, error }.
 */
export async function syncNow(state) {
  const out = { pushed: 0, pulled: 0, offline: false, error: null };
  try {
    const pending = [...state.events.values()].filter((r) => r.pending).sort((a, b) => a.event.lamport - b.event.lamport);
    for (let i = 0; i < pending.length; i += PUSH_BATCH) {
      const batch = pending.slice(i, i + PUSH_BATCH);
      const r = await withAuth(state, () => state.api.push(batch.map((b) => b.event)));
      if (!r.ok) { out.error = `push failed (${r.status})`; return out; }
      const done = new Set([...r.json.accepted, ...r.json.duplicates]);
      for (const b of batch) {
        if (done.has(b.event.event_id)) { await saveEvent(state, b.event, false); out.pushed++; }
      }
      state.clock.observe(r.json.server_lamport);
    }
    for (let guard = 0; guard < 100; guard++) {
      const r = await withAuth(state, () => state.api.pull(state.cursor));
      if (!r.ok) { out.error = `pull failed (${r.status})`; return out; }
      for (const ev of r.json.events) {
        const { server_seq: _s, ...wire } = ev;
        if (!state.events.has(wire.event_id) || state.events.get(wire.event_id).pending) await saveEvent(state, wire, false);
        out.pulled++;
      }
      state.cursor = r.json.next_cursor;
      state.clock.observe(r.json.server_lamport);
      await state.vault.put('kv', 'cursor', state.cursor);
      await state.vault.put('kv', 'lamport', state.clock.now);
      if (!r.json.has_more) {
        if (r.json.predictions) { state.predictions = r.json.predictions; await state.vault.put('kv', 'predictions', state.predictions); }
        break;
      }
    }
    state.lastSync = new Date().toISOString();
    await state.vault.put('kv', 'lastSync', state.lastSync);
  } catch (e) {
    if (e instanceof NetworkError) out.offline = true; else out.error = 'unexpected sync error';
  }
  return out;
}
