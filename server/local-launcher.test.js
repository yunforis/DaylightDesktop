import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { controlEndpoint, stopForeground, supervise } from '../scripts/daylight.mjs';

function fixture(t, operations = {}) {
  fs.mkdirSync('work', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('work/launcher fixture-'));
  const endpoint = controlEndpoint(root);
  const signals = new EventEmitter();
  const started = Promise.withResolvers();
  const startup = Promise.withResolvers();
  const stopping = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const calls = [];
  const running = supervise({ endpoint, signals, log() {},
    async start() { calls.push('start'); started.resolve(); await startup.promise; },
    cancel() { calls.push('cancel'); },
    async stop() { calls.push('stop'); stopping.resolve(); await stopped.promise; },
    ...operations,
  });
  // Attach a rejection handler before deliberately exercising failure paths.
  running.catch(() => {});
  t.after(async () => {
    startup.resolve(); stopped.resolve(); signals.emit('SIGINT');
    await running.catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, endpoint, signals, calls, started, startup, stopping, stopped, running };
}

test('Ctrl+C during startup waits for it to settle, then drains exactly once', async t => {
  const f = fixture(t);
  await f.started.promise;
  f.signals.emit('SIGINT');
  f.signals.emit('SIGINT');
  assert.deepEqual(f.calls, ['start', 'cancel']);
  f.startup.reject(new Error('Startup cancelled'));
  await f.stopping.promise;
  assert.deepEqual(f.calls, ['start', 'cancel', 'stop']);
  f.stopped.resolve();
  await f.running;
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
});

test('a new terminal waits for full shutdown; concurrent stop requests share cleanup', async t => {
  const f = fixture(t);
  await f.started.promise;
  f.startup.resolve();
  let returned = false;
  const first = stopForeground(f.endpoint).then(value => { returned = true; return value; });
  const second = stopForeground(f.endpoint);
  await f.stopping.promise;
  assert.equal(returned, false, 'down must wait for dependencies to stop');
  // Let the second IPC request reach the supervisor while shutdown is pending.
  await new Promise(resolve => setTimeout(resolve, 30));
  f.stopped.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  await f.running;
  assert.equal(f.calls.filter(call => call === 'stop').length, 1);
  assert.equal(await stopForeground(f.endpoint), false);
});

test('failed shutdown is reported and leaves the foreground launcher available for retry', async t => {
  let attempts = 0;
  const f = fixture(t, { async stop() { if (++attempts === 1) throw new Error('Worker did not drain'); } });
  await f.started.promise;
  f.startup.resolve();
  await assert.rejects(stopForeground(f.endpoint), /Worker did not drain/);
  assert.equal(await stopForeground(f.endpoint), true);
  await f.running;
  assert.equal(attempts, 2);
});

test('watchdog is released only after successful shutdown of the whole stack', async t => {
  let watcher, response = '';
  const done = Promise.withResolvers();
  const f = fixture(t, { async launchWatchdog() {
    watcher = net.createConnection(f.endpoint);
    watcher.on('connect', () => watcher.write('watch\n'));
    watcher.on('data', bytes => { response += bytes.toString(); if (response.includes('done\n')) done.resolve(); });
  } });
  t.after(() => watcher?.destroy());
  await f.started.promise;
  f.startup.resolve();
  const down = stopForeground(f.endpoint);
  await f.stopping.promise;
  assert.equal(response, '');
  f.stopped.resolve();
  assert.equal(await down, true);
  await done.promise;
  await f.running;
});

test('partial startup failure cleans up roles and dependencies and preserves a failing result', async t => {
  const f = fixture(t);
  await f.started.promise;
  const failed = assert.rejects(f.running, /Dependency startup failed/);
  f.startup.reject(new Error('Dependency startup failed'));
  await f.stopping.promise;
  f.stopped.resolve();
  await failed;
  assert.deepEqual(f.calls, ['start', 'cancel', 'stop']);
});

test('only one foreground launcher can own a repository and stopped endpoints permit fallback', async t => {
  const f = fixture(t);
  await f.started.promise;
  let duplicateStarted = false;
  await assert.rejects(supervise({ endpoint: f.endpoint, signals: new EventEmitter(), log() {},
    async start() { duplicateStarted = true; }, async stop() {},
  }), /already has a foreground launcher/);
  assert.equal(duplicateStarted, false);
  assert.equal(controlEndpoint(path.join(f.root, '.')), f.endpoint);
  f.startup.resolve(); f.stopped.resolve();
  assert.equal(await stopForeground(f.endpoint), true);
  await f.running;
  assert.equal(await stopForeground(f.endpoint), false);
});

function isolatedPowerShell(t, args, files = {}) {
  fs.mkdirSync('work', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('work/launcher ps fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync('scripts/production.ps1', path.join(root, 'scripts/production.ps1'));
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts/production.ps1'), ...(typeof args === 'function' ? args(root) : args)],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
}

test('full-stack stop refuses partial role selection before touching processes or dependencies', { skip: process.platform !== 'win32' }, t => {
  const result = isolatedPowerShell(t, ['-Action', 'Stop', '-WithDependencies', '-Roles', 'api']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires all three roles/);
});

test('a role shutdown error prevents dependency shutdown', { skip: process.platform !== 'win32' }, t => {
  const result = isolatedPowerShell(t, ['-Action', 'Stop', '-WithDependencies'], {
    'data/runtime/roles/scheduler.json': '{"role":"scheduler","repositoryRoot":"invalid"}',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid scheduler process metadata/);
  assert.doesNotMatch(result.stdout, /Stopping PostgreSQL/);
});

test('startup cancellation stops before reading configuration or starting dependencies', { skip: process.platform !== 'win32' }, t => {
  const result = isolatedPowerShell(t, root => ['-Action', 'Start', '-WithDependencies',
    '-StartupCancelPath', path.join(root, 'cancel.request')], { 'cancel.request': 'stop\n' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Startup was cancelled/);
});
