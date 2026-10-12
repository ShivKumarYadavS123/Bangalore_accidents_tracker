/**
 * Free-only LLM client for BAT's AI features (OpenRouter).
 *
 * Budget rules (the project is unfunded):
 *  - Only models that are free on OpenRouter are allowed: ids ending in ":free"
 *    or the "openrouter/free" meta-router. A paid model id in .env is replaced
 *    with "openrouter/free" unless ALLOW_PAID_MODELS=true is set explicitly.
 *  - A daily call budget (AI_DAILY_LLM_BUDGET, default 45) keeps us under the
 *    OpenRouter free-tier daily limit. When it is used up, callers fall back to
 *    their deterministic (no-LLM) path instead of failing.
 *  - Responses are cached in memory so repeated questions cost nothing.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const FREE_ROUTER = 'openrouter/free';

export function isFreeModel(id) {
  const s = String(id || '').trim();
  return s === FREE_ROUTER || /:free$/i.test(s);
}

const warned = new Set();
export function ensureFreeModel(id, fallback = FREE_ROUTER) {
  const s = String(id || '').trim();
  if (!s) return fallback;
  if (isFreeModel(s) || process.env.ALLOW_PAID_MODELS === 'true') return s;
  if (!warned.has(s)) {
    warned.add(s);
    console.warn(`[ai] Model "${s}" is not a free model; using "${fallback}" instead (set ALLOW_PAID_MODELS=true to override).`);
  }
  return fallback;
}

/**
 * Ordered list of free models to try for text tasks. The "openrouter/free"
 * router alone is unreliable for structured output (it can land on a
 * content-safety classifier), so general-purpose free models are tried first
 * and the router is the last resort. Override with OPENROUTER_AGENT_MODELS
 * (comma-separated) if a model is retired.
 */
export const DEFAULT_TEXT_MODELS = ['nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free', FREE_ROUTER];
export const DEFAULT_VISION_MODELS = ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', FREE_ROUTER];

function modelList(envValue, defaults) {
  const list = String(envValue || '').split(',').map(s => s.trim()).filter(Boolean);
  const chosen = (list.length ? list : defaults).map(m => ensureFreeModel(m));
  return [...new Set(chosen)];
}

export function textModels() { return modelList(process.env.OPENROUTER_AGENT_MODELS || process.env.OPENROUTER_AGENT_MODEL, DEFAULT_TEXT_MODELS); }
export function visionModels() { return modelList(process.env.OPENROUTER_AI_VISION_MODELS, DEFAULT_VISION_MODELS); }
export const textModel = () => textModels()[0];
export const visionModel = () => visionModels()[0];

// ── Daily budget ─────────────────────────────────────────────────────────────

const budget = { day: '', used: 0 };

function today() { return new Date().toISOString().slice(0, 10); }

export function budgetStatus() {
  const limit = Number(process.env.AI_DAILY_LLM_BUDGET || 45);
  if (budget.day !== today()) { budget.day = today(); budget.used = 0; }
  return { limit, used: budget.used, remaining: Math.max(0, limit - budget.used) };
}

export function resetBudget() { budget.day = today(); budget.used = 0; }

export function llmAvailable() {
  return Boolean(process.env.OPENROUTER_API_KEY) && process.env.AI_DISABLE_LLM !== 'true' && budgetStatus().remaining > 0;
}

// ── Response cache ───────────────────────────────────────────────────────────

const cache = new Map();
const CACHE_MAX = 200;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) { cache.delete(key); return undefined; }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, exp: Date.now() + ttlMs });
}

export function clearLlmCache() { cache.clear(); }

// ── JSON extraction ──────────────────────────────────────────────────────────

/** Pull the first balanced JSON object out of a model reply (handles ```json fences and chatter). */
export function extractJson(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  if (s.indexOf('{') < 0) throw new Error('No JSON object in model reply');
  // Try every '{' as a start (some models emit a stray leading brace).
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    const end = balancedEnd(s, start);
    if (end < 0) continue;
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* try next start */ }
  }
  throw new Error('Unbalanced JSON in model reply');
}

function balancedEnd(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

// ── Reasoning control ────────────────────────────────────────────────────────

export const REASONING_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];

/**
 * OpenRouter's unified reasoning control, sent with every request. Reasoning
 * tokens count against max_tokens on most providers, so a "thinking" model
 * left alone can spend the whole budget thinking and return empty content.
 * Low effort keeps the thinking short and `exclude` keeps it out of the reply.
 * Models that don't reason ignore it (OpenRouter's default routing drops
 * parameters a provider doesn't support).
 * AI_REASONING_EFFORT: low (default), minimal, medium, high, none, ... or off to send nothing.
 */
export function reasoningParam(env = process.env) {
  const v = String(env.AI_REASONING_EFFORT ?? '').trim().toLowerCase();
  if (v === 'off' || v === 'false') return null;
  return { effort: REASONING_EFFORTS.includes(v) ? v : 'low', exclude: true };
}

/** "finish_reason=length, completion_tokens=1500, reasoning_tokens=1490" for error messages. */
function finishDetails(choice, usage) {
  const parts = [`finish_reason=${choice?.finish_reason ?? choice?.native_finish_reason ?? 'unknown'}`];
  if (Number.isFinite(usage?.completion_tokens)) parts.push(`completion_tokens=${usage.completion_tokens}`);
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;
  if (Number.isFinite(reasoning)) parts.push(`reasoning_tokens=${reasoning}`);
  return parts.join(', ');
}

// ── Chat call ────────────────────────────────────────────────────────────────

/**
 * Call free chat models and return { json, text, model, finishReason, usage }.
 * Tries each model in `models` (default: textModels()) until one returns
 * parseable JSON; at most `maxAttempts` calls, each counted against the budget.
 * A malformed reply retries the same model once; an empty reply or an HTTP
 * error moves to the next model.
 * Throws when all attempts fail so callers can use their deterministic fallback.
 * `content` in messages may be a string or an OpenAI-style multimodal array.
 */
export async function chatJSON({ messages, model, models, maxAttempts = 3, temperature = 0.2, maxTokens = 3000, timeoutMs = 90000, cacheTtlMs = 30 * 60 * 1000, fetchImpl = globalThis.fetch, validate }) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  if (process.env.AI_DISABLE_LLM === 'true') throw new Error('LLM disabled');
  const candidates = (models || (model ? [model] : textModels())).map(m => ensureFreeModel(m));
  const key = JSON.stringify([candidates, temperature, messages]);
  const cached = cacheTtlMs > 0 ? cacheGet(key) : undefined;
  if (cached) return { ...cached, cached: true };

  const errors = [];
  let attempts = 0;
  for (const chosen of candidates) {
    // A malformed reply is often a one-off, so retry the same model once.
    // An empty reply (typically a reasoning model that used max_tokens on
    // thinking) and HTTP errors (rate limits, outages) move to the next model.
    for (let tryNo = 0; tryNo < 2 && attempts < Math.max(1, maxAttempts); tryNo++) {
      attempts++;
      try {
        const out = await callOnce({ chosen, messages, temperature, maxTokens, timeoutMs, fetchImpl });
        if (validate) validate(out.json);
        if (cacheTtlMs > 0) cacheSet(key, out, cacheTtlMs);
        return out;
      } catch (e) {
        errors.push(`${chosen}: ${e.message}`);
        if (/budget/i.test(e.message)) throw new Error(errors.join(' | '));
        if (e.code === 'EMPTY_REPLY') break;
        if (!/JSON|missing|Reply/i.test(e.message)) break;
      }
    }
    if (attempts >= maxAttempts) break;
  }
  throw new Error(errors.join(' | ') || 'No model available');
}

async function callOnce({ chosen, messages, temperature, maxTokens, timeoutMs, fetchImpl }) {
  const b = budgetStatus();
  if (b.remaining <= 0) throw new Error('Daily free LLM budget used up');
  budget.used++;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/shreyastk/Bangalore_accidents_tracker',
        'X-Title': 'Bangalore Accidents Tracker',
      },
      body: JSON.stringify({
        model: chosen,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        ...(reasoningParam() ? { reasoning: reasoningParam() } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${body?.error?.message || 'error'}`);
    const choice = body?.choices?.[0];
    const text = choice?.message?.content;
    if (!text) {
      const e = new Error(`Empty model reply (${finishDetails(choice, body?.usage)})`);
      e.code = 'EMPTY_REPLY';
      throw e;
    }
    return { json: extractJson(text), text, model: body.model || chosen, finishReason: choice?.finish_reason ?? null, usage: body?.usage ?? null };
  } finally {
    clearTimeout(timer);
  }
}

// ── Numeric grounding check ─────────────────────────────────────────────────

/** Collect every number that appears anywhere in a facts object (plus rounded variants). */
export function allowedNumbers(facts) {
  const set = new Set();
  const add = (n) => {
    if (!Number.isFinite(n)) return;
    set.add(String(n));
    set.add(String(Math.round(n)));
    set.add(n.toFixed(1).replace(/\.0$/, ''));
    set.add(String(Math.abs(Math.round(n))));
  };
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'number') add(v);
    else if (typeof v === 'string') (v.match(/\d+(?:\.\d+)?/g) || []).forEach(x => add(Number(x)));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(facts);
  return set;
}

/**
 * Returns the numbers in `text` that do not appear in `facts`.
 * Used to reject LLM output that invents statistics.
 */
export function unsupportedNumbers(text, facts, { ignoreBelow = 2 } = {}) {
  const allowed = allowedNumbers(facts);
  const found = String(text || '').replace(/,(?=\d{3})/g, '').match(/\d+(?:\.\d+)?/g) || [];
  return found.filter(n => Number(n) >= ignoreBelow && !allowed.has(n) && !allowed.has(String(Number(n))));
}

/**
 * Catches the most harmful hallucination class for this app: a real number
 * attached to the wrong severity (e.g. "11 lives lost" when 6 were fatal).
 * `counts` is { fatal, serious, minor } for the period being described.
 * Returns human-readable problems; empty array means the claims are consistent.
 */
export function severityClaimErrors(text, counts) {
  if (!counts) return [];
  const s = String(text || '').toLowerCase().replace(/,(?=\d{3})/g, '');
  const rules = [
    { key: 'fatal', re: /(\d+)\s+(?:fatal(?:ities)?|deaths?|lives?(?:\s+lost)?|people\s+(?:killed|died)|killed|dead)\b/g },
    { key: 'serious', re: /(\d+)\s+serious\b/g },
    { key: 'minor', re: /(\d+)\s+minor\b/g },
  ];
  const problems = [];
  for (const { key, re } of rules) {
    for (const m of s.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isFinite(counts[key]) && n !== counts[key]) problems.push(`"${m[0]}" but data says ${counts[key]} ${key}`);
    }
  }
  return problems;
}
