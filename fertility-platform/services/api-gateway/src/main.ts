import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { buildApp } from './server.js';
import { PgPhiStore } from './store.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ config, store: new PgPhiStore(pool), logger: true });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
