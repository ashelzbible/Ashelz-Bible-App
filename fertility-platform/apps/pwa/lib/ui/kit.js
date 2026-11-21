import { h, svg } from './dom.js';
import { icon } from './icons.js';
import { pendingCount } from '../sync.js';

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function topbar(title, { back, right, iconName } = {}) {
  return h('div', { className: 'topbar' },
    back ? h('button', { className: 'left', onclick: back, 'aria-label': 'Back', 'data-testid': 'back' }, icon('back')) : null,
    iconName ? icon(iconName) : null, h('span', { 'data-testid': 'screen-title' }, title), right ?? null);
}

export function statusLine(state) {
  if (!state.cloud) {
    return h('div', { className: 'status', 'data-testid': 'status' }, h('span', {}, h('span', { className: 'dot' }), 'This device only'), h('span', { 'data-testid': 'pending' }, 'Private, not synced'));
  }
  const n = pendingCount(state);
  return h('div', { className: 'status', 'data-testid': 'status' },
    h('span', {}, h('span', { className: `dot${state.online ? '' : ' off'}` }), state.online ? 'Online' : 'Offline'),
    h('span', { 'data-testid': 'pending' }, n === 0 ? 'All saved & synced' : `${n} waiting to sync`));
}

export function initials(name) {
  const w = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase() || '·';
}
export const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] ?? '';

const TABS = [['home', 'Home', 'home'], ['charts', 'Charts', 'chart'], ['calendar', 'Calendar', 'calendar'], ['history', 'History', 'history'], ['settings', 'Settings', 'settings']];
export function tabs(state, on) {
  return h('nav', { className: 'tabs', 'aria-label': 'Main' }, h('div', { className: 'inner' },
    TABS.map(([id, label, ic]) => h('button', { 'aria-current': state.route.tab === id && !state.route.screen ? 'page' : undefined, onclick: () => on.tab(id), 'data-testid': `tab-${id}` },
      h('span', { className: 'ico' }, icon(ic)), label))));
}

/** Circular progress ring with the cycle day in the middle. */
export function ring({ day, length }) {
  const r = 62, c = 2 * Math.PI * r, frac = day && length ? Math.min(day / length, 1) : 0;
  return svg('svg', { viewBox: '0 0 150 150', width: 190, height: 190, role: 'img', 'aria-label': day ? `Cycle day ${day} of ${length}` : 'No cycle yet' },
    svg('defs', {}, svg('linearGradient', { id: 'ringG', x1: 0, y1: 0, x2: 1, y2: 1 }, svg('stop', { offset: 0, 'stop-color': '#8f50d8' }), svg('stop', { offset: 1, 'stop-color': '#f06bb2' }))),
    svg('circle', { cx: 75, cy: 75, r, fill: '#fff', stroke: '#eadcf8', 'stroke-width': 12 }),
    svg('circle', { cx: 75, cy: 75, r, fill: 'none', stroke: 'url(#ringG)', 'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-dasharray': `${c * frac} ${c}`, transform: 'rotate(-90 75 75)' }));
}
