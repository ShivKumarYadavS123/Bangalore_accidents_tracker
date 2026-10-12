/**
 * Check that the News Agent's AI triage works with your OpenRouter key.
 *
 *   cd server
 *   node scripts/agent-ai-check.mjs
 *
 * Loads server/.env the same way index.js does, sends ONE triage request with
 * 5 sample headlines (2 Bengaluru crashes, 1 crash elsewhere, 2 non-accidents)
 * using the agent's model order, and prints every attempt (model, HTTP status,
 * finish_reason, token usage) and which headlines the AI kept.
 * Uses 1 to 3 of the free daily OpenRouter calls. Never prints the API key.
 *
 * Exit code: 0 = triage works, 1 = no usable reply, 2 = not configured.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Imported after .env is loaded so every setting is in place.
const { chatJSON, reasoningParam } = await import('../ai/llm.mjs');
const { buildTriageMessages, parseTriage, agentModels, TRIAGE_ATTEMPTS, TRIAGE_MAX_TOKENS } = await import('../agent/news-agent.mjs');

const today = new Date().toISOString();
const SAMPLES = [
  { title: 'Two bikers killed as speeding lorry rams them near Silk Board junction in Bengaluru', publisher: 'Sample', publishedAt: today, keep: true },
  { title: 'BMTC bus knocks down woman crossing Outer Ring Road near Marathahalli in Bengaluru; she is critical', publisher: 'Sample', publishedAt: today, keep: true },
  { title: 'Three killed as car collides with truck on Mumbai-Pune Expressway', publisher: 'Sample', publishedAt: today, keep: false },
  { title: 'Bengaluru traffic police announce diversions on Hosur Road for metro work this weekend', publisher: 'Sample', publishedAt: today, keep: false },
  { title: 'Heavy rain causes waterlogging on Outer Ring Road in Bengaluru', publisher: 'Sample', publishedAt: today, keep: false },
];

const line = (s = '') => console.log(s);

line('BAT News Agent - AI triage check');
line('--------------------------------');
if (!process.env.OPENROUTER_API_KEY) {
  line('OPENROUTER_API_KEY: NOT SET in server/.env. Add it and run again. (No AI call was made.)');
  process.exit(2);
}
if (process.env.AI_DISABLE_LLM === 'true') {
  line('AI_DISABLE_LLM=true in server/.env, so the AI is switched off. (No AI call was made.)');
  process.exit(2);
}
const models = agentModels(process.env);
line('OPENROUTER_API_KEY: set (value not shown)');
line(`Models in order:    ${models.join(', ')}`);
line(`Reasoning control:  ${reasoningParam() ? JSON.stringify(reasoningParam()) : 'off (AI_REASONING_EFFORT=off)'}`);
line(`max_tokens:         ${TRIAGE_MAX_TOKENS}, up to ${TRIAGE_ATTEMPTS} attempts`);
line();

// Record every attempt chatJSON makes, without changing what it receives.
const attempts = [];
async function recordingFetch(url, init) {
  const sent = JSON.parse(init.body);
  const started = Date.now();
  const res = await fetch(url, init);
  let body = null;
  try { body = await res.clone().json(); } catch { /* not JSON */ }
  attempts.push({ model: sent.model, status: res.status, seconds: ((Date.now() - started) / 1000).toFixed(1), body });
  return res;
}

let out = null;
let failure = null;
try {
  out = await chatJSON({
    messages: buildTriageMessages(SAMPLES),
    models,
    maxAttempts: TRIAGE_ATTEMPTS,
    temperature: 0,
    maxTokens: TRIAGE_MAX_TOKENS,
    timeoutMs: 60000,
    cacheTtlMs: 0,
    fetchImpl: recordingFetch,
    validate: (j) => parseTriage(j, SAMPLES.length),
  });
} catch (e) {
  failure = e;
}

attempts.forEach((a, i) => {
  const choice = a.body?.choices?.[0];
  const usage = a.body?.usage || {};
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;
  const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  line(`Attempt ${i + 1}: ${a.model} -> HTTP ${a.status} in ${a.seconds} s`);
  if (a.status !== 200) {
    line(`  error:         ${String(a.body?.error?.message || 'no details').slice(0, 300)}`);
  } else {
    line(`  answered by:   ${a.body?.model || a.model}`);
    line(`  finish_reason: ${choice?.finish_reason ?? 'unknown'}`);
    line(`  tokens:        prompt ${usage.prompt_tokens ?? '?'}, completion ${usage.completion_tokens ?? '?'}, reasoning ${reasoning ?? 0}`);
    line(`  reply:         ${content ? content.replace(/\s+/g, ' ').slice(0, 200) : '(EMPTY)'}`);
  }
  line();
});
line(`AI calls used: ${attempts.length}`);
line();

if (failure) {
  line('RESULT: FAIL - no usable reply from any model.');
  line(`  ${String(failure.message).slice(0, 800)}`);
  line('  If every attempt says "Empty model reply (finish_reason=length ...)", the models are still');
  line('  spending max_tokens on reasoning: try AI_REASONING_EFFORT=minimal, or put a different free');
  line('  model first in AGENT_MODELS.');
  line('  HTTP 429 "rate-limited upstream" means that free model is busy right now (the next model is');
  line('  tried); if every model says it, run the check again in a few minutes.');
  line('  HTTP 429 "free-models-per-day" means the free daily limit is used up (try tomorrow).');
  process.exit(1);
}

const kept = parseTriage(out.json, SAMPLES.length);
line(`RESULT: the AI answered with valid JSON (model ${out.model}, finish_reason ${out.finishReason ?? 'unknown'}).`);
SAMPLES.forEach((s, i) => {
  const got = kept.has(i);
  const mark = got === s.keep ? 'ok   ' : 'WRONG';
  line(`  [${i + 1}] ${got ? 'KEPT   ' : 'dropped'} ${mark} ${s.title}${got && kept.get(i) ? `  (${kept.get(i)})` : ''}`);
});
const crashesKept = SAMPLES.every((s, i) => !s.keep || kept.has(i));
const extras = SAMPLES.filter((s, i) => !s.keep && kept.has(i)).length;
line();
if (crashesKept && !extras) {
  line('PASS: triage works. It kept both Bengaluru crashes and dropped the other three.');
} else if (crashesKept) {
  line(`PASS (with a note): triage works and kept both Bengaluru crashes, plus ${extras} it should have dropped.`);
  line('  That is acceptable: the extraction step still rejects crashes outside Bengaluru and non-accidents.');
} else {
  line('WORKS, BUT MISSED A CRASH: the AI replied, but dropped a Bengaluru crash. Run it once more;');
  line('  if it keeps happening, put a different free model first in AGENT_MODELS.');
}
process.exit(0);
