import { h } from './dom.js';
import { icon } from './icons.js';
import { topbar, plural } from './kit.js';
import { addDays, fmtLong, fmtShort } from '../domain/dates.js';
import { ovulationCycleDays } from '../domain/cycles.js';

export function historyView(state) {
  const d = state.derived, fc = d.fc, stats = d.stats;
  const done = d.cycles.filter((c) => c.length !== null);
  const ov = ovulationCycleDays(d.eff, d.cycles);

  const current = fc && h('div', { className: 'card', 'data-testid': 'cycle-current' },
    h('div', { className: 'cyc' }, h('div', { className: 'mark' }, icon('drop', { filled: true })),
      h('div', { className: 'grow', style: 'flex:1' }, h('div', { style: 'font-weight:800' }, 'Current Cycle'), h('div', { style: 'font-size:20px;font-weight:800' }, `Day ${fc.cycleDay} of ~${fc.cycleLength}`),
        h('div', { className: 'muted' }, `Expected period: ${fmtLong(fc.nextPeriod)} · estimate`)),
      h('span', { className: 'badge', 'data-testid': 'cycle-badge' }, fc.daysToPeriod < 0 ? 'Running late' : 'On Track')));

  const prev = done.slice().reverse().map((c, i) => h('div', { className: 'card', 'data-testid': `cycle-prev-${i}` },
    h('div', { className: 'cyc' }, h('div', { className: `mark done` }, icon('check')),
      h('div', { style: 'flex:1' }, h('div', { style: 'font-weight:800' }, `Cycle ${done.length - i}`), h('div', { style: 'font-size:18px;font-weight:800' }, plural(c.length, 'Day')),
        h('div', { className: 'muted' }, `${fmtShort(c.start)} – ${fmtShort(addDays(c.next, -1))}${c.periodLength ? ` · period ${plural(c.periodLength, 'day')}` : ''}`)))));

  const insights = h('div', { className: 'card', 'data-testid': 'insights' }, h('div', { className: 'sec' }, icon('chart'), 'Cycle Insights'),
    stats.consistent === true ? h('div', { className: 'insight' }, icon('check'), `Your cycle length is consistent (${stats.min === stats.max ? `${stats.min} days` : `${stats.min}–${stats.max} days`}).`)
      : stats.consistent === false ? h('div', { className: 'insight' }, icon('info'), `Your cycle length varies (${stats.min}–${stats.max} days).`)
      : h('div', { className: 'insight' }, icon('info'), 'Log at least two complete cycles to see how consistent your cycle length is.'),
    ov ? h('div', { className: 'insight' }, icon('check'), `Ovulation typically occurs around CD ${ov.from}–${ov.to} (from temperature shifts in ${plural(ov.cycles, 'cycle')}).`)
      : h('div', { className: 'insight' }, icon('info'), 'Log temperatures through a cycle to see when you usually ovulate.'));

  return h('div', {}, topbar('Cycle History', { iconName: 'history' }),
    h('div', { className: 'pad' },
      d.cycles.length === 0 ? h('div', { className: 'card', 'data-testid': 'history-empty' }, h('p', { className: 'muted', style: 'margin:0' }, 'No cycles yet. Log the days of your period on the Today screen and your cycles will appear here.')) : [current, prev],
      insights));
}
