#!/usr/bin/env node
/**
 * Reads the metrics sink written by server/metrics.js and prints a human-readable report.
 *
 * The recorder keeps every raw sample in `metrics-<host>-<pid>.jsonl` precisely so that any
 * percentile can be recomputed later; this tool re-derives the numbers from those files
 * instead of trusting `metrics-summary.json`, and only uses the summaries for health flags
 * (`sinkError`, `dropped`, provenance).
 *
 * Usage:
 *   node scripts/metrics-report.mjs [dir] [--json] [--top N] [--metric <name>]
 *
 * `dir` defaults to DAYLIGHT_METRICS_DIR, then <DAYLIGHT_DATA_DIR>/metrics, then data/metrics.
 * Inside a container the sink lives on the tmpfs, so read it from the service itself:
 *   docker compose exec api node scripts/metrics-report.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = name => {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const jsonOnly = Boolean(flag('json'));
const top = Math.max(1, Number(flag('top')) || 12);
const focus = typeof flag('metric') === 'string' ? flag('metric') : null;
const positional = args.find(a => !a.startsWith('--'));

const dataDir = process.env.DAYLIGHT_DATA_DIR || 'data';
const dir = path.resolve(positional || process.env.DAYLIGHT_METRICS_DIR || path.join(dataDir, 'metrics'));

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(ratio * (sorted.length - 1))));
  return sorted[index];
}
const round = value => (value === null || value === undefined ? null : Number(value.toFixed(3)));

if (!fs.existsSync(dir)) {
  const message = `no metrics sink at ${dir} — run with DAYLIGHT_METRICS=1 to record one`;
  if (jsonOnly) console.log(JSON.stringify({ dir, error: message }, null, 2));
  else console.error(message);
  process.exitCode = 2;
} else {
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'));
  const processes = [];
  const series = new Map();
  let malformed = 0;
  const runIds = new Set();
  const git = new Set();
  let firstTs = null;
  let lastTs = null;

  for (const file of files) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
    let kept = 0;
    for (const line of lines) {
      let sample;
      try { sample = JSON.parse(line); } catch { malformed += 1; continue; }
      if (!sample || typeof sample.metric !== 'string') { malformed += 1; continue; }
      kept += 1;
      if (sample.runId) runIds.add(sample.runId);
      if (sample.gitSha) git.add(`${sample.gitSha}${sample.dirty === true ? ' (dirty)' : sample.dirty === false ? ' (clean)' : ''}`);
      if (sample.ts) { if (!firstTs || sample.ts < firstTs) firstTs = sample.ts; if (!lastTs || sample.ts > lastTs) lastTs = sample.ts; }
      const entry = series.get(sample.metric) || { unit: sample.unit, values: [], labels: new Map() };
      if (typeof sample.value === 'number' && Number.isFinite(sample.value)) entry.values.push(sample.value);
      const labelKey = Object.entries(sample.labels || {}).map(([k, v]) => `${k}=${v}`).sort().join(',') || '(none)';
      const bucket = entry.labels.get(labelKey) || [];
      if (typeof sample.value === 'number' && Number.isFinite(sample.value)) bucket.push(sample.value);
      entry.labels.set(labelKey, bucket);
      series.set(sample.metric, entry);
    }
    processes.push({ file, samples: kept });
  }

  const summaries = fs.existsSync(path.join(dir, 'metrics-summary.json'))
    ? [JSON.parse(fs.readFileSync(path.join(dir, 'metrics-summary.json'), 'utf8'))]
    : [];
  const summaryFiles = processes.length ? fs.readdirSync(dir).filter(n => /summary.*\.json$/.test(n)) : [];

  const rows = [...series.entries()].map(([metric, entry]) => {
    const sorted = [...entry.values].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    return { metric, unit: entry.unit, count: sorted.length, min: round(sorted[0] ?? null),
      p50: round(percentile(sorted, 0.5)), p90: round(percentile(sorted, 0.9)),
      p95: round(percentile(sorted, 0.95)), p99: round(percentile(sorted, 0.99)),
      max: round(sorted.at(-1) ?? null), mean: sorted.length ? round(sum / sorted.length) : null };
  }).sort((a, b) => b.count - a.count);

  const health = summaries.map(summary => ({ written: summary.written, dropped: summary.dropped,
    sinkError: summary.sinkError, sampling: summary.sampling, gitSha: summary.gitSha, dirty: summary.dirty }));

  const report = {
    dir, files: files.length, samples: rows.reduce((n, row) => n + row.count, 0), malformed,
    window: firstTs && lastTs ? { from: firstTs, to: lastTs } : null,
    runIds: [...runIds], provenance: [...git], processes, health,
    metrics: rows,
    focus: focus && series.has(focus) ? {
      metric: focus,
      labels: [...series.get(focus).labels.entries()]
        .map(([key, values]) => { const sorted = [...values].sort((a, b) => a - b);
          return { labels: key, count: sorted.length, p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), max: round(sorted.at(-1) ?? null) }; })
        .sort((a, b) => b.count - a.count).slice(0, top),
    } : null,
  };

  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`metrics sink: ${dir}`);
    console.log(`  ${files.length} process file(s), ${report.samples} samples, ${malformed} malformed line(s)`);
    if (report.window) console.log(`  window: ${report.window.from} → ${report.window.to}`);
    if (report.runIds.length) console.log(`  runId(s): ${report.runIds.join(', ')}`);
    if (report.provenance.length) console.log(`  provenance: ${report.provenance.join(', ')}`);
    for (const process_ of report.processes) console.log(`  - ${process_.file}: ${process_.samples}`);
    const problems = health.filter(h => h.sinkError || h.dropped);
    console.log(`  health: ${problems.length ? `${problems.length} summary file(s) report drops or sink errors` : 'no drops, no sink errors reported'}`);
    console.log('');
    const header = ['metric', 'count', 'unit', 'p50', 'p95', 'p99', 'max', 'mean'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.slice(0, top).map(r =>
      String([r.metric, r.count, r.unit, r.p50, r.p95, r.p99, r.max, r.mean][i] ?? '').length)));
    const line = cells => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    console.log(line(header));
    console.log(widths.map(w => '─'.repeat(w)).join('  '));
    for (const row of rows.slice(0, Math.max(top, 1))) {
      console.log(line([row.metric, row.count, row.unit, row.p50, row.p95, row.p99, row.max, row.mean]));
    }
    if (rows.length > top) console.log(`  … ${rows.length - top} more metric(s); use --top N`);
    if (focus) {
      if (!report.focus) console.log(`\nno samples for --metric ${focus}`);
      else {
        console.log(`\n${focus} by label set (top ${report.focus.labels.length}):`);
        for (const row of report.focus.labels) {
          console.log(`  ${row.labels}  n=${row.count} p50=${row.p50} p95=${row.p95} max=${row.max}`);
        }
      }
    }
  }
}
