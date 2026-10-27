import { startIceRefresh } from './lib/ice.ts';
import { Redis } from 'ioredis';
import { buildApp } from './app.ts';
import { config } from './config.ts';
import { migrate } from './db/migrate.ts';
import { pool, setPublisher } from './db/pool.ts';
import { hub } from './lib/hub.ts';
import { useRedisRateLimit } from './lib/ratelimit.ts';
import { attachWebSocket } from './ws.ts';
import { startWorker, stopWorker } from './modules/jobs.ts';

async function main() {
  await migrate();
  await hub.start(config.redisUrl);
  if (config.redisUrl) useRedisRateLimit(new Redis(config.redisUrl));
  setPublisher((events) => hub.send(events.map((e) => ({ userId: e.userId, msg: { t: 'event', id: e.id, type: e.type, payload: e.payload } }))));

  const app = await buildApp();
  startIceRefresh();
  await app.listen({ port: config.port, host: config.host });
  const ws = attachWebSocket(app.server);
  if (process.env.DISABLE_WORKER !== 'true') startWorker();

  const stop = async () => {
    stopWorker(); ws.close(); await app.close(); await hub.stop(); await pool.end(); process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
