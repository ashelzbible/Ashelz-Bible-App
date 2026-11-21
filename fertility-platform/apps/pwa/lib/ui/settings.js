import { h } from './dom.js';
import { icon } from './icons.js';
import { initials, topbar } from './kit.js';
import { PROFILES } from '../engine/profiles.js';

const row = (iconName, label, right, fn, id) => h('button', { className: 'listrow', onclick: fn, 'data-testid': id }, icon(iconName), h('span', { className: 'grow' }, label), right ? h('span', { className: 'right' }, right) : null, icon('chevron', { size: 18 }));

export function settingsView(state, on) {
  const sync = state.cloud ? (state.lastSync ? `Last synced ${new Date(state.lastSync).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : 'Not synced yet') : 'This device only';
  return h('div', {}, topbar('Settings', { iconName: 'settings' }),
    h('div', { className: 'pad' },
      h('div', { className: 'card profile' }, h('div', { className: 'avatar' }, initials(state.user?.name)),
        h('div', { style: 'flex:1' }, h('div', { style: 'font-weight:800;font-size:18px', 'data-testid': 'profile-name' }, state.user?.name ?? 'Signed in'), h('div', { className: 'muted' }, state.email),
          h('button', { className: 'btn soft', style: 'min-height:36px;padding:4px 14px;margin-top:6px', onclick: () => on.open('settings/profile'), 'data-testid': 'edit-profile' }, 'Edit Profile'))),
      h('div', { className: 'card' },
        row('sync', 'Sync Data', sync, () => on.open('settings/sync'), 'row-sync'),
        row('bell', 'Notification Settings', state.prefs.reminder.enabled ? `Daily at ${state.prefs.reminder.time}` : 'Off', () => on.open('settings/notifications'), 'row-notifications'),
        row('sliders', 'Cycle Preferences', null, () => on.open('settings/cycle'), 'row-cycle'),
        row('units', 'Units & Display', state.prefs.unit === 'F' ? '°F' : '°C', () => on.open('settings/units'), 'row-units'),
        row('lock', 'Privacy & Security', null, () => on.open('settings/privacy'), 'row-privacy'),
        row('help', 'Help & Support', null, () => on.open('settings/help'), 'row-help'),
        row('info', 'About Cycle Tracker', null, () => on.open('settings/about'), 'row-about')),
      h('button', { className: 'btn soft full', onclick: on.logout, 'data-testid': 'logout' }, icon('logout', { size: 18 }), ' Log Out'),
      h('p', { className: 'muted', style: 'text-align:center;margin-top:12px', 'data-testid': 'version' }, `Version ${state.version} · Demo build, not a medical device`)));
}

export function settingsSub(state, on) {
  const id = state.route.screen.split('/')[1];
  const back = () => on.open(null);
  const msg = (k) => h('p', { className: state.settingsMsgKind === 'error' ? 'error' : 'ok', role: 'status', 'data-testid': k }, state.settingsMsg ?? '');
  const num = (key, label, min, max, unit) => [h('label', { for: key }, `${label}${unit ? ` (${unit})` : ''}`), h('input', { type: 'number', id: key, min, max, step: 1, value: state.prefs[key], 'data-testid': `pref-${key}`, onchange: (e) => on.setPref({ [key]: Number(e.target.value) }, { min, max, key }) })];

  if (id === 'profile') {
    const name = h('input', { type: 'text', id: 'pname', value: state.user?.name ?? '', autocomplete: 'name', 'data-testid': 'profile-input' });
    return h('div', {}, topbar('Edit Profile', { back }), h('div', { className: 'pad' }, h('div', { className: 'card' }, h('label', { for: 'pname' }, 'Your name'), name,
      h('label', {}, 'Email'), h('p', { className: 'muted', style: 'margin:0' }, state.email)), msg('settings-msg'),
      h('button', { className: 'btn full', onclick: () => on.saveName(name.value), 'data-testid': 'save-profile' }, 'Save')));
  }
  if (id === 'sync') {
    const serverInput = h('input', { type: 'url', id: 'server', placeholder: 'https://your-server.example.com', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: state.prefillServer ?? '' });
    return h('div', {}, topbar('Sync Data', { back }), h('div', { className: 'pad' },
      state.cloud
        ? h('div', { className: 'card' }, h('p', { className: 'muted', 'data-testid': 'last-sync' }, state.lastSync ? `Last synced ${new Date(state.lastSync).toLocaleString()}` : 'Not synced yet'),
            h('button', { className: 'btn full', onclick: on.sync, disabled: state.syncing, 'data-testid': 'sync-now' }, state.syncing ? 'Syncing…' : 'Sync now'))
        : h('div', { className: 'card' }, h('p', { className: 'muted', 'data-testid': 'device-only' }, 'This account lives only on this device. Nothing is sent anywhere.'),
            state.serverMode === 'none' ? h('p', { className: 'muted' }, 'Syncing needs a server, and none is available to this copy of the app.')
              : [h('p', { className: 'muted' }, 'Optional: upload your entries to a server so they are backed up and can be opened on another phone.'), state.serverMode === 'native' ? [h('label', { for: 'server' }, 'Server address'), serverInput] : null,
                 h('p', { className: 'error', role: 'alert', 'data-testid': 'sync-error' }, state.syncError ?? ''),
                 h('button', { className: 'btn full', onclick: () => on.enableSync(serverInput.value), 'data-testid': 'enable-sync' }, 'Turn on sync')])));
  }
  if (id === 'notifications') {
    const r = state.prefs.reminder;
    const time = h('input', { type: 'time', id: 'rtime', value: r.time, 'data-testid': 'reminder-time' });
    return h('div', {}, topbar('Notifications', { back }), h('div', { className: 'pad' }, h('div', { className: 'card' },
      h('label', { className: 'check', for: 'remind' }, h('input', { type: 'checkbox', id: 'remind', checked: r.enabled, 'data-testid': 'reminder-toggle', onchange: (e) => on.setReminder(e.target.checked, time.value) }), 'Remind me every day to log'),
      h('label', { for: 'rtime' }, 'Time'), time,
      h('button', { className: 'btn secondary full', style: 'margin-top:10px', onclick: () => on.setReminder(r.enabled, time.value), 'data-testid': 'reminder-save' }, 'Save time'),
      h('p', { className: 'muted' }, state.native ? 'The reminder is a notification on this phone. It contains no health information.' : 'Reminders work in the Android app. This copy runs in a browser, which cannot schedule them reliably.')), msg('settings-msg')));
  }
  if (id === 'cycle') {
    const goal = h('select', { id: 'goal', 'data-testid': 'pref-goal', onchange: (e) => on.setPref({ goal: e.target.value }) }, [['track', 'Just tracking my cycle'], ['conceive', 'Trying to conceive']].map(([v, l]) => h('option', { value: v, selected: state.prefs.goal === v }, l)));
    const prof = h('select', { id: 'profile', 'data-testid': 'profile-select', onchange: (e) => on.setProfile(e.target.value) }, Object.keys(PROFILES).map((n) => h('option', { value: n, selected: n === state.profileName }, n)));
    return h('div', {}, topbar('Cycle Preferences', { back }), h('div', { className: 'pad' }, h('div', { className: 'card' },
      h('label', { for: 'goal' }, 'My goal'), goal, num('cycleLength', 'Typical cycle length', 21, 45, 'days'), num('periodLength', 'Typical period length', 2, 10, 'days'), num('lutealLength', 'Luteal phase length', 10, 16, 'days'),
      h('p', { className: 'muted' }, 'Used only for estimates until you have logged your own cycles.')), msg('settings-msg'),
      h('div', { className: 'card' }, h('h2', {}, 'Hormone thresholds'), h('p', { className: 'muted' }, 'The numbers used to read your urine hormone results. Results are calculated on this device.'),
        h('label', { for: 'profile' }, 'Threshold set'), prof, h('details', {}, h('summary', { className: 'muted' }, 'Where these numbers come from'), h('p', { className: 'muted', 'data-testid': 'evidence' }, PROFILES[state.profileName]?.evidence ?? '')))));
  }
  if (id === 'units') {
    return h('div', {}, topbar('Units & Display', { back }), h('div', { className: 'pad' }, h('div', { className: 'card' }, h('div', { className: 'sec' }, icon('thermo'), 'Temperature'),
      h('div', { className: 'seg' }, [['C', '°C'], ['F', '°F']].map(([u, l]) => h('button', { 'aria-pressed': state.prefs.unit === u ? 'true' : 'false', onclick: () => on.setPref({ unit: u }), 'data-testid': `unit-${u}` }, l))),
      h('p', { className: 'muted' }, 'Temperatures are stored in °C and converted for display.'))));
  }
  if (id === 'privacy') {
    return h('div', {}, topbar('Privacy & Security', { back }), h('div', { className: 'pad' },
      h('div', { className: 'card' }, h('p', { style: 'margin-top:0' }, 'Your entries are encrypted on this device with a key made from your password (AES-256-GCM). The password is never stored, so it cannot be reset.'),
        h('p', {}, state.cloud ? 'This account syncs with a server. The server stores your entries under a pseudonym, separate from your name and email.' : 'This account is device-only: nothing is sent anywhere.'),
        h('p', { className: 'muted', style: 'margin-bottom:0' }, 'Demo build: do not enter real health data.')),
      h('button', { className: 'btn danger full', onclick: on.wipe, 'data-testid': 'wipe' }, 'Delete data on this device')));
  }
  if (id === 'help') {
    const q = (t, a) => h('details', { className: 'day-detail' }, h('summary', {}, t), h('p', { className: 'muted', style: 'margin:8px 0 0' }, a));
    return h('div', {}, topbar('Help & Support', { back }), h('div', { className: 'pad' },
      q('How do I log my period?', 'Open Log Your Day, choose Yes under Period, and save. Log each day you bleed; a new cycle starts with the first day.'),
      q('Why do the dates say "estimate"?', 'Next period, ovulation and fertile window dates are statistics from your past cycle lengths. Results marked "measured" come from the temperatures, mucus and hormones you logged.'),
      q('How do I enter hormone results?', 'Tap Log Hormones on the Home screen and type the LH, E3G and PdG numbers from your monitor.'),
      q('Which temperatures are ignored?', 'Readings above 37.8 °C, readings marked "slept badly or unwell", and duplicate entries for one day.'),
      q('I forgot my password.', 'Entries on this device are encrypted with it and cannot be recovered. If you synced the account, the server copy can be opened on a new phone.'),
      h('p', { className: 'muted' }, 'This is a demo without a support service.')));
  }
  // about
  return h('div', {}, topbar('About Cycle Tracker', { back }), h('div', { className: 'pad' }, h('div', { className: 'card' },
    h('p', { style: 'margin-top:0', 'data-testid': 'about-version' }, `Cycle Tracker ${state.version}`),
    h('p', {}, 'Tracks periods, basal body temperature, cervical mucus and urine hormones, and calculates daily fertility results on your device.'),
    h('p', { className: 'muted' }, 'Not a medical device. The hormone thresholds are provisional and not clinically validated, and estimates ahead of time are statistics, not measurements. Do not use for medical decisions or as contraception.'))));
}
