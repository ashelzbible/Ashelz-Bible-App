import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { HttpEngineClient } from './engine-client.js';
import { RecalcWorker } from './recalc.js';

const config = loadConfig();
if (!config.workerDatabaseUrl) throw new Error('WORKER_DATABASE_URL is required to run the recalculation worker');

const pool = createPool(config.workerDatabaseUrl, 4);
const log = {
  info: (o: object, m?: string) => console.log(JSON.stringify({ level: 'info', msg: m, ...o })),
  error: (o: object, m?: string) => console.error(JSON.stringify({ level: 'error', msg: m, ...o })),
};
const worker = new RecalcWorker(pool, new HttpEngineClient(config.engineUrl, config.engineToken), log, config.assayProfile);

const stop = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => stop.abort());

log.info({ assay_profile: config.assayProfile }, 'recalculation worker started');
await worker.start(stop.signal);
await pool.end();
