// Daily "log your day" reminder using the Android app's local-notification plugin. Nothing here runs in a browser.
// NOTE: written against the plugin's documented API and not run on a device from the build environment.
const ID = 1;
const cap = () => (typeof window !== 'undefined' ? window.Capacitor : undefined);
export const reminderSupported = () => !!(cap()?.isNativePlatform?.() && (cap().nativePromise || cap().Plugins?.LocalNotifications));

function call(method, options) {
  const c = cap();
  if (c?.Plugins?.LocalNotifications?.[method]) return c.Plugins.LocalNotifications[method](options);
  return c.nativePromise('LocalNotifications', method, options);
}

/** Turn the daily reminder on (at HH:MM) or off. Returns { ok, reason? }. The notification text holds no health information. */
export async function applyReminder({ enabled, time }) {
  if (!reminderSupported()) return { ok: false, reason: 'unsupported' };
  try {
    await call('cancel', { notifications: [{ id: ID }] }).catch(() => undefined);
    if (!enabled) return { ok: true };
    const perm = await call('requestPermissions', {});
    if (perm?.display !== 'granted') return { ok: false, reason: 'denied' };
    const [hour, minute] = time.split(':').map(Number);
    await call('schedule', { notifications: [{ id: ID, title: 'Cycle Tracker', body: 'Time to log your day.', schedule: { on: { hour, minute }, allowWhileIdle: true } }] });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
