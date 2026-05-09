#!/usr/bin/env node
/**
 * Capacity probe for a WindsurfAPI deployment.
 *
 * This intentionally defaults to a conservative smoke test. Use
 * --until-rate-limit only when you explicitly want to spend quota to discover
 * the first 429 boundary for each model.
 *
 * Examples:
 *   node scripts/capacity-probe.js --base-url http://127.0.0.1:3003 --api-key sk-xxx
 *   node scripts/capacity-probe.js --until-rate-limit --max-per-model 50 --concurrency 2
 */

import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPORT_DIR = join(ROOT, 'logs', 'capacity-probe');
mkdirSync(REPORT_DIR, { recursive: true });

const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

function positiveInt(name, fallback) {
  const n = parseInt(getArg(name, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function usage() {
  console.log(`
Capacity probe

Required:
  --api-key <key>                API key for your WindsurfAPI service
                                or set API_KEY in the environment

Common:
  --base-url <url>               Default: http://127.0.0.1:3003
  --models <a,b,c>               Probe only these models
  --models-file <path>           Newline-separated model list
  --include-regex <regex>        Keep matching models only
  --exclude-regex <regex>        Drop matching models
  --rounds <n>                   Requests per model in normal mode. Default: 1
  --until-rate-limit             Keep probing each model until first 429
  --max-per-model <n>            Safety cap in --until-rate-limit mode. Default: 25
  --max-requests <n>             Global safety cap. Default: 500
  --concurrency <n>              Parallel model workers. Default: 1
  --delay-ms <n>                 Delay between requests per model. Default: 1000
  --timeout-ms <n>               Per-request timeout. Default: 90000
  --max-tokens <n>               Default: 8
  --prompt <text>                Default asks for exactly OK
  --dry-run                      List selected models without sending requests

Notes:
  The script cache-busts prompts by default so local response cache does not
  inflate capacity numbers.
`);
}

if (hasFlag('help') || hasFlag('h')) {
  usage();
  process.exit(0);
}

const BASE_URL = getArg('base-url', process.env.BASE_URL || 'http://127.0.0.1:3003').replace(/\/$/, '');
const API_KEY = getArg('api-key', process.env.API_KEY || '');
const ROUNDS = positiveInt('rounds', 1);
const UNTIL_RATE_LIMIT = hasFlag('until-rate-limit');
const MAX_PER_MODEL = positiveInt('max-per-model', UNTIL_RATE_LIMIT ? 25 : ROUNDS);
const MAX_REQUESTS = positiveInt('max-requests', 500);
const CONCURRENCY = positiveInt('concurrency', 1);
const DELAY_MS = positiveInt('delay-ms', 1000);
const TIMEOUT_MS = positiveInt('timeout-ms', 90_000);
const MAX_TOKENS = positiveInt('max-tokens', 8);
const DRY_RUN = hasFlag('dry-run');
const CACHE_BUST = !hasFlag('no-cache-bust');
const STOP_ON_429 = !hasFlag('no-stop-on-429');
const PROMPT = getArg('prompt', 'Reply with exactly OK and nothing else.');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');

if (!API_KEY && !DRY_RUN) {
  console.error('Missing --api-key or API_KEY env.');
  usage();
  process.exit(2);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  try {
    const res = await fetch(new URL(path, BASE_URL), {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {
      body = { raw: text.slice(0, 1000) };
    }
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  } finally {
    clearTimeout(timer);
  }
}

function parseModelsFromFile(file) {
  if (!file) return [];
  return readFileSync(resolve(process.cwd(), file), 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));
}

async function loadModels() {
  const explicit = [
    ...getArg('models', '').split(',').map(s => s.trim()).filter(Boolean),
    ...parseModelsFromFile(getArg('models-file', '')),
  ];
  if (explicit.length) return [...new Set(explicit)];

  const res = await fetchJson('/v1/models', { method: 'GET' });
  if (res.status !== 200) {
    const msg = res.body?.error?.message || res.body?.error || JSON.stringify(res.body);
    throw new Error(`/v1/models failed: status=${res.status} ${msg || ''}`);
  }
  const data = Array.isArray(res.body?.data) ? res.body.data : [];
  return data.map(m => m.id || m._windsurf_id).filter(Boolean);
}

function filterModels(models) {
  let out = [...new Set(models)];
  const include = getArg('include-regex', '');
  const exclude = getArg('exclude-regex', '');
  if (include) {
    const re = new RegExp(include);
    out = out.filter(m => re.test(m));
  }
  if (exclude) {
    const re = new RegExp(exclude);
    out = out.filter(m => !re.test(m));
  }
  const maxModels = positiveInt('max-models', 0);
  if (maxModels > 0) out = out.slice(0, maxModels);
  return out;
}

function retryAfterMs(headers, body) {
  const h = headers?.['retry-after'];
  const hSec = h ? parseInt(h, 10) : 0;
  if (Number.isFinite(hSec) && hSec > 0) return hSec * 1000;
  const ms = body?.error?.retry_after_ms || body?.retry_after_ms || 0;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

async function requestModel(model, attempt) {
  const nonce = CACHE_BUST ? `\nprobe_run=${RUN_ID} model=${model} attempt=${attempt}` : '';
  const payload = {
    model,
    stream: false,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: 'user', content: `${PROMPT}${nonce}` },
    ],
  };
  const started = Date.now();
  try {
    const res = await fetchJson('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const ms = Date.now() - started;
    const content = res.body?.choices?.[0]?.message?.content || '';
    const err = res.body?.error || null;
    return {
      ok: res.status === 200,
      status: res.status,
      ms,
      retryAfterMs: retryAfterMs(res.headers, res.body),
      usage: res.body?.usage || null,
      contentLen: content.length,
      errorType: err?.type || '',
      errorMessage: err?.message || '',
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      retryAfterMs: 0,
      usage: null,
      contentLen: 0,
      errorType: 'transport_error',
      errorMessage: err.message || String(err),
    };
  }
}

function makeModelState(model) {
  return {
    model,
    attempts: 0,
    success: 0,
    rateLimited: 0,
    errors: 0,
    statuses: {},
    firstRateLimitAt: null,
    retryAfterMs: 0,
    latenciesMs: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    samples: [],
  };
}

function addObservation(state, obs) {
  state.attempts++;
  state.statuses[String(obs.status)] = (state.statuses[String(obs.status)] || 0) + 1;
  if (obs.ok) {
    state.success++;
    state.latenciesMs.push(obs.ms);
  } else if (obs.status === 429 || /rate/i.test(obs.errorType) || /rate limit|速率|限制/i.test(obs.errorMessage)) {
    state.rateLimited++;
    if (!state.firstRateLimitAt) state.firstRateLimitAt = new Date().toISOString();
    state.retryAfterMs = Math.max(state.retryAfterMs, obs.retryAfterMs || 0);
  } else {
    state.errors++;
  }
  if (obs.usage) {
    state.usage.promptTokens += obs.usage.prompt_tokens || obs.usage.input_tokens || 0;
    state.usage.completionTokens += obs.usage.completion_tokens || obs.usage.output_tokens || 0;
    state.usage.totalTokens += obs.usage.total_tokens || 0;
  }
  if (!obs.ok && state.samples.length < 5) {
    state.samples.push({
      status: obs.status,
      type: obs.errorType,
      message: String(obs.errorMessage || '').slice(0, 300),
      retryAfterMs: obs.retryAfterMs || 0,
    });
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

let globalAttempts = 0;
let globalStop = false;

async function probeModel(model) {
  const state = makeModelState(model);
  const limit = UNTIL_RATE_LIMIT ? MAX_PER_MODEL : ROUNDS;
  for (let i = 1; i <= limit; i++) {
    if (globalStop) break;
    if (globalAttempts >= MAX_REQUESTS) {
      globalStop = true;
      break;
    }
    if (state.attempts > 0 && DELAY_MS > 0) await sleep(DELAY_MS);
    globalAttempts++;
    const obs = await requestModel(model, i);
    addObservation(state, obs);

    const mark = obs.ok ? 'OK' : obs.status === 429 ? '429' : `ERR ${obs.status}`;
    const retry = obs.retryAfterMs ? ` retry_after=${Math.ceil(obs.retryAfterMs / 1000)}s` : '';
    console.log(`${mark.padEnd(7)} ${model.padEnd(34)} attempt=${String(i).padStart(3)} ms=${String(obs.ms).padStart(5)}${retry}`);

    const nonRetryable = [400, 401, 403, 404, 410].includes(obs.status);
    if (STOP_ON_429 && (obs.status === 429 || obs.retryAfterMs > 0)) break;
    if (nonRetryable) break;
  }
  state.p50Ms = percentile(state.latenciesMs, 50);
  state.p95Ms = percentile(state.latenciesMs, 95);
  return state;
}

async function runPool(models) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < models.length && !globalStop) {
      const model = models[idx++];
      results.push(await probeModel(model));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, models.length) }, worker));
  return results.sort((a, b) => models.indexOf(a.model) - models.indexOf(b.model));
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeReports(report) {
  const jsonPath = join(REPORT_DIR, `capacity-${RUN_ID}.json`);
  const csvPath = join(REPORT_DIR, `capacity-${RUN_ID}.csv`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const header = [
    'model', 'attempts', 'success', 'rateLimited', 'errors',
    'p50Ms', 'p95Ms', 'retryAfterSec', 'statuses', 'firstError',
  ];
  const lines = [header.join(',')];
  for (const r of report.models) {
    lines.push([
      r.model,
      r.attempts,
      r.success,
      r.rateLimited,
      r.errors,
      r.p50Ms,
      r.p95Ms,
      Math.ceil((r.retryAfterMs || 0) / 1000),
      JSON.stringify(r.statuses),
      r.samples?.[0]?.message || '',
    ].map(csvEscape).join(','));
  }
  writeFileSync(csvPath, lines.join('\n') + '\n');
  return { jsonPath, csvPath };
}

async function main() {
  const models = filterModels(await loadModels());
  if (!models.length) throw new Error('No models selected.');

  console.log(`Base: ${BASE_URL}`);
  console.log(`Models: ${models.length}`);
  console.log(`Mode: ${UNTIL_RATE_LIMIT ? `until first 429, max ${MAX_PER_MODEL}/model` : `${ROUNDS} round(s)/model`}`);
  console.log(`Concurrency: ${CONCURRENCY}, delay: ${DELAY_MS}ms, global max: ${MAX_REQUESTS}`);
  console.log('');

  if (DRY_RUN) {
    for (const m of models) console.log(m);
    return;
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const results = await runPool(models);
  const elapsedMs = Date.now() - startedMs;

  const summary = {
    models: results.length,
    attempts: results.reduce((n, r) => n + r.attempts, 0),
    success: results.reduce((n, r) => n + r.success, 0),
    rateLimited: results.reduce((n, r) => n + r.rateLimited, 0),
    errors: results.reduce((n, r) => n + r.errors, 0),
    elapsedMs,
  };
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    config: {
      rounds: ROUNDS,
      untilRateLimit: UNTIL_RATE_LIMIT,
      maxPerModel: MAX_PER_MODEL,
      maxRequests: MAX_REQUESTS,
      concurrency: CONCURRENCY,
      delayMs: DELAY_MS,
      timeoutMs: TIMEOUT_MS,
      maxTokens: MAX_TOKENS,
      cacheBust: CACHE_BUST,
    },
    summary,
    models: results,
  };
  const paths = writeReports(report);

  console.log('\nSummary');
  console.log(`  attempts:     ${summary.attempts}`);
  console.log(`  success:      ${summary.success}`);
  console.log(`  rate limited: ${summary.rateLimited}`);
  console.log(`  errors:       ${summary.errors}`);
  console.log(`  elapsed:      ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  json:         ${paths.jsonPath}`);
  console.log(`  csv:          ${paths.csvPath}`);
  if (UNTIL_RATE_LIMIT) {
    console.log('\nObserved success is a lower-bound for this run, not a guaranteed daily quota.');
    console.log('For a clean daily estimate, start from a fresh reset window and keep concurrency low.');
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
