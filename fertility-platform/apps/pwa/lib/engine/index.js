import { effectiveEvents } from '../../vendor/sync-protocol/order.js';
import { ALGORITHM_VERSION, analyzeCycle } from './engine.js';
import { DEFAULT_PROFILE, getProfile } from './profiles.js';
import { buildWindow } from './window.js';

export { DEFAULT_PROFILE, getProfile };

/**
 * Compute the daily fertility timeline for the current cycle from the device's own events. Same shape the server
 * stores, so the app shows identical results whether or not it ever talks to a server.
 */
export function computePredictions(events, profileName = DEFAULT_PROFILE.name) {
  const profile = getProfile(profileName);
  const built = buildWindow(effectiveEvents(events));
  if (!built) return null;
  const { bbt, hormones, mucus } = built.request;
  const r = analyzeCycle(bbt, hormones, mucus, profile);
  return {
    algorithm_version: `${ALGORITHM_VERSION}+${profile.name}`,
    computed_at: new Date().toISOString(),
    computed_on: 'device',
    ovulation_confirmed_on: r.ovulation_confirmed_on,
    anovulatory_pattern_suspected: r.anovulatory_pattern_suspected,
    days: r.days.map((d) => ({ log_date: d.day, status: d.status, flags: d.flags, reasoning: d.reasoning })),
  };
}
