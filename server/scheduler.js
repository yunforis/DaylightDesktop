import { bootInfra, sharedRuntimeReady } from './infra/index.js';
import { getPostgresPool } from './infra/postgres.js';
import { jobRepository, scheduleMailboxes } from './job-service.js';
import { scheduleExternalCalendars } from './calendar-job.js';
import { pause } from './jobs/runtime.js';
import { isProductionRuntime } from './runtime-mode.js';
import { serviceHealth, startHealthServer, installShutdown } from './service-health.js';

if (!isProductionRuntime()) throw new Error('Scheduler requires DAYLIGHT_RUNTIME=production');
const health = serviceHealth({ role: 'scheduler', checkReady: async () => {
  if (!await sharedRuntimeReady()) return false;
  await getPostgresPool().query('SELECT 1 FROM daylight_jobs LIMIT 1');
  return true;
} });
const server = startHealthServer(health);
await bootInfra();
const repository = jobRepository();
const controller = new AbortController();
const running = (async () => {
  while (!controller.signal.aborted) {
    try {
      const mail = await scheduleMailboxes(repository);
      if (mail.scheduled || mail.deferred) console.log('Scheduled mailboxes', mail);
    } catch (error) { console.error('Scheduler dependency failure', { code: error.code || 'SCHEDULE_FAILED', reason: error.message }); }
    try { await scheduleExternalCalendars(repository); }
    catch (error) { console.error('Calendar scheduler dependency failure', { code: error.code || 'CALENDAR_SCHEDULE_FAILED', reason: error.message }); }
    await pause(60000 - Date.now() % 60000, controller.signal);
  }
})();
health.started();
installShutdown({ health, server, stop: async () => {
  controller.abort();
  await running;
} });
