import { h } from './dom.js';
import { lotus, flower } from './icons.js';

export function loginView(state, on) {
  const registering = state.mode === 'register';
  const sm = state.serverMode; // 'same-origin' | 'native' | 'none'
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'username', required: true, value: state.prefillEmail ?? '' });
  const pw = h('input', { type: 'password', id: 'password', autocomplete: registering ? 'new-password' : 'current-password', required: true, minlength: registering ? 10 : 1 });
  const name = h('input', { type: 'text', id: 'name', autocomplete: 'name' });
  const server = h('input', { type: 'url', id: 'server', placeholder: 'https://your-server.example.com', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: state.prefillServer ?? '' });
  const sync = h('input', { type: 'checkbox', id: 'sync', checked: sm === 'same-origin' ? (state.prefillSync ?? true) : (state.prefillSync ?? false) });
  const serverShown = () => sm === 'native' && (registering ? sync.checked : !!state.showServer);
  const serverBox = h('div', { hidden: !serverShown(), 'data-testid': 'server-box' },
    h('label', { for: 'server' }, registering ? 'Server address' : 'Server address (optional)'), server,
    h('p', { className: 'muted' }, registering ? 'Where to sync and back up your entries.' : 'The server your synced account lives on.'));
  sync.addEventListener('change', () => { serverBox.hidden = !serverShown(); });
  const err = h('p', { className: 'error', role: 'alert', 'data-testid': 'error' }, state.error ?? '');
  const submit = h('button', { type: 'submit', className: 'btn full', 'data-testid': 'submit' }, registering ? 'Create account' : 'Sign in');
  const form = h('form', { className: 'card', onsubmit: (e) => { e.preventDefault(); submit.disabled = true; on.submit({ email: email.value, password: pw.value, name: name.value, server: server.value, sync: sync.checked }).finally(() => { submit.disabled = false; }); } },
    h('h2', {}, registering ? 'Create your account' : 'Sign in'),
    registering ? [h('label', { for: 'name' }, 'Your name'), name] : null,
    h('label', { for: 'email' }, 'Email'), email,
    h('label', { for: 'password' }, registering ? 'Password (at least 10 characters)' : 'Password'), pw,
    registering && sm !== 'none' ? h('label', { className: 'check', for: 'sync' }, sync, 'Also sync and back up with a server (optional)') : null,
    registering && sm === 'none' ? h('p', { className: 'muted' }, 'No server needed: your account, entries and results all stay on this device.') : null,
    !registering && sm === 'native' ? h('button', { type: 'button', className: 'link', onclick: on.toggleServer, 'data-testid': 'toggle-server' }, state.showServer ? 'Hide server address' : 'Sign in to a synced account from another phone') : null,
    serverBox, err,
    h('div', { className: 'stack' }, submit, h('button', { type: 'button', className: 'btn secondary full', onclick: on.toggleMode, 'data-testid': 'toggle-mode' }, registering ? 'I already have an account' : 'Create an account')));
  return h('div', {}, h('div', { className: 'hero', style: 'padding-bottom:18px' },
    h('span', { className: 'deco', style: 'left:-24px;top:10px' }, flower(110)), h('span', { className: 'deco', style: 'right:-20px;top:30px' }, flower(100, '#ffb3d9', '#c9a0ff')),
    h('div', { className: 'brand' }, h('div', { className: 'name' }, lotus(44), 'Cycle Tracker')), h('p', { className: 'tagline' }, 'Know Your Body • Embrace Your Cycle')),
    h('div', { className: 'pad', style: 'margin-top:14px' },
      h('p', { className: 'muted' }, 'Your entries are stored encrypted on this device and work without a connection. Your password unlocks them, so it cannot be reset: keep it safe.'),
      form, h('p', { className: 'muted', 'data-testid': 'version' }, `Version ${state.version} · works without a server`)));
}
