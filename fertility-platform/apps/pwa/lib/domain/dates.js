import { addDays, ord } from '../engine/engine.js';

export { addDays, ord };
export const diffDays = (a, b) => ord(a) - ord(b); // a - b in days

export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = DAYS;
const parts = (iso) => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }; };

/** "Tue, 09 Dec 2026" */
export function fmtLong(iso) { const p = parts(iso); return `${DAYS[p.dow]}, ${String(p.d).padStart(2, '0')} ${MONTHS[p.m - 1].slice(0, 3)} ${p.y}`; }
/** "05 Dec" */
export function fmtShort(iso) { const p = parts(iso); return `${String(p.d).padStart(2, '0')} ${MONTHS[p.m - 1].slice(0, 3)}`; }
/** "November 2026" */
export function monthTitle(y, m) { return `${MONTHS[m]} ${y}`; } // m is 0-based
export const dowOf = (iso) => parts(iso).dow;
export const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; // m is 0-based
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
