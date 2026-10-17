import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

const windowsOnly = { skip: process.platform !== 'win32' };

function launcherFixture(t, port = 45000) {
  fs.mkdirSync('work', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('work/production launcher fixture-'));
  const runtime = path.join(root, 'data/runtime/roles');
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of ['production.ps1', 'production-role.mjs']) {
    fs.copyFileSync(path.join('scripts', file), path.join(root, 'scripts', file));
  }
  const metadataPath = path.join(runtime, 'api.json');
  const controlPath = path.join(runtime, 'api.stop.json');
  let started = false;
  function powershell(script, args = []) {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(root, script), ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  }
  function run(action, ...args) {
    if (action === 'Start') started = true;
    return powershell('scripts/production.ps1', ['-Action', action, '-TimeoutSeconds', '5', ...args]);
  }
  t.after(() => {
    // Only this fixture can create a role here. Never inspect or stop real roles.
    try {
      if (started && fs.existsSync(metadataPath)) {
        const result = run('Stop', '-Roles', 'api', '-Force');
        assert.equal(result.status, 0, result.stderr);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  fs.writeFileSync(path.join(root, 'seed.ps1'), `
param([switch]$SameCreationTime, [switch]$MissingProcess)
$ErrorActionPreference = 'Stop'
$recordedProcessId = ${process.pid}
$startTicks = [long]1
$nodePath = '${process.execPath.replaceAll("'", "''")}'
if ($MissingProcess) { $recordedProcessId = [int]::MaxValue }
else {
    $candidate = Get-Process -Id $recordedProcessId
    $startTicks = $candidate.StartTime.ToUniversalTime().Ticks
    if (!$SameCreationTime) { $startTicks -= 1 }
    $nodePath = $candidate.Path
}
$record = @{
    role = 'api'; repositoryRoot = $PSScriptRoot
    wrapperPath = Join-Path $PSScriptRoot 'scripts/production-role.mjs'
    processId = $recordedProcessId; startTicks = [string]$startTicks
    launchId = [guid]::NewGuid().ToString(); nodePath = $nodePath; port = ${port}
    stdout = 'fixture.stdout.log'; stderr = 'fixture.stderr.log'
}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'data/runtime/roles/api.json'),
    ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
`);
  function seed(...args) {
    const result = powershell('seed.ps1', args);
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(metadataPath, 'utf8');
  }
  return { root, metadataPath, controlPath, run, seed };
}

test('status treats a reused PID as stopped without changing its stale record', windowsOnly, t => {
  const f = launcherFixture(t);
  const before = f.seed();
  const result = f.run('Status', '-Roles', 'api');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stopped/);
  assert.equal(fs.readFileSync(f.metadataPath, 'utf8'), before);
  assert.equal(fs.existsSync(f.controlPath), false);
});

for (const [description, args] of [['reused', []], ['exited', ['-MissingProcess']]]) {
  test(`stop clears ${description} PID records without signalling another process`, windowsOnly, t => {
    const f = launcherFixture(t);
    const record = JSON.parse(f.seed(...args));
    fs.writeFileSync(f.controlPath, JSON.stringify({ launchId: record.launchId }));
    const result = f.run('Stop', '-Roles', 'api');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already stopped/);
    assert.equal(fs.existsSync(f.metadataPath), false);
    assert.equal(fs.existsSync(f.controlPath), false);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  });
}

test('matching creation time with a different identity still blocks status, force stop and dependency stop', windowsOnly, t => {
  const f = launcherFixture(t);
  const before = f.seed('-SameCreationTime');
  for (const result of [f.run('Status', '-Roles', 'api'), f.run('Stop', '-WithDependencies', '-Force')]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match this launcher's api record/);
    assert.doesNotMatch(result.stdout, /Stopping PostgreSQL/);
    assert.equal(fs.readFileSync(f.metadataPath, 'utf8'), before);
    assert.equal(fs.existsSync(f.controlPath), false);
  }
});

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('start replaces a reused PID record, reuses its own live role, and cleans up after graceful stop', windowsOnly, async t => {
  const port = await unusedPort();
  const f = launcherFixture(t, port);
  fs.mkdirSync(path.join(f.root, 'dist'));
  fs.writeFileSync(path.join(f.root, 'dist/index.html'), 'fixture');
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"type":"module"}');
  fs.mkdirSync(path.join(f.root, 'server'));
  fs.writeFileSync(path.join(f.root, 'server/index.js'), `
import http from 'node:http';
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ ok: true, role: 'api' }));
});
process.on('SIGTERM', () => server.close());
server.listen(Number(process.env.PORT), '127.0.0.1');
`);
  fs.writeFileSync(path.join(f.root, 'data/runtime/environment.json'), JSON.stringify({
    DAYLIGHT_DATA_DIR: 'data', DAYLIGHT_DATABASE_URL: 'fixture', DAYLIGHT_REDIS_URL: 'fixture',
    DAYLIGHT_AMQP_URL: 'fixture', DAYLIGHT_JWT_SECRET: 'synthetic-launcher-fixture-secret-32-characters',
    DAYLIGHT_OSS_PROVIDER: 's3', DAYLIGHT_OSS_BUCKET: 'fixture', DAYLIGHT_OSS_ACCESS_KEY: 'fixture',
    DAYLIGHT_OSS_SECRET_KEY: 'fixture', PORT: String(port),
  }));
  const oldRecord = JSON.parse(f.seed());
  const started = f.run('Start', '-Roles', 'api');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /api is ready/);
  const liveRecord = fs.readFileSync(f.metadataPath, 'utf8');
  assert.notEqual(JSON.parse(liveRecord).launchId, oldRecord.launchId);
  assert.notEqual(JSON.parse(liveRecord).processId, process.pid);
  const status = f.run('Status', '-Roles', 'api');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /ready/);
  const repeated = f.run('Start', '-Roles', 'api');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already ready/);
  assert.equal(fs.readFileSync(f.metadataPath, 'utf8'), liveRecord);
  const stopped = f.run('Stop', '-Roles', 'api');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /api stopped/);
  assert.equal(fs.existsSync(f.metadataPath), false);
  assert.equal(fs.existsSync(f.controlPath), false);
  assert.equal(f.run('Stop', '-Roles', 'api').status, 0);
});
