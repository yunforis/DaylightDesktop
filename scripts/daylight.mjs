/** Foreground Windows runtime: Ctrl+C or `npm run down` drains roles, then dependencies. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export function controlEndpoint(root) {
  const identity = fs.realpathSync(root).toLowerCase();
  const id = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\daylight-${id}`;
}

function runProduction(action, cancelPath) {
  return new Promise((resolve, reject) => {
    const args = [fileURLToPath(import.meta.url), '--production-operation', action];
    if (cancelPath) args.push(cancelPath);
    // A separate process group lets this supervisor finish cleanup after Ctrl+C.
    // Children remain hidden; their output is forwarded to the original terminal.
    // Windows PowerShell 5.1 cannot execute directly with DETACHED_PROCESS.
    // A detached Node bridge runs PowerShell with CREATE_NO_WINDOW instead.
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.once('error', () => reject(new Error(`Could not launch the production ${action} operation.`)));
    child.once('exit', code => {
      child.stdout.destroy(); child.stderr.destroy();
      if (code === 0) resolve();
      else reject(new Error(`Production ${action} failed (exit ${code}). See the output above.`));
    });
  });
}

/** Real IPC is also used in tests, with isolated start/stop operations. */
export async function supervise({ endpoint, start, stop, cancel = () => {}, launchWatchdog, log = console.log, signals = process }) {
  const finished = Promise.withResolvers();
  const watchdogReady = Promise.withResolvers();
  let watchdog;
  let startup, shutdown, stopRequested = false, startupError, drained = false;
  const server = net.createServer(socket => {
    let request = '';
    socket.setTimeout(10000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', bytes => {
      request += bytes.toString();
      if (request.length > 128) { socket.destroy(); return; }
      if (!request.includes('\n')) return;
      socket.removeAllListeners('data');
      socket.setTimeout(0);
      if (request.trim() === 'watch' && launchWatchdog && !watchdog) {
        watchdog = socket;
        watchdogReady.resolve();
        return;
      }
      if (request.trim() !== 'stop') { socket.end('{"ok":false,"error":"Unknown command"}\n'); return; }
      stopAll().then(
        () => socket.end('{"ok":true}\n'),
        error => socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  }).catch(error => {
    if (error.code === 'EADDRINUSE') throw new Error('Daylight already has a foreground launcher. Use that terminal, or npm run down first.');
    throw error;
  });
  server.on('error', error => finished.reject(error));

  function stopAll() {
    if (shutdown) return shutdown;
    stopRequested = true;
    log('Stopping Daylight and its dependencies; waiting for the current startup step or running work to finish...');
    shutdown = (async () => {
      cancel();
      // A pending Compose operation must settle before stopping its containers.
      try { await startup; } catch { /* Partial startup is cleaned up below. */ }
      await stop();
      drained = true;
      watchdog?.end('done\n');
      server.close();
      if (startupError) finished.reject(startupError);
      else finished.resolve();
    })().catch(error => { shutdown = undefined; throw error; });
    return shutdown;
  }
  const onSignal = () => stopAll().catch(error => log(`${error.message} Retry Ctrl+C or npm run down; shutdown has not completed.`));
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  startup = Promise.resolve().then(async () => {
    if (launchWatchdog) {
      await launchWatchdog();
      const timer = setTimeout(() => watchdogReady.reject(new Error('Foreground shutdown watchdog did not connect.')), 10000);
      try { await watchdogReady.promise; } finally { clearTimeout(timer); }
    }
    await start();
  }).then(() => {
    if (!stopRequested) log('Daylight is running. Press Ctrl+C here, or run npm run down in another terminal.');
  });
  startup.catch(async error => {
    if (stopRequested) return;
    startupError = error;
    log(`${error.message} Cleaning up the partial startup...`);
    try { await stopAll(); }
    catch (cleanupError) { server.close(); finished.reject(new Error(`${error.message} Cleanup also failed: ${cleanupError.message}`)); }
  });
  try { await finished.promise; }
  finally {
    signals.removeListener('SIGINT', onSignal);
    signals.removeListener('SIGTERM', onSignal);
    server.close();
    if (!drained) watchdog?.destroy();
  }
}

/** Returns false only when there is no live foreground supervisor. */
export async function stopForeground(endpoint) {
  return new Promise((resolve, reject) => {
    let response = '', connected = false;
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Timed out connecting to the Daylight launcher.')); }, 5000);
    socket.on('connect', () => { connected = true; clearTimeout(timer); socket.write('stop\n'); });
    socket.on('data', bytes => {
      response += bytes.toString();
      if (response.length > 8192) { socket.destroy(); reject(new Error('Invalid launcher response.')); return; }
      if (!response.includes('\n')) return;
      socket.end();
      try {
        const result = JSON.parse(response.trim());
        if (!result.ok) reject(new Error(result.error || 'Daylight shutdown failed.'));
        else resolve(true);
      } catch (error) { reject(error); }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      if (!connected && ['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false);
      else reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (connected && !response.includes('\n')) reject(new Error('Launcher disconnected before confirming shutdown. Retry npm run down.'));
    });
  });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('These commands manage the Windows host runtime. See deploy/README.md for Compose or systemd deployment.');
  if (process.argv[2] === '--production-operation') {
    const [, , , action, cancelPath] = process.argv;
    if (!['Start', 'Stop'].includes(action) || process.argv.length > 5) throw new Error('Invalid production operation.');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(repositoryRoot, 'scripts/production.ps1'), '-Action', action, '-WithDependencies'];
    if (action === 'Stop') args.push('-LockWaitSeconds', '360');
    if (cancelPath) args.push('-StartupCancelPath', cancelPath);
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', args, { cwd: repositoryRoot, windowsHide: true, stdio: 'inherit' });
      child.once('error', () => reject(new Error('Could not launch PowerShell.')));
      child.once('exit', code => { process.exitCode = code === 0 ? 0 : 1; resolve(); });
    });
    return;
  }
  if (process.argv[2] === '--watchdog') {
    const [, , , endpoint, cancelPath] = process.argv;
    if (process.argv.length !== 5 || !cancelPath) throw new Error('Invalid watchdog arguments.');
    let completed = false, connected = false, response = '';
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      socket.on('connect', () => { connected = true; socket.write('watch\n'); });
      socket.on('data', bytes => { response += bytes.toString(); if (response.includes('done\n')) completed = true; });
      socket.on('error', error => { if (!connected) reject(error); });
      socket.on('close', resolve);
    });
    if (!completed) {
      fs.writeFileSync(cancelPath, 'stop\n');
      console.log('Foreground terminal ended; stopping Daylight and its dependencies.');
      await runProduction('Stop');
    }
    fs.rmSync(cancelPath, { force: true });
    return;
  }
  const [action, ...extra] = process.argv.slice(2);
  if (!['up', 'down'].includes(action) || extra.length) throw new Error('Use npm run up or npm run down.');
  const endpoint = controlEndpoint(repositoryRoot);
  if (action === 'down') {
    if (!await stopForeground(endpoint)) await runProduction('Stop');
    console.log('Daylight and its dependency containers are stopped. Data volumes are retained.');
    return;
  }
  const runtimeDirectory = path.join(repositoryRoot, 'data/runtime/roles');
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const cancelPath = path.join(runtimeDirectory, `startup-${randomUUID()}.cancel`);
  try {
    await supervise({ endpoint, start: () => runProduction('Start', cancelPath), stop: () => runProduction('Stop'),
      launchWatchdog: () => new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(repositoryRoot, 'scripts/start-foreground-watchdog.ps1'), '-Endpoint', endpoint, '-CancelPath', cancelPath],
        { cwd: repositoryRoot, windowsHide: true, stdio: 'ignore' });
        child.once('error', () => reject(new Error('Could not launch the foreground shutdown watchdog.')));
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('Could not launch the foreground shutdown watchdog.')));
      }),
      cancel: () => fs.writeFileSync(cancelPath, 'stop\n') });
  } finally { fs.rmSync(cancelPath, { force: true }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
