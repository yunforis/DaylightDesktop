import { randomUUID } from 'node:crypto';
import { LeaseLostError } from './repository.js';
import { counter, timer } from '../metrics.js';

const EMAILISH = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Provider and HTTP errors routinely echo the request back. Redact the credentials they may
// carry before the reason is persisted on the job row or written to the service log.
const TOKENISH = /(sk-[A-Za-z0-9_-]{6,}|bearer\s+[A-Za-z0-9._~+/=-]{6,}|(?:postgres(?:ql)?|rediss?|amqps?|https?):\/\/[^\s/@:]*:[^\s/@]*@)/gi;
// Keeps the parameter name so the diagnostic still says which field was present.
const PARAMISH = /([?&](?:token|api_?key|access_?token|secret|password|passwd|signature|sig)=)[^\s&]+/gi;

/**
 * A bounded, redacted reason for the job row and the service log. Providers echo the account
 * address and the request URL back in errors, so addresses and credentials are replaced
 * before the text is persisted or logged.
 */
export function describeFailure(error, limit = 300) {
  const raw = String(error?.message || error?.code || 'Job execution failed')
    .replace(EMAILISH, '<address>').replace(TOKENISH, '<redacted>').replace(PARAMISH, '$1<redacted>')
    .replace(/\s+/g, ' ').trim();
  return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
}

export const pause = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

export function bounded(promise, ms, message = 'Operation timed out') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'JOB_TIMEOUT' })), ms);
  })]).finally(() => clearTimeout(timer));
}

/** Handlers must honor signal; only checkpoint/complete transaction callbacks may commit DB effects.
 * External effects need their own idempotency key or an explicit unknown-result state. */
export class JobWorker {
  constructor(repository, handlers, { workerId = randomUUID(), pollMs = 500, timeoutMs = 300000,
    heartbeatMs = Math.max(25, Math.floor(repository.leaseMs / 3)), onError = () => {} } = {}) {
    if (!(heartbeatMs > 0 && heartbeatMs < repository.leaseMs) || !(pollMs > 0) || !(timeoutMs > 0)) throw new TypeError('Invalid worker timing');
    Object.assign(this, { repository, handlers, workerId, pollMs, timeoutMs, heartbeatMs, onError });
  }

  async execute(job, signal) {
    const stopTimer = timer('job.execute.ms', { kind: job.kind });
    let outcome = 'succeeded';
    const abort = new AbortController();
    const stop = () => abort.abort(signal.reason ?? new Error('Worker stopped'));
    signal?.addEventListener('abort', stop, { once: true });
    let rejectLost;
    const lost = new Promise((_, reject) => { rejectLost = reject; });
    // Validation may fail before Promise.race subscribes (for example an unknown kind).
    void lost.catch(() => {});
    const lose = error => { abort.abort(error); rejectLost(error); };
    const onAbort = () => rejectLost(abort.signal.reason);
    abort.signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) stop();
    const heartbeatStop = new AbortController();
    const heartbeat = (async () => {
      while (!heartbeatStop.signal.aborted) {
        await pause(this.heartbeatMs, heartbeatStop.signal);
        if (heartbeatStop.signal.aborted) break;
        try { await this.repository.heartbeat(job.id, job.lease_token); }
        catch (error) { lose(error); break; }
      }
    })();
    try {
      const handler = this.handlers[job.kind];
      if (typeof handler !== 'function') throw Object.assign(new Error('Unsupported job kind'), { retryable: false });
      const context = {
        signal: abort.signal,
        steps: () => this.repository.steps(job.id, job.lease_token),
        checkpoint: (name, result, write) => {
          abort.signal.throwIfAborted();
          return this.repository.checkpoint(job.id, job.lease_token, name, result, async (client, current) => {
            abort.signal.throwIfAborted();
            if (write) await write(client, current);
            abort.signal.throwIfAborted();
          });
        },
      };
      const result = await bounded(Promise.race([Promise.resolve().then(() => {
        abort.signal.throwIfAborted();
        return handler(job, context);
      }), lost]), this.timeoutMs, 'Job execution timed out');
      abort.signal.throwIfAborted();
      await this.repository.complete(job.id, job.lease_token, result);
    } catch (error) {
      outcome = error instanceof LeaseLostError ? 'lease_lost' : 'failed';
      // Operators need to know which job failed and why; the recorded reason is bounded and
      // has addresses redacted so a diagnostics field never leaks user identifiers.
      this.onError(error, { jobId: job.id, kind: job.kind, mailboxId: job.mailbox_id, attempt: Number(job.attempts) || 1 });
      abort.abort(error);
      if (!(error instanceof LeaseLostError)) {
        try {
          await this.repository.fail(job.id, job.lease_token,
            { code: error.code ?? 'JOB_FAILED', message: describeFailure(error) }, { retryable: error.retryable !== false });
        } catch (failure) { if (!(failure instanceof LeaseLostError)) throw failure; }
      }
    } finally {
      heartbeatStop.abort();
      await heartbeat;
      stopTimer({ outcome });
      counter('job.executed_total', { kind: job.kind, outcome });
      signal?.removeEventListener('abort', stop);
      abort.signal.removeEventListener('abort', onAbort);
    }
  }

  async run({ signal } = {}) {
    while (!signal?.aborted) {
      try {
        await this.repository.recoverExpired();
        const job = await this.repository.claim({ workerId: this.workerId });
        if (job) { await this.execute(job, signal); continue; }
      } catch (error) { this.onError(error); }
      await pause(this.pollMs, signal);
    }
  }
}
