import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCalendarRecoveryRouter, unknownCalendarSummaries } from './calendar-api.js';

const intent = (extra = {}) => ({ id: 'intent', ownerId: 'alice', mailboxId: 'box', status: 'unknown',
  event: { id: 'event', title: 'Interview', description: 'private body' }, connectionIds: ['remote'],
  receipts: { remote: { status: 'unknown', accessToken: 'secret', raw: 'private' } }, ...extra });

test('unknown summary filters scope and projects only actionable identifiers and event summary', () => {
  const result = unknownCalendarSummaries({ intents: [intent(), intent({ ownerId: 'bob' }), intent({ mailboxId: 'other' })],
    targets: { '["event","remote"]': { status: 'unknown', token: 'secret' } } }, { ownerId: 'alice', mailboxId: 'box' });
  assert.deepEqual(result, [{ id: 'intent', status: 'unknown', target: { connectionId: 'remote', status: 'unknown' },
    event: { id: 'event', title: 'Interview', status: 'deleted' }, canReconcile: true }]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

async function serve(t, options = {}, user = { id: 'alice' }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use(createCalendarRecoveryRouter({
    settings: () => ({ activeMailboxId: 'box', mailboxes: [{ id: 'box', ownerUserId: 'alice' }] }),
    inSnapshot: () => true, document: () => ({ intents: [intent()], targets: {} }),
    store: () => ({ events: [] }), ...options,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
}

test('reconcile uses current mailbox, allowlists input/output, and waits for commit', async t => {
  let release, entered;
  const committing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const request = await serve(t, {
    reconcile: async (mailboxId, id, input) => {
      assert.equal(mailboxId, 'box'); assert.equal(id, 'intent');
      assert.deepEqual(input, { confirmed: true, connectionId: 'remote', outcome: 'absent', remoteId: undefined, note: 'Checked manually' });
      return { intentId: id, connectionId: 'remote', status: 'reconciled', reconciliation: { note: 'private', remoteId: 'private' } };
    }, commit: async () => { entered(); await gate; },
  });
  let delivered = false;
  const pending = request('/unknown/intent/reconcile', { confirmed: true, connectionId: 'remote', outcome: 'absent',
    note: 'Checked manually', mailboxId: 'other', token: 'secret' }).then(response => { delivered = true; return response; });
  await committing;
  assert.equal(delivered, false);
  release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'intent', status: 'reconciled', target: { connectionId: 'remote', status: 'manual_absent' } });
});

test('commit failure does not return success or raw error', async t => {
  const request = await serve(t, { reconcile: async () => ({ intentId: 'intent', connectionId: 'remote', status: 'reconciled' }),
    commit: async () => { throw new Error('secret connection token'); } });
  const response = await request('/unknown/intent/reconcile', { confirmed: true });
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(await response.json()).includes('secret'), false);
});

test('recovery rejects unauthenticated, foreign mailbox and non-snapshot requests', async t => {
  for (const [options, user, status] of [
    [{}, null, 401], [{}, { id: 'bob' }, 403], [{ inSnapshot: () => false }, { id: 'alice' }, 503],
  ]) {
    const request = await serve(t, { ...options, reconcile: () => assert.fail('must not execute') }, user);
    assert.equal((await request('/unknown')).status, status);
    assert.equal((await request('/unknown/intent/reconcile', { confirmed: true })).status, status);
  }
});
