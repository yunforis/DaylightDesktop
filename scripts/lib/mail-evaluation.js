// Pure scoring and evidence helpers. No server imports, credentials or network access.
export const METRIC_KEYS = ['llm_tokens_in', 'llm_tokens_out', 'llm_tokens_cached_in', 'cost_cny', 'cost_status', 'pricing'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const instant = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const compare = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

export function validateDataset(dataset) {
  if (dataset?.schemaVersion !== 1 || dataset.synthetic !== true || !Array.isArray(dataset.cases) || !dataset.cases.length) {
    throw new Error('Dataset must have schemaVersion=1, synthetic=true and nonempty cases.');
  }
  const ids = new Set();
  for (const item of dataset.cases) {
    if (!/^[a-z0-9-]+$/.test(item.id || '') || ids.has(item.id)) throw new Error('Invalid or duplicate case id.');
    ids.add(item.id);
    if (!item.email?.body || !item.email.subject || !instant(item.email.receivedAt)) throw new Error(`Invalid email: ${item.id}`);
    if (!Array.isArray(item.context?.events) || !Array.isArray(item.context?.tasks)) throw new Error(`Missing context: ${item.id}`);
    const expected = item.expected;
    if (!Array.isArray(expected?.actions) || !Array.isArray(expected?.tasks) || !expected.state) throw new Error(`Missing golden: ${item.id}`);
    for (const [kind, rows] of [['actions', expected.actions], ['tasks', expected.tasks]]) {
      for (const row of rows) {
        const allowed = kind === 'actions' ? ['create', 'cancel', 'reschedule', 'keep'] : ['create', 'merge', 'reopen', 'link'];
        if (!allowed.includes(row.action)) throw new Error(`Invalid golden action: ${item.id}`);
        for (const key of ['start', 'end', 'dueAt']) {
          if (own(row, key) && row[key] !== null && !instant(row[key])) throw new Error(`Invalid golden time: ${item.id}`);
        }
        if (row.titleIncludes && (!Array.isArray(row.titleIncludes) || !row.titleIncludes.length || row.titleIncludes.some((v) => typeof v !== 'string' || !v))) {
          throw new Error(`Invalid title tokens: ${item.id}`);
        }
      }
    }
    for (const key of ['eventCount', 'activeEventCount', 'taskCount', 'pendingMatchCount']) {
      if (!Number.isSafeInteger(expected.state[key]) || expected.state[key] < 0) throw new Error(`Invalid state golden: ${item.id}`);
    }
    if (!Array.isArray(expected.state.cancelledEventIds)) throw new Error(`Missing cancellation golden: ${item.id}`);
  }
  return { valid: true, cases: dataset.cases.length, ids: [...ids] };
}

// Only known dataset identifiers, enum values, dates and keyword-hit booleans leave memory.
// Titles, reasons, summaries, bodies, arbitrary provider strings and raw responses are never exported.
export function publicActual(item, extraction, record, store) {
  const knownIds = new Set([...item.context.events, ...item.context.tasks].map((row) => row.id));
  const id = (value) => !value ? null : knownIds.has(value) ? value : '[unrecognized]';
  const project = (row, kind) => {
    const allowed = kind === 'actions' ? ['create', 'cancel', 'reschedule', 'keep'] : ['create', 'merge', 'reopen', 'link'];
    const tokens = [...new Set(item.expected[kind].flatMap((value) => value.titleIncludes || []))];
    const locations = [...new Set(item.expected[kind].filter((value) => own(value, 'location')).map((value) => value.location))];
    return { action: allowed.includes(row.action || 'create') ? row.action || 'create' : '[invalid]',
      ...(kind === 'actions' ? { targetEventId: id(row.targetEventId), start: instant(row.start), end: instant(row.end),
        allDay: typeof row.allDay === 'boolean' ? row.allDay : null,
        outcome: ['needs_match', 'kept', 'conflict'].includes(row.outcome) ? row.outcome : null,
        locationMatches: Object.fromEntries(locations.map((location) => [location, row.location === location])) }
        : { taskId: id(row.taskId), dueAt: instant(row.dueAt) }),
      titleIncludes: Object.fromEntries(tokens.map((token) => [token, typeof row.title === 'string' && row.title.includes(token)])) };
  };
  return { rawEventCount: extraction?.events?.length ?? null, rawTaskCount: extraction?.tasks?.length ?? 0,
    actions: (record?.extraction?.actions || []).map((row) => project(row, 'actions')),
    tasks: (record?.extraction?.tasks || []).map((row) => project(row, 'tasks')),
    state: { eventCount: store.events.length, activeEventCount: store.events.filter((row) => row.status !== 'cancelled').length,
      cancelledEventIds: store.events.filter((row) => row.status === 'cancelled').map((row) => id(row.id)).sort(),
      taskCount: store.tasks.length, pendingMatchCount: record?.pendingActions?.length || 0 } };
}

function matches(actual, expected) {
  return Object.entries(expected).every(([key, value]) => {
    if (['start', 'end', 'dueAt'].includes(key)) return actual[key] === instant(value);
    if (key === 'titleIncludes') return value.every((token) => actual.titleIncludes[token] === true);
    if (key === 'location') return actual.locationMatches[value] === true;
    return compare(actual[key], value);
  });
}

// Backtracking gives an order-independent one-to-one assignment, including overlapping goldens.
function matchRows(actual, expected, index = 0, used = new Set()) {
  if (index === expected.length) return true;
  return actual.some((row, candidate) => {
    if (used.has(candidate) || !matches(row, expected[index])) return false;
    const next = new Set(used); next.add(candidate);
    return matchRows(actual, expected, index + 1, next);
  });
}

export function scoreCase(item, actual, failure = null) {
  const assertions = [];
  const check = (name, expected, observed) => assertions.push({ name, expected, actual: observed, pass: compare(expected, observed) });
  check('execution.completed', true, !failure && Boolean(actual));
  if (!failure && actual) {
    for (const kind of ['actions', 'tasks']) {
      check(`${kind}.count`, item.expected[kind].length, actual[kind].length);
      check(`${kind}.golden_one_to_one`, true, matchRows(actual[kind], item.expected[kind]));
    }
    check('rawEventCount', item.expected.rawEventCount ?? item.expected.actions.length, actual.rawEventCount);
    check('rawTaskCount', item.expected.rawTaskCount ?? item.expected.tasks.length, actual.rawTaskCount);
    for (const [key, value] of Object.entries(item.expected.state)) {
      check(`state.${key}`, Array.isArray(value) ? [...value].sort() : value, actual.state[key]);
    }
  }
  return { passed: assertions.every((row) => row.pass), assertions };
}

export function nearestRank(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

export function summarize(results, plannedCount) {
  const completed = results.length;
  const passed = results.filter((row) => row.passed).length;
  const durations = results.map((row) => row.duration_ms).filter(numeric);
  const known = results.filter((row) => row.metrics?.cost_status === 'known' && numeric(row.metrics.cost_cny));
  const knownTotal = known.reduce((sum, row) => sum + row.metrics.cost_cny, 0);
  const unknownUsage = results.filter((row) => !numeric(row.metrics?.llm_tokens_in) || !numeric(row.metrics?.llm_tokens_out)).length;
  return { planned_count: plannedCount, completed_count: completed, passed_count: passed, failed_count: completed - passed,
    interrupted_or_unattempted_count: plannedCount - completed, success_denominator: plannedCount,
    success_rate: plannedCount ? passed / plannedCount : null,
    latency: { sample_count: durations.length, includes_failures: true, method: 'nearest-rank',
      p50_ms: nearestRank(durations, 0.5), p95_ms: nearestRank(durations, 0.95) },
    costs: { known_call_count: known.length, unknown_usage_count: unknownUsage, unknown_cost_count: completed - known.length,
      known_subtotal_cny: known.length ? knownTotal : null,
      total_cny: completed === plannedCount && known.length === completed && completed > 0 ? knownTotal : null,
      fully_priced_mean_cny: known.length ? knownTotal / known.length : null,
      coverage: completed ? known.length / completed : null, billing_verified: false } };
}

export function metricsContext() {
  const metrics = { llm_tokens_in: null, llm_tokens_out: null, llm_tokens_cached_in: null, cost_cny: null, cost_status: 'usage_missing', pricing: null };
  const capture = (_span, fields = {}) => {
    for (const key of METRIC_KEYS) if (own(fields, key)) metrics[key] = fields[key];
  };
  return { metrics, context: { startSpan: () => ({}), updateSpan: capture, finishSpan: capture } };
}
