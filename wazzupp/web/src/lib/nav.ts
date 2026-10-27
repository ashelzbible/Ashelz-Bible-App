/** Navigation state. Normally the URL hash; the in-page demo keeps it in memory because hosted frames only allow plain "#name" hashes. */
const demo = () => !!(window as any).__WZ_DEMO__;
let mem = '';
const stack: string[] = [];
export const getHash = () => (demo() ? mem : location.hash);
export function setHash(h: string) {
  if (!demo()) { if (location.hash !== h) location.hash = h; return; }
  if (mem !== h) { stack.push(mem); mem = h; window.dispatchEvent(new Event('wz-nav')); }
}
export function replaceHash(h: string) {
  if (!demo()) { history.replaceState(null, '', h); window.dispatchEvent(new HashChangeEvent('hashchange')); return; }
  mem = h; window.dispatchEvent(new Event('wz-nav'));
}
export function backHash() {
  if (!demo()) { history.back(); return; }
  mem = stack.pop() ?? ''; window.dispatchEvent(new Event('wz-nav'));
}
export function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb); window.addEventListener('wz-nav', cb);
  return () => { window.removeEventListener('hashchange', cb); window.removeEventListener('wz-nav', cb); };
}
