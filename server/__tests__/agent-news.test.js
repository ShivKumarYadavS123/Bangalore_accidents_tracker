/**
 * BAT News Agent: feed parsing, the run steps, AI budgets, the seen-list and
 * the schedule. Feeds, articles and OpenRouter are all mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createNewsAgent, parseTriage, agentModels, isModelRateLimit, TRIAGE_BATCH, DEFAULT_AGENT_MODELS, STATUS_CHECK_REASON } from '../agent/news-agent.mjs';
import { chatReply, jsonResponse } from './fixtures/ai-fixtures.js';
import { createImportPipeline, istDate } from '../agent/pipeline.mjs';
import {
  parseGoogleNewsRss, parseGdelt, googleNewsUrl, gdeltUrl, normalizeUrl, urlKey, linkVariants,
  htmlToText, titleTokens, similarTitles, parseQueries, DEFAULT_QUERIES,
} from '../agent/sources.mjs';
import { resetBudget, clearLlmCache } from '../ai/llm.mjs';
import {
  GOOGLE_RSS, GOOGLE_ITEMS, GDELT_JSON, GDELT_URLS, CRASH_ARTICLE, googleRss, extraction,
  makeFeedFetch, makeAi, makeStore, tmpDir, silentLogger, openRouterError, upstreamLimited, freeDailyLimit, STATUS_CHECK_ERROR,
} from './fixtures/agent-fixtures.js';

beforeEach(() => { process.env.OPENROUTER_API_KEY = 'test-key'; delete process.env.AI_DISABLE_LLM; resetBudget(); clearLlmCache(); });
afterEach(() => { delete process.env.OPENROUTER_API_KEY; vi.useRealTimers(); vi.restoreAllMocks(); });

const fullBudget = () => ({ limit: 45, used: 0, remaining: 45 });

function makeAgent({ env = {}, store = makeStore(), fetchUrl = makeFeedFetch(), aiFetch = makeAi(), dataDir = tmpDir(), budgetStatus = fullBudget, geocode = async () => ({ lat: 12.9177, lng: 77.6233 }), sleep = async () => {} } = {}) {
  const pipeline = createImportPipeline({ store, geocode, inferZone: () => 'South', sleep: async () => {}, logger: silentLogger });
  const agent = createNewsAgent({
    pipeline, store, dataDir, fetchUrl, aiFetch, budgetStatus,
    // Publisher feeds off unless a test turns them on, so the older tests count only GDELT and Google News requests.
    env: { OPENROUTER_API_KEY: 'test-key', AGENT_QUERIES: 'Bengaluru accident|ಬೆಂಗಳೂರು ಅಪಘಾತ', AGENT_RSS_FEEDS: 'off', ...env },
    logger: silentLogger, sleep,
  });
  return { agent, store, fetchUrl, aiFetch, dataDir };
}

async function runOnce(agent, opts) {
  const r = agent.runAgent(opts);
  expect(r.started).toBe(true);
  return r.done;
}

/** A made-up word per index, so generated headlines are distinct stories (digits alone are ignored). */
const word = (i) => 'abcdefghijklmnopqrstuvwxyz'[i % 26] + 'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26) % 26] + 'q';

/** n distinct accident headlines with their own Google links. */
const manyHeadlines = (n) => googleRss(Array.from({ length: n }, (_, i) => ({
  title: `Biker injured in crash at ${word(i)}nagar junction near ${word(i + 300)}pura`,
  publisher: 'Deccan Herald',
  link: `https://news.google.com/rss/articles/CBMiMANY${i}`,
})));

describe('sources', () => {
  it('parses a Google News RSS feed', () => {
    const items = parseGoogleNewsRss(GOOGLE_RSS);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      source: 'google-news',
      title: 'Two killed as lorry rams bike on Hosur Road',
      url: 'https://news.google.com/rss/articles/CBMiAAA111?oc=5',
      publisher: 'Deccan Herald',
      publisherUrl: 'https://www.deccanherald.com',
      snippet: '',
    });
    expect(items[0].publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(items[2]).toMatchObject({ title: 'ಹೆಬ್ಬಾಳ ಮೇಲ್ಸೇತುವೆ ಬಳಿ ಬೈಕ್‌ಗೆ ಬಸ್ ಡಿಕ್ಕಿ', publisher: 'Prajavani' });
    expect(parseGoogleNewsRss('<rss><channel></channel></rss>')).toEqual([]);
    expect(parseGoogleNewsRss('not xml')).toEqual([]);
  });

  it('parses a GDELT artlist response', () => {
    const items = parseGdelt(JSON.stringify(GDELT_JSON));
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      source: 'gdelt', title: 'Car overturns on NICE Road, driver injured', url: GDELT_URLS.crash,
      publisher: null, publisherUrl: null, domain: 'thehindu.com', publishedAt: '2026-10-10T09:15:00.000Z', snippet: '',
    });
    expect(parseGdelt('{}')).toEqual([]);
    expect(parseGdelt('')).toEqual([]);
    expect(() => parseGdelt('Please limit requests to one every 5 seconds')).toThrow(/non-JSON/);
  });

  it('builds the feed URLs (Kannada edition for Kannada queries)', () => {
    expect(googleNewsUrl('Bengaluru accident')).toBe('https://news.google.com/rss/search?q=Bengaluru%20accident%20when%3A2d&hl=en-IN&gl=IN&ceid=IN:en');
    expect(googleNewsUrl('ಬೆಂಗಳೂರು ಅಪಘಾತ', 30)).toMatch(/when%3A30d&hl=kn&gl=IN&ceid=IN:kn$/);
    const g = new URL(gdeltUrl(2));
    expect(g.searchParams.get('query')).toBe('(accident OR crash OR collision) (Bengaluru OR Bangalore) sourcecountry:india');
    expect(Object.fromEntries([...g.searchParams].filter(([k]) => k !== 'query'))).toEqual({ mode: 'artlist', format: 'json', timespan: '2d', maxrecords: '100', sort: 'datedesc' });
  });

  it('reads queries from AGENT_QUERIES', () => {
    expect(parseQueries('')).toEqual(DEFAULT_QUERIES);
    expect(DEFAULT_QUERIES).toEqual(['Bengaluru accident', 'Bengaluru road accident killed', 'Bengaluru crash injured', 'Bengaluru hit-and-run', 'ಬೆಂಗಳೂರು ಅಪಘಾತ']);
    expect(parseQueries(' a | b ||c ')).toEqual(['a', 'b', 'c']);
  });

  it('normalises URLs and compares them loosely', () => {
    expect(normalizeUrl('https://www.thehindu.com/a.ece?utm_source=gdelt&id=3#comments')).toBe('https://www.thehindu.com/a.ece?id=3');
    expect(normalizeUrl('https://news.google.com/rss/articles/X?oc=5')).toBe('https://news.google.com/rss/articles/X');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(urlKey('http://www.a.com/x/')).toBe(urlKey('https://a.com/x'));
    expect(linkVariants('https://a.com/x')).toEqual(expect.arrayContaining(['https://a.com/x', 'http://a.com/x', 'https://a.com/x/']));
  });

  it('extracts article text without menus and scripts', () => {
    const text = htmlToText(CRASH_ARTICLE);
    expect(text).toMatch(/overturned on NICE Road/);
    expect(text).not.toMatch(/window\.ads|Home|Copyright/);
  });

  it('spots near-identical headlines', () => {
    expect(similarTitles(titleTokens('Two killed as lorry rams bike on Hosur Road'), titleTokens('Two killed as lorry rams bike on Hosur road - Deccan Herald', 'Deccan Herald'))).toBe(true);
    expect(similarTitles(titleTokens('Two killed as lorry rams bike on Hosur Road'), titleTokens('Car overturns on NICE Road, driver injured'))).toBe(false);
  });
});

describe('triage replies', () => {
  it('accepts 1-based indexes, numbers or objects, and rejects bad ones', () => {
    expect([...parseTriage({ keep: [{ i: 2, reason: 'crash' }, 3] }, 3).entries()]).toEqual([[1, 'crash'], [2, '']]);
    expect(() => parseTriage({ keep: [{ i: 4 }] }, 3)).toThrow(/Reply/);
    expect(() => parseTriage({ items: [] }, 3)).toThrow(/Reply/);
    expect(parseTriage({ keep: [] }, 3).size).toBe(0);
  });
});

describe('News Agent run', () => {
  it('searches, filters, triages, reads and saves pending rows', async () => {
    const { agent, store, fetchUrl, aiFetch, dataDir } = makeAgent();
    const run = await runOnce(agent);

    expect(run.status).toBe('completed');
    expect(run.sources.GDELT).toEqual({ ok: true, count: 2 });
    expect(run.sources['Google News: Bengaluru accident']).toEqual({ ok: true, count: 3 });
    // Mall + waterlogging fail the keyword filter; three crashes go to one triage call.
    expect(aiFetch.calls.triage).toEqual([3]);
    expect(aiFetch.calls.extract).toHaveLength(3);
    expect(run.aiCalls).toBe(4);
    expect(run.counts).toMatchObject({ imported: 3, not_accident: 2 });

    const byLink = Object.fromEntries(store.inserted.map(r => [r.link, r]));
    // GDELT: the publisher page was read; tracking parameters dropped from the link.
    const hindu = byLink['https://www.thehindu.com/news/cities/bangalore/car-overturns-on-nice-road/article1.ece'];
    expect(hindu).toMatchObject({ status: 'pending', reporter_id: null, source: 'The Hindu' });
    expect(hindu.description.endsWith('(Found by BAT News Agent)')).toBe(true);
    expect(aiFetch.calls.extract.some(u => u.includes('overturned on NICE Road near the Hosur Road junction'))).toBe(true);
    // Google News: the Google page is never read, so the headline is used and the Google link kept.
    const dh = byLink['https://news.google.com/rss/articles/CBMiAAA111'];
    expect(dh).toMatchObject({ source: 'Deccan Herald', status: 'pending' });
    const googleCalls = fetchUrl.mock.calls.filter(([u]) => u.startsWith('https://news.google.com/rss/articles/'));
    expect(googleCalls.length).toBeGreaterThan(0);
    for (const [u, opts] of googleCalls) expect(opts.skipBodyIf(u)).toBe(true);
    expect(run.items.find(i => i.url.includes('CBMiAAA111')).reason).toMatch(/used the headline/);

    // Files: run log, seen list and the IST daily counter.
    const runsFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-runs.json'), 'utf8'));
    expect(runsFile[0].id).toBe(run.id);
    const seen = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-seen.json'), 'utf8'));
    expect(seen).toEqual(expect.arrayContaining([urlKey(GOOGLE_ITEMS[0].link), urlKey(GDELT_URLS.other)]));
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-state.json'), 'utf8'));
    expect(state).toMatchObject({ day: istDate(), aiCalls: 4 });
    expect(run.items.every(i => ['imported', 'duplicate', 'not_accident', 'outside_bangalore', 'invalid_link', 'error'].includes(i.status))).toBe(true);
  });

  it('skips URLs it has already seen', async () => {
    const dataDir = tmpDir();
    const keys = [...GOOGLE_ITEMS.map(i => urlKey(i.link)), urlKey(GDELT_URLS.crash), urlKey(GDELT_URLS.other)];
    fs.writeFileSync(path.join(dataDir, 'agent-seen.json'), JSON.stringify(keys));
    const { agent, aiFetch, store } = makeAgent({ dataDir });
    const run = await runOnce(agent);
    expect(run.counts.alreadySeen).toBe(5);
    expect(aiFetch).not.toHaveBeenCalled();
    expect(store.inserted).toHaveLength(0);
  });

  it('a wiped seen-list never creates duplicate rows', async () => {
    const store = makeStore();
    const dataDir = tmpDir();
    await runOnce(makeAgent({ store, dataDir }).agent);
    expect(store.inserted).toHaveLength(3);
    fs.rmSync(dataDir, { recursive: true, force: true });
    // Even with the stored-link list unavailable, the save step's link match catches every repeat.
    const second = makeAgent({ store: Object.assign(store, { allLinkKeys: async () => { throw new Error('db down'); } }), dataDir: tmpDir() });
    const run = await runOnce(second.agent);
    expect(store.inserted).toHaveLength(3);
    expect(run.counts.imported).toBe(0);
    expect(run.counts.duplicate).toBe(3);
  });

  it('sends at most 30 headlines per triage call', async () => {
    const { agent, aiFetch } = makeAgent({ fetchUrl: makeFeedFetch({ gdelt: { articles: [] }, rss: manyHeadlines(45) }), aiFetch: makeAi({ keep: () => [] }) });
    const run = await runOnce(agent);
    expect(TRIAGE_BATCH).toBe(30);
    expect(aiFetch.calls.triage).toEqual([30, 15]);
    expect(run.aiCalls).toBe(2);
    expect(run.counts.not_accident).toBe(45);
  });

  it('stops at the per-run AI budget and logs "budget reached"', async () => {
    const { agent, aiFetch, dataDir } = makeAgent({ env: { AGENT_MAX_AI_CALLS_PER_RUN: '1' }, fetchUrl: makeFeedFetch({ gdelt: { articles: [] }, rss: manyHeadlines(45) }) });
    const run = await runOnce(agent);
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect(run.aiCalls).toBe(1);
    expect(run.status).toBe('budget_reached');
    expect(run.log.some(l => /budget reached/.test(l))).toBe(true);
    expect(run.counts.imported).toBe(0);
    expect(run.counts.deferred).toBeGreaterThan(0);
    // Deferred items are not marked as seen, so a later run picks them up.
    const seen = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-seen.json'), 'utf8'));
    expect(seen).not.toContain(urlKey('https://news.google.com/rss/articles/CBMiMANY40'));
  });

  it('stops at the daily AI budget (IST day, kept across runs)', async () => {
    const dataDir = tmpDir();
    fs.writeFileSync(path.join(dataDir, 'agent-state.json'), JSON.stringify({ day: istDate(), aiCalls: 19 }));
    const { agent, aiFetch } = makeAgent({ dataDir, env: { AGENT_DAILY_AI_BUDGET: '20' } });
    const run = await runOnce(agent);
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('budget_reached');
    expect(run.stopReason).toMatch(/daily AI limit/);
    expect(agent.status().aiCallsToday).toBe(20);
    const again = await runOnce(agent);
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect(again.aiCalls).toBe(0);
  });

  it('resets the daily count on a new IST day', async () => {
    const dataDir = tmpDir();
    fs.writeFileSync(path.join(dataDir, 'agent-state.json'), JSON.stringify({ day: '2020-01-01', aiCalls: 20 }));
    const { agent } = makeAgent({ dataDir });
    expect(agent.status().aiCallsToday).toBe(0);
  });

  it('never starts an AI step when fewer than 10 site-wide calls are left', async () => {
    const { agent, aiFetch, store } = makeAgent({ budgetStatus: () => ({ limit: 45, used: 36, remaining: 9 }) });
    const run = await runOnce(agent);
    expect(aiFetch).not.toHaveBeenCalled();
    expect(run.status).toBe('budget_reached');
    expect(run.stopReason).toMatch(/site-wide/);
    expect(store.inserted).toHaveLength(0);
  });

  it('a failing source is logged and skipped', async () => {
    const { agent, store } = makeAgent({ fetchUrl: makeFeedFetch({ fail: ['api.gdeltproject.org', 'hl=kn'] }) });
    const run = await runOnce(agent);
    expect(run.status).toBe('completed');
    expect(run.sources.GDELT).toMatchObject({ ok: false, count: 0, error: expect.stringMatching(/ECONNREFUSED/) });
    expect(run.sources['Google News: ಬೆಂಗಳೂರು ಅಪಘಾತ'].ok).toBe(false);
    expect(run.sources['Google News: Bengaluru accident'].ok).toBe(true);
    expect(store.inserted.length).toBe(2);
    expect(run.log.some(l => /GDELT: failed/.test(l))).toBe(true);
  });

  it('a 429 from OpenRouter stops the run', async () => {
    const { agent, aiFetch, store } = makeAgent({ aiFetch: makeAi({ status: 429 }) });
    const run = await runOnce(agent);
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('rate_limited');
    expect(run.log.some(l => /rate limit/.test(l))).toBe(true);
    expect(store.inserted).toHaveLength(0);
  });

  it('runs never overlap', async () => {
    let release;
    const hold = new Promise(r => { release = r; });
    const { agent } = makeAgent({ fetchUrl: makeFeedFetch({ hold }) });
    const first = agent.runAgent();
    expect(first.started).toBe(true);
    expect(agent.status().running).toBe(true);
    expect(agent.runAgent()).toMatchObject({ started: false, reason: 'running', runId: first.runId });
    release();
    await first.done;
    expect(agent.status().running).toBe(false);
    const third = agent.runAgent();
    expect(third.started).toBe(true);
    await third.done;
  });

  it('backfill searches the last N days (max 30) under the same budgets', async () => {
    const { agent, fetchUrl } = makeAgent();
    const run = await runOnce(agent, { backfillDays: 45 });
    expect(run).toMatchObject({ trigger: 'backfill', days: 30 });
    const urls = fetchUrl.mock.calls.map(([u]) => u);
    expect(urls.some(u => u.includes('when%3A30d'))).toBe(true);
    expect(urls.some(u => u.includes('timespan=30d&maxrecords=250'))).toBe(true);
  });

  it('articles over the read limit wait for the next run without another triage call', async () => {
    const { agent, aiFetch, store } = makeAgent({ env: { AGENT_MAX_READS_PER_RUN: '1' } });
    const first = await runOnce(agent);
    expect(first.counts.imported).toBe(1);
    expect(agent.status().queueLength).toBe(2);
    const second = await runOnce(agent);
    expect(aiFetch.calls.triage).toEqual([3]);
    expect(second.counts.imported).toBe(1);
    expect(store.inserted).toHaveLength(2);
  });

  it('marks the possible duplicate when a nearby same-day record exists', async () => {
    const store = makeStore({ nearby: [{ id: '812', distance_m: 90 }] });
    const { agent } = makeAgent({ store, fetchUrl: makeFeedFetch({ rss: googleRss([GOOGLE_ITEMS[0]]), gdelt: { articles: [] } }) });
    const run = await runOnce(agent);
    expect(run.items.find(i => i.status === 'imported').reason).toMatch(/possible duplicate of #812/);
    expect(store.inserted[0].description.startsWith('Possible duplicate of #812.')).toBe(true);
  });

  it('refuses to run without a database or AI key, and says why', () => {
    const noKey = makeAgent({ env: { OPENROUTER_API_KEY: '' } }).agent;
    expect(noKey.runAgent()).toMatchObject({ started: false, reason: 'not_ready' });
    expect(noKey.status()).toMatchObject({ ready: false, notReadyReason: 'OPENROUTER_API_KEY is not set' });
    const noDb = makeAgent({ store: { ...makeStore(), available: () => false } }).agent;
    expect(noDb.status().notReadyReason).toBe('no database configured');
  });
});

describe('News Agent AI calls', () => {
  const oneHeadline = () => makeFeedFetch({ gdelt: { articles: [] }, rss: googleRss([GOOGLE_ITEMS[0]]) });
  const upstreamLimitedText = (model) => `${model} is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits.`;
  const emptyThinkingReply = () => jsonResponse({
    model: 'nvidia/nemotron',
    choices: [{ finish_reason: 'length', message: { content: '' } }],
    usage: { prompt_tokens: 900, completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 3990 } },
  });
  const isTriage = (body) => body.messages[body.messages.length - 1].content.includes('<<<HEADLINES');

  it('uses the agent model order, 4000 tokens and reasoning control for triage, and gets past an empty reply', async () => {
    const bodies = [];
    let triageCalls = 0;
    const aiFetch = vi.fn(async (_u, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (isTriage(body)) return ++triageCalls === 1 ? emptyThinkingReply() : chatReply({ keep: [{ i: 1, reason: 'crash on Hosur Road' }] });
      return chatReply(extraction());
    });
    const { agent, store } = makeAgent({ fetchUrl: oneHeadline(), aiFetch });
    const run = await runOnce(agent);
    const triage = bodies.filter(isTriage);
    expect(triage.map(b => b.model)).toEqual(DEFAULT_AGENT_MODELS.slice(0, 2));
    expect(triage.every(b => b.max_tokens === 4000)).toBe(true);
    expect(triage[0].reasoning).toEqual({ effort: 'low', exclude: true });
    const extract = bodies.filter(b => !isTriage(b));
    expect(extract).toHaveLength(1);
    expect(extract[0]).toMatchObject({ model: 'google/gemma-4-31b-it:free', max_tokens: 2500 });
    expect(run.counts.imported).toBe(1);
    expect(store.inserted).toHaveLength(1);
    expect(run.aiCalls).toBe(3);
  });

  it('triage may use 3 attempts, one per model, when every model replies with nothing', async () => {
    const bodies = [];
    const aiFetch = vi.fn(async (_u, init) => { bodies.push(JSON.parse(init.body)); return emptyThinkingReply(); });
    const { agent } = makeAgent({ fetchUrl: oneHeadline(), aiFetch });
    const run = await runOnce(agent);
    expect(bodies.map(b => b.model)).toEqual(DEFAULT_AGENT_MODELS);
    expect(run.log.some(l => /finish_reason=length, completion_tokens=4000, reasoning_tokens=3990/.test(l))).toBe(true);
    expect(run.items[0]).toMatchObject({ status: 'error', deferred: true, reason: expect.stringMatching(/will retry next run \(1 of 3\)/) });
  });

  it('reads AGENT_MODELS and never lets a paid model through', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(agentModels({})).toEqual(['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'openrouter/free']);
    expect(agentModels({ AGENT_MODELS: ' a/b:free , openai/gpt-5, a/b:free ' })).toEqual(['a/b:free', 'openrouter/free']);
  });

  it('a headline whose triage fails 3 runs in a row is finished as an error', async () => {
    const aiFetch = vi.fn(async () => chatReply('this is not JSON'));
    const dataDir = tmpDir();
    const { agent } = makeAgent({ fetchUrl: oneHeadline(), aiFetch, dataDir });
    const key = urlKey(GOOGLE_ITEMS[0].link);

    const r1 = await runOnce(agent);
    expect(r1.items[0]).toMatchObject({ status: 'error', deferred: true, reason: expect.stringMatching(/\(1 of 3\)/) });
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-state.json'), 'utf8')).triageFails[key].n).toBe(1);
    const r2 = await runOnce(agent);
    expect(r2.items[0].reason).toMatch(/\(2 of 3\)/);
    const r3 = await runOnce(agent);
    expect(r3.items[0]).toEqual(expect.objectContaining({ status: 'error', step: 'triage', reason: 'AI could not judge this headline (triage failed 3 runs in a row)' }));
    expect(r3.items[0].deferred).toBeUndefined();
    expect(r3.counts.error).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-seen.json'), 'utf8'))).toContain(key);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-state.json'), 'utf8')).triageFails[key]).toBeUndefined();
    const calls = aiFetch.mock.calls.length;
    const r4 = await runOnce(agent);
    expect(aiFetch.mock.calls.length).toBe(calls);
    expect(r4.counts.alreadySeen).toBe(1);
  });

  it('tells a busy model apart from the account limit', () => {
    expect(isModelRateLimit(upstreamLimitedText('google/gemma-4-31b-it:free'))).toBe(true);
    expect(isModelRateLimit('Provider rate limit exceeded, please retry')).toBe(true);
    expect(isModelRateLimit('Rate limit exceeded: free-models-per-day. Add 10 credits')).toBe(false);
    expect(isModelRateLimit('Rate limit exceeded: free-models-per-min.')).toBe(false);
    expect(isModelRateLimit('Provider returned error')).toBe(false);
    expect(isModelRateLimit('')).toBe(false);
  });

  it('a 429 from a model that is busy upstream hands over to the next model, and the run completes', async () => {
    const [first, second] = DEFAULT_AGENT_MODELS;
    const sent = [];
    const aiFetch = vi.fn(async (_u, init) => {
      const body = JSON.parse(init.body);
      sent.push(body.model);
      if (body.model === first) return upstreamLimited(first);
      return isTriage(body) ? chatReply({ keep: [{ i: 1, reason: 'crash' }] }) : chatReply(extraction());
    });
    const { agent, store } = makeAgent({ fetchUrl: oneHeadline(), aiFetch });
    const run = await runOnce(agent);
    expect(run.status).toBe('completed');
    expect(run.stopReason).toBeNull();
    expect(sent).toEqual([first, second, first, second]); // triage, then extraction: busy model, then the next one
    expect(run.counts.imported).toBe(1);
    expect(store.inserted).toHaveLength(1);
    expect(run.aiCalls).toBe(4);
  });

  it('a free-models-per-day 429 stops the run as rate limited', async () => {
    const aiFetch = vi.fn(async () => freeDailyLimit());
    const { agent, store } = makeAgent({ fetchUrl: oneHeadline(), aiFetch });
    const run = await runOnce(agent);
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('rate_limited');
    expect(run.stopReason).toBe('OpenRouter rate limit (HTTP 429)');
    expect(run.items[0]).toMatchObject({ deferred: true, reason: 'AI rate-limited (HTTP 429); will retry next run' });
    expect(store.inserted).toHaveLength(0);
  });

  it('a 429 without a readable reason also stops the run', async () => {
    const aiFetch = vi.fn(async () => openRouterError(429, ''));
    const run = await runOnce(makeAgent({ fetchUrl: oneHeadline(), aiFetch }).agent);
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('rate_limited');
  });

  it('a 429 from every model gives rate_limited', async () => {
    const sent = [];
    const aiFetch = vi.fn(async (_u, init) => { const { model } = JSON.parse(init.body); sent.push(model); return upstreamLimited(model); });
    const run = await runOnce(makeAgent({ fetchUrl: oneHeadline(), aiFetch }).agent);
    expect(sent).toEqual(DEFAULT_AGENT_MODELS);
    expect(run.status).toBe('rate_limited');
    expect(run.items[0].reason).toBe('AI rate-limited (HTTP 429); will retry next run');
  });

  it('a 429 caught mid-extraction says "rate-limited", and no message ever contains null or undefined', async () => {
    const triageThenDailyLimit = () => vi.fn(async (_u, init) => (isTriage(JSON.parse(init.body)) ? chatReply({ keep: [{ i: 1 }, { i: 2 }, { i: 3 }] }) : freeDailyLimit()));
    const scenarios = {
      'daily limit on the first call': { aiFetch: vi.fn(async () => freeDailyLimit()) },
      'daily limit during extraction': { aiFetch: triageThenDailyLimit() },
      'every model busy': { aiFetch: vi.fn(async (_u, init) => upstreamLimited(JSON.parse(init.body).model)) },
      'site-wide budget low': { budgetStatus: () => ({ limit: 45, used: 40, remaining: 5 }) },
      'per-run budget used by triage': { env: { AGENT_MAX_AI_CALLS_PER_RUN: '1' } },
      'daily budget used': { env: { AGENT_DAILY_AI_BUDGET: '1' } },
    };
    for (const [name, opts] of Object.entries(scenarios)) {
      const run = await runOnce(makeAgent({ fetchUrl: makeFeedFetch(), ...opts }).agent);
      const texts = [run.stopReason, ...run.log, ...run.items.map(i => i.reason), ...Object.values(run.sources).map(s => s.error)].filter(t => t != null);
      expect(texts.length, name).toBeGreaterThan(0);
      for (const t of texts) expect(String(t), `${name}: ${t}`).not.toMatch(/\bnull\b|\bundefined\b/);
      if (name === 'daily limit during extraction') {
        expect(run.status).toBe('rate_limited');
        expect(run.items.filter(i => i.deferred).map(i => i.reason)).toContain('AI rate-limited (HTTP 429); will retry next run');
      }
      if (name === 'per-run budget used by triage') {
        expect(run.items.filter(i => i.deferred)[0].reason).toBe('waiting for AI budget (per-run AI limit reached (1 calls))');
      }
    }
  });

  it('waiting for budget does not count as a failed triage', async () => {
    const { agent } = makeAgent({ fetchUrl: oneHeadline(), budgetStatus: () => ({ limit: 45, used: 40, remaining: 5 }) });
    for (let i = 0; i < 4; i++) {
      const run = await runOnce(agent);
      expect(run.items[0]).toMatchObject({ deferred: true, reason: expect.stringMatching(/waiting for AI budget/) });
    }
  });
});

describe('failed saves', () => {
  const oneHeadline = () => makeFeedFetch({ gdelt: { articles: [] }, rss: googleRss([GOOGLE_ITEMS[0]]) });
  const key = urlKey(GOOGLE_ITEMS[0].link);
  const seenFile = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-seen.json'), 'utf8'));
  const stateFile = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-state.json'), 'utf8'));

  it('are deferred and queued with the extracted record; the next run retries only the save (no AI call)', async () => {
    const dataDir = tmpDir();
    const store = makeStore({ insertErrors: ['connection reset by peer'] });
    const { agent, aiFetch } = makeAgent({ fetchUrl: oneHeadline(), store, dataDir });

    const first = await runOnce(agent);
    expect(first.items[0]).toMatchObject({ step: 'save', status: 'error', deferred: true, reason: 'could not save (connection reset by peer); will retry next run' });
    expect(first.counts).toMatchObject({ deferred: 1, error: 0, imported: 0 });
    expect(seenFile(dataDir)).not.toContain(key);
    const queued = stateFile(dataDir).queue[0];
    expect(queued).toMatchObject({ key, saveTries: 1, saveRetry: { item: { link: 'https://news.google.com/rss/articles/CBMiAAA111', publisher: 'Deccan Herald' }, data: { location: 'Hosur Road near Silk Board junction' }, loc: { has_coords: true } } });
    expect(queued.saveRetry.item).not.toHaveProperty('text');
    const aiCalls = aiFetch.mock.calls.length;

    const second = await runOnce(agent);
    expect(aiFetch.mock.calls.length).toBe(aiCalls); // no triage, no extraction
    expect(second.aiCalls).toBe(0);
    expect(second.items[0]).toMatchObject({ step: 'save', status: 'imported', reason: 'imported #1191' });
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]).toMatchObject({ status: 'pending', source: 'Deccan Herald', link: 'https://news.google.com/rss/articles/CBMiAAA111' });
    expect(seenFile(dataDir)).toContain(key);
  });

  it('explain an accidents_status_check failure', async () => {
    const { agent } = makeAgent({ fetchUrl: oneHeadline(), store: makeStore({ insertErrors: () => STATUS_CHECK_ERROR }) });
    const run = await runOnce(agent);
    expect(run.items[0].reason).toBe("database doesn't accept Pending records yet: the Supabase owner must run the accidents_status_check lines from Database/supabase-setup.sql; will retry next run");
    expect(STATUS_CHECK_REASON).toBe(run.items[0].reason);
    expect(run.stopReason).toBe("database doesn't accept Pending records yet: the Supabase owner must run the accidents_status_check lines from Database/supabase-setup.sql");
  });

  it('after a status-check failure, the rest of the run spends no AI calls', async () => {
    const dataDir = tmpDir();
    const store = makeStore({ insertErrors: () => STATUS_CHECK_ERROR });
    const { agent, aiFetch } = makeAgent({ store, dataDir }); // three crash headlines
    const run = await runOnce(agent);
    expect(aiFetch.calls.triage).toEqual([3]);
    expect(aiFetch.calls.extract).toHaveLength(1); // only the first; the other two are not sent to the AI
    const deferred = run.items.filter(i => i.deferred);
    expect(deferred).toHaveLength(3);
    for (const d of deferred) expect(d.reason).toBe(STATUS_CHECK_REASON);
    expect(run.log.some(l => /no more AI extraction this run/.test(l))).toBe(true);
    const queue = stateFile(dataDir).queue;
    expect(queue).toHaveLength(3);
    expect(queue.filter(q => q.saveRetry)).toHaveLength(1);

    // Still broken next run: the queued save is tried once, the others wait again, still no AI call.
    const second = await runOnce(agent);
    expect(aiFetch.calls.extract).toHaveLength(1);
    expect(second.aiCalls).toBe(0);
    expect(store.insertAttempts).toBe(2);
    expect(second.items.filter(i => i.deferred).every(i => i.reason === STATUS_CHECK_REASON)).toBe(true);
  });

  it('give up on a queued save after 5 runs', async () => {
    const dataDir = tmpDir();
    const store = makeStore({ insertErrors: () => 'timeout' });
    const { agent, aiFetch } = makeAgent({ fetchUrl: oneHeadline(), store, dataDir });
    for (let n = 1; n <= 4; n++) {
      const run = await runOnce(agent);
      expect(run.items[0], `run ${n}`).toMatchObject({ step: 'save', deferred: true });
      expect(stateFile(dataDir).queue[0].saveTries).toBe(n);
    }
    const fifth = await runOnce(agent);
    expect(fifth.items[0]).toMatchObject({ step: 'save', status: 'error', gaveUp: true, reason: 'gave up after 5 failed saves (could not save (timeout))' });
    expect(fifth.items[0].deferred).toBeUndefined();
    expect(seenFile(dataDir)).toContain(key);
    expect(stateFile(dataDir).queue).toHaveLength(0);
    expect(aiFetch.calls.extract).toHaveLength(1); // extracted once, then only saves were retried
    expect(store.insertAttempts).toBe(5);
    const sixth = await runOnce(agent);
    expect(sixth.items).toHaveLength(0);
  });

  it('one-off: an article whose save failed before this fix comes back (but not give-ups)', async () => {
    const dataDir = tmpDir();
    const avalahalli = { title: 'Biker killed as truck hits him near Avalahalli', url: 'https://news.google.com/rss/articles/CBMiAVALA', link: 'https://www.deccanherald.com/avalahalli-crash' };
    const gaveUp = { title: 'Old crash that could never be saved', url: 'https://news.google.com/rss/articles/CBMiGAVE' };
    const laterImported = { title: 'Crash that failed then got saved', url: 'https://news.google.com/rss/articles/CBMiLATER' };
    fs.writeFileSync(path.join(dataDir, 'agent-runs.json'), JSON.stringify([
      { id: 'run_2', items: [
        { ...avalahalli, step: 'save', status: 'error', reason: 'could not save (new row for relation "accidents" violates check constraint "accidents_status_check")' },
        { ...gaveUp, step: 'save', status: 'error', gaveUp: true, reason: 'gave up after 5 failed saves (timeout)' },
        { ...laterImported, step: 'save', status: 'imported', reason: 'imported #1100' },
      ] },
      { id: 'run_1', items: [{ ...laterImported, step: 'save', status: 'error', reason: 'could not save (timeout)' }] },
    ]));
    const keys = [avalahalli.url, avalahalli.link, gaveUp.url, laterImported.url].map(urlKey);
    fs.writeFileSync(path.join(dataDir, 'agent-seen.json'), JSON.stringify(keys));
    fs.writeFileSync(path.join(dataDir, 'agent-state.json'), JSON.stringify({ recentTitles: [{ t: 'biker killed truck hits him near avalahalli', title: avalahalli.title, at: Date.now() }] }));

    const rss = googleRss([{ title: avalahalli.title, publisher: 'Deccan Herald', link: avalahalli.url }]);
    const { agent, store } = makeAgent({ dataDir, fetchUrl: makeFeedFetch({ gdelt: { articles: [] }, rss }) });
    const seen = seenFile(dataDir);
    expect(seen).not.toContain(urlKey(avalahalli.url));
    expect(seen).not.toContain(urlKey(avalahalli.link));
    expect(seen).toContain(urlKey(gaveUp.url));
    expect(seen).toContain(urlKey(laterImported.url));
    expect(stateFile(dataDir)).toMatchObject({ saveErrorsUnseen: true, recentTitles: [] });

    const run = await runOnce(agent);
    expect(run.items.find(i => i.url === avalahalli.url)).toMatchObject({ status: 'imported' });
    expect(store.inserted).toHaveLength(1);

    // It only happens once: a later agent start leaves the seen-list alone.
    const before = seenFile(dataDir);
    makeAgent({ dataDir });
    expect(seenFile(dataDir)).toEqual(before);
  });
});

describe('Kannada Google News query', () => {
  const kannadaQuery = 'ಬೆಂಗಳೂರು ಅಪಘಾತ';
  const isKannadaQuery = (u) => new URL(u).searchParams.get('q').startsWith(kannadaQuery);

  it('falls back to the English India edition when the Kannada edition has nothing', async () => {
    const rss = (u) => {
      if (u.includes('hl=kn')) return googleRss([]);
      if (isKannadaQuery(u)) return googleRss([GOOGLE_ITEMS[2]]);
      return googleRss([GOOGLE_ITEMS[0]]);
    };
    const fetchUrl = makeFeedFetch({ gdelt: { articles: [] }, rss });
    const { agent, store } = makeAgent({ fetchUrl });
    const run = await runOnce(agent);
    const kannadaCalls = fetchUrl.mock.calls.map(([u]) => u).filter(u => u.startsWith('https://news.google.com/rss/search') && isKannadaQuery(u));
    expect(kannadaCalls).toHaveLength(2);
    expect(kannadaCalls[0]).toMatch(/hl=kn&gl=IN&ceid=IN:kn$/);
    expect(kannadaCalls[1]).toMatch(/hl=en-IN&gl=IN&ceid=IN:en$/);
    expect(run.sources[`Google News: ${kannadaQuery}`]).toEqual({ ok: true, count: 1, edition: 'en-IN' });
    expect(run.log.some(l => l.endsWith(`SEARCH Google News: ${kannadaQuery} (Kannada edition): 0 results (HTTP 200, content-type application/rss+xml)`))).toBe(true);
    expect(run.log.some(l => l.endsWith(`SEARCH Google News: ${kannadaQuery} (English India edition): 1 results`))).toBe(true);
    expect(run.log.some(l => /<rss|<\?xml|<channel/.test(l))).toBe(false); // never the body
    expect(store.inserted.map(r => r.link)).toEqual(expect.arrayContaining(['https://news.google.com/rss/articles/CBMiCCC333']));
  });

  it('keeps the Kannada edition when it has results', async () => {
    const fetchUrl = makeFeedFetch({ gdelt: { articles: [] } });
    const run = await runOnce(makeAgent({ fetchUrl }).agent);
    const kannadaCalls = fetchUrl.mock.calls.map(([u]) => u).filter(u => u.startsWith('https://news.google.com/rss/search') && isKannadaQuery(u));
    expect(kannadaCalls).toHaveLength(1);
    expect(run.sources[`Google News: ${kannadaQuery}`]).toEqual({ ok: true, count: 3, edition: 'kn' });
    expect(run.log.some(l => l.endsWith(`SEARCH Google News: ${kannadaQuery} (Kannada edition): 3 results`))).toBe(true);
  });

  it('an English feed with 0 items logs its status and content type', async () => {
    const fetchUrl = makeFeedFetch({ gdelt: { articles: [] }, rss: (u) => (u.includes('hl=en-IN') ? googleRss([]) : GOOGLE_RSS) });
    const run = await runOnce(makeAgent({ fetchUrl }).agent);
    expect(run.log.some(l => l.endsWith('SEARCH Google News: Bengaluru accident: 0 results (HTTP 200, content-type application/rss+xml)'))).toBe(true);
  });
});

describe('Google News feed errors', () => {
  const feed = 'Google News: Bengaluru accident';
  const englishCalls = (fetchUrl) => fetchUrl.mock.calls.filter(([u]) => u.startsWith('https://news.google.com/rss/search') && u.includes('hl=en-IN'));

  it('a 404 is tried once more after 3 seconds', async () => {
    const sleep = vi.fn(async () => {});
    const fetchUrl = makeFeedFetch({ rssStatuses: { 'hl=en-IN': [404] } });
    const run = await runOnce(makeAgent({ fetchUrl, sleep }).agent);
    expect(englishCalls(fetchUrl)).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(run.sources[feed]).toEqual({ ok: true, count: 3 });
  });

  it('a 404 twice is skipped in amber, not a failure', async () => {
    const fetchUrl = makeFeedFetch({ rssStatuses: { 'hl=en-IN': [404, 404] } });
    const { agent, store } = makeAgent({ fetchUrl });
    const run = await runOnce(agent);
    expect(englishCalls(fetchUrl)).toHaveLength(2);
    expect(run.sources[feed]).toEqual({ ok: false, skipped: true, count: 0, error: "didn't answer (HTTP 404)" });
    expect(run.log.some(l => l.endsWith("SEARCH Google News: Bengaluru accident: didn't answer (HTTP 404), skipped"))).toBe(true);
    expect(run.log.some(l => /Bengaluru accident: failed/.test(l))).toBe(false);
    expect(run.status).toBe('completed');
    expect(agent.status().lastRuns[0].sources[feed]).toEqual({ ok: false, count: 0, skipped: true });
    expect(store.inserted.length).toBeGreaterThan(0); // the other feeds still came through
  });

  it('a 5xx is retried the same way', async () => {
    const fetchUrl = makeFeedFetch({ rssStatuses: { 'hl=en-IN': [503] } });
    const run = await runOnce(makeAgent({ fetchUrl }).agent);
    expect(run.sources[feed]).toEqual({ ok: true, count: 3 });
  });
});

describe('GDELT rate limit', () => {
  it('waits 6 seconds, retries once, then skips GDELT without failing the run', async () => {
    const sleep = vi.fn(async () => {});
    const fetchUrl = makeFeedFetch({ gdeltLimited: [429, 429] });
    const { agent, store } = makeAgent({ fetchUrl, sleep });
    const run = await runOnce(agent);
    expect(fetchUrl.mock.calls.filter(([u]) => u.startsWith('https://api.gdeltproject.org/'))).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(6000);
    expect(run.sources.GDELT).toEqual({ ok: false, skipped: true, count: 0, error: 'rate-limited' });
    expect(run.log.some(l => l.endsWith('SEARCH GDELT: rate-limited, skipped'))).toBe(true);
    expect(run.log.some(l => /GDELT: failed/.test(l))).toBe(false);
    expect(run.status).toBe('completed');
    expect(store.inserted).toHaveLength(2); // the Google News crashes still came through
    expect(agent.status().lastRuns[0].sources.GDELT).toEqual({ ok: false, count: 0, skipped: true });
  });

  it('uses the retry when the first request is rate-limited', async () => {
    const fetchUrl = makeFeedFetch({ gdeltLimited: ['text'] });
    const { agent } = makeAgent({ fetchUrl });
    const run = await runOnce(agent);
    expect(run.sources.GDELT).toEqual({ ok: true, count: 2 });
    expect(fetchUrl.mock.calls.filter(([u]) => u.startsWith('https://api.gdeltproject.org/'))).toHaveLength(2);
  });

  it('makes one GDELT request per run when it is not rate-limited', async () => {
    const sleep = vi.fn(async () => {});
    const fetchUrl = makeFeedFetch();
    await runOnce(makeAgent({ fetchUrl, sleep }).agent);
    expect(fetchUrl.mock.calls.filter(([u]) => u.startsWith('https://api.gdeltproject.org/'))).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalledWith(6000);
  });
});

describe('News Agent schedule', () => {
  it('AGENT_ENABLED=false starts nothing', async () => {
    vi.useFakeTimers();
    const { agent, fetchUrl } = makeAgent({ env: { AGENT_ENABLED: 'false' } });
    expect(agent.start()).toBe(false);
    await vi.advanceTimersByTimeAsync(4 * 3600 * 1000);
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(agent.runAgent()).toMatchObject({ started: false, reason: 'disabled' });
    expect(agent.status()).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('first run 2 minutes after startup, then every AGENT_INTERVAL_HOURS', async () => {
    vi.useFakeTimers();
    const { agent, fetchUrl } = makeAgent({ env: { AGENT_INTERVAL_HOURS: '3' } });
    expect(agent.start()).toBe(true);
    const t0 = Date.now();
    expect(Date.parse(agent.status().nextRunAt) - t0).toBe(2 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(119 * 1000);
    expect(fetchUrl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 1000);
    await vi.waitFor(() => expect(agent.status().lastRuns).toHaveLength(1));
    expect(agent.status().lastRuns[0].trigger).toBe('schedule');
    const next = Date.parse(agent.status().nextRunAt);
    expect(next - Date.now()).toBeGreaterThan(3 * 3600 * 1000 - 5000);
    agent.stop();
    expect(agent.status().nextRunAt).toBeNull();
  });

  it('a scheduled tick while a manual run is going does not start a second run', async () => {
    vi.useFakeTimers();
    let release;
    const hold = new Promise(r => { release = r; });
    const { agent } = makeAgent({ fetchUrl: makeFeedFetch({ hold }) });
    const manual = agent.runAgent();
    agent.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 10);
    expect(agent.isRunning()).toBe(true);
    release();
    await manual.done;
    expect(agent.status().lastRuns).toHaveLength(1);
    expect(agent.status().nextRunAt).not.toBeNull();
    agent.stop();
  });

  it('minimum interval is 1 hour', () => {
    const { agent } = makeAgent({ env: { AGENT_INTERVAL_HOURS: '0.1' } });
    expect(agent.config.intervalHours).toBe(1);
  });
});

describe('extraction fixture sanity', () => {
  it('is valid for today', () => {
    expect(extraction().date).toBe(istDate());
  });
});
