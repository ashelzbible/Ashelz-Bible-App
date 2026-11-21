import { h } from './dom.js';
import { icon } from './icons.js';
import { topbar } from './kit.js';
import { addDays, fmtLong, todayLocal } from '../domain/dates.js';
import { normalText, stepFor, unitLabel } from '../domain/units.js';

export const MUCUS_OPTIONS = [['dry', 'Dry', 0], ['creamy', 'Creamy', 2], ['watery', 'Watery', 3], ['egg', 'Egg White', 4]];
export const SYMPTOM_OPTIONS = [['cramps', 'Cramps'], ['mood_swings', 'Mood Swings'], ['headache', 'Headache'], ['breast_tenderness', 'Breast Tenderness'], ['bloating', 'Bloating'], ['other', 'Other']];

const when = (iso) => (iso === todayLocal() ? `Today, ${fmtLong(iso).slice(5, 11)}` : fmtLong(iso));

export function logView(state, on) {
  const dr = state.draft, unit = state.prefs.unit;
  const lh = state.derived.lhResult(dr.date);
  const isToday = dr.date === todayLocal();

  const section = (id, iconName, title, ...body) => h('div', { className: 'card', id: `sec-${id}` }, h('div', { className: 'sec' }, icon(iconName), title), body);
  const temp = h('input', { type: 'number', id: 'temp', inputmode: 'decimal', step: 'any', value: dr.tempText, 'aria-label': `Basal body temperature in ${unitLabel(unit)}`, 'data-testid': 'temp-input',
    oninput: (e) => on.draft({ tempText: e.target.value }, false) });

  const el = h('div', {},
    topbar('Log Your Day', { back: on.back, right: h('button', { className: 'right', onclick: on.help, 'aria-label': 'Help', 'data-testid': 'log-help' }, icon('help')) }),
    h('div', { className: 'pad' },
      h('div', { className: 'dateline' },
        h('button', { className: 'icon-btn', onclick: () => on.setLogDate(addDays(dr.date, -1)), 'aria-label': 'Previous day', 'data-testid': 'log-prev' }, icon('back')),
        h('input', { type: 'date', id: 'date', value: dr.date, max: todayLocal(), 'aria-label': 'Date', 'data-testid': 'log-date', onchange: (e) => e.target.value && on.setLogDate(e.target.value) }),
        h('button', { className: 'icon-btn', onclick: () => on.setLogDate(addDays(dr.date, 1)), disabled: isToday, 'aria-label': 'Next day', 'data-testid': 'log-next' }, icon('chevron'))),
      h('p', { className: 'muted', style: 'text-align:center;margin:-6px 0 10px' }, when(dr.date)),

      section('period', 'drop', 'Period', h('div', { className: 'seg' },
        h('button', { 'aria-pressed': dr.period ? 'true' : 'false', onclick: () => on.draft({ period: true }), 'data-testid': 'period-yes' }, 'Yes'),
        h('button', { 'aria-pressed': dr.period ? 'false' : 'true', onclick: () => on.draft({ period: false }), 'data-testid': 'period-no' }, 'No'))),

      section('bbt', 'thermo', 'Basal Body Temperature (BBT)',
        h('div', { className: 'stepper' },
          h('button', { className: 'step', onclick: () => on.stepTemp(-1), 'aria-label': 'Lower', 'data-testid': 'temp-minus' }, icon('minus')),
          temp, h('span', { style: 'font-weight:800' }, unitLabel(unit)),
          h('button', { className: 'step', onclick: () => on.stepTemp(1), 'aria-label': 'Higher', 'data-testid': 'temp-plus' }, icon('plus'))),
        h('p', { className: 'muted', style: 'margin:6px 0 0' }, normalText(unit)),
        h('label', { className: 'check', for: 'disturbed' }, h('input', { type: 'checkbox', id: 'disturbed', checked: dr.disturbed, onchange: (e) => on.draft({ disturbed: e.target.checked }, false), 'data-testid': 'disturbed' }), 'Slept badly or was unwell (this reading will be ignored)')),

      section('cm', 'drop', 'Cervical Mucus (CM)', h('div', { className: 'opts four', role: 'group', 'aria-label': 'Cervical mucus' },
        MUCUS_OPTIONS.map(([id, label, score]) => h('button', { className: 'opt', 'aria-pressed': dr.mucus === score ? 'true' : 'false', onclick: () => on.draft({ mucus: dr.mucus === score ? null : score }), 'data-testid': `mucus-${id}` },
          h('span', { className: 'circle' }, icon('drop', { size: 26, filled: score >= 3 })), label)))),

      section('lh', 'hormone', 'LH Test Result',
        h('div', { className: 'chips', 'data-testid': 'lh-result', role: 'group', 'aria-label': 'LH test result (from your hormone values)' },
          ['Negative', 'Positive', 'Not Tested'].map((label) => h('span', { className: `chip static${label === lh ? ' on' : ''}`, 'aria-current': label === lh ? 'true' : undefined }, label))),
        h('p', { className: 'muted', style: 'margin:8px 0' }, 'Worked out from the LH value you enter on the Hormones screen.'),
        h('button', { className: 'btn secondary full', onclick: () => on.open('hormones', { date: dr.date }), 'data-testid': 'to-hormones' }, 'Enter hormone values')),

      section('symptoms', 'heart', 'Symptoms (optional)', h('div', { className: 'chips', role: 'group', 'aria-label': 'Symptoms' },
        SYMPTOM_OPTIONS.map(([id, label]) => h('button', { className: 'chip', 'aria-pressed': dr.symptoms.has(id) ? 'true' : 'false', onclick: () => on.toggleSymptom(id), 'data-testid': `sym-${id}` }, label)))),

      h('p', { className: dr.msgKind === 'error' ? 'error' : 'ok', role: 'status', 'data-testid': 'log-msg' }, dr.msg ?? ''),
      h('button', { className: 'btn full', onclick: on.saveDay, 'data-testid': 'save-day' }, h('span', {}, icon('check', { size: 18 }), ' '), isToday ? 'Save Today' : 'Save Day')));

  const focus = state.route.params?.focus;
  if (focus) queueMicrotask(() => document.getElementById(`sec-${focus}`)?.scrollIntoView({ block: 'center' }));
  return el;
}

export function hormonesView(state, on) {
  const dr = state.draftH;
  const field = (id, label, unit, key) => [h('label', { for: id }, `${label} (${unit})`),
    h('input', { type: 'number', id, inputmode: 'decimal', step: 'any', min: '0', value: dr[key], 'data-testid': `hormone-${id}`, oninput: (e) => { dr[key] = e.target.value; } })];
  return h('div', {}, topbar('Hormones', { back: on.back }),
    h('div', { className: 'pad' },
      h('div', { className: 'dateline' },
        h('button', { className: 'icon-btn', onclick: () => on.setHormoneDate(addDays(dr.date, -1)), 'aria-label': 'Previous day' }, icon('back')),
        h('input', { type: 'date', value: dr.date, max: todayLocal(), 'aria-label': 'Date', 'data-testid': 'hormone-date', onchange: (e) => e.target.value && on.setHormoneDate(e.target.value) }),
        h('button', { className: 'icon-btn', onclick: () => on.setHormoneDate(addDays(dr.date, 1)), disabled: dr.date === todayLocal(), 'aria-label': 'Next day' }, icon('chevron'))),
      h('div', { className: 'card' }, h('div', { className: 'sec' }, icon('hormone'), 'First-morning urine test'),
        h('p', { className: 'muted', style: 'margin:0 0 6px' }, 'Enter the numbers from your monitor. Leave a box empty if you did not test it.'),
        field('lh', 'LH', 'mIU/mL', 'lh'), field('e3g', 'E3G', 'ng/mL', 'e3g'), field('pdg', 'PdG', 'µg/mL', 'pdg'),
        h('p', { className: 'muted', style: 'margin:10px 0 0' }, `Read with the "${state.profileName}" threshold set (change it in Settings → Cycle Preferences).`)),
      h('p', { className: dr.msgKind === 'error' ? 'error' : 'ok', role: 'status', 'data-testid': 'hormone-msg' }, dr.msg ?? ''),
      h('button', { className: 'btn full', onclick: on.saveHormones, 'data-testid': 'save-hormones' }, 'Save hormone values')));
}
