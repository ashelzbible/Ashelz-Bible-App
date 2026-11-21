import { h } from './dom.js';
import { icon, lotus, flower } from './icons.js';
import { firstName, initials, plural, ring, statusLine } from './kit.js';
import { fmtLong, fmtShort } from '../domain/dates.js';

const greeting = () => { const hr = new Date().getHours(); return hr < 12 ? 'Good Morning' : hr < 18 ? 'Good Afternoon' : 'Good Evening'; };
const inDays = (n) => (n === 0 ? 'Today' : n > 0 ? `in ${plural(n, 'Day')}` : `${plural(-n, 'day')} ago`);

export function homeView(state, on) {
  const { fc, engineDays, today, ovulationDay } = state.derived;
  const todayStatus = engineDays.get(today)?.status;
  const measuredFertile = todayStatus === 'HIGH' || todayStatus === 'PEAK';
  const confirmed = state.derived.ovulationConfirmedOn !== null;

  let periodCard, fertileCard, ovCard;
  if (!fc) {
    periodCard = h('div', { className: 'card', 'data-testid': 'onboarding' }, h('h2', {}, 'Start here'),
      h('p', { className: 'muted' }, 'Log the first day of your last period to see your cycle day and estimates.'),
      h('button', { className: 'btn full', onclick: () => on.openLog({ focus: 'period' }), 'data-testid': 'start-period' }, 'Log my period'));
  } else {
    const late = fc.daysToPeriod < 0;
    periodCard = h('button', { className: 'hl pink', onclick: () => on.tab('calendar'), 'data-testid': 'next-period' }, icon('calendar', { size: 30 }),
      h('div', { className: 'grow' }, h('div', { className: 't' }, late ? `Period may be ${plural(-fc.daysToPeriod, 'day')} late` : fc.daysToPeriod === 0 ? 'Next period: expected today' : `Next Period in ${plural(fc.daysToPeriod, 'Day')}`),
        h('div', { className: 's' }, `(${fmtLong(fc.nextPeriod)}) · estimate`)));
    const w = fc.thisCycle;
    const windowText = measuredFertile ? `Measured: ${todayStatus === 'PEAK' ? 'peak' : 'high'} fertility today`
      : confirmed ? 'Ovulation confirmed; this cycle\'s window has closed'
      : fc.inEstimatedWindow ? `Today – ${fmtShort(w.fertileEnd)} · estimate`
      : today < w.fertileStart ? `${fmtShort(w.fertileStart)} – ${fmtShort(w.fertileEnd)} · estimate`
      : `Next: ${fmtShort(fc.projected[0].fertileStart)} – ${fmtShort(fc.projected[0].fertileEnd)} · estimate`;
    fertileCard = h('button', { className: 'hl purple', onclick: () => on.tab('calendar'), 'data-testid': 'fertility-window' }, icon('heart', { size: 30, filled: true }),
      h('div', { className: 'grow' }, h('div', { className: 't' }, 'Fertility Window'), h('div', { className: 's' }, windowText)), icon('chevron'));
    ovCard = h('div', { className: 'hl gold', 'data-testid': 'ovulation-card' }, icon('star', { size: 30, filled: true }),
      h('div', { className: 'grow' }, confirmed
        ? [h('div', { className: 't' }, 'Ovulation confirmed'), h('div', { className: 's' }, ovulationDay ? `Likely around ${fmtLong(ovulationDay)}` : 'Confirmed from your entries')]
        : [h('div', { className: 't' }, fc.daysToOvulation >= 0 ? `Ovulation Predicted ${inDays(fc.daysToOvulation)}` : `Ovulation (estimated) ${inDays(fc.daysToOvulation)}`),
           h('div', { className: 's' }, `(${fmtLong(w.ovulation)}) · estimate`)]));
  }

  const name = firstName(state.user?.name);
  return h('div', {},
    h('div', { className: 'hero' },
      h('span', { className: 'deco', style: 'left:-24px;top:70px' }, flower(110)), h('span', { className: 'deco', style: 'right:-20px;top:150px' }, flower(100, '#ffb3d9', '#c9a0ff')),
      h('div', { className: 'brand' }, h('div', { className: 'name' }, lotus(40), 'Cycle Tracker'),
        h('button', { className: 'icon-btn', onclick: () => on.open('settings/notifications'), 'aria-label': 'Reminders', 'data-testid': 'bell' }, icon('bell'))),
      h('p', { className: 'tagline' }, 'Know Your Body • Embrace Your Cycle'),
      h('div', { className: 'greet' }, h('div', { className: 'avatar' }, initials(state.user?.name)),
        h('div', {}, h('div', { style: 'font-weight:800;font-size:17px' }, `${greeting()}${name ? ` ${name}` : ''}`), h('div', { className: 'muted' }, 'Stay positive, you\'ve got this!'))),
      h('div', { className: 'ringwrap' }, ring({ day: fc?.cycleDay, length: fc?.cycleLength })),
      h('div', { className: 'ring-text', 'data-testid': 'cycle-day' }, fc
        ? [h('div', { style: 'color:#e0559f' }, icon('drop', { filled: true })), h('div', { className: 'muted', style: 'font-weight:700' }, 'Cycle Day'), h('div', { className: 'big' }, fc.cycleDay),
           h('div', { className: 'muted', style: 'font-weight:700' }, `of ${fc.cycleLength}${fc.basis.kind === 'typical' ? ' (typical)' : ''}`)]
        : [h('div', { className: 'big' }, '–'), h('div', { className: 'muted', style: 'font-weight:700' }, 'Cycle Day')]),
      statusLine(state)),
    h('div', { className: 'pad', style: 'margin-top:14px' },
      periodCard, fertileCard, h('div', { className: 'tile-row', style: 'margin:0 0 12px' }, [
        ['Log Period', 'drop', () => on.openLog({ focus: 'period' }), 'tile-period'], ['Log BBT', 'thermo', () => on.openLog({ focus: 'bbt' }), 'tile-bbt'],
        ['Log Hormones', 'hormone', () => on.open('hormones'), 'tile-hormones'], ['Log CM', 'drop', () => on.openLog({ focus: 'cm' }), 'tile-cm'],
      ].map(([label, ic, fn, id]) => h('button', { className: 'tile', onclick: fn, 'data-testid': id }, icon(ic, { size: 26 }), label))),
      ovCard));
}
