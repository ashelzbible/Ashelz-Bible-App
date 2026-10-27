import type { Settings } from './types.ts';
let mq: MediaQueryList | null = null;
export function applyAppearance(a: Partial<Pick<Settings['appearance'], 'theme' | 'fontSize' | 'highContrast' | 'reduceMotion'>> | undefined) {
  const root = document.documentElement;
  const set = () => {
    const t = a?.theme ?? 'system';
    const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#052E2B' : '#003B32');
  };
  set();
  root.dataset.font = a?.fontSize ?? 'md';
  root.dataset.contrast = a?.highContrast ? 'high' : 'normal';
  root.dataset.motion = a?.reduceMotion ? 'reduced' : 'normal';
  mq?.removeEventListener('change', set);
  mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', set);
  try { localStorage.setItem('wz.appearance', JSON.stringify(a ?? {})); } catch { /* storage unavailable */ }
}
export function applyStoredAppearance() {
  try { applyAppearance(JSON.parse(localStorage.getItem('wz.appearance') ?? '{}')); } catch { applyAppearance(undefined); }
}
