/**
 * Lamport logical clock. A device calls `tick()` for every local mutation and
 * `observe()` with the `server_lamport` it receives, so a later local edit can
 * never sort before an event the device has already seen.
 */
export class LamportClock {
  private value: number;

  constructor(initial = 0) {
    if (!Number.isSafeInteger(initial) || initial < 0) throw new RangeError('initial must be a non-negative safe integer');
    this.value = initial;
  }

  /** Current value without advancing. */
  get now(): number {
    return this.value;
  }

  tick(): number {
    if (this.value >= Number.MAX_SAFE_INTEGER) throw new RangeError('Lamport clock exhausted');
    return ++this.value;
  }

  observe(remote: number): number {
    if (!Number.isSafeInteger(remote) || remote < 0) throw new RangeError('remote must be a non-negative safe integer');
    this.value = Math.max(this.value, remote);
    return this.value;
  }
}
