import { Api, NetworkError, detectServerMode, getServerUrl, isNative, normalizeServerUrl, setServerUrl } from './lib/api.js';
import { LamportClock } from './vendor/sync-protocol/clock.js';
import { canonicalJson } from './vendor/sync-protocol/canonical.js';
import { Vault, WrongPasswordError } from './lib/store.js';
import { makeEvent, markAllPending, pendingCount, saveEvent, syncNow } from './lib/sync.js';
import { computePredictions, DEFAULT_PROFILE, getProfile } from './lib/engine/index.js';
import { accountView, chartView, effectiveOn, loginView, nav, todayView, todayLocal } from './lib/view.js';

const root = document.getElementById('app');
const state = {
  mode: 'login', tab: 'today', date: todayLocal(), error: '', msg: '', msgKind: 'ok', syncError: '',
  api: new Api(), vault: null, email: null, password: null, user: null,
  events: new Map(), clock: new LamportClock(0), deviceId: null, cursor: 0, predictions: null, lastSync: null,
  online: navigator.onLine, syncing: false,
  native: isNative(), serverMode: 'none', prefillServer: getServerUrl(),
  cloud: false, // does this account sync with a server? Device-only accounts never touch the network.
  profileName: DEFAULT_PROFILE.name,
};

// ---- rendering -------------------------------------------------------------------------------------------------
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
  const on = {
    setDate, save, sync: () => runSync(), logout, wipe, enableSync, setProfile,
    dirty: () => { state.formDirty = true; },
    tab: (t) => { state.tab = t; state.msg = ''; state.syncError = ''; state.formDirty = false; render(); },
  };
  root.append(state.tab === 'today' ? todayView(state, on) : state.tab === 'chart' ? chartView(state) : accountView(state, on), nav(state, on));
  if (snap && state.tab === 'today') restoreForm(snap);
}

/** Recompute the fertility timeline on this device from the stored events (identical to the server's engine). */
function recompute() {
  try {
    state.predictions = computePredictions([...state.events.values()].map((r) => r.event), state.profileName) ?? state.predictions;
  } catch (e) {
    state.predictions = null; // e.g. data spanning more than a year: show nothing rather than something wrong
  }
}

// ---- local state -----------------------------------------------------------------------------------------------
async function loadLocal(vault, user) {
  state.vault = vault;
  state.events = new Map((await vault.all('events')).map((r) => [r.event.event_id, r]));
  state.deviceId = (await vault.get('kv', 'deviceId')) ?? crypto.randomUUID();
  await vault.put('kv', 'deviceId', state.deviceId);
  state.clock = new LamportClock((await vault.get('kv', 'lamport')) ?? 0);
  state.cursor = (await vault.get('kv', 'cursor')) ?? 0;
  state.lastSync = (await vault.get('kv', 'lastSync')) ?? null;
  state.user = user ?? (await vault.get('kv', 'profile')) ?? null;
  if (user) await vault.put('kv', 'profile', user);
  const saved = await vault.get('kv', 'profileName');
  state.profileName = saved && safeProfile(saved) ? saved : DEFAULT_PROFILE.name;
  recompute();
}

function safeProfile(name) { try { return getProfile(name); } catch { return null; } }

async function setProfile(name) {
  if (!safeProfile(name)) return;
  state.profileName = name;
  await state.vault.put('kv', 'profileName', name);
  recompute();
  render();
}

// ---- sign in / create account ------------------------------------------------------------------------------------
const loginHandlers = {
  toggleMode: () => { state.mode = state.mode === 'login' ? 'register' : 'login'; state.error = ''; render(); },

  async submit({ email, password, name, server, sync }) {
    state.error = '';
    email = email.trim().toLowerCase();
    state.prefillEmail = email; // keep it in the form if sign-in fails
    state.prefillSync = sync;
    try {
      const wantServer = state.mode === 'register' ? sync && state.serverMode !== 'none' : false;
      if (state.native && (wantServer || (state.mode === 'login' && server.trim()))) {
        const url = normalizeServerUrl(server);
        if (!url) throw new Error('That server address does not look right. Example: https://your-server.example.com');
        setServerUrl(url); state.prefillServer = url;
      }
      if (state.mode === 'register') await createAccount({ email, password, name: name.trim(), wantServer });
      else await signIn({ email, password });
    } catch (e) {
      state.error = e instanceof WrongPasswordError ? 'Wrong password for the data on this device.' : e.message || 'Something went wrong.';
      render();
    }
  },
};

async function createAccount({ email, password, name, wantServer }) {
  if (password.length < 10) throw new Error('Password must be at least 10 characters.');
  if (!name) throw new Error('Please enter your name.');
  if (wantServer) {
    const r = await state.api.register(email, password, name).catch((e) => { if (e instanceof NetworkError) throw new Error('Could not reach the server. Check the address and your connection, or untick sync to use this device only.'); throw e; });
    if (r.status === 409) throw new Error('An account with this email already exists on the server. Sign in instead.');
    if (!r.ok) throw new Error(r.status === 429 ? 'Too many attempts. Wait a minute.' : 'Could not create the account. Check your details.');
    if (await Vault.exists(email)) await Vault.destroy(email); // stale data from a deleted account
  } else if (await Vault.exists(email)) {
    throw new Error('An account with this email already exists on this device. Sign in instead.');
  }
  const vault = await Vault.create(email, password);
  await vault.put('kv', 'cloud', wantServer);
  await finishLogin(vault, email, password, { name }, wantServer);
}

async function signIn({ email, password }) {
  if (await Vault.exists(email)) {
    const vault = await Vault.unlock(email, password); // the device holds the truth: this works with no connection
    const stored = await vault.get('kv', 'cloud');
    const cloud = stored === undefined ? state.serverMode !== 'none' : stored; // accounts made before device-only mode synced
    if (cloud) { try { await state.api.login(email, password); } catch (e) { if (!(e instanceof NetworkError)) throw e; } }
    await finishLogin(vault, email, password, null, cloud);
    return;
  }
  // No data for this email on this phone: a synced account can be opened here by signing in to its server.
  if (state.serverMode === 'none' || (state.native && !getServerUrl())) {
    throw new Error('No account with this email on this device. Create one first.');
  }
  let r;
  try { r = await state.api.login(email, password); } catch (e) {
    if (e instanceof NetworkError) throw new Error('You are offline. Signing in to a synced account on a new phone needs a connection.');
    throw e;
  }
  if (r.status === 429) throw new Error('Too many attempts. Wait a minute.');
  if (!r.ok) throw new Error('Wrong email or password.');
  const vault = await Vault.create(email, password);
  await vault.put('kv', 'cloud', true);
  await finishLogin(vault, email, password, null, true);
}

async function finishLogin(vault, email, password, user, cloud) {
  state.email = email; state.password = password; state.error = ''; state.cloud = cloud;
  await loadLocal(vault, user);
  state.tab = 'today'; state.date = todayLocal();
  render();
  if (state.cloud) void runSync();
}

// ---- syncing (synced accounts only) --------------------------------------------------------------------------------
async function runSync({ quiet = false } = {}) {
  if (!state.cloud || state.syncing || !state.vault) return;
  state.syncing = true; if (!quiet) render();
  const r = await syncNow(state);
  state.online = !r.offline && navigator.onLine;
  state.syncing = false;
  if (state.vault) { recompute(); const keep = document.activeElement?.id; render(); if (keep) document.getElementById(keep)?.focus(); }
}

async function enableSync(serverInput) {
  state.syncError = '';
  try {
    if (state.native) {
      const url = normalizeServerUrl(serverInput);
      if (!url) throw new Error('Enter the server address, for example https://your-server.example.com');
      setServerUrl(url); state.prefillServer = url;
    }
    let r = await state.api.register(state.email, state.password, state.user?.name ?? 'Me').catch((e) => { if (e instanceof NetworkError) throw new Error('Could not reach the server.'); throw e; });
    if (r.status === 409) r = await state.api.login(state.email, state.password); // already registered there with the same password
    if (!r.ok) throw new Error(r.status === 401 ? 'That email already has a different password on the server.' : r.status === 429 ? 'Too many attempts. Wait a minute.' : 'The server did not accept this account.');
    state.cloud = true;
    await state.vault.put('kv', 'cloud', true);
    await markAllPending(state); // upload everything entered so far
    render();
    void runSync();
  } catch (e) {
    state.syncError = e.message; render();
  }
}

// ---- logging a day ---------------------------------------------------------------------------------------------------
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
    // synced accounts queue events for upload; device-only accounts keep them and never send anything
    for (const [op, kind, payload] of changes) await saveEvent(state, makeEvent(state, kind, op, date, payload), state.cloud);
    recompute();
    state.msg = !state.cloud ? 'Saved on this device.' : navigator.onLine ? 'Saved.' : 'Saved on this device. It will sync when you are back online.'; state.msgKind = 'ok';
    state.formDirty = false;
    render();
    void runSync({ quiet: true });
  } catch (e) {
    state.msg = e.message; state.msgKind = 'error'; render();
  }
}

// ---- lock / wipe ---------------------------------------------------------------------------------------------------------
function logout() {
  state.vault?.close();
  Object.assign(state, { vault: null, password: null, api: new Api(), events: new Map(), predictions: null, user: null, error: '', cloud: false });
  render();
}

async function wipe() {
  const n = state.cloud ? pendingCount(state) : state.events.size;
  const warn = state.cloud
    ? (n > 0 ? `${n} entries have not synced yet and will be lost. ` : '')
    : 'This account exists only on this device, so every entry will be lost for good. ';
  if (!confirm(`${warn}Delete all data stored on this device?${state.cloud ? ' Synced data stays on the server.' : ''}`)) return;
  const email = state.email;
  state.vault.close();
  await Vault.destroy(email);
  logout();
}

// ---- start ------------------------------------------------------------------------------------------------------------------
window.addEventListener('online', () => { state.online = true; void runSync({ quiet: true }); });
window.addEventListener('offline', () => { state.online = false; if (state.vault) render(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void runSync({ quiet: true }); });
setInterval(() => { if (state.vault && state.cloud && navigator.onLine) void runSync({ quiet: true }); }, 60_000);

if (!state.native && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* app still works online */ });
state.serverMode = await detectServerMode();
render();
