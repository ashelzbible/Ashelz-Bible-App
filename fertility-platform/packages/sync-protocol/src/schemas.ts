import { z } from 'zod';

/** Maximum events accepted per push; larger offline backlogs are sent in batches. */
export const MAX_PUSH_EVENTS = 500;
export const MAX_PULL_LIMIT = 500;

export const uuid = z.string().uuid();

/** Calendar date YYYY-MM-DD that actually exists (rejects 2025-02-30). */
export const logDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'not a real calendar date');

/** UTC instant, e.g. 2025-03-01T06:30:00Z (offsets are rejected on purpose). */
export const utcTimestamp = z.string().datetime({ offset: false });

export const lamport = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const bbtPayload = z
  .object({
    temp_c: z.number().finite().min(34).max(42),
    sleep_disrupted: z.boolean().default(false),
  })
  .strict();

const assay = z.number().finite().min(0).max(100000);
export const hormonePayload = z
  .object({
    lh_miu_ml: assay.optional(),
    e3g_ng_ml: assay.optional(),
    pdg_ug_ml: assay.optional(),
  })
  .strict()
  .refine((p) => p.lh_miu_ml !== undefined || p.e3g_ng_ml !== undefined || p.pdg_ug_ml !== undefined, {
    message: 'at least one analyte is required',
  });

export const mucusPayload = z.object({ score: z.number().int().min(0).max(4) }).strict();

/** First day of menstrual bleeding: starts a new cycle and bounds the engine's analysis window. */
export const cyclePayload = z.object({}).strict();

const base = {
  event_id: uuid,
  device_id: uuid,
  lamport,
  client_ts: utcTimestamp,
  log_date: logDate,
};

const setEvent = <K extends string, P extends z.ZodTypeAny>(kind: K, payload: P) =>
  z.object({ ...base, kind: z.literal(kind), op: z.literal('SET'), payload }).strict();

const retractEvent = <K extends string>(kind: K) =>
  z.object({ ...base, kind: z.literal(kind), op: z.literal('RETRACT') }).strict();

/** One client mutation. SET assigns the value of (kind, log_date); RETRACT withdraws it. */
export const syncEventSchema = z.union([
  setEvent('BBT', bbtPayload),
  setEvent('HORMONE', hormonePayload),
  setEvent('MUCUS', mucusPayload),
  setEvent('CYCLE', cyclePayload),
  retractEvent('BBT'),
  retractEvent('HORMONE'),
  retractEvent('MUCUS'),
  retractEvent('CYCLE'),
]);

export const pushRequestSchema = z
  .object({ events: z.array(syncEventSchema).min(1).max(MAX_PUSH_EVENTS) })
  .strict();

export const pullQuerySchema = z
  .object({
    cursor: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).default(200),
    /** Clinicians name the patient (user uuid); patients must omit it. */
    patient_id: uuid.optional(),
  })
  .strict();

export type EventKind = 'BBT' | 'HORMONE' | 'MUCUS' | 'CYCLE';
export type SyncEvent = z.infer<typeof syncEventSchema>;
export type PushRequest = z.infer<typeof pushRequestSchema>;
export type PullQuery = z.infer<typeof pullQuerySchema>;

export interface PushConflict {
  event_id: string;
  reason: 'EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT';
}

export interface PushResponse {
  /** Newly stored events. */
  accepted: string[];
  /** Already stored with identical content (safe retry); nothing changed. */
  duplicates: string[];
  /** Rejected: the event_id exists with different content. History is never overwritten. */
  conflicts: PushConflict[];
  /** Highest Lamport value the server holds for this subject; clients fast-forward to it. */
  server_lamport: number;
  recalculation: 'queued' | 'none';
}

export interface ServerEvent {
  server_seq: number;
  event_id: string;
  device_id: string;
  lamport: number;
  client_ts: string;
  kind: EventKind;
  op: 'SET' | 'RETRACT';
  log_date: string;
  payload: Record<string, unknown>;
}

export interface PredictionDay {
  log_date: string;
  status: 'LOW' | 'HIGH' | 'PEAK' | 'OVULATION_CONFIRMED' | 'INSUFFICIENT_DATA';
  flags: string[];
  reasoning: string[];
}

export interface PredictionSnapshot {
  algorithm_version: string;
  computed_at: string;
  ovulation_confirmed_on: string | null;
  anovulatory_pattern_suspected: boolean;
  days: PredictionDay[];
}

export interface PullResponse {
  events: ServerEvent[];
  /** Pass back as `cursor` to continue. */
  next_cursor: number;
  has_more: boolean;
  server_lamport: number;
  /** Latest deterministic engine output, or null if none has been computed yet. */
  predictions: PredictionSnapshot | null;
}
