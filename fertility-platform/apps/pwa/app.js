import { Api, NetworkError, detectServerMode, getServerUrl, isNative, normalizeServerUrl, setServerUrl } from './lib/api.js';
import { LamportClock } from './vendor/sync-protocol/clock.js';
import { canonicalJson } from './vendor/sync-protocol/canonical.js';
import { Vault, WrongPasswordError } from './lib/store.js';
import { makeEvent, markAllPending, pendingCount, saveEvent, syncNow } from './lib/sync.js';
import { analyzeBbt } from './lib/engine/engine.js';
import { computePredictions, DEFAULT_PROFILE, getProfile } from './lib/engine/index.js';
import { cycleList, effective, lengthStats, periodDays } from './lib/domain/cycles.js';
import { DEFAULTS, forecast } from './lib/domain/forecast.js';
import { addDays, todayLocal } from './lib/domain/dates.js';
import { decimalsFor, fromDisplay, stepFor, toDisplay, unitLabel } from './lib/domain/units.js';
import { applyReminder } from './lib/notify.js';
import { loginView } from './lib/ui/login.js';
import { tabs } from './lib/ui/kit.js';
import { homeView } from './lib/ui/home.js';
import { calendarView } from './lib/ui/calendar.js';
import { chartsView } from './lib/ui/charts.js';
import { historyView } from './lib/ui/history.js';
import { settingsView, settingsSub } from './lib/ui/settings.js';
import { hormonesView, logView } from './lib/ui/log.js';

export const APP_VERSION = '1.2';
const root = document.getElementById('app');
const t0 = todayLocal();
const defaultPrefs = () => ({ unit: 'C', ...DEFAULTS, reminder: { enabled: false, time: '20:00' } });

const state = {
  mode: 'login', error: '', syncError: '', settingsMsg: '', settingsMsgKind: 'ok',
  route: { tab: 'home', screen: null, params: {} },
  api: new Api(), vault: null, email: null, password: null, user: null,
  events: new Map(), clock: new LamportClock(0), deviceId: null, cursor: 0, predictions: null, lastSync: null,
  online: navigator.onLine, syncing: false,
  native: isNative(), serverMode: 'none', prefillServer: getServerUrl(),
  cloud: false, profileName: DEFAULT_PROFILE.name, version: APP_VERSION,
  prefs: defaultPrefs(),
  cal: { y: Number(t0.slice(0, 4)), m: Number(t0.slice(5, 7)) - 1 },
  chart: { range: '1M', from: '', to: '', selected: null },
  draft: null, draftH: null, derived: null,
};
state.derived = deriveNothing();

function deriveNothing() {
  return { today: todayLocal(), eff: [], cycles: [], stats: lengthStats([]), fc: null, period: new Set(), engineDays: new Map(), ovulationConfirmedOn: null, ovulationDay: null, lhResult: () => 'Not Tested' };
}

// ---- derived data ---------------------------------------------------------------------------------------------------
/** Recompute everything shown from the stored entries: the engine's daily results plus cycle history and estimates. */
function recompute() {
  const events = [...state.events.values()].map((r) => r.event);
  try { state.predictions = computePredictions(events, state.profileName); } catch { state.predictions = null; }
  const today = todayLocal();
  const eff = effective(events);
  const cycles = cycleList(eff, today);
  const engineDays = new Map((state.predictions?.days ?? []).map((d) => [d.log_date, d]));
  const confirmedOn = state.predictions?.ovulation_confirmed_on ?? null;
  let ovulationDay = null;
  const cur = cycles[cycles.length - 1];
  if (confirmedOn && cur) {
    const bbt = eff.filter((e) => e.kind === 'BBT' && e.log_date >= cur.start && e.payload?.temp_c !== undefined)
      .map((e) => ({ day: e.log_date, temp_c: Number(e.payload.temp_c), sleep_disrupted: e.payload.sleep_disrupted === true }));
    const r = analyzeBbt(bbt);
    ovulationDay = r.status === 'SHIFT_CONFIRMED' ? r.ovulation_window[1] : null;
  }
  state.derived = {
    today, eff, cycles, stats: lengthStats(cycles), fc: forecast(cycles, state.prefs, today), period: periodDays(eff), engineDays,
    ovulationConfirmedOn: confirmedOn, ovulationDay,
    /** LH chip for the Log screen: derived from the entered LH value and the engine's reading of it. */
    lhResult(date) {
      const h = eff.find((e) => e.kind === 'HORMONE' && e.log_date === date);
      if (typeof h?.payload?.lh_miu_ml !== 'number') return 'Not Tested';
      return engineDays.get(date)?.flags.includes('LH_SURGE') ? 'Positive' : 'Negative';
    },
  };
}

const effectiveOn = (date) => Object.fromEntries(state.derived.eff.filter((e) => e.log_date === date).map((e) => [e.kind, e]));

// ---- rendering ---------------------------------------------------------------------------------------------------------
function render({ keepScroll = true } = {}) {
  const y = window.scrollY;
  root.replaceChildren();
  state.pendingRender = false;
  if (!state.vault) { root.append(loginView(state, loginHandlers)); window.scrollTo(0, keepScroll ? y : 0); return; }
  const r = state.route;
  let view;
  if (r.screen === 'log') view = logView(state, actions);
  else if (r.screen === 'hormones') view = hormonesView(state, actions);
  else if (r.screen?.startsWith('settings/')) view = settingsSub(state, actions);
  else view = { home: homeView, charts: chartsView, calendar: calendarView, history: historyView, settings: settingsView }[r.tab](state, actions);
  root.append(view, tabs(state, actions));
  window.scrollTo(0, keepScroll ? y : 0);
}

/** Re-render after background work, but never while the user is typing in a field (that would drop focus). */
function renderSoon() {
  const a = document.activeElement;
  if (a && root.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox') { state.pendingRender = true; return; }
  render();
}
document.addEventListener('focusout', () => { if (state.pendingRender) setTimeout(() => { if (state.pendingRender) render(); }, 0); });

// ---- local state ----------------------------------------------------------------------------------------------------------
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
  const prefs = (await vault.get('kv', 'prefs')) ?? {};
  state.prefs = { ...defaultPrefs(), ...prefs, reminder: { ...defaultPrefs().reminder, ...(prefs.reminder ?? {}) } };
  state.route = { tab: 'home', screen: null, params: {} };
  const n = new Date(); state.cal = { y: n.getFullYear(), m: n.getMonth() };
  state.chart = { range: '1M', from: '', to: '', selected: null };
  state.draft = null; state.draftH = null;
  recompute();
}

function safeProfile(name) { try { return getProfile(name); } catch { return null; } }
const savePrefs = () => state.vault.put('kv', 'prefs', state.prefs);

// ---- sign in / create account -----------------------------------------------------------------------------------------------
const loginHandlers = {
  toggleMode: () => { state.mode = state.mode === 'login' ? 'register' : 'login'; state.error = ''; render(); },
  toggleServer: () => { state.showServer = !state.showServer; render(); },

  async submit({ email, password, name, server, sync }) {
    state.error = '';
    email = email.trim().toLowerCase();
    state.prefillEmail = email; // keep it in the form if sign-in fails
    state.prefillSync = sync;
    try {
      const wantServer = state.mode === 'register' ? sync && state.serverMode !== 'none' : false;
      if (state.native && (wantServer || (state.mode === 'login' && state.showServer && server.trim()))) {
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
    throw new Error(state.native ? 'No account with this email on this phone. Create one, or use "Sign in to a synced account from another phone".' : 'No account with this email on this device. Create one first.');
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
  render({ keepScroll: false });
  if (state.cloud) void runSync();
}

// ---- syncing (synced accounts only) ---------------------------------------------------------------------------------------------
async function runSync({ quiet = false } = {}) {
  if (!state.cloud || state.syncing || !state.vault) return;
  state.syncing = true; if (!quiet) render();
  const r = await syncNow(state);
  state.online = !r.offline && navigator.onLine;
  state.syncing = false;
  if (state.vault) { recompute(); renderSoon(); }
}

// ---- actions used by the screens -----------------------------------------------------------------------------------------------------
function makeDraft(date) {
  const eff = effectiveOn(date), unit = state.prefs.unit;
  return {
    date, period: !!eff.PERIOD, tempText: eff.BBT ? String(toDisplay(eff.BBT.payload.temp_c, unit)) : '', disturbed: eff.BBT?.payload?.sleep_disrupted === true,
    mucus: typeof eff.MUCUS?.payload?.score === 'number' ? eff.MUCUS.payload.score : null, symptoms: new Set(eff.SYMPTOMS?.payload?.tags ?? []), msg: '', msgKind: 'ok',
  };
}
function makeDraftH(date) {
  const p = effectiveOn(date).HORMONE?.payload ?? {};
  const t = (v) => (typeof v === 'number' ? String(v) : '');
  return { date, lh: t(p.lh_miu_ml), e3g: t(p.e3g_ng_ml), pdg: t(p.pdg_ug_ml), msg: '', msgKind: 'ok' };
}

/** SET only when different from what is stored; returns the events to write. */
function diff(eff, kind, payload) { return canonicalJson(eff[kind]?.payload ?? null) !== canonicalJson(payload) ? [['SET', kind, payload]] : []; }

async function writeChanges(date, changes) {
  for (const [op, kind, payload] of changes) await saveEvent(state, makeEvent(state, kind, op, date, payload), state.cloud);
  recompute();
  void runSync({ quiet: true });
}

const actions = {
  tab(t) { state.route = { tab: t, screen: null, params: {} }; state.settingsMsg = ''; state.chart.selected = null; render({ keepScroll: false }); },
  open(screen, params = {}) {
    state.settingsMsg = ''; state.syncError = '';
    state.route = { tab: screen === null || screen?.startsWith('settings') ? 'settings' : state.route.tab, screen, params };
    if (screen === 'hormones') state.draftH = makeDraftH(params.date ?? todayLocal());
    render({ keepScroll: false });
  },
  back() { state.route = { tab: state.route.screen?.startsWith('settings/') ? 'settings' : state.route.tab, screen: null, params: {} }; render({ keepScroll: false }); },
  openLog({ focus, date } = {}) { state.draft = makeDraft(date ?? todayLocal()); state.route = { tab: state.route.tab, screen: 'log', params: { focus } }; render({ keepScroll: false }); },
  dayTap(iso) { if (iso <= todayLocal()) actions.openLog({ date: iso }); },
  month(delta) { const d = new Date(state.cal.y, state.cal.m + delta, 1); state.cal = { y: d.getFullYear(), m: d.getMonth() }; render(); },
  range(k) { state.chart.range = k; state.chart.selected = null; render(); },
  customRange(from, to) { if (from) state.chart.from = from; if (to) state.chart.to = to; state.chart.selected = null; render(); },
  selectDate(date) { state.chart.selected = state.chart.selected === date ? null : date; render(); },

  // log screen
  draft(patch, rerender = true) { Object.assign(state.draft, patch, { msg: '' }); if (rerender) render(); },
  stepTemp(dir) {
    const unit = state.prefs.unit, cur = Number(state.draft.tempText);
    const base = Number.isFinite(cur) && state.draft.tempText.trim() !== '' ? cur : toDisplay(36.5, unit);
    state.draft.tempText = String(Number((base + dir * stepFor(unit)).toFixed(decimalsFor(unit))));
    state.draft.msg = ''; render();
  },
  setLogDate(date) { if (date && date <= todayLocal()) { state.draft = makeDraft(date); render(); } },
  toggleSymptom(id) { const s = state.draft.symptoms; if (s.has(id)) s.delete(id); else s.add(id); state.draft.msg = ''; render(); },
  help() { alert('Log what you noticed this morning. Period: yes on each day you bleed. Temperature: before getting up. Mucus: the most fertile type you saw. Symptoms are optional. Hormone values go on the Hormones screen.'); },
  async saveDay() {
    const dr = state.draft, date = dr.date, eff = effectiveOn(date), unit = state.prefs.unit, changes = [];
    try {
      if (dr.period && !eff.PERIOD) changes.push(['SET', 'PERIOD', {}]); else if (!dr.period && eff.PERIOD) changes.push(['RETRACT', 'PERIOD']);
      if (dr.tempText.trim() !== '') {
        const c = fromDisplay(Number(dr.tempText), unit);
        if (!Number.isFinite(c) || !(c >= 34 && c <= 42)) throw new Error(`That temperature does not look right (expected ${toDisplay(34, unit)}–${toDisplay(42, unit)} ${unitLabel(unit)}).`);
        changes.push(...diff(eff, 'BBT', { temp_c: c, sleep_disrupted: dr.disturbed }));
      } else if (eff.BBT) changes.push(['RETRACT', 'BBT']);
      if (dr.mucus !== null) changes.push(...diff(eff, 'MUCUS', { score: dr.mucus })); else if (eff.MUCUS) changes.push(['RETRACT', 'MUCUS']);
      const tags = [...dr.symptoms].sort();
      if (tags.length) changes.push(...diff(eff, 'SYMPTOMS', { tags })); else if (eff.SYMPTOMS) changes.push(['RETRACT', 'SYMPTOMS']);
      if (!changes.length) { dr.msg = 'Nothing changed.'; dr.msgKind = 'ok'; render(); return; }
      await writeChanges(date, changes);
      dr.msg = !state.cloud ? 'Saved on this device.' : navigator.onLine ? 'Saved.' : 'Saved on this device. It will sync when you are back online.'; dr.msgKind = 'ok';
      render();
    } catch (e) { dr.msg = e.message; dr.msgKind = 'error'; render(); }
  },

  // hormones screen
  setHormoneDate(date) { if (date && date <= todayLocal()) { state.draftH = makeDraftH(date); render(); } },
  async saveHormones() {
    const dr = state.draftH, eff = effectiveOn(dr.date), payload = {};
    try {
      for (const [k, key] of [['lh', 'lh_miu_ml'], ['e3g', 'e3g_ng_ml'], ['pdg', 'pdg_ug_ml']]) {
        if (dr[k].trim() === '') continue;
        const v = Number(dr[k]);
        if (!(Number.isFinite(v) && v >= 0 && v <= 100000)) throw new Error('Hormone values must be positive numbers.');
        payload[key] = v;
      }
      const changes = Object.keys(payload).length ? diff(eff, 'HORMONE', payload) : eff.HORMONE ? [['RETRACT', 'HORMONE']] : [];
      if (!changes.length) { dr.msg = 'Nothing changed.'; dr.msgKind = 'ok'; render(); return; }
      await writeChanges(dr.date, changes);
      dr.msg = state.cloud && !navigator.onLine ? 'Saved on this device. It will sync when you are back online.' : state.cloud ? 'Saved.' : 'Saved on this device.'; dr.msgKind = 'ok';
      render();
    } catch (e) { dr.msg = e.message; dr.msgKind = 'error'; render(); }
  },

  // settings
  async setPref(patch, check) {
    state.settingsMsg = '';
    if (check) {
      const v = patch[check.key];
      if (!Number.isInteger(v) || v < check.min || v > check.max) { state.settingsMsg = `Enter a whole number from ${check.min} to ${check.max}.`; state.settingsMsgKind = 'error'; render(); return; }
    }
    state.prefs = { ...state.prefs, ...patch };
    await savePrefs();
    if ('unit' in patch) state.draft = null;
    recompute(); state.settingsMsg = 'Saved.'; state.settingsMsgKind = 'ok'; render();
  },
  async setProfile(name) {
    if (!safeProfile(name)) return;
    state.profileName = name; await state.vault.put('kv', 'profileName', name);
    recompute(); render();
  },
  async saveName(name) {
    name = name.trim();
    if (!name) { state.settingsMsg = 'Please enter your name.'; state.settingsMsgKind = 'error'; render(); return; }
    state.user = { ...(state.user ?? {}), name }; await state.vault.put('kv', 'profile', state.user);
    state.settingsMsg = 'Saved.'; state.settingsMsgKind = 'ok'; render();
  },
  async setReminder(enabled, time) {
    state.prefs = { ...state.prefs, reminder: { enabled, time: time || '20:00' } }; await savePrefs();
    const r = await applyReminder(state.prefs.reminder);
    state.settingsMsgKind = r.ok ? 'ok' : 'error';
    state.settingsMsg = r.ok ? (enabled ? `Reminder set for ${state.prefs.reminder.time} every day.` : 'Reminder off.')
      : r.reason === 'unsupported' ? 'Saved. Reminders only work in the Android app.' : r.reason === 'denied' ? 'Notifications are blocked. Allow them for this app in Android settings.' : 'Could not set the reminder.';
    if (r.reason === 'unsupported') state.settingsMsgKind = 'ok';
    render();
  },
  async enableSync(serverInput) {
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
    } catch (e) { state.syncError = e.message; render(); }
  },
  sync: () => runSync(),
  logout,
  wipe,
};

// ---- lock / wipe ----------------------------------------------------------------------------------------------------------------------
function logout() {
  state.vault?.close();
  Object.assign(state, { vault: null, password: null, api: new Api(), events: new Map(), predictions: null, user: null, error: '', cloud: false, draft: null, draftH: null });
  state.derived = deriveNothing();
  render({ keepScroll: false });
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

// ---- start ----------------------------------------------------------------------------------------------------------------------------------
window.addEventListener('online', () => { state.online = true; void runSync({ quiet: true }); });
window.addEventListener('offline', () => { state.online = false; if (state.vault) renderSoon(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (state.vault) { recompute(); renderSoon(); } void runSync({ quiet: true }); } });
setInterval(() => { if (state.vault && state.cloud && navigator.onLine) void runSync({ quiet: true }); }, 60_000);

if (!state.native && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* app still works online */ });
state.serverMode = await detectServerMode();
render();
