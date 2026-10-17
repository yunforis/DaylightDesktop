# Durable job interfaces

These modules are infrastructure primitives. They are not yet connected to mailbox sync,
calendar writes, SMTP, API routes or the deployment entrypoint. The integrating session
must update the project README/STATUS for the actual final integration.

```js
import { migrateJobs } from './schema.js';
import { JobRepository } from './repository.js';
import { JobWorker } from './runtime.js';
import { JobTransport } from './rabbit.js';

await migrateJobs(pool);
const jobs = new JobRepository(pool, { leaseMs: 60000 });
const controller = new AbortController();
const worker = new JobWorker(jobs, {
  'mailbox.sync': async (job, context) => {
    const saved = await context.steps();
    context.signal.throwIfAborted();
    // Pure computation / cancellable reads can use job.payload and saved checkpoints.
    await context.checkpoint('persist', { version: 1 }, async (client, current) => {
      // Write business rows with THIS client; checkpoint + effects commit atomically.
      // current.tenant_id / owner_id / mailbox_id are authoritative scope.
      // Do not call a model, IMAP, SMTP or any network API inside this callback.
    });
    return { completed: true };
  },
});
const transport = new JobTransport(jobs, { url: process.env.RABBITMQ_URL });
const running = [worker.run({ signal: controller.signal }), transport.run({ signal: controller.signal })];
// Shutdown: controller.abort(); await Promise.all(running);
```

- `enqueue({tenantId, ownerId, mailboxId, kind, idempotencyKey, payload, maxAttempts, availableAt})`
  atomically commits a job and its outbox row. Returns `{job, created}`; duplicate keys
  are scoped to tenant + mailbox, and cannot be reused by a different owner/kind.
- User-facing reads/mutations: `getOwned`, `listOwned`, `cancelOwned`, `retryOwned`.
  The API must derive owner and tenant from authentication, verify mailbox ownership
  and validate allowed kinds/payload. Repository methods do not implement authentication.
- Worker claim, heartbeat, steps, checkpoint, complete and fail are privileged APIs.
  `checkpoint(id, token, name, result, write)` and `complete(id, token, result, write)`
  fence DB writes by lease token and recheck expiry before commit. Existing checkpoint
  names return their saved result and do not run `write` again. Manual retry retains
  checkpoints and generation; use a new key for intentionally new business work.
- Enqueues serialize per tenant + mailbox. Pending jobs execute in enqueue sequence;
  a delayed retry blocks later jobs in that mailbox until terminal. Other mailboxes
  can execute concurrently via additional worker instances. This is enqueue order,
  not message date order: a sync handler must sort emails oldest first before processing.
  Existing legacy rows receive sequence during migration; historical date ordering
  must be audited before migrating a live backlog.
- DB polling/recovery makes notifications advisory. Transport uses a durable queue,
  persistent messages and per-message publisher confirms. It marks outbox published
  only after confirm, retries with bounded exponential jitter and reconnects on channel,
  connection or consumer cancellation. A crash between confirm and DB update causes
  duplicates; DB claims/checkpoints absorb these. A dropped consumer wakeup cannot
  lose a job. PG outages fail closed; configure pool connection/query/statement/lock
  timeouts to bound dependency failure. Transport operation timeout defaults to 10s.
- Handler timeout defaults to 5min; heartbeat defaults to lease/3. Lease loss aborts
  context.signal. Handlers must honor cancellation, avoid detached work and write only
  through fenced transactions. JavaScript cannot forcibly stop arbitrary handler code.
  Use process isolation for non-cooperative CPU work. `onError` is injectable; logging
  callers must redact sensitive errors. Persisted worker errors omit handler messages.
- Checkpoints provide atomic DB effects, not exactly-once external side effects.
  SMTP/model/calendar effects need provider idempotency or a durable intent/unknown
  receipt workflow. A token alone cannot fence a remote service. Never automatically
  repeat an external effect whose outcome is unknown.

Verification (Node 22+, Node 24 preferred):

```sh
node --test server/jobs.test.js
JOBS_TEST_DATABASE_URL=postgres://... JOBS_TEST_AMQP_URL=amqp://... node scripts/verify-jobs.mjs
```

Use dedicated test PG/MQ instances. The script creates and drops its own PG schema and
RabbitMQ queue; it never imports business storage or reads `data/`. It exercises real
PG transactions, concurrent claims, ownership isolation, strict mailbox ordering,
retry exhaustion, stale-token fencing, rollback after expiry, checkpoint redelivery,
real MQ confirms with injected lost outbox commit, reconnection, and multi-lease worker
heartbeat. These checks are local dependency integration, not cloud or production acceptance.
