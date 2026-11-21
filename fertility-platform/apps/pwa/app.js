import { Api, NetworkError } from './lib/api.js';
import { LamportClock } from './vendor/sync-protocol/clock.js';
import { Vault, WrongPasswordError } from './lib/store.js';
import { makeEvent, pendingCount, saveEvent, syncNow } from './lib/sync.js';
import { accountView, chartView, effectiveOn, loginView, nav, todayView, todayLocal } from './lib/view.js';
import { canonicalJson } from './vendor/sync-protocol/canonical.js';

const root = document.getElementById('app');
const state = {
  mode: 'login', tab: 'today', date: todayLocal(), error: '', msg: '', msgKind: 'ok',
  api: new Api(), vault: null, email: null, password: null, user: null,
  events: new Map(), clock: new LamportClock(0), deviceId: null, cursor: 0, predictions: null, lastSync: null,
  online: navigator.onLine, syncing: false,
};

const FORM_FIELDS = ['temp', 'lh', 'e3g', 'pdg'];
const FORM_CHECKS = ['disturbed', 'cycle'];

/** Unsaved edits in the Today form, so a background re-render (sync finished) never wipes what the user is typing. */
function snapshotForm() {
  if (!state.formDirty || !state.vault || state.tab !== 'today') return null;
  const get = (id) => document.getElementById(id);
  if (!get('temp')) return null;
  return {
    values: Object.fromEntries(FORM_FIELDS.map((id) => [id, get(id).value])),
    checks: Object.fromEntries(FORM_CHECKS.map((id) => [id, get(id).checked])),
    mucus: document.querySelector('input[name=mucus]:checked')?.value ?? null,
  };
}

function restoreForm(snap) {
  for (const id of FORM_FIELDS) document.getElementById(id).value = snap.values[id];
  for (const id of FORM_CHECKS) document.getElementById(id).checked = snap.checks[id];
  for (const r of document.querySelectorAll('input[name=mucus]')) r.checked = r.value === snap.mucus;
}

function render() {
  const snap = snapshotForm();
  root.replaceChildren();
  if (!state.vault) { root.append(loginView(state, loginHandlers)); return; }
  const on = { setDate, save, sync: () => runSync(), logout, wipe, dirty: () => { state.formDirty = true; }, tab: (t) => { state.tab = t; state.msg = ''; state.formDirty = false; render(); } };
  root.append(state.tab === 'today' ? todayView(state, on) : state.tab === 'chart' ? chartView(state) : accountView(state, on), nav(state, on));
  if (snap && state.tab === 'today') restoreForm(snap);
}

async function loadLocal(vault, user) {
  state.vault = vault;
  state.events = new Map((await vault.all('events')).map((r) => [r.event.event_id, r]));
  state.deviceId = (await vault.get('kv', 'deviceId')) ?? crypto.randomUUID();
  await vault.put('kv', 'deviceId', state.deviceId);
  state.clock = new LamportClock((await vault.get('kv', 'lamport')) ?? 0);
  state.cursor = (await vault.get('kv', 'cursor')) ?? 0;
  state.predictions = (await vault.get('kv', 'predictions')) ?? null;
  state.lastSync = (await vault.get('kv', 'lastSync')) ?? null;
  state.user = user ?? (await vault.get('kv', 'profile')) ?? null;
  if (user) await vault.put('kv', 'profile', user);
}

const loginHandlers = {
  toggleMode: () => { state.mode = state.mode === 'login' ? 'register' : 'login'; state.error = ''; render(); },
  async submit({ email, password, name }) {
    state.error = '';
    email = email.trim().toLowerCase();
    state.prefillEmail = email; // keep it in the form if sign-in fails
    try {
      if (state.mode === 'register') {
        if (password.length < 10) throw new Error('Password must be at least 10 characters.');
        if (!name.trim()) throw new Error('Please enter your name.');
        const r = await state.api.register(email, password, name.trim());
        if (r.status === 409) throw new Error('An account with this email already exists. Sign in instead.');
        if (!r.ok) throw new Error(r.status === 429 ? 'Too many attempts. Wait a minute.' : 'Could not create the account. Check your details.');
        if (await Vault.exists(email)) await Vault.destroy(email); // stale data from a deleted account
        await finishLogin(await Vault.create(email, password), email, password, { name: name.trim() });
        return;
      }
      const haveLocal = await Vault.exists(email);
      let online = true;
      let r;
      try { r = await state.api.login(email, password); } catch (e) { if (!(e instanceof NetworkError)) throw e; online = false; }
      if (online && r.status === 429) throw new Error('Too many attempts. Wait a minute.');
      if (online && !r.ok) throw new Error('Wrong email or password.');
      if (!online && !haveLocal) throw new Error('You are offline. The first sign-in on a device needs a connection.');
      const vault = haveLocal ? await Vault.unlock(email, password) : await Vault.create(email, password);
      await finishLogin(vault, email, password, null);
    } catch (e) {
      state.error = e instanceof WrongPasswordError ? 'Wrong password for the data on this device.' : e.message || 'Something went wrong.';
      render();
    }
  },
};

async function finishLogin(vault, email, password, user) {
  state.email = email; state.password = password; state.error = '';
  await loadLocal(vault, user);
  state.tab = 'today'; state.date = todayLocal();
  render();
  void runSync();
}

async function runSync({ quiet = false } = {}) {
  if (state.syncing || !state.vault) return;
  state.syncing = true; if (!quiet) render();
  const r = await syncNow(state);
  state.online = !r.offline && navigator.onLine;
  state.syncing = false;
  if (r.pushed > 0) for (const ms of [1500, 4000, 9000]) setTimeout(() => { if (state.vault && !state.syncing) void runSync({ quiet: true }); }, ms); // pick up fresh predictions
  if (state.vault) { const keep = document.activeElement?.id; render(); if (keep) document.getElementById(keep)?.focus(); }
}

function setDate(d) { if (d) { state.date = d; state.msg = ''; state.formDirty = false; render(); } }

async function save(v) {
  const date = state.date;
  const eff = effectiveOn(state, date);
  const changes = [];
  const want = (kind, payload) => { // SET only when it differs from what is stored for this date
    if (canonicalJson(eff[kind]?.payload ?? null) !== canonicalJson(payload)) changes.push(['SET', kind, payload]);
  };
  const clear = (kind) => { if (eff[kind]) changes.push(['RETRACT', kind]); };

  try {
    if (v.temp !== undefined) {
      if (!(v.temp >= 34 && v.temp <= 42)) throw new Error('Temperature must be between 34 and 42 °C.');
      want('BBT', { temp_c: v.temp, sleep_disrupted: v.disturbed });
    } else clear('BBT');
    const hor = {};
    for (const [k, key] of [['lh', 'lh_miu_ml'], ['e3g', 'e3g_ng_ml'], ['pdg', 'pdg_ug_ml']]) {
      if (v[k] !== undefined) {
        if (!(Number.isFinite(v[k]) && v[k] >= 0 && v[k] <= 100000)) throw new Error('Hormone values must be positive numbers.');
        hor[key] = v[k];
      }
    }
    if (Object.keys(hor).length) want('HORMONE', hor); else clear('HORMONE');
    if (v.mucus !== undefined) want('MUCUS', { score: Number(v.mucus) }); // a score is never cleared by leaving it blank
    if (v.cycle) want('CYCLE', {}); else clear('CYCLE');
    if (changes.length === 0) { state.msg = 'Nothing changed.'; state.msgKind = 'ok'; state.formDirty = false; render(); return; }
    for (const [op, kind, payload] of changes) await saveEvent(state, makeEvent(state, kind, op, date, payload), true);
    state.msg = navigator.onLine ? 'Saved.' : 'Saved on this device. It will sync when you are back online.'; state.msgKind = 'ok';
    state.formDirty = false;
    render();
    void runSync({ quiet: true });
  } catch (e) {
    state.msg = e.message; state.msgKind = 'error'; render();
  }
}

function logout() {
  state.vault?.close();
  Object.assign(state, { vault: null, password: null, api: new Api(), events: new Map(), predictions: null, user: null, error: '' });
  render();
}

async function wipe() {
  const n = pendingCount(state);
  const warn = n > 0 ? `${n} entries have not synced yet and will be lost. ` : '';
  if (!confirm(`${warn}Delete all data stored on this device? Synced data stays on the server.`)) return;
  const email = state.email;
  state.vault.close();
  await Vault.destroy(email);
  logout();
}

window.addEventListener('online', () => { state.online = true; void runSync({ quiet: true }); });
window.addEventListener('offline', () => { state.online = false; if (state.vault) render(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void runSync({ quiet: true }); });
setInterval(() => { if (state.vault && navigator.onLine) void runSync({ quiet: true }); }, 60_000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* app still works online */ });
render();
