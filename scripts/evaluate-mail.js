#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { validateDataset, publicActual, scoreCase, summarize, metricsContext } from './lib/mail-evaluation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (['--live', '--validate', '--help'].includes(key)) options[key] = true;
  else if (['--settings', '--settings-user', '--limit', '--cases'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
  else { console.error('Unknown or incomplete option. Use --help.'); process.exit(2); }
}
if (options['--help']) {
  console.log('Zero-network default: node scripts/evaluate-mail.js --validate\nLive: node scripts/evaluate-mail.js --live --settings <file> --limit <1..case-count> [--settings-user <id>] [--cases <comma-separated-ids>]');
  process.exit(0);
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const datasetPath = path.join(root, 'docs/submission/evaluation-cases.json');
const datasetBytes = fs.readFileSync(datasetPath);
const dataset = JSON.parse(datasetBytes);
validateDataset(dataset);
if (options['--live'] && options['--validate']) { console.error('Choose either --live or --validate.'); process.exit(2); }
if (!options['--live']) {
  console.log(JSON.stringify({ mode: 'dataset-validation-only', model_calls: 0, ...validateDataset(dataset), dataset_sha256: hash(datasetBytes),
    note: 'Validates fixture structure only. This is not model accuracy, performance or end-to-end evidence.' }, null, 2));
  process.exit(0);
}
const limit = Number(options['--limit']);
if (!options['--settings'] || !Number.isSafeInteger(limit) || limit < 1 || limit > dataset.cases.length) {
  console.error('--live requires --settings and an explicit --limit between 1 and the dataset case count.'); process.exit(2);
}
let selected = dataset.cases;
if (options['--cases']) {
  const ids = options['--cases'].split(',');
  if (new Set(ids).size !== ids.length || ids.some((id) => !dataset.cases.some((row) => row.id === id))) {
    console.error('--cases contains duplicate or unknown ids.'); process.exit(2);
  }
  selected = ids.map((id) => dataset.cases.find((row) => row.id === id));
}
selected = selected.slice(0, limit);
// Always replace any inherited data path BEFORE dynamically importing production modules.
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, 'work', 'mail-evaluation-'));
const isolatedData = path.join(runDir, 'isolated-data');
fs.mkdirSync(isolatedData);
process.env.DAYLIGHT_DATA_DIR = isolatedData;
process.env.DAYLIGHT_AUTO_PROXY = '0';
const keys = ['baseUrl', 'apiKey', 'model', 'tokenPriceIn', 'tokenPriceOut', 'tokenPriceCachedIn'];
let settings;
try {
  const source = JSON.parse(fs.readFileSync(path.resolve(options['--settings']), 'utf8'));
  const user = options['--settings-user'] ? source.userPrefs?.[options['--settings-user']] : null;
  if (options['--settings-user'] && !user) throw new Error('missing user');
  settings = Object.fromEntries(keys.map((key) => [key, user?.[key] ?? source[key]]));
  const endpoint = new URL(settings.baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('unsupported URL');
  if (typeof settings.apiKey !== 'string' || !settings.apiKey || !settings.model || typeof settings.model !== 'string') throw new Error('missing model settings');
  for (const key of keys.filter((key) => key.startsWith('tokenPrice'))) {
    const raw = settings[key];
    settings[key] = raw !== null && raw !== '' && raw !== undefined && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
  }
} catch { console.error('Cannot read selected model settings; require baseUrl, apiKey and model. URLs must not contain credentials, query or fragment.'); process.exit(2); }
const git = (argv) => { try { return execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const sourceHashes = {};
function collect(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) collect(relative);
    else if (entry.name.endsWith('.js')) sourceHashes[relative] = hash(fs.readFileSync(path.join(root, relative)));
  }
}
for (const directory of ['server', 'shared']) collect(directory);
for (const filename of ['scripts/evaluate-mail.js', 'scripts/lib/mail-evaluation.js', 'package.json', 'package-lock.json']) sourceHashes[filename] = hash(fs.readFileSync(path.join(root, filename)));
const manifest = { schema_version: 1, mode: 'live-model-synthetic-mail', started_at: new Date().toISOString(),
  scope: 'Production extractEvents + in-memory importEmail only; no IMAP, SMTP, workbench or cloud-server benchmark.',
  node: process.version, platform: process.platform, arch: process.arch, git_sha: git(['rev-parse', 'HEAD']),
  git_dirty: Boolean(git(['status', '--porcelain'])), git_status: git(['status', '--porcelain']),
  dataset_sha256: hash(datasetBytes), source_sha256: sourceHashes, selected_cases: selected.map((row) => row.id),
  max_model_calls: selected.length, retries: 0, timeout_per_call_ms: 60_000,
  requested_model: String(settings.model).split(settings.apiKey).join('[redacted]'), model_identity_verified: false, endpoint_origin: new URL(settings.baseUrl).origin,
  price_snapshot: Object.fromEntries(keys.filter((key) => key.startsWith('tokenPrice')).map((key) => [key, settings[key] ?? null])),
  prompt_source: 'Repository default prompt, fresh isolated data; no user prompt/settings copied.',
  proxy: { explicit_environment_proxy_present: Boolean(process.env.DAYLIGHT_HTTPS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy), auto_detection: false },
  resource_scope: 'Evaluation client Node process including production in-process parsing/application. Not model-provider or deployed-server resource usage.' };
fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const jsonl = path.join(runDir, 'results.jsonl');
const append = (row) => {
  const fd = fs.openSync(jsonl, 'a');
  try { fs.writeSync(fd, `${JSON.stringify(row)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const results = [];
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
function writeSummary(status) {
  const changed = Object.entries(sourceHashes).some(([filename, initial]) => {
    try { return hash(fs.readFileSync(path.join(root, filename))) !== initial; } catch { return true; }
  });
  const summary = { ...summarize(results, selected.length), status, finished_at: new Date().toISOString(),
    source_changed_during_run: changed, dataset_changed_during_run: hash(fs.readFileSync(datasetPath)) !== hash(datasetBytes),
    interpretation: 'Fixed synthetic regression cases, one call each, no retries. Not representative user accuracy or full business-chain validation.' };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}
let production;
try { production = await import('../server/agent.js'); }
catch { append({ type: 'setup_failure', code: 'PRODUCTION_IMPORT_FAILED' }); writeSummary('setup_failed'); console.error(`Production module import failed. Evidence: ${runDir}`); process.exit(2); }
for (const item of selected) {
  if (stopping) break;
  const started = performance.now();
  const cpu = process.cpuUsage();
  let rssPeak = process.memoryUsage().rss;
  const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 50);
  const { metrics, context } = metricsContext();
  const store = { events: structuredClone(item.context.events), tasks: structuredClone(item.context.tasks), emails: [], lastSync: null };
  const email = { ...item.email, id: `synthetic-evaluation:${item.id}`, sender: 'admissions@example.invalid' };
  append({ type: 'case_started', id: item.id, started_at: new Date().toISOString() });
  let actual = null;
  let failure = null;
  // Suppress production proxy diagnostic URLs, which may contain proxy credentials.
  const originalLog = console.log;
  console.log = () => {};
  try {
    const extraction = await production.extractEvents(email, settings, store.events, context, store.tasks);
    const record = production.importEmail(store, email, extraction, 'qq');
    actual = publicActual(item, extraction, record, store);
  } catch (error) {
    // Provider error text can echo request data. Export a category, never the raw error.
    failure = { code: /超时|超过|timeout/i.test(String(error.message)) ? 'TIMEOUT' : 'EXTRACTION_OR_APPLICATION_FAILED' };
  } finally { console.log = originalLog; clearInterval(sampler); }
  const usage = process.cpuUsage(cpu);
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  const row = { type: 'case_result', id: item.id, expected: item.expected, actual, failure,
    ...scoreCase(item, actual, failure), duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
    metrics, client_resources: { rss_sampled_peak_bytes: rssPeak, rss_sampling_interval_ms: 50,
      cpu_user_ms: usage.user / 1000, cpu_system_ms: usage.system / 1000 } };
  results.push(row); append(row); writeSummary('running');
  console.log(`${item.id}: ${row.passed ? 'PASS' : 'FAIL'} (${row.duration_ms} ms)`);
}
const summary = writeSummary(stopping ? 'interrupted' : 'complete');
console.log(JSON.stringify({ evidence_directory: runDir, ...summary }, null, 2));
process.exitCode = stopping ? 130 : summary.failed_count ? 1 : 0;
