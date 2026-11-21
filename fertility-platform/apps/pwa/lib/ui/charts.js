import { h, svg } from './dom.js';
import { icon } from './icons.js';
import { topbar } from './kit.js';
import { addDays, diffDays, fmtShort, ord } from '../domain/dates.js';
import { toDisplay, unitLabel } from '../domain/units.js';

const RANGES = [['6M', 180], ['3M', 90], ['1M', 30], ['Custom', null]];
const W = 340, H = 180, L = 36, R = 8, T = 12, B = 26;
const el = svg;

/** Cycle day (1-based) of a date within its cycle, or null before the first logged cycle. */
export function cycleDayOf(date, cycles) {
  let c = null;
  for (const cy of cycles) if (cy.start <= date) c = cy;
  return c ? diffDays(date, c.start) + 1 : null;
}

export function rangeBounds(state) {
  const to = state.derived.today;
  const ch = state.chart;
  if (ch.range === 'Custom') {
    const a = ch.from || addDays(to, -29), b = ch.to || to;
    return a <= b ? [a, b] : [b, a];
  }
  const n = RANGES.find(([k]) => k === ch.range)[1];
  return [addDays(to, -(n - 1)), to];
}

function axes(from, to, ticks, fmt) {
  const g = [];
  for (const t of ticks) g.push(el('line', { x1: L, x2: W - R, y1: t.y, y2: t.y, class: 'grid' }), el('text', { x: 2, y: t.y + 3 }, fmt(t.v)));
  const span = Math.max(ord(to) - ord(from), 1);
  for (const f of [0, 0.5, 1]) g.push(el('text', { x: L + f * (W - L - R) - (f === 1 ? 26 : f === 0.5 ? 12 : 0), y: H - 8 }, fmtShort(addDays(from, Math.round(span * f)))));
  return g;
}

function bbtChart(state, on, from, to) {
  const d = state.derived, unit = state.prefs.unit;
  const pts = d.eff.filter((e) => e.kind === 'BBT' && e.log_date >= from && e.log_date <= to && e.payload?.temp_c !== undefined)
    .map((e) => ({ date: e.log_date, v: toDisplay(e.payload.temp_c, unit), bad: e.payload.sleep_disrupted === true || e.payload.temp_c > 37.8 })).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (pts.length < 2) return h('p', { className: 'muted', 'data-testid': 'bbt-empty' }, 'Log at least two morning temperatures in this range to see the chart.');
  const lo0 = Math.min(...pts.map((p) => p.v)), hi0 = Math.max(...pts.map((p) => p.v));
  const pad = unit === 'F' ? 0.3 : 0.15, lo = Math.floor((lo0 - pad) * 10) / 10, hi = Math.ceil((hi0 + pad) * 10) / 10;
  const span = Math.max(ord(to) - ord(from), 1);
  const x = (date) => L + ((ord(date) - ord(from)) / span) * (W - L - R), y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const s = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `Basal body temperature, ${pts.length} readings`, 'data-testid': 'bbt-chart' });
  s.append(...axes(from, to, [lo, (lo + hi) / 2, hi].map((v) => ({ v, y: y(v) })), (v) => v.toFixed(1)));
  const bw = Math.max(((W - L - R) / span), 4);
  for (const [date, day] of d.engineDays) if ((day.status === 'HIGH' || day.status === 'PEAK') && date >= from && date <= to) s.append(el('rect', { class: 'shade', x: x(date) - bw / 2, y: T, width: bw, height: H - T - B }));
  s.append(el('polyline', { points: pts.filter((p) => !p.bad).map((p) => `${x(p.date)},${y(p.v)}`).join(' '), fill: 'none', stroke: '#6a2cb5', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  for (const p of pts) {
    s.append(el('circle', { cx: x(p.date), cy: y(p.v), r: p.date === state.chart.selected ? 6 : 3.5, fill: p.bad ? '#fff' : '#6a2cb5', stroke: '#6a2cb5', 'stroke-width': 2 }));
    const hit = el('circle', { cx: x(p.date), cy: y(p.v), r: 11, fill: 'transparent', 'data-testid': `bbt-pt-${p.date}`, tabindex: 0, role: 'button', 'aria-label': `${p.date}: ${p.v} ${unitLabel(unit)}` });
    hit.addEventListener('click', () => on.selectDate(p.date));
    s.append(hit);
  }
  const sel = pts.find((p) => p.date === state.chart.selected);
  const cd = sel ? cycleDayOf(sel.date, d.cycles) : null;
  return h('div', {}, sel ? h('div', { className: 'tip', 'data-testid': 'bbt-tip' }, `${sel.v}${unitLabel(unit)}${cd ? ` · CD ${cd}` : ''} · ${fmtShort(sel.date)}${sel.bad ? ' · ignored' : ''}`) : h('p', { className: 'muted', style: 'margin:0 0 4px' }, 'Tap a point for details. Shaded days are measured fertile days.'), s);
}

const SERIES = [['lh_miu_ml', 'LH', '#e0559f', 'mIU/mL'], ['e3g_ng_ml', 'E3G', '#8f50d8', 'ng/mL'], ['pdg_ug_ml', 'PdG', '#2bb3c0', 'µg/mL']];

function hormoneChart(state, on, from, to) {
  const d = state.derived;
  const rows = d.eff.filter((e) => e.kind === 'HORMONE' && e.log_date >= from && e.log_date <= to).sort((a, b) => (a.log_date < b.log_date ? -1 : 1));
  const data = SERIES.map(([key, name, color, u]) => ({ key, name, color, u, pts: rows.filter((r) => typeof r.payload[key] === 'number').map((r) => ({ date: r.log_date, v: r.payload[key] })) }));
  if (!data.some((s) => s.pts.length >= 2)) return h('p', { className: 'muted', 'data-testid': 'hormone-empty' }, 'Enter hormone values on at least two days to see the chart.');
  const span = Math.max(ord(to) - ord(from), 1);
  const x = (date) => L + ((ord(date) - ord(from)) / span) * (W - L - R), y = (pct) => T + ((100 - pct) / 100) * (H - T - B);
  const s = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Hormone levels', 'data-testid': 'hormone-chart' });
  s.append(...axes(from, to, [0, 50, 100].map((v) => ({ v, y: y(v) })), (v) => `${v}`));
  for (const ser of data) {
    const max = Math.max(...ser.pts.map((p) => p.v), 1e-9);
    if (ser.pts.length >= 2) s.append(el('polyline', { points: ser.pts.map((p) => `${x(p.date)},${y((p.v / max) * 100)}`).join(' '), fill: 'none', stroke: ser.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    for (const p of ser.pts) s.append(el('circle', { cx: x(p.date), cy: y((p.v / max) * 100), r: 3, fill: ser.color }));
  }
  for (const r of rows) { const hit = el('rect', { x: x(r.log_date) - 8, y: T, width: 16, height: H - T - B, fill: 'transparent', 'data-testid': `hormone-pt-${r.log_date}`, tabindex: 0, role: 'button', 'aria-label': `Hormone values on ${r.log_date}` }); hit.addEventListener('click', () => on.selectDate(r.log_date)); s.append(hit); }
  const selRow = rows.find((r) => r.log_date === state.chart.selected);
  return h('div', {},
    h('div', { className: 'legend', style: 'margin:0 0 6px' }, data.map((s2) => h('span', {}, h('i', { style: `background:${s2.color}` }), s2.name))),
    selRow ? h('div', { className: 'tip', 'data-testid': 'hormone-tip' }, `${fmtShort(selRow.log_date)} · ${SERIES.filter(([k]) => typeof selRow.payload[k] === 'number').map(([k, n, , u]) => `${n} ${selRow.payload[k]} ${u}`).join(' · ')}`) : null,
    s, h('p', { className: 'muted', style: 'margin:4px 0 0' }, 'Each hormone is scaled to its own highest value in this range (0–100).'));
}

export function chartsView(state, on) {
  const d = state.derived, ch = state.chart;
  const [from, to] = rangeBounds(state);
  const cur = d.cycles[d.cycles.length - 1];
  const measured = cur ? [...d.engineDays.entries()].filter(([date, day]) => date >= cur.start && (day.status === 'HIGH' || day.status === 'PEAK')).map(([date]) => date).sort() : [];
  let fertile;
  if (measured.length) fertile = `Most fertile days (measured): CD ${cycleDayOf(measured[0], d.cycles)} – ${cycleDayOf(measured[measured.length - 1], d.cycles)}`;
  else if (d.fc) fertile = `Most fertile days (estimate): CD ${diffDays(d.fc.thisCycle.fertileStart, d.fc.start) + 1} – ${diffDays(d.fc.thisCycle.fertileEnd, d.fc.start) + 1}`;
  else fertile = 'Log a period to see your most fertile days.';
  const p = state.predictions;
  const profile = p?.algorithm_version?.includes('+') ? p.algorithm_version.split('+')[1] : null;
  const days = p ? [...p.days].reverse() : [];

  return h('div', {}, topbar('Charts', { iconName: 'chart' }),
    h('div', { className: 'pad' },
      h('div', { className: 'ranges', role: 'group', 'aria-label': 'Range' }, RANGES.map(([k]) => h('button', { 'aria-pressed': ch.range === k ? 'true' : 'false', onclick: () => on.range(k), 'data-testid': `range-${k}` }, k))),
      ch.range === 'Custom' ? h('div', { className: 'row card' }, h('div', { className: 'grow' }, h('label', { for: 'cfrom' }, 'From'), h('input', { type: 'date', id: 'cfrom', value: from, max: to, onchange: (e) => on.customRange(e.target.value, null), 'data-testid': 'custom-from' })),
        h('div', { className: 'grow' }, h('label', { for: 'cto' }, 'To'), h('input', { type: 'date', id: 'cto', value: to, max: d.today, onchange: (e) => on.customRange(null, e.target.value), 'data-testid': 'custom-to' }))) : null,
      h('div', { className: 'card' }, h('div', { className: 'sec' }, icon('thermo'), 'BBT Chart'), bbtChart(state, on, from, to)),
      h('div', { className: 'card' }, h('div', { className: 'sec' }, icon('hormone'), 'Hormone Levels'), hormoneChart(state, on, from, to)),
      h('div', { className: 'card' }, h('div', { className: 'sec' }, icon('heart', { filled: true }), 'Fertility Window'), h('p', { style: 'margin:0', 'data-testid': 'fertile-days' }, fertile)),
      profile && /provisional|preliminary/.test(profile) ? h('div', { className: 'notice', 'data-testid': 'provisional' }, `Thresholds in use (${profile}) are provisional and not clinically validated. Do not use for medical decisions.`) : null,
      p?.ovulation_confirmed_on ? h('div', { className: 'notice', 'data-testid': 'ovulation' }, `Ovulation confirmed (detected ${p.ovulation_confirmed_on}).`) : null,
      p?.anovulatory_pattern_suspected ? h('div', { className: 'notice' }, 'No ovulation signs found in this cycle so far. This is a hint, not a diagnosis; talk to a clinician if you are worried.') : null,
      days.length ? [h('h2', { style: 'margin-top:6px' }, 'Daily fertility status'), ...days.map((dd) => h('details', { className: 'day-detail', 'data-testid': 'day' },
        h('summary', {}, h('span', {}, dd.log_date), h('span', { className: `pill ${dd.status}` }, { LOW: 'Low', HIGH: 'High', PEAK: 'Peak', OVULATION_CONFIRMED: 'Ovulation confirmed', INSUFFICIENT_DATA: 'Not enough data' }[dd.status] ?? dd.status)),
        h('ul', {}, dd.reasoning.map((r) => h('li', {}, r)))))]
        : h('p', { className: 'muted', 'data-testid': 'no-predictions' }, 'Your daily fertility status appears here once you have logged a few days.'),
      p ? h('p', { className: 'muted', 'data-testid': 'computed' }, `Computed on this device ${new Date(p.computed_at).toLocaleString()} · ${p.algorithm_version}`) : null));
}
