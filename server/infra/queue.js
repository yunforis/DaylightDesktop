import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readInfraConfig } from './config.js';

const bus = new EventEmitter();
const handlers = new Map();
const consuming = new Set();
const jobs = [];
let mode = 'local';
let channel = null;
let connection = null;

export function queueMode() {
  return mode;
}

function amqpUrl(config = readInfraConfig().mq) {
  if (config.url) return config.url;
  const user = encodeURIComponent(config.user || 'guest');
  const pass = encodeURIComponent(config.password || 'guest');
  const host = config.host || '127.0.0.1';
  const port = Number(config.port) || 5672;
  const vhost = encodeURIComponent(config.vhost || '/');
  return `amqp://${user}:${pass}@${host}:${port}/${vhost}`;
}

function queueName(topic, prefix = readInfraConfig().mq.topicPrefix || 'daylight') {
  return `${prefix}.${topic}`.replace(/[^\w.\-]+/g, '_');
}

function trackJob(partial) {
  const job = {
    id: randomUUID(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...partial,
  };
  jobs.unshift(job);
  if (jobs.length > 200) jobs.length = 200;
  return job;
}

async function closeRabbit() {
  consuming.clear();
  try { await channel?.close(); } catch { /* ignore */ }
  try { await connection?.close(); } catch { /* ignore */ }
  channel = null;
  connection = null;
}

async function startConsumer(topic) {
  if (!channel || consuming.has(topic)) return;
  const q = queueName(topic);
  await channel.assertQueue(q, { durable: true });
  consuming.add(topic);
  await channel.consume(q, async (msg) => {
    if (!msg) return;
    let payload = {};
    let meta = {};
    try {
      const body = JSON.parse(msg.content.toString('utf8'));
      payload = body.payload || {};
      meta = body.meta || {};
    } catch {
      channel.nack(msg, false, false);
      return;
    }
    const job = trackJob({
      id: meta.id || randomUUID(),
      topic,
      name: q,
      payload,
      status: 'running',
      startedAt: new Date().toISOString(),
      transport: 'rabbitmq',
    });
    try {
      const worker = handlers.get(topic);
      job.result = worker ? await worker(payload, job) : null;
      job.status = 'done';
      channel.ack(msg);
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      channel.nack(msg, false, false);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }, { noAck: false });
}

async function startAllConsumers() {
  for (const topic of handlers.keys()) {
    await startConsumer(topic);
  }
}

export async function initQueue() {
  const config = readInfraConfig({ force: true }).mq;
  await closeRabbit();
  mode = 'local';

  if (!config.enabled || config.provider === 'local') {
    return { ok: true, mode, note: '使用进程内任务队列' };
  }

  if (config.provider !== 'rabbitmq') {
    return {
      ok: true,
      mode: 'local',
      note: `已记录 ${config.provider}，当前仍回退本地队列（可后续接 SDK）`,
    };
  }

  try {
    const amqp = await import('amqplib');
    connection = await amqp.connect(amqpUrl(config));
    connection.on('error', () => { mode = 'local'; });
    connection.on('close', () => {
      channel = null;
      connection = null;
      consuming.clear();
      mode = 'local';
    });
    channel = await connection.createChannel();
    await channel.prefetch(1);
    mode = 'rabbitmq';
    await startAllConsumers();
    return { ok: true, mode, note: '已连接本机 RabbitMQ' };
  } catch (error) {
    await closeRabbit();
    mode = 'local';
    return { ok: false, mode, error: error.message, note: 'RabbitMQ 不可用，已回退进程内队列' };
  }
}

export async function queueStatus() {
  return {
    ok: mode === 'rabbitmq' ? Boolean(channel) : true,
    mode,
    pending: jobs.filter((job) => job.status === 'pending').length,
    running: jobs.filter((job) => job.status === 'running').length,
    urlMasked: mode === 'rabbitmq' ? amqpUrl().replace(/\/\/.*@/, '//***@') : null,
  };
}

export async function testQueueConnection(incoming) {
  const config = { ...readInfraConfig().mq, ...(incoming || {}) };
  if ((config.provider || 'local') === 'local') {
    return { ok: true, mode: 'local', message: '本地进程队列无需外部连接' };
  }
  if (config.provider !== 'rabbitmq') {
    return { ok: false, mode: config.provider, message: `暂不支持探测 ${config.provider}` };
  }
  const amqp = await import('amqplib');
  const conn = await amqp.connect(amqpUrl(config));
  const ch = await conn.createChannel();
  const q = queueName('connectivity', config.topicPrefix || 'daylight');
  await ch.assertQueue(q, { durable: true });
  await ch.close();
  await conn.close();
  return { ok: true, mode: 'rabbitmq', message: `已连通 RabbitMQ，队列 ${q} 可用` };
}

export function registerWorker(topic, handler) {
  handlers.set(topic, handler);
  bus.on(topic, async (job) => {
    const worker = handlers.get(topic);
    if (!worker) return;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      job.result = await worker(job.payload, job);
      job.status = 'done';
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  });
  if (mode === 'rabbitmq' && channel) {
    startConsumer(topic).catch(() => {});
  }
}

export async function enqueue(topic, payload = {}) {
  const prefix = readInfraConfig().mq.topicPrefix || 'daylight';
  const job = trackJob({
    topic,
    name: `${prefix}.${topic}`,
    payload,
    transport: mode === 'rabbitmq' && channel ? 'rabbitmq' : 'local',
  });

  if (mode === 'rabbitmq' && channel) {
    const q = queueName(topic, prefix);
    await channel.assertQueue(q, { durable: true });
    channel.sendToQueue(q, Buffer.from(JSON.stringify({
      payload,
      meta: { id: job.id, topic, enqueuedAt: job.createdAt },
    })), { persistent: true, contentType: 'application/json' });
    return job;
  }

  // 本地回退：直接 await worker，行为对齐原先 interval 内 runSync（测试 mock tick 可见）。
  // 启用 RabbitMQ 时仍走上方异步投递，不阻塞定时器回调。
  const worker = handlers.get(topic);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  try {
    job.result = worker ? await worker(payload, job) : null;
    job.status = 'done';
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    throw error;
  } finally {
    job.finishedAt = new Date().toISOString();
  }
  return job;
}

export function listJobs(limit = 40) {
  return jobs.slice(0, limit);
}
