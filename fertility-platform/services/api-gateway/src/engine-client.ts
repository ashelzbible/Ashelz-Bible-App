import type { PredictionDay } from '@fertility/sync-protocol';

export interface AnalyzeRequest {
  /** Assay profile (threshold set); the engine rejects unknown names. */
  profile?: string;
  bbt: Array<{ day: string; temp_c: number; sleep_disrupted: boolean }>;
  hormones: Array<{ day: string; lh_miu_ml?: number; e3g_ng_ml?: number; pdg_ug_ml?: number }>;
  mucus: Array<{ day: string; score: number }>;
}

export interface AnalyzeResponse {
  algorithm_version: string;
  input_hash: string;
  ovulation_confirmed_on: string | null;
  anovulatory_pattern_suspected: boolean;
  days: Array<{ day: string; status: PredictionDay['status']; flags: string[]; reasoning: string[] }>;
}

export interface EngineClient {
  analyze(req: AnalyzeRequest): Promise<AnalyzeResponse>;
}

/** Thrown when the engine rejects the input (4xx); retrying cannot help. */
export class EngineRejectedError extends Error {}

export class HttpEngineClient implements EngineClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 15000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    const res = await this.fetchImpl(new URL('/v1/analyze', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-engine-token': this.token },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status >= 400 && res.status < 500) throw new EngineRejectedError(`engine rejected request (${res.status})`);
    if (!res.ok) throw new Error(`engine unavailable (${res.status})`);
    return (await res.json()) as AnalyzeResponse;
  }
}
