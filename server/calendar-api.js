import { Router } from 'express';
import { commitStorage, readSnapshotDocument, usesStorageSnapshot } from './storage/index.js';
import { readSettings, readStore } from './store.js';
import { externalSyncKey } from './external-calendar.js';
import { reconcileUnknownCalendarResult } from './calendar-job.js';

// Explicit projection: receipts, connection credentials and raw events never leave here.
export function unknownCalendarSummaries(document, { ownerId, mailboxId, events = [] }) {
  return (document?.intents || []).filter(intent => intent.ownerId === ownerId && intent.mailboxId === mailboxId)
    .flatMap(intent => (intent.connectionIds || []).filter(connectionId => intent.receipts?.[connectionId]?.status === 'unknown')
      .map(connectionId => {
        const event = events.find(item => item.id === intent.event?.id);
        const targetStatus = document.targets?.[JSON.stringify([intent.event?.id, connectionId])]?.status;
        return {
          id: intent.id, status: intent.status,
          target: { connectionId, status: targetStatus || 'unknown' },
          event: { id: intent.event?.id, title: String(event?.title ?? intent.event?.title ?? '').slice(0, 500),
            status: event ? (event.status || 'active') : 'deleted' },
          canReconcile: targetStatus === 'unknown',
        };
      }));
}

export function createCalendarRecoveryRouter({ settings = readSettings, store = readStore,
  document = readSnapshotDocument, inSnapshot = usesStorageSnapshot,
  reconcile = reconcileUnknownCalendarResult, commit = commitStorage } = {}) {
  const router = Router();
  const route = handler => async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: '请先登录' });
      if (!inSnapshot()) return res.status(503).json({ error: '人工核对需要共享存储模式。' });
      const current = settings();
      const mailboxId = current.activeMailboxId;
      if (!current.mailboxes?.some(box => box.id === mailboxId && (box.ownerUserId || box.userId) === req.user.id)) {
        return res.status(403).json({ error: '当前邮箱不可用。' });
      }
      await handler(req, res, mailboxId);
    } catch (error) {
      const status = [400, 403, 404, 409].includes(error.status) ? error.status : 503;
      res.status(status).json({ error: '核对未完成，请刷新状态并检查核验输入后重试。' });
    }
  };
  router.get('/unknown', route(async (req, res, mailboxId) => {
    res.json({ mailboxId, intents: unknownCalendarSummaries(document(externalSyncKey(mailboxId)), {
      ownerId: req.user.id, mailboxId, events: store(mailboxId).events,
    }) });
  }));
  router.post('/unknown/:intentId/reconcile', route(async (req, res, mailboxId) => {
    const { confirmed, connectionId, outcome, remoteId, note } = req.body || {};
    const result = await reconcile(mailboxId, req.params.intentId, { confirmed, connectionId, outcome, remoteId, note });
    await commit();
    res.json({ id: result.intentId, status: result.status,
      target: { connectionId: result.connectionId, status: outcome === 'found' ? 'verified' : 'manual_absent' } });
  }));
  return router;
}
