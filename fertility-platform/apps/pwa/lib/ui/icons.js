import { svg } from './dom.js';

/** An 8-tooth gear drawn from its geometry, with a centre hole. */
const GEAR = (() => {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    for (const [da, r] of [[-0.3, 7.4], [-0.16, 9.8], [0.16, 9.8], [0.3, 7.4]]) pts.push(`${(12 + r * Math.sin(a + da)).toFixed(2)} ${(12 - r * Math.cos(a + da)).toFixed(2)}`);
  }
  return `M${pts.join('L')}ZM15 12a3 3 0 1 0-6 0 3 3 0 1 0 6 0z`;
})();

// 24x24 stroke icons (paths are drawn here; no third-party icon set).
const P = {
  home: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h5v-5.5h3v5.5h5V10',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H3',
  calendar: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 10h16M8 3v4m8-4v4',
  history: 'M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4M12 8v4.5l3 2',
  settings: GEAR,
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  back: 'M15 5l-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  drop: 'M12 3.5s6 6.2 6 10.3a6 6 0 0 1-12 0C6 9.700 12 3.500 12 3.500z',
  thermo: 'M10 14.500V5a2 2 0 0 1 4 0v9.500a4 4 0 1 1-4 0zM12 9v7',
  hormone: 'M12 8l4 2.300v4.600L12 17.200 8 14.900v-4.600zM12 8V4M16 10.300l3.500-2M16 14.900l3.500 2M12 17.200v3.800M8 14.900l-3.500 2M8 10.300l-3.500-2',
  star: 'M12 3.500l2.600 5.400 5.900.8-4.300 4.100 1 5.800-5.200-2.800-5.200 2.800 1-5.800L3.500 9.700l5.900-.8z',
  sliders: 'M5 7h9m4 0h1M5 17h2m4 0h8M14 5v4M7 15v4',
  chevron: 'M9 5l7 7-7 7',
  heart: 'M12 20s-7.500-4.600-7.500-10.200A4 4 0 0 1 12 8a4 4 0 0 1 7.500 1.800C19.500 15.400 12 20 12 20z',
  help: 'M9.500 9.500a2.500 2.500 0 1 1 3.600 2.200c-.8.4-1.100 1-1.100 1.800M12 17v.5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.500 20a7.500 7.500 0 0 1 15 0',
  sync: 'M20 11a8 8 0 0 0-14.500-3.500M4 4v4h4M4 13a8 8 0 0 0 14.500 3.500M20 20v-4h-4',
  lock: 'M6 11h12v9H6zM8.500 11V8a3.500 3.500 0 0 1 7 0v3',
  info: 'M12 17v-5.500M12 8v.5M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z',
  logout: 'M10 5H5v14h5M14 8l4 4-4 4M18 12H9',
  units: 'M9 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM17 13a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM5 19L19 5',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.500 10.900V16h7v-2.100A6 6 0 0 0 12 3z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.500 6.500l4 4',
  x: 'M6 6l12 12M18 6L6 18',
};

/** Stroke icon. `filled` fills the path with the current colour (used for stars and hearts). */
export function icon(name, { size = 24, filled = false, label } = {}) {
  const path = P[name];
  if (!path) throw new Error(`unknown icon ${name}`);
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: filled ? 'currentColor' : 'none', stroke: 'currentColor',
    'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': label ? undefined : 'true', role: label ? 'img' : undefined, 'aria-label': label },
    svg('path', { d: path }));
}

/** The lotus logo: five layered petals. */
export function lotus(size = 44) {
  const petal = (rot, fill, rx = 5, ry = 11, op = 1) => svg('ellipse', { cx: 24, cy: 20, rx, ry, fill, opacity: op, transform: `rotate(${rot} 24 32)` });
  return svg('svg', { viewBox: '0 0 48 48', width: size, height: size, role: 'img', 'aria-label': 'Cycle Tracker lotus logo' },
    svg('defs', {}, svg('linearGradient', { id: 'lotusG', x1: 0, y1: 0, x2: 0, y2: 1 }, svg('stop', { offset: 0, 'stop-color': '#f78fc4' }), svg('stop', { offset: 1, 'stop-color': '#b04bd6' }))),
    petal(-62, 'url(#lotusG)', 4.500, 11, .85), petal(62, 'url(#lotusG)', 4.500, 11, .85), petal(-32, 'url(#lotusG)', 5, 12), petal(32, 'url(#lotusG)', 5, 12),
    petal(0, '#e0559f', 5.500, 13), svg('path', { d: 'M8 36c5 4 11 5 16 5s11-1 16-5', stroke: '#8c3fc0', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }));
}

/** Soft decorative flower used behind headers. */
export function flower(size = 90, a = '#c9a0ff', b = '#ff9ccd') {
  const p = (rot, fill) => svg('ellipse', { cx: 50, cy: 28, rx: 11, ry: 24, fill, opacity: .8, transform: `rotate(${rot} 50 50)` });
  return svg('svg', { viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true' },
    [0, 72, 144, 216, 288].map((r, i) => p(r, i % 2 ? a : b)), svg('circle', { cx: 50, cy: 50, r: 7, fill: '#fff6c9' }));
}
