import { publicInfraConfig, readInfraConfig, saveInfraConfig, mergeInfraSecrets } from './config.js';
import { initPostgres, postgresStatus } from './postgres.js';
import { initRedis, redisStatus } from './redis.js';
import { initOss, ossStatus } from './oss.js';
import { initQueue, queueStatus, listJobs } from './queue.js';
import { calendarPgEnabled } from './calendar-pg.js';

export async function bootInfra() {
  const postgres = await initPostgres();
  const redis = await initRedis();
  const oss = await initOss();
  const mq = await initQueue();
  let hydrate = null;
  if (calendarPgEnabled()) {
    try {
      const { hydrateStoreFromPostgres } = await import('../store.js');
      const { readSettings } = await import('../store.js');
      hydrate = await hydrateStoreFromPostgres(readSettings().activeMailboxId);
    } catch (error) {
      hydrate = { ok: false, error: error.message };
    }
  }
  return { postgres, redis, oss, mq, hydrate };
}

export async function reloadInfra(incoming) {
  const merged = mergeInfraSecrets(incoming, readInfraConfig({ force: true }));
  const saved = saveInfraConfig(merged);
  const status = await bootInfra();
  return { config: publicInfraConfig(saved), status };
}

export async function infraHealth() {
  const [postgres, redis, oss, mq] = await Promise.all([
    postgresStatus(),
    redisStatus(),
    ossStatus(),
    queueStatus(),
  ]);
  return {
    config: publicInfraConfig(),
    status: { postgres, redis, oss, mq },
    jobs: listJobs(20),
  };
}

export {
  readInfraConfig,
  publicInfraConfig,
  saveInfraConfig,
  mergeInfraSecrets,
};
