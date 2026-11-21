import { describe, expect, it } from 'vitest';
import {
  LamportClock,
  canonicalJson,
  compareEvents,
  effectiveEvents,
  logDate,
  pullQuerySchema,
  pushRequestSchema,
  syncEventSchema,
  type OrderedEvent,
} from '../src/index.js';

const ids = {
  event_id: '0b8e3f0e-6f1c-4c43-9d8e-2d6f8d1d0001',
  device_id: 'd0000000-0000-4000-8000-000000000001',
};
const bbt = (over: Record<string, unknown> = {}) => ({
  ...ids,
  lamport: 1,
  client_ts: '2025-03-01T06:30:00Z',
  kind: 'BBT',
  op: 'SET',
  log_date: '2025-03-01',
  payload: { temp_c: 36.5 },
  ...over,
});

describe('event schema', () => {
  it('accepts valid events of each kind and a retraction', () => {
    expect(syncEventSchema.safeParse(bbt()).success).toBe(true);
    expect(syncEventSchema.safeParse(bbt({ kind: 'HORMONE', payload: { lh_miu_ml: 12.5 } })).success).toBe(true);
    expect(syncEventSchema.safeParse(bbt({ kind: 'MUCUS', payload: { score: 4 } })).success).toBe(true);
    expect(syncEventSchema.safeParse(bbt({ kind: 'CYCLE', payload: {} })).success).toBe(true);
    const { payload, ...retract } = bbt({ op: 'RETRACT' });
    expect(payload).toBeDefined();
    expect(syncEventSchema.safeParse(retract).success).toBe(true);
  });

  it('defaults sleep_disrupted to false', () => {
    const r = syncEventSchema.parse(bbt());
    expect((r as { payload: { sleep_disrupted: boolean } }).payload.sleep_disrupted).toBe(false);
  });

  it.each([
    ['impossible temperature', bbt({ payload: { temp_c: 12 } })],
    ['NaN temperature', bbt({ payload: { temp_c: Number.NaN } })],
    ['mucus out of range', bbt({ kind: 'MUCUS', payload: { score: 5 } })],
    ['payload kind mismatch', bbt({ kind: 'MUCUS', payload: { temp_c: 36.5 } })],
    ['empty hormone payload', bbt({ kind: 'HORMONE', payload: {} })],
    ['negative hormone', bbt({ kind: 'HORMONE', payload: { pdg_ug_ml: -1 } })],
    ['cycle start with data', bbt({ kind: 'CYCLE', payload: { flow: 3 } })],
    ['unknown payload field', bbt({ payload: { temp_c: 36.5, name: 'x' } })],
    ['unknown envelope field', bbt({ extra: 1 })],
    ['non-uuid event id', bbt({ event_id: 'abc' })],
    ['negative lamport', bbt({ lamport: -1 })],
    ['fractional lamport', bbt({ lamport: 1.5 })],
    ['offset timestamp', bbt({ client_ts: '2025-03-01T06:30:00+02:00' })],
    ['local timestamp', bbt({ client_ts: '2025-03-01T06:30:00' })],
    ['impossible date', bbt({ log_date: '2025-02-30' })],
    ['retract carrying a payload', bbt({ op: 'RETRACT' })],
    ['SET without payload', (() => { const { payload, ...r } = bbt(); void payload; return r; })()],
  ])('rejects %s', (_name, ev) => {
    expect(syncEventSchema.safeParse(ev).success).toBe(false);
  });

  it('validates real calendar dates incl. leap years', () => {
    expect(logDate.safeParse('2024-02-29').success).toBe(true);
    expect(logDate.safeParse('2025-02-29').success).toBe(false);
    expect(logDate.safeParse('2025-13-01').success).toBe(false);
    expect(logDate.safeParse('25-1-1').success).toBe(false);
  });
});

describe('push/pull requests', () => {
  it('bounds batch size', () => {
    expect(pushRequestSchema.safeParse({ events: [] }).success).toBe(false);
    expect(pushRequestSchema.safeParse({ events: Array.from({ length: 501 }, () => bbt()) }).success).toBe(false);
    expect(pushRequestSchema.safeParse({ events: [bbt()] }).success).toBe(true);
  });

  it('coerces and bounds pull query strings', () => {
    expect(pullQuerySchema.parse({})).toEqual({ cursor: 0, limit: 200 });
    expect(pullQuerySchema.parse({ cursor: '42', limit: '10' })).toEqual({ cursor: 42, limit: 10 });
    expect(pullQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(pullQuerySchema.safeParse({ cursor: '-1' }).success).toBe(false);
    expect(pullQuerySchema.safeParse({ patient_id: 'nope' }).success).toBe(false);
  });
});

describe('LamportClock', () => {
  it('ticks monotonically and fast-forwards on observe', () => {
    const c = new LamportClock();
    expect([c.tick(), c.tick()]).toEqual([1, 2]);
    expect(c.observe(10)).toBe(10);
    expect(c.observe(3)).toBe(10); // never goes backwards
    expect(c.tick()).toBe(11);
    expect(c.now).toBe(11);
  });

  it('validates input', () => {
    expect(() => new LamportClock(-1)).toThrow(RangeError);
    expect(() => new LamportClock().observe(1.5)).toThrow(RangeError);
    expect(() => new LamportClock(Number.MAX_SAFE_INTEGER).tick()).toThrow(RangeError);
  });
});

describe('deterministic conflict resolution', () => {
  const ev = (event_id: string, lamport: number, over: Partial<OrderedEvent> = {}): OrderedEvent => ({
    event_id,
    device_id: 'd0000000-0000-4000-8000-000000000001',
    lamport,
    kind: 'BBT',
    op: 'SET',
    log_date: '2025-03-01',
    ...over,
  });

  it('orders by lamport, then device, then event id', () => {
    expect(compareEvents(ev('a', 1), ev('b', 2))).toBe(-1);
    expect(compareEvents(ev('a', 2), ev('b', 1))).toBe(1);
    expect(compareEvents(ev('a', 1, { device_id: 'A' }), ev('a', 1, { device_id: 'B' }))).toBe(-1);
    expect(compareEvents(ev('a', 1, { device_id: 'B' }), ev('a', 1, { device_id: 'A' }))).toBe(1);
    expect(compareEvents(ev('a', 1), ev('b', 1))).toBe(-1);
    expect(compareEvents(ev('b', 1), ev('a', 1))).toBe(1);
    expect(compareEvents(ev('a', 1), ev('A', 1))).toBe(0); // case-insensitive uuids
  });

  it('keeps the highest event per (kind, log_date) regardless of arrival order', () => {
    const log = [ev('e1', 1), ev('e3', 3), ev('e2', 2), ev('m1', 1, { kind: 'MUCUS' }), ev('d2', 1, { log_date: '2025-03-02' })];
    const fwd = effectiveEvents(log).map((e) => e.event_id);
    const rev = effectiveEvents([...log].reverse()).map((e) => e.event_id);
    expect(fwd).toEqual(['e3', 'm1', 'd2']);
    expect(rev).toEqual(fwd);
  });

  it('a winning RETRACT removes the entry; a later SET restores it', () => {
    const retracted = effectiveEvents([ev('e1', 1), ev('r', 2, { op: 'RETRACT' })]);
    expect(retracted).toEqual([]);
    const restored = effectiveEvents([ev('e1', 1), ev('r', 2, { op: 'RETRACT' }), ev('e3', 3)]);
    expect(restored.map((e) => e.event_id)).toEqual(['e3']);
  });

  it('does not mutate its input', () => {
    const log = [ev('e2', 2), ev('e1', 1)];
    const copy = structuredClone(log);
    effectiveEvents(log);
    expect(log).toEqual(copy);
  });
});

describe('canonicalJson', () => {
  it('is key-order independent and recursive', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  });
  it('drops undefined properties and rejects non-JSON values', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});
