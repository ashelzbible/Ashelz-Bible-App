import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { HttpEngineClient } from './engine-client.js';
import { IdentityStore } from './identity-store.js';
import { StoreIdentityService } from './identity-service.js';
import { RecalcWorker } from './recalc.js';
import { buildApp } from './server.js';
import { PgPhiStore } from './store.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const identityPool = config.identityDatabaseUrl ? createPool(config.identityDatabaseUrl, 4) : undefined;
const identity = identityPool ? new StoreIdentityService(new IdentityStore(identityPool, config.fieldEncryptionKey, config.emailHashKey)) : undefined;
const app = await buildApp({ config, store: new PgPhiStore(pool), identity, logger: true });

// Optional in-process recalculation worker (single-container deployments). It uses its own
// database login (engine_worker), so database privileges stay separated from the API's.
const stop = new AbortController();
let workerPool: ReturnType<typeof createPool> | undefined;
let workerLoop: Promise<void> | undefined;
if (config.runWorker) {
  if (!config.workerDatabaseUrl) throw new Error('RUN_WORKER=true requires WORKER_DATABASE_URL');
  workerPool = createPool(config.workerDatabaseUrl, 4);
  const log = { info: (o: object, m?: string) => app.log.info(o, m), error: (o: object, m?: string) => app.log.error(o, m) };
  workerLoop = new RecalcWorker(workerPool, new HttpEngineClient(config.engineUrl, config.engineToken), log, config.assayProfile).start(stop.signal);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  stop.abort();
  await app.close();
  await workerLoop;
  await Promise.all([pool.end(), identityPool?.end(), workerPool?.end()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
