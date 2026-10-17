/**
 * P2 concurrency gate. The twenty race conditions live in
 * `scripts/verify-concurrency.mjs`; this file only decides whether the
 * environment is available to run them.
 *
 * Real dependencies are required by design: claiming a lease or resolving a
 * CAS conflict against a mock would prove nothing. Set
 * `DAYLIGHT_VERIFY_CONCURRENCY=1` plus the loopback URLs below.
 */
import test from 'node:test';
import { verifyConcurrency } from '../scripts/verify-concurrency.mjs';

test('twenty race conditions hold against real PostgreSQL, Redis and RabbitMQ', {
  skip: process.env.DAYLIGHT_VERIFY_CONCURRENCY !== '1', timeout: 300000,
}, async () => {
  const summary = await verifyConcurrency();
  if (summary.failed) throw new Error(`${summary.failed} concurrency checks failed`);
});
