import { effectiveEvents } from '../vendor/sync-protocol/order.js';
import { pendingCount } from './sync.js';
import { PROFILES } from './engine/profiles.js';

/** DOM builder. Only textContent is ever used for data, so nothing from the server can inject markup. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

export const MUCUS = ['Dry', 'Sticky', 'Creamy', 'Watery', 'Egg-white'];
export const STATUS_LABEL = { LOW: 'Low', HIGH: 'High', PEAK: 'Peak', OVULATION_CONFIRMED: 'Ovulation confirmed', INSUFFICIENT_DATA: 'Not enough data' };

export const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Effective (conflict-resolved) value of each kind on a date, using the shared deterministic ordering. */
export function effectiveOn(state, date) {
  const out = {};
  for (const e of effectiveEvents([...state.events.values()].map((r) => r.event))) if (e.log_date === date) out[e.kind] = e;
  return out;
}

function statusBar(state) {
  if (!state.cloud) {
    return h('div', { className: 'status', 'data-testid': 'status' },
      h('span', {}, h('span', { className: 'dot' }), 'This device only'),
      h('span', { 'data-testid': 'pending' }, 'Private, not synced'));
  }
  const n = pendingCount(state);
  return h('div', { className: 'status', 'data-testid': 'status' },
    h('span', {}, h('span', { className: `dot${state.online ? '' : ' off'}` }), state.online ? 'Online' : 'Offline'),
    h('span', { 'data-testid': 'pending' }, n === 0 ? 'All saved & synced' : `${n} waiting to sync`));
}

export function loginView(state, on) {
  const registering = state.mode === 'register';
  const sm = state.serverMode; // 'same-origin' | 'native' | 'none'
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'username', required: true, value: state.prefillEmail ?? '' });
  const pw = h('input', { type: 'password', id: 'password', autocomplete: registering ? 'new-password' : 'current-password', required: true, minlength: registering ? 10 : 1 });
  const name = h('input', { type: 'text', id: 'name', autocomplete: 'name' });
  const server = h('input', { type: 'url', id: 'server', placeholder: 'https://your-server.example.com', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: state.prefillServer ?? '' });
  const sync = h('input', { type: 'checkbox', id: 'sync', checked: sm === 'same-origin' ? (state.prefillSync ?? true) : (state.prefillSync ?? false) });
  const serverBox = h('div', { hidden: !(sm === 'native' && (!registering || sync.checked)), 'data-testid': 'server-box' },
    h('label', { for: 'server' }, registering ? 'Server address' : 'Server address (optional)'), server,
    h('p', { className: 'muted' }, registering ? 'Where to sync and back up your entries.' : 'Only needed to sign in to a synced account on a new phone. Leave empty to use this device only.'));
  sync.addEventListener('change', () => { serverBox.hidden = !(sm === 'native' && sync.checked); });
  const err = h('p', { className: 'error', role: 'alert', 'data-testid': 'error' }, state.error ?? '');
  const submit = h('button', { type: 'submit', className: 'full', 'data-testid': 'submit' }, registering ? 'Create account' : 'Sign in');
  const form = h('form', { className: 'card', onsubmit: (e) => { e.preventDefault(); submit.disabled = true; on.submit({ email: email.value, password: pw.value, name: name.value, server: server.value, sync: sync.checked }).finally(() => { submit.disabled = false; }); } },
    h('h2', {}, registering ? 'Create your account' : 'Sign in'),
    registering ? [h('label', { for: 'name' }, 'Your name'), name] : null,
    h('label', { for: 'email' }, 'Email'), email,
    h('label', { for: 'password' }, registering ? 'Password (at least 10 characters)' : 'Password'), pw,
    registering && sm !== 'none' ? h('label', { className: 'check', for: 'sync' }, sync, 'Also sync and back up with a server (optional)') : null,
    registering && sm === 'none' ? h('p', { className: 'muted' }, 'No server needed: your account, entries and results all stay on this device.') : null,
    serverBox,
    err, h('div', { className: 'stack' }, submit,
      h('button', { type: 'button', className: 'secondary full', onclick: on.toggleMode, 'data-testid': 'toggle-mode' }, registering ? 'I already have an account' : 'Create an account')));
  return h('div', {},
    h('h1', {}, 'Cycle Tracker'),
    h('p', { className: 'muted' }, 'Your entries are stored encrypted on this device and work without a connection. Your password unlocks them, so it cannot be reset: keep it safe.'),
    form);
}

export function todayView(state, on) {
  const date = state.date;
  const eff = effectiveOn(state, date);
  const bbt = eff.BBT?.payload ?? {};
  const hor = eff.HORMONE?.payload ?? {};
  const f = {
    date: h('input', { type: 'date', id: 'date', value: date, max: todayLocal(), onchange: (e) => on.setDate(e.target.value) }),
    temp: h('input', { type: 'number', id: 'temp', inputmode: 'decimal', step: '0.01', min: '34', max: '42', value: bbt.temp_c ?? '' }),
    disturbed: h('input', { type: 'checkbox', id: 'disturbed', checked: bbt.sleep_disrupted === true }),
    lh: h('input', { type: 'number', id: 'lh', inputmode: 'decimal', step: 'any', min: '0', value: hor.lh_miu_ml ?? '' }),
    e3g: h('input', { type: 'number', id: 'e3g', inputmode: 'decimal', step: 'any', min: '0', value: hor.e3g_ng_ml ?? '' }),
    pdg: h('input', { type: 'number', id: 'pdg', inputmode: 'decimal', step: 'any', min: '0', value: hor.pdg_ug_ml ?? '' }),
    cycle: h('input', { type: 'checkbox', id: 'cycle', checked: eff.CYCLE !== undefined }),
  };
  const mucusSel = eff.MUCUS?.payload?.score;
  const mucusRadios = MUCUS.map((label, i) => h('label', {}, h('input', { type: 'radio', name: 'mucus', value: String(i), checked: mucusSel === i }), h('span', {}, label)));
  const msg = h('p', { className: state.msgKind === 'error' ? 'error' : 'ok', role: 'status', 'data-testid': 'msg' }, state.msg ?? '');
  const num = (el) => (el.value.trim() === '' ? undefined : Number(el.value));

  const edited = (e) => { if (e.target.id !== 'date') on.dirty(); }; // choosing a date is navigation, not an unsaved edit
  const form = h('form', { oninput: edited, onchange: edited, onsubmit: (e) => { e.preventDefault(); on.save({
    temp: num(f.temp), disturbed: f.disturbed.checked, lh: num(f.lh), e3g: num(f.e3g), pdg: num(f.pdg), cycle: f.cycle.checked,
    mucus: (mucusRadios.map((l) => l.firstChild).find((r) => r.checked) ?? {}).value,
  }); } },
    h('div', { className: 'card' }, h('label', { for: 'date' }, 'Date'), f.date),
    h('div', { className: 'card' }, h('h2', {}, 'Morning temperature'),
      h('label', { for: 'temp' }, 'Basal body temperature (°C)'), f.temp,
      h('label', { className: 'check', for: 'disturbed' }, f.disturbed, 'Slept badly or was unwell')),
    h('div', { className: 'card' }, h('h2', {}, 'Urine hormone test'),
      h('p', { className: 'muted' }, 'First-morning urine, from your monitor.'),
      h('div', { className: 'row' }, h('div', {}, h('label', { for: 'lh' }, 'LH (mIU/mL)'), f.lh), h('div', {}, h('label', { for: 'e3g' }, 'E3G (ng/mL)'), f.e3g)),
      h('label', { for: 'pdg' }, 'PdG (µg/mL)'), f.pdg),
    h('div', { className: 'card' }, h('h2', {}, 'Cervical mucus'), h('div', { className: 'mucus', role: 'radiogroup', 'aria-label': 'Cervical mucus' }, mucusRadios)),
    h('div', { className: 'card' }, h('label', { className: 'check', for: 'cycle' }, f.cycle, 'First day of my period')),
    msg,
    h('button', { type: 'submit', className: 'full', 'data-testid': 'save' }, 'Save this day'));
  return h('div', {}, h('h1', {}, 'Today'), statusBar(state), form);
}

function bbtChart(state) {
  const pts = effectiveEvents([...state.events.values()].map((r) => r.event))
    .filter((e) => e.kind === 'BBT' && e.payload?.temp_c !== undefined && !e.payload.sleep_disrupted && e.payload.temp_c <= 37.8)
    .map((e) => ({ d: e.log_date, t: e.payload.temp_c })).slice(-40);
  if (pts.length < 2) return h('p', { className: 'muted' }, 'Log at least two morning temperatures to see your chart.');
  const W = 320, H = 150, L = 30, B = 20, T = 8, R = 8;
  const lo = Math.floor(Math.min(...pts.map((p) => p.t)) * 10) / 10 - 0.1, hi = Math.ceil(Math.max(...pts.map((p) => p.t)) * 10) / 10 + 0.1;
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1), y = (t) => T + ((hi - t) * (H - T - B)) / (hi - lo);
  const ns = 'http://www.w3.org/2000/svg';
  const el = (name, attrs, text) => { const n = document.createElementNS(ns, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text) n.textContent = text; return n; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `Basal body temperature, last ${pts.length} readings` });
  for (const t of [lo, (lo + hi) / 2, hi]) { svg.append(el('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: 'grid' }), el('text', { x: 2, y: y(t) + 3 }, t.toFixed(1))); }
  svg.append(el('polyline', { class: 'line', points: pts.map((p, i) => `${x(i)},${y(p.t)}`).join(' ') }));
  pts.forEach((p, i) => svg.append(el('circle', { class: 'pt', cx: x(i), cy: y(p.t), r: 2.5 })));
  svg.append(el('text', { x: L, y: H - 4 }, pts[0].d.slice(5)), el('text', { x: W - R - 28, y: H - 4 }, pts[pts.length - 1].d.slice(5)));
  return svg;
}

export function chartView(state) {
  const p = state.predictions;
  const version = p?.algorithm_version ?? '';
  const profile = version.includes('+') ? version.split('+')[1] : null;
  const provisional = profile && /provisional|preliminary/.test(profile);
  const days = p ? [...p.days].reverse() : [];
  return h('div', {}, h('h1', {}, 'Your cycle'), statusBar(state),
    provisional ? h('div', { className: 'notice', 'data-testid': 'provisional' }, `Thresholds in use (${profile}) are provisional and not clinically validated. Do not use for medical decisions.`) : null,
    p?.ovulation_confirmed_on ? h('div', { className: 'notice', 'data-testid': 'ovulation' }, `Ovulation confirmed (detected ${p.ovulation_confirmed_on}).`) : null,
    p?.anovulatory_pattern_suspected ? h('div', { className: 'notice' }, 'No ovulation signs found in this cycle so far. This is a hint, not a diagnosis; talk to a clinician if you are worried.') : null,
    h('div', { className: 'card' }, h('h2', {}, 'Temperature'), bbtChart(state)),
    days.length === 0
      ? h('p', { className: 'muted', 'data-testid': 'no-predictions' }, 'Your fertility timeline appears here after you sync and log a few days.')
      : [h('h2', {}, 'Daily fertility status'), ...days.map((d) => h('details', { className: 'day', 'data-testid': 'day' },
          h('summary', { className: 'top' }, h('span', {}, d.log_date), h('span', { className: `pill ${d.status}` }, STATUS_LABEL[d.status] ?? d.status)),
          h('ul', {}, d.reasoning.map((r) => h('li', {}, r)))))],
    h('p', { className: 'muted', 'data-testid': 'computed' }, p ? `Computed ${p.computed_on === 'device' ? 'on this device ' : ''}${new Date(p.computed_at).toLocaleString()} · ${version}` : ''));
}

export function accountView(state, on) {
  const cloud = state.cloud;
  const serverInput = h('input', { type: 'url', id: 'server', placeholder: 'https://your-server.example.com', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: state.prefillServer ?? '' });
  const profile = h('select', { id: 'profile', 'data-testid': 'profile-select', onchange: (e) => on.setProfile(e.target.value) },
    Object.keys(PROFILES).map((n) => h('option', { value: n, selected: n === state.profileName }, n)));
  return h('div', {}, h('h1', {}, 'Account'), statusBar(state),
    h('div', { className: 'card' }, h('h2', {}, state.user?.name ?? 'Signed in'), h('p', { className: 'muted' }, state.email),
      cloud
        ? [h('p', { className: 'muted', 'data-testid': 'last-sync' }, state.lastSync ? `Last synced ${new Date(state.lastSync).toLocaleString()}` : 'Not synced yet'),
           h('button', { className: 'full', onclick: on.sync, 'data-testid': 'sync-now', disabled: state.syncing }, state.syncing ? 'Syncing…' : 'Sync now')]
        : h('p', { className: 'muted', 'data-testid': 'device-only' }, 'This account lives only on this device. Nothing is sent anywhere.'),
      h('div', { className: 'stack' }, h('button', { className: 'secondary full', onclick: on.logout, 'data-testid': 'logout' }, 'Lock and sign out'))),
    !cloud && state.serverMode !== 'none'
      ? h('div', { className: 'card' }, h('h2', {}, 'Sync across devices'),
          h('p', { className: 'muted' }, 'Optional. Uploads your entries to a server so they are backed up and can be opened on another phone.'),
          state.serverMode === 'native' ? [h('label', { for: 'server' }, 'Server address'), serverInput] : null,
          h('p', { className: 'error', role: 'alert', 'data-testid': 'sync-error' }, state.syncError ?? ''),
          h('button', { className: 'full', onclick: () => on.enableSync(serverInput.value), 'data-testid': 'enable-sync' }, 'Turn on sync'))
      : null,
    h('div', { className: 'card' }, h('h2', {}, 'Hormone thresholds'),
      h('p', { className: 'muted' }, 'The numbers used to read your urine hormone results. Results are calculated on this device.'),
      h('label', { for: 'profile' }, 'Threshold set'), profile,
      h('details', {}, h('summary', { className: 'muted' }, 'Where these numbers come from'), h('p', { className: 'muted', 'data-testid': 'evidence' }, PROFILES[state.profileName]?.evidence ?? ''))),
    h('div', { className: 'card' }, h('h2', {}, 'This device'),
      h('p', { className: 'muted' }, 'Entries are encrypted on this device and unlock with your password, even offline.'),
      h('button', { className: 'danger full', onclick: on.wipe, 'data-testid': 'wipe' }, 'Delete data on this device')),
    h('p', { className: 'muted' }, 'Demo build. Not a medical device.'));
}

export function nav(state, on) {
  const tab = (id, label) => h('button', { 'aria-current': state.tab === id ? 'page' : undefined, onclick: () => on.tab(id), 'data-testid': `tab-${id}` }, label);
  return h('nav', { 'aria-label': 'Main' }, tab('today', 'Today'), tab('chart', 'Cycle'), tab('account', 'Account'));
}
