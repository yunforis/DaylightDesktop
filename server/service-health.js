import http from 'node:http';
import { closeInfra } from './infra/index.js';
import { metricsStatus, startMetrics, stopMetrics } from './metrics.js';

/** Dependency failures affect readiness, never process liveness. */
export function serviceHealth({ checkReady, role = 'api', readinessTimeoutMs = 5000 }) {
  let draining = false;
  let started = false;
  // The service entry point is the only place that knows the role; start the metrics
  // sink here so api/worker/scheduler all share one consistent lifecycle.
  startMetrics({ role });
  return {
    started() { started = true; },
    drain() { draining = true; },
    async respond(req, res) {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (!['/health/live', '/health/ready', '/health/startup'].includes(pathname)) return false;
      let ok = true;
      if (pathname === '/health/startup') ok = started;
      if (pathname === '/health/ready') {
        ok = started && !draining;
        if (ok) {
          let timer;
          const controller = new AbortController();
          try {
            ok = Boolean(await Promise.race([
              Promise.resolve().then(() => checkReady({ signal: controller.signal })),
              new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, Math.min(5000, Math.max(1, readinessTimeoutMs))); }),
            ]));
            ok = ok && !draining;
          } catch { ok = false; }
          finally { clearTimeout(timer); controller.abort(); }
        }
      }
      res.statusCode = ok ? 200 : 503;
      res.setHeader('Content-Type', 'application/json');
      const status = metricsStatus();
      res.end(JSON.stringify({ ok, role, draining,
        metrics: { enabled: status.enabled, runId: status.runId, written: status.written, dropped: status.dropped, sinkError: status.sinkError } }));
      return true;
    },
  };
}

export function startHealthServer(health, port = Number(process.env.DAYLIGHT_HEALTH_PORT || process.env.HEALTH_PORT || 3001)) {
  return http.createServer(async (req, res) => {
    if (!await health.respond(req, res)) { res.statusCode = 404; res.end(); }
  }).listen(port, process.env.HOST || '0.0.0.0');
}

export function installShutdown({ health, server, stop = async () => {}, close = closeInfra, timeoutMs = 30000 }) {
  let closing;
  const run = async () => {
    health.drain();
    let cleanup;
    const cleanupInfra = () => cleanup ||= Promise.resolve().then(close).finally(() => { stopMetrics(); });
    // Force HTTP connections before the hard process deadline, leaving time for cleanup.
    const force = setTimeout(() => {
      server.closeAllConnections?.();
      void cleanupInfra().catch(() => {});
    }, Math.max(1, timeoutMs - Math.min(1000, timeoutMs / 5)));
    const deadline = setTimeout(() => { server.closeAllConnections?.(); process.exit(1); }, timeoutMs);
    try {
      const results = await Promise.allSettled([
        new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections?.();
        }),
        Promise.resolve().then(stop).finally(cleanupInfra),
      ]);
      if (results.some(result => result.status === 'rejected')) {
        process.exitCode = 1;
        // Retain the hard deadline when a close failed: handles may still be alive.
        return;
      }
      clearTimeout(force);
      clearTimeout(deadline);
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  const shutdown = () => {
    if (closing) return closing;
    closing = run();
    return closing;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return shutdown;
}
