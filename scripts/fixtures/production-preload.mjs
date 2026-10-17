// Test-only process instrumentation. Loaded by --import, never by application code.
import net from 'node:net';
import fs from 'node:fs';
import { JobRepository } from '../../server/jobs/repository.js';
import { JobTransport } from '../../server/jobs/rabbit.js';

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const option = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof option === 'object' ? option.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Production verification blocked non-loopback connection: ${host}`);
  }
  return connect.apply(this, args);
};
const session = JobTransport.prototype.session;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (process.env.PRODUCTION_VERIFY_CALENDAR_URL && url.origin === 'https://www.googleapis.com'
    && url.pathname.startsWith('/calendar/v3/calendars/')) {
    return originalFetch(new URL(url.pathname + url.search, process.env.PRODUCTION_VERIFY_CALENDAR_URL), options);
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`Production verification blocked non-loopback fetch: ${url.hostname}`);
  }
  return originalFetch(input, options);
};
JobTransport.prototype.session = function (...args) {
  this.queue = process.env.PRODUCTION_VERIFY_QUEUE;
  return session.apply(this, args);
};
if (process.env.PRODUCTION_VERIFY_CRASH_MARKER) {
  JobRepository.prototype.complete = async function (id) {
    fs.writeFileSync(process.env.PRODUCTION_VERIFY_CRASH_MARKER, id);
    // The real handler has committed its business document + checkpoint. The
    // parent kills this worker before the final job-status transaction.
    await new Promise(() => {});
  };
}
