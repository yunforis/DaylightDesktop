import test from 'node:test';
import { verifyProduction } from '../scripts/verify-production.mjs';

test('isolated production HTTP, PostgreSQL, Redis, S3/calendar mocks and independent scheduler/worker recovery', {
  skip: process.env.DAYLIGHT_VERIFY_PRODUCTION !== '1', timeout: 180000,
}, async () => { await verifyProduction(); });
