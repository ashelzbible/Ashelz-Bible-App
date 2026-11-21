// Temperatures are always stored in degrees Celsius; Fahrenheit is a display choice only.
export const cToF = (c) => (c * 9) / 5 + 32;
export const fToC = (f) => ((f - 32) * 5) / 9;
const round = (x, n) => Number(x.toFixed(n));

/** Display value for a stored Celsius temperature. */
export const toDisplay = (c, unit) => (unit === 'F' ? round(cToF(c), 1) : round(c, 2));
/** Stored Celsius value (2 decimals) from what the user typed in their unit. */
export const fromDisplay = (v, unit) => round(unit === 'F' ? fToC(v) : v, 2);
export const unitLabel = (unit) => (unit === 'F' ? '°F' : '°C');
/** Step of the +/- buttons: 0.05 °C or 0.1 °F. */
export const stepFor = (unit) => (unit === 'F' ? 0.1 : 0.05);
export const decimalsFor = (unit) => (unit === 'F' ? 1 : 2);
export const NORMAL_C = [36.3, 37.2]; // typical range shown as a hint; a normal reading, not a diagnosis
export const normalText = (unit) => `Normal: ${toDisplay(NORMAL_C[0], unit).toFixed(1)} – ${toDisplay(NORMAL_C[1], unit).toFixed(1)} ${unitLabel(unit)}`;
export const PLAUSIBLE_C = [34, 42];
