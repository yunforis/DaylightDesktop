import { publicInfraConfig, readInfraConfig, saveInfraConfig, mergeInfraSecrets } from './config.js';
import { initPostgres, postgresStatus, postgresRuntimeReady, closePostgres } from './postgres.js';
import { initRedis, redisStatus, closeRedis } from './redis.js';
import { initOss, ossStatus, closeOss } from './oss.js';
import { initQueue, queueStatus, listJobs } from './queue.js';
import { calendarPgEnabled } from './calendar-pg.js';
import { isProductionRuntime } from '../runtime-mode.js';

let jobsTransportStatus = null;

// The jobs runtime owns the connection. Absence of its observation is not success.
export function setJobsTransportStatus(check) { jobsTransportStatus = check; }
async function productionQueueStatus() {
  if (!jobsTransportStatus) return { ok: false, mode: 'unobserved', required: false, fallback: 'database-polling' };
  try { return { ...await jobsTransportStatus(), required: false, fallback: 'database-polling' }; }
  catch (error) { return { ok: false, mode: 'unavailable', required: false, fallback: 'database-polling', error: error.message }; }
}

export async function sharedRuntimeReady({ requireSettings = true, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.all([
        postgresRuntimeReady({ requireSettings }),
        redisStatus(),
        ossStatus({ signal: controller.signal }),
      ]).then(([postgres, redis, oss]) => postgres && redis.ok && redis.mode === 'redis'
        && oss.ok && !['local', 'unavailable'].includes(oss.mode)),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, Math.min(5000, Math.max(1, timeoutMs))); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function closeInfra({ timeoutMs = 1000 } = {}) {
  // Start every close even if another resource's cleanup rejects.
  const results = await Promise.allSettled([
    closeRedis({ timeoutMs }), Promise.resolve().then(closeOss), closePostgres(),
  ]);
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Infrastructure cleanup failed');
}

export async function bootInfra() {
  const postgres = await initPostgres();
  const redis = await initRedis();
  const oss = await initOss();
  // Production jobs are owned by the durable jobs runtime, never the legacy queue.
  const mq = isProductionRuntime() ? await productionQueueStatus() : await initQueue();
  let hydrate = null;
  if (!isProductionRuntime() && calendarPgEnabled()) {
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
    isProductionRuntime() ? productionQueueStatus() : queueStatus(),
  ]);
  return {
    config: publicInfraConfig(),
    status: { postgres, redis, oss, mq },
    jobs: isProductionRuntime() ? [] : listJobs(20),
  };
}

export {
  readInfraConfig,
  publicInfraConfig,
  saveInfraConfig,
  mergeInfraSecrets,
};
