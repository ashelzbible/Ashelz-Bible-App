import { h } from './dom.js';
import { icon } from './icons.js';
import { topbar, plural } from './kit.js';
import { WEEKDAYS, daysInMonth, dowOf, monthTitle, ymd } from '../domain/dates.js';
import { markersFor } from '../domain/forecast.js';

export function calendarView(state, on) {
  const { y, m } = state.cal;
  const d = state.derived;
  const ctx = { period: d.period, engineDays: d.engineDays, fc: d.fc, ovulationConfirmed: d.ovulationDay };
  const lead = dowOf(ymd(y, m, 1)), count = daysInMonth(y, m);
  const cells = [...WEEKDAYS.map((w) => h('div', { className: 'dow' }, w)), ...Array.from({ length: lead }, () => h('button', { className: 'day blank', tabindex: -1, 'aria-hidden': 'true' }))];
  for (let day = 1; day <= count; day++) {
    const iso = ymd(y, m, day), mk = markersFor(iso, ctx);
    const cls = ['day', mk.period && 'period', (mk.measuredFertile) && 'fertile', mk.estPeriod && !mk.period && 'est-period', mk.estFertile && !mk.measuredFertile && !mk.period && 'est-fertile', iso === d.today && 'today'].filter(Boolean).join(' ');
    const desc = [mk.period && 'period', mk.measuredFertile && 'fertile (measured)', mk.estFertile && 'fertile window (estimate)', mk.estPeriod && 'expected period (estimate)', mk.ovulation && 'ovulation', mk.ovulationEstimated && 'ovulation (estimate)'].filter(Boolean).join(', ');
    cells.push(h('button', { className: cls, onclick: () => on.dayTap(iso), 'data-testid': `cal-day-${iso}`, 'aria-label': `${iso}${desc ? `, ${desc}` : ''}` },
      day, (mk.ovulation || mk.ovulationEstimated) ? h('span', { className: `star${mk.ovulation ? '' : ' est'}` }, icon('star', { size: 14, filled: true })) : null));
  }

  const stats = d.stats;
  const normal = stats.avg !== null && stats.avg >= 21 && stats.avg <= 35;
  const tip = state.prefs.goal === 'conceive'
    ? (['HIGH', 'PEAK'].includes(d.engineDays.get(d.today)?.status) ? 'Your fertility is at its peak. Consider timing intercourse for the best chances.' : 'Your most fertile days are the days around ovulation. Tracking temperature and hormones shows when they are.')
    : (['HIGH', 'PEAK'].includes(d.engineDays.get(d.today)?.status) ? 'Your results show a fertile phase now. Pregnancy is possible on these days.' : 'Log temperature, mucus and hormones daily to see when your fertile days are.');

  return h('div', {}, topbar('Calendar', { iconName: 'calendar' }),
    h('div', { className: 'pad' },
      h('div', { className: 'card' },
        h('div', { className: 'monthnav' }, h('button', { className: 'icon-btn', onclick: () => on.month(-1), 'aria-label': 'Previous month', 'data-testid': 'cal-prev' }, icon('back')),
          h('span', { 'data-testid': 'cal-title' }, monthTitle(y, m)), h('button', { className: 'icon-btn', onclick: () => on.month(1), 'aria-label': 'Next month', 'data-testid': 'cal-next' }, icon('chevron'))),
        h('div', { className: 'cal' }, cells),
        h('div', { className: 'legend' }, h('span', {}, h('i', { className: 'p' }), 'Period'), h('span', {}, h('i', { className: 'f' }), 'Fertile (measured)'), h('span', {}, icon('star', { size: 12, filled: true }), ' Ovulation (faded = estimate)'), h('span', {}, h('i', { className: 't' }), 'Today'),
          h('span', {}, 'Dashed = estimate'))),
      h('button', { className: 'card listrow', style: 'width:100%', onclick: () => on.tab('history'), 'data-testid': 'cycle-overview' }, icon('chart', { size: 28 }),
        h('div', { className: 'grow' }, h('div', { style: 'font-weight:800' }, 'Cycle Overview'),
          h('div', { style: 'font-size:22px;font-weight:800' }, stats.avg !== null ? plural(stats.avg, 'Day') : d.fc ? `${d.fc.cycleLength} Days (typical)` : '–'),
          stats.avg !== null ? h('div', { className: normal ? 'ok' : 'error' }, normal ? '✓ Normal Cycle' : 'Outside the typical 21–35 days. Consider talking to a clinician.') : h('div', { className: 'muted' }, 'Log two periods to see your cycle length.')), icon('chevron')),
      h('div', { className: 'card' }, h('div', { className: 'sec' }, icon('bulb'), 'Fertility Tip'), h('p', { style: 'margin:0', 'data-testid': 'tip' }, tip))));
}
