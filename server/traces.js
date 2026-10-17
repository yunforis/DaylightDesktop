import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mailboxDirectory } from './store.js';

const traceFile = (mailboxId) => path.join(mailboxDirectory(mailboxId), 'traces.json');
const MAX_TEXT = 700;

// These are small evidence snapshots, never request headers or hidden model reasoning.
export function sanitizeSnapshot(value, secrets = [], depth = 0, maxText = MAX_TEXT) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value ?? null;
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter((item) => typeof item === 'string' && item.length)) {
      text = text.split(secret).join('[已脱敏]');
    }
    text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已脱敏]')
      .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, '[手机号已脱敏]')
      .replace(/\b(?:sk|key)[-_][A-Za-z0-9_-]{8,}/gi, '[密钥已脱敏]')
      .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已脱敏]')
      .replace(/((?:api[_ -]?key|authorization(?:[_ -]?code)?|password|passwd|(?:client[_ -]?)?secret|(?:access[_ -]?|refresh[_ -]?)?token|授权码|密码)["']?\s*[=:：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;，；}]+)/gi, '$1[已脱敏]')
      .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
        try { const parsed = new URL(url); parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; return parsed.toString(); }
        catch { return '[链接已脱敏]'; }
      });
    return text.length > maxText ? `${text.slice(0, maxText)}…（已截断，原长 ${text.length}）` : text;
  }
  if (depth >= 5) return '[深层内容省略]';
  if (Array.isArray(value)) {
    const result = value.slice(0, 12).map((item) => sanitizeSnapshot(item, secrets, depth + 1));
    if (value.length > 12) result.push(`…（另 ${value.length - 12} 项省略）`);
    return result;
  }
  return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [key,
    /^(?:api[_-]?key|authorization(?:[_-]?code)?|password|passwd|(?:client[_-]?)?secret|(?:access[_-]?|refresh[_-]?)?token|headers|reasoning_content|reasoning|chain_of_thought)$/i.test(key)
      ? '[已脱敏]' : sanitizeSnapshot(item, secrets, depth + 1)]));
}

// The reply is an editable artifact: retain every proposed slot while still removing credentials.
export const sanitizeReplyDraft = (draft, secrets = []) => sanitizeSnapshot(draft, secrets, 0, Infinity);

export function readTraces(mailboxId) {
  const filename = traceFile(mailboxId);
  if (!fs.existsSync(filename)) return [];
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

export function saveTraces(traces, mailboxId) {
  const filename = traceFile(mailboxId);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(traces, null, 2));
}

export function emailReference(emailId) {
  return createHash('sha256').update(String(emailId)).digest('hex').slice(0, 24);
}

const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const price = (value) => value === '' || value === null || value === undefined ? null : numeric(Number(value));

export function usageMetrics(usage, settings = {}) {
  const input = numeric(usage?.prompt_tokens);
  const output = numeric(usage?.completion_tokens);
  const cached = numeric(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens) ?? 0;
  const inputPrice = price(settings.tokenPriceIn);
  const outputPrice = price(settings.tokenPriceOut);
  const cachedPrice = price(settings.tokenPriceCachedIn);
  const usageKnown = input !== null && output !== null;
  const priceKnown = usageKnown && (input - cached <= 0 || inputPrice !== null) &&
    (output === 0 || outputPrice !== null) && (cached === 0 || cachedPrice !== null);
  return { llm_tokens_in: input, llm_tokens_out: output, llm_tokens_cached_in: usageKnown ? Math.min(cached, input) : null,
    cost_cny: priceKnown ? ((input - Math.min(cached, input)) * (inputPrice ?? 0) + output * (outputPrice ?? 0) +
      Math.min(cached, input) * (cachedPrice ?? 0)) / 1_000_000 : null,
    cost_status: !usageKnown ? 'usage_missing' : !priceKnown ? 'price_missing' : 'known',
    pricing: { input_cny_per_million: inputPrice, output_cny_per_million: outputPrice, cached_input_cny_per_million: cachedPrice } };
}

function recalculate(trace) {
  const calls = trace.spans.filter((span) => (span.llm_request === true || (span.stage === 'extract' && span.llm_request !== false)));
  const knownInput = calls.filter((span) => span.llm_tokens_in !== null);
  const knownOutput = calls.filter((span) => span.llm_tokens_out !== null);
  trace.llm_tokens_in = !calls.length ? 0 : knownInput.length ? knownInput.reduce((sum, span) => sum + span.llm_tokens_in, 0) : null;
  trace.llm_tokens_out = !calls.length ? 0 : knownOutput.length ? knownOutput.reduce((sum, span) => sum + span.llm_tokens_out, 0) : null;
  trace.llm_tokens_cached_in = calls.filter((span) => span.llm_tokens_cached_in !== null)
    .reduce((sum, span) => sum + span.llm_tokens_cached_in, 0);
  trace.tokens_complete = knownInput.length === calls.length && knownOutput.length === calls.length;
  trace.known_cost_cny = calls.reduce((sum, span) => sum + (span.cost_cny ?? 0), 0);
  trace.cost_cny = calls.every((span) => span.cost_cny !== null) ? trace.known_cost_cny : null;
  trace.cost_status = trace.mode === 'demo' ? 'preset' : trace.cost_cny !== null ? 'known'
    : calls.some((span) => span.cost_status === 'usage_missing') ? 'usage_missing' : 'price_missing';
  trace.latency_ms = trace.attempts.reduce((sum, attempt) => sum + attempt.latency_ms, 0);
}

export function createTraceRecorder({ settings = {}, traces = [], persist = () => {}, secrets = [] } = {}) {
  const privateValues = [settings.apiKey, settings.authorizationCode, settings.feishu?.appSecret, ...secrets];
  const clean = (value) => sanitizeSnapshot(value, privateValues);
  const save = () => persist(traces);
  return { traces, sanitize: clean,
    beginEmail(email, mode) {
      const email_ref = emailReference(email.id);
      let trace = traces.find((item) => item.email_ref === email_ref && item.mode === mode);
      const now = new Date().toISOString();
      if (!trace) {
        trace = { trace_id: randomUUID(), email_ref, subject: clean(email.subject || '（读取中）'), mode,
          status: 'running', started_at: now, ended_at: null, latency_ms: 0, decision: null,
          user_action: null, draft_reply: null, llm_tokens_in: null, llm_tokens_out: null,
          cost_cny: null, known_cost_cny: 0, cost_status: mode === 'demo' ? 'preset' : 'usage_missing', attempts: [], spans: [] };
        traces.unshift(trace);
      }
      const attempt = { attempt: trace.attempts.length + 1, status: 'running', started_at: now, ended_at: null, latency_ms: 0 };
      trace.attempts.push(attempt);
      Object.assign(trace, { status: 'running', ended_at: null, subject: clean(email.subject || trace.subject), error: null });
      save();
      const context = { trace, attempt, sanitize: clean,
        update(fields) { Object.assign(trace, clean(fields)); save(); },
        startSpan(stage, label, fields = {}) {
          const started_at = fields.started_at || new Date().toISOString();
          const span = { span_id: randomUUID(), parent_span: trace.trace_id, attempt: attempt.attempt,
            stage, label, status: 'running', started_at, ended_at: null,
            offset_ms: Math.max(0, Date.parse(started_at) - Date.parse(attempt.started_at)), latency_ms: 0,
            thought: '', input_snapshot: null, output_snapshot: null, tool_calls: [],
            llm_tokens_in: null, llm_tokens_out: null, llm_tokens_cached_in: null,
            cost_cny: stage === 'extract' ? null : 0,
            ...clean(fields) };
          if (Date.parse(started_at) < Date.parse(attempt.started_at)) {
            attempt.started_at = started_at;
            if (trace.attempts.length === 1) trace.started_at = started_at;
          }
          trace.spans.push(span);
          save();
          return span;
        },
        updateSpan(span, fields) { Object.assign(span, clean(fields)); recalculate(trace); save(); },
        finishSpan(span, fields = {}) {
          if (span.status !== 'running') return span;
          const ended_at = fields.ended_at || new Date().toISOString();
          Object.assign(span, { status: 'success', ended_at,
            latency_ms: Math.max(0, Date.parse(ended_at) - Date.parse(span.started_at)) }, clean(fields));
          for (const item of trace.spans.filter((item) => item.attempt === attempt.attempt)) {
            item.offset_ms = Math.max(0, Date.parse(item.started_at) - Date.parse(attempt.started_at));
          }
          attempt.latency_ms = Math.max(0, Date.parse(ended_at) - Date.parse(attempt.started_at));
          recalculate(trace); save();
          return span;
        },
        finish(status, fields = {}) {
          const ended_at = new Date().toISOString();
          Object.assign(attempt, { status, ended_at, latency_ms: Math.max(0, Date.parse(ended_at) - Date.parse(attempt.started_at)) });
          Object.assign(trace, { status, ended_at }, clean(fields));
          if (typeof fields.draft_reply === 'string') trace.draft_reply = sanitizeReplyDraft(fields.draft_reply, privateValues);
          recalculate(trace); save();
          return trace;
        },
      };
      return context;
    },
  };
}

export function summarizeTraces(traces) {
  const summarize = (mode) => {
    const rows = traces.filter((trace) => trace.mode === mode);
    const priced = rows.filter((trace) => trace.status !== 'running' && trace.cost_cny !== null);
    const knownCost = rows.reduce((sum, trace) => sum + (trace.known_cost_cny ?? trace.cost_cny ?? 0), 0);
    const fullCoverage = rows.length > 0 && priced.length === rows.length;
    return { count: rows.length, completed_count: rows.filter((trace) => ['imported', 'skipped', 'conflict'].includes(trace.status)).length,
      failed_count: rows.filter((trace) => trace.status === 'failed').length,
      running_count: rows.filter((trace) => trace.status === 'running').length,
      attempt_count: rows.reduce((sum, trace) => sum + trace.attempts.length, 0),
      tokens_in: rows.reduce((sum, trace) => sum + (trace.llm_tokens_in ?? 0), 0),
      tokens_out: rows.reduce((sum, trace) => sum + (trace.llm_tokens_out ?? 0), 0),
      token_coverage_count: rows.filter((trace) => trace.tokens_complete).length,
      cost_cny: fullCoverage ? knownCost : null, known_cost_cny: knownCost, priced_count: priced.length,
      unknown_cost_count: rows.length - priced.length,
      avg_cost_cents: fullCoverage ? knownCost / rows.length * 100 : null,
      known_avg_cost_cents: priced.length ? priced.reduce((sum, trace) => sum + trace.cost_cny, 0) / priced.length * 100 : null,
      latency_ms: rows.reduce((sum, trace) => sum + trace.latency_ms, 0) };
  };
  return { qq: summarize('qq'), demo: summarize('demo'), total_count: traces.length };
}
