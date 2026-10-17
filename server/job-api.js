import { Router } from 'express';
import { createHash } from 'node:crypto';
import { readSettings } from './store.js';

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
// Do not expose internal input payloads, credentials, or raw exception messages.
export function publicJob(job) {
  return {
    id: job.id, mailboxId: job.mailbox_id, kind: job.kind, status: job.status,
    attempts: job.attempts, maxAttempts: job.max_attempts, generation: job.generation,
    createdAt: job.created_at, updatedAt: job.updated_at, finishedAt: job.finished_at,
    availableAt: job.available_at,
    error: job.error ? { code: job.error.code || 'TASK_FAILED', message: '任务未完成，请查看执行记录或重试。' } : null,
  };
}

export function createJobRouter({ repository, enqueueMail, enqueuePlan }) {
  const router = Router();
  router.use((req, res, next) => req.user ? next() : res.status(401).json({ error: '请先登录' }));
  const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
  const scope = req => ({ tenantId: req.user.id, ownerId: req.user.id });
  const ownsMailbox = id => readSettings().mailboxes.some(mailbox => mailbox.id === id);
  router.get('/', route(async (req, res) => {
    const mailboxId = String(req.query.mailbox || readSettings().activeMailboxId);
    if (!ownsMailbox(mailboxId)) return res.status(404).json({ error: '邮箱不存在' });
    const jobs = await repository.listOwned({ ...scope(req), mailboxId, limit: 50 });
    res.json({ jobs: jobs.map(publicJob) });
  }));
  router.get('/:id', route(async (req, res) => {
    if (!uuid(req.params.id)) return res.status(404).json({ error: '任务不存在' });
    const job = await repository.getOwned({ ...scope(req), id: req.params.id });
    if (!job || !ownsMailbox(job.mailbox_id)) return res.status(404).json({ error: '任务不存在' });
    res.json({ job: publicJob(job) });
  }));
  for (const [action, method] of [['retry', 'retryOwned'], ['cancel', 'cancelOwned']]) {
    router.post(`/:id/${action}`, route(async (req, res) => {
      if (!uuid(req.params.id)) return res.status(404).json({ error: '任务不存在' });
      const original = await repository.getOwned({ ...scope(req), id: req.params.id });
      if (!original || !ownsMailbox(original.mailbox_id)) return res.status(404).json({ error: '任务不存在' });
      const job = await repository[method]({ ...scope(req), id: req.params.id });
      if (!job) return res.status(409).json({ error: '当前任务状态不支持此操作' });
      res.json({ job: publicJob(job) });
    }));
  }
  router.post('/mail-sync', route(async (req, res) => {
    const mailboxId = String(req.body.mailboxId || readSettings().activeMailboxId);
    if (!ownsMailbox(mailboxId)) return res.status(404).json({ error: '邮箱不存在' });
    const key = req.get('Idempotency-Key');
    if (!key || key.length > 200) return res.status(400).json({ error: '请提供有效的 Idempotency-Key' });
    const { job } = await enqueueMail({ ...scope(req), mailboxId, idempotencyKey: `manual:${createHash('sha256').update(key).digest('hex')}` });
    res.status(202).json({ job: publicJob(job) });
  }));
  return router;
}
