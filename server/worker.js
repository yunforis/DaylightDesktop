import { bootInfra, readInfraConfig, sharedRuntimeReady, setJobsTransportStatus } from './infra/index.js';
import { getPostgresPool } from './infra/postgres.js';
import { jobRepository, createPlanHandler, createMailHandler } from './job-service.js';
import { createCalendarHandler } from './calendar-job.js';
import { JobWorker, describeFailure } from './jobs/runtime.js';
import { JobTransport } from './jobs/rabbit.js';
import { isProductionRuntime } from './runtime-mode.js';
import { serviceHealth, startHealthServer, installShutdown } from './service-health.js';

if (!isProductionRuntime()) throw new Error('Worker requires DAYLIGHT_RUNTIME=production');
const health = serviceHealth({ role: 'worker', checkReady: async () => {
  if (!await sharedRuntimeReady()) return false;
  await getPostgresPool().query('SELECT 1 FROM daylight_jobs LIMIT 1');
  return true;
} });
const server = startHealthServer(health);
await bootInfra();
const repository = jobRepository();
const controller = new AbortController();
// A mailbox sync processes every message sequentially through the model, so a large
// mailbox on a slow reasoning model can outlive the default guard. The lease is renewed
// by heartbeat, so a longer budget is safe; misconfiguration must not silently win.
const jobTimeoutMs = () => {
  const raw = Number(process.env.DAYLIGHT_JOB_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 300_000;
  if (raw < 10_000 || raw > 3_600_000) throw new Error('DAYLIGHT_JOB_TIMEOUT_MS must be between 10000 and 3600000');
  return Math.floor(raw);
};
const onError = (error, context = {}) => console.error('Worker dependency/task failure', {
  code: error.code || 'TASK_FAILED',
  reason: describeFailure(error, 200),
  ...context,
});
const worker = new JobWorker(repository, {
  'scenario.plan': createPlanHandler(repository),
  'mailbox.sync': createMailHandler(repository),
  'calendar.sync': createCalendarHandler(repository),
}, { onError, timeoutMs: jobTimeoutMs() });
const transport = new JobTransport(repository, { url: readInfraConfig().mq.url, onError });
setJobsTransportStatus(() => transport.status());
const running = [worker.run({ signal: controller.signal }), transport.run({ signal: controller.signal })];
health.started();
installShutdown({ health, server, stop: async () => {
  controller.abort();
  await Promise.allSettled(running);
  setJobsTransportStatus(null);
} });
