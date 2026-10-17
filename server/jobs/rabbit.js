import amqp from 'amqplib';
import { bounded, pause } from './runtime.js';
import { retryDelay } from './repository.js';
import { counter, timer } from '../metrics.js';

/** Confirmed persistent wakeups. PostgreSQL remains authoritative; duplicates are expected. */
export class JobTransport {
  constructor(repository, { url, queue = 'daylight.jobs.v1', connect = amqp.connect,
    operationMs = 10000, pollMs = 500, onWake = () => {}, onError = () => {} } = {}) {
    if (!url || !(operationMs >= 100) || !(pollMs > 0)) throw new TypeError('Invalid transport configuration');
    Object.assign(this, { repository, url, queue, connect, operationMs, pollMs, onWake, onError });
    this.state = 'stopped';
  }

  status() { return { ok: this.state === 'connected', mode: 'rabbitmq', state: this.state }; }

  async session(signal) {
    this.state = 'connecting';
    // amqplib's socket timeout bounds connection establishment, including unavailable brokers.
    let connection;
    try { connection = await this.connect(this.url, { timeout: this.operationMs }); }
    catch (error) { this.state = signal?.aborted ? 'stopped' : 'reconnecting'; throw error; }
    let channel;
    let closed = false;
    const close = () => { closed = true; this.state = signal?.aborted ? 'stopped' : 'reconnecting'; };
    const error = err => { close(); this.onError(err); };
    connection.on('error', error);
    connection.on('close', close);
    const abort = () => { close(); void connection.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) return;
      channel = await bounded(connection.createConfirmChannel(), this.operationMs);
      channel.on('error', error);
      channel.on('close', close);
      await bounded(channel.assertQueue(this.queue, { durable: true }), this.operationMs);
      await bounded(channel.prefetch(1), this.operationMs);
      await bounded(channel.consume(this.queue, message => {
        if (!message) { close(); return; }
        // No job payload or owner identity is trusted from the broker. Wakeup only.
        Promise.resolve().then(() => this.onWake({ messageId: message.properties.messageId })).then(() => {
          counter('mq.wakeup_total', { outcome: 'ok' });
          if (!closed) channel.ack(message);
        }).catch(error => {
          counter('mq.wakeup_total', { outcome: 'error' });
          this.onError(error);
          // Polling is the recovery path; never create an immediate nack/requeue storm.
          if (!closed) channel.nack(message, false, false);
        });
      }, { noAck: false }), this.operationMs);
      if (closed || signal?.aborted) return;
      this.state = 'connected';
      while (!closed && !signal?.aborted) {
        // Claim one row per confirm to keep its DB lease valid under broker backpressure.
        const [row] = await this.repository.claimOutbox({ limit: 1, leaseMs: this.operationMs * 3 });
        if (!row) { await pause(this.pollMs, signal); continue; }
        const stopPublish = timer('mq.publish.ms');
        let publishOutcome = 'ok';
        try {
          await bounded(new Promise((resolve, reject) => {
            channel.sendToQueue(this.queue, Buffer.from(JSON.stringify({ jobId: row.job_id })),
              { persistent: true, contentType: 'application/json', messageId: row.id }, err => err ? reject(err) : resolve());
          }), this.operationMs, 'RabbitMQ publisher confirm timed out');
          if (!await this.repository.confirmOutbox(row.id, row.lease_token)) throw new Error('Outbox lease lost');
        } catch (err) {
          publishOutcome = 'error';
          await this.repository.releaseOutbox(row.id, row.lease_token, 'Broker publish failed', retryDelay(row.attempts));
          throw err;
        } finally {
          stopPublish({ outcome: publishOutcome });
          counter('mq.publish_total', { outcome: publishOutcome });
        }
      }
      if (!signal?.aborted) throw new Error('RabbitMQ connection closed');
    } finally {
      this.state = signal?.aborted ? 'stopped' : 'reconnecting';
      signal?.removeEventListener('abort', abort);
      await bounded(connection.close().catch(() => {}), this.operationMs).catch(() => {});
    }
  }

  async run({ signal } = {}) {
    let attempts = 0;
    try {
      while (!signal?.aborted) {
        const started = Date.now();
        try { await this.session(signal); }
        catch (error) { this.onError(error); }
        if (Date.now() - started > 30000) attempts = 0;
        if (!signal?.aborted) await pause(retryDelay(++attempts, { maxMs: 30000 }), signal);
      }
    } finally { this.state = 'stopped'; }
  }
}
