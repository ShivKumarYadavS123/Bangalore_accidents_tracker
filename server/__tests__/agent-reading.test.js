/**
 * BAT News Agent, finding and reading articles: publisher RSS feeds, reading a
 * Google News item through the same story's publisher link, the page's
 * description / og:title / JSON-LD body, and related-story links.
 * Feeds, pages and OpenRouter are all mocked; nothing touches the network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createNewsAgent, agentConfig } from '../agent/news-agent.mjs';
import { createImportPipeline, NO_PLACE_LOCATION } from '../agent/pipeline.mjs';
import {
  parsePublisherRss, parseFeedList, DEFAULT_FEEDS, metaContent, pageMeta, jsonLdArticle, htmlToText,
  relatedLinks, mentionsBengaluru, urlKey,
} from '../agent/sources.mjs';
import { resetBudget, clearLlmCache } from '../ai/llm.mjs';
import {
  googleRss, publisherRss, articleHtml, extraction, makeFeedFetch, makeAi, makeStore, tmpDir, silentLogger,
  FEED_URLS, SILK_BOARD_URL, SILK_BOARD_ARTICLE, jsonLdPage,
} from './fixtures/agent-fixtures.js';

beforeEach(() => { process.env.OPENROUTER_API_KEY = 'test-key'; delete process.env.AI_DISABLE_LLM; resetBudget(); clearLlmCache(); });
afterEach(() => { delete process.env.OPENROUTER_API_KEY; vi.restoreAllMocks(); });

const fullBudget = () => ({ limit: 45, used: 0, remaining: 45 });
const noGoogle = googleRss([]);
const fetchedUrls = (fetchUrl) => fetchUrl.mock.calls.map(([u]) => u);
const stateFile = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-state.json'), 'utf8'));
const gdeltOf = (...arts) => ({ articles: arts.map(a => ({ url: a.url, title: a.title, seendate: '20261016T091500Z', domain: a.domain, language: 'English', sourcecountry: 'India' })) });

function makeAgent({ env = {}, store = makeStore(), fetchUrl, aiFetch = makeAi(), dataDir = tmpDir(), budgetStatus = fullBudget, sleep = async () => {} } = {}) {
  const geocode = vi.fn(async () => ({ lat: 12.9177, lng: 77.6233 }));
  const pipeline = createImportPipeline({ store, geocode, inferZone: () => 'South', sleep: async () => {}, logger: silentLogger });
  const agent = createNewsAgent({
    pipeline, store, dataDir, fetchUrl, aiFetch, budgetStatus,
    env: { OPENROUTER_API_KEY: 'test-key', AGENT_QUERIES: 'Bengaluru accident', AGENT_RSS_FEEDS: 'off', ...env },
    logger: silentLogger, sleep,
  });
  return { agent, store, fetchUrl, aiFetch, dataDir, geocode };
}

async function runOnce(agent, opts) {
  const r = agent.runAgent(opts);
  expect(r.started).toBe(true);
  return r.done;
}

describe('publisher feeds (AGENT_RSS_FEEDS)', () => {
  const hebbal = {
    title: 'Two-wheeler rider killed as bus hits bike near Hebbal flyover',
    link: 'https://www.thehindu.com/news/cities/bangalore/rider-killed-near-hebbal-flyover/article70001.ece',
    description: 'The <b>accident</b> happened on Bellary Road on Sunday morning.',
  };
  const hebbalPage = articleHtml([
    'A 28-year-old two-wheeler rider was killed when a BMTC bus hit his bike near the Hebbal flyover on Bellary Road on Sunday morning, police said.',
    'The bus driver was detained. The Hebbal traffic police have registered a case and are examining footage from the junction cameras.',
  ]);

  it('parses a publisher RSS feed: direct links, a plain-text snippet and the date; other sites are dropped', () => {
    const items = parsePublisherRss(publisherRss([hebbal, { title: 'Story on another site', link: 'https://www.example.com/story' }]), FEED_URLS.hindu);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'publisher-feed', title: hebbal.title, url: hebbal.link, publisher: 'The Hindu',
      publisherUrl: 'https://www.thehindu.com', domain: 'thehindu.com', snippet: 'The accident happened on Bellary Road on Sunday morning.',
    });
    expect(items[0].publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsePublisherRss('not a feed', FEED_URLS.hindu)).toEqual([]);
  });

  it('reads Atom feeds too', () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Car overturns on NICE Road</title>
      <link rel="alternate" href="https://timesofindia.indiatimes.com/city/bengaluru/car-overturns/articleshow/1.cms"/>
      <updated>2026-10-16T10:00:00Z</updated><summary>A car overturned on NICE Road near Kengeri.</summary></entry></feed>`;
    expect(parsePublisherRss(atom, FEED_URLS.toi)[0]).toMatchObject({
      url: 'https://timesofindia.indiatimes.com/city/bengaluru/car-overturns/articleshow/1.cms',
      publisher: 'The Times of India', publishedAt: '2026-10-16T10:00:00.000Z', snippet: 'A car overturned on NICE Road near Kengeri.',
    });
  });

  it('defaults to The Hindu and Times of India; "off" turns feeds off; bad entries are dropped', () => {
    expect(DEFAULT_FEEDS).toEqual([FEED_URLS.hindu, FEED_URLS.toi]);
    expect(parseFeedList(undefined)).toEqual(DEFAULT_FEEDS);
    expect(parseFeedList('  ')).toEqual(DEFAULT_FEEDS);
    expect(parseFeedList('off')).toEqual([]);
    expect(parseFeedList(' https://a.com/rss | javascript:alert(1) | https://news.google.com/rss/search?q=x | https://a.com/rss/ | ftp://b.com/x ')).toEqual(['https://a.com/rss']);
    expect(parseFeedList(Array.from({ length: 12 }, (_, i) => `https://s${i}.com/rss`).join('|'))).toHaveLength(10);
    expect(agentConfig({})).toMatchObject({ feeds: DEFAULT_FEEDS, maxRelated: 3 });
    expect(agentConfig({ AGENT_MAX_RELATED_PER_RUN: '0' }).maxRelated).toBe(0);
    expect(agentConfig({ AGENT_MAX_RELATED_PER_RUN: '99' }).maxRelated).toBe(10);
  });

  it('a run reads feed items straight from the publisher, and leaves out items older than the search window', async () => {
    const old = { title: 'Lorry rams car on Tumakuru Road, three injured', link: 'https://www.thehindu.com/news/cities/bangalore/lorry-rams-car/article60001.ece', pubDate: new Date(Date.now() - 5 * 24 * 3600 * 1000).toUTCString() };
    const fetchUrl = makeFeedFetch({ gdelt: { articles: [] }, rss: noGoogle, feeds: { [FEED_URLS.hindu]: publisherRss([hebbal, old]) }, articles: { [hebbal.link]: hebbalPage } });
    const aiFetch = makeAi({ extract: () => extraction({ location: 'Bellary Road near Hebbal flyover', area: 'Hebbal' }) });
    const { agent, store } = makeAgent({ env: { AGENT_RSS_FEEDS: FEED_URLS.hindu }, fetchUrl, aiFetch });
    const run = await runOnce(agent);
    expect(run.sources['Feed: The Hindu']).toEqual({ ok: true, count: 2 });
    expect(run.log.some(l => l.endsWith('SEARCH Feed: The Hindu: 1 older than 2 days, left out'))).toBe(true);
    expect(aiFetch.calls.triage).toEqual([1]);
    expect(fetchedUrls(fetchUrl)).toContain(hebbal.link);
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]).toMatchObject({ link: hebbal.link, source: 'The Hindu', has_coords: true, location: 'Bellary Road near Hebbal flyover' });
    expect(run.items[0]).toMatchObject({ feed: 'publisher-feed', publisher: 'The Hindu', status: 'imported' });
  });

  it('a feed that answers 404 or 5xx is tried once more, then skipped in amber', async () => {
    const sleep = vi.fn(async () => {});
    const once = makeFeedFetch({ gdelt: { articles: [] }, rss: noGoogle, feeds: { [FEED_URLS.toi]: [503, publisherRss([])] } });
    const r1 = await runOnce(makeAgent({ env: { AGENT_RSS_FEEDS: FEED_URLS.toi }, fetchUrl: once, sleep }).agent);
    expect(once.mock.calls.filter(([u]) => u === FEED_URLS.toi)).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(r1.sources['Feed: The Times of India']).toEqual({ ok: true, count: 0 });

    const twice = makeFeedFetch({ gdelt: { articles: [] }, rss: noGoogle, feeds: { [FEED_URLS.toi]: [404, 404] } });
    const r2 = await runOnce(makeAgent({ env: { AGENT_RSS_FEEDS: FEED_URLS.toi }, fetchUrl: twice }).agent);
    expect(r2.sources['Feed: The Times of India']).toEqual({ ok: false, skipped: true, count: 0, error: "didn't answer (HTTP 404)" });
    expect(r2.log.some(l => l.endsWith("SEARCH Feed: The Times of India: didn't answer (HTTP 404), skipped"))).toBe(true);
    expect(r2.status).toBe('completed');
  });

  it('the same story in a feed and on Google News: the feed\'s direct link wins, the Google copy costs nothing', async () => {
    const story = { title: 'Two killed as lorry rams bike on Hosur Road', link: 'https://www.thehindu.com/news/cities/bangalore/two-killed-hosur-road/article70002.ece' };
    const google = { title: story.title, publisher: 'The Hindu', link: 'https://news.google.com/rss/articles/CBMiHINDU1?oc=5', publisherUrl: 'https://www.thehindu.com' };
    const fetchUrl = makeFeedFetch({
      gdelt: { articles: [] }, rss: googleRss([google]), feeds: { [FEED_URLS.hindu]: publisherRss([story]) },
      articles: { [story.link]: articleHtml(['Two men were killed when a speeding lorry rammed their motorcycle on Hosur Road near Bommanahalli late on Friday night, police said.', 'The lorry driver fled the spot. The Bommanahalli traffic police have registered a case and launched a search for him.']) },
    });
    const { agent, store, aiFetch } = makeAgent({ env: { AGENT_RSS_FEEDS: FEED_URLS.hindu }, fetchUrl });
    const run = await runOnce(agent);
    expect(run.items.find(i => i.url.includes('CBMiHINDU1'))).toMatchObject({ step: 'search', status: 'duplicate', reason: expect.stringMatching(/^same story as "Two killed/) });
    expect(fetchedUrls(fetchUrl).some(u => u.includes('CBMiHINDU1'))).toBe(false);
    expect(aiFetch.calls.triage).toEqual([1]);
    expect(store.inserted.map(r => r.link)).toEqual([story.link]);
  });
});

describe('a Google News item is read through the same story\'s publisher link', () => {
  const googleLink = 'https://news.google.com/rss/articles/CBMiQUEUED1';
  const nice = 'https://www.thehindu.com/news/cities/bangalore/car-overturns-on-nice-road/article1.ece';
  const queued = (over = {}) => ({
    key: urlKey(googleLink), url: googleLink, title: 'Car overturns on NICE Road, driver injured', publisher: 'The Hindu',
    publisherUrl: 'https://www.thehindu.com', domain: null, publishedAt: new Date().toISOString(), snippet: '', source: 'google-news',
    triageReason: 'crash', tries: 0, queuedAt: new Date().toISOString(), ...over,
  });
  function withQueued(item, seen = []) {
    const dataDir = tmpDir();
    fs.writeFileSync(path.join(dataDir, 'agent-state.json'), JSON.stringify({ queue: [item] }));
    if (seen.length) fs.writeFileSync(path.join(dataDir, 'agent-seen.json'), JSON.stringify(seen));
    return dataDir;
  }

  it('a carried-over Google News item reads the GDELT link of the same story (title + publisher)', async () => {
    const fetchUrl = makeFeedFetch({ rss: noGoogle }); // GDELT has the same story from thehindu.com
    const aiFetch = makeAi({ extract: () => extraction({ location: 'NICE Road near the Hosur Road junction', area: 'Electronic City' }) });
    const { agent, store } = makeAgent({ dataDir: withQueued(queued()), fetchUrl, aiFetch });
    const run = await runOnce(agent);
    const urls = fetchedUrls(fetchUrl);
    expect(urls).not.toContain(googleLink);
    expect(urls).toContain(nice);
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]).toMatchObject({ link: nice, source: 'The Hindu', has_coords: true });
    const item = run.items.find(i => i.url === googleLink);
    expect(item).toMatchObject({ status: 'imported', link: nice, reason: 'imported #1191 (publisher link from GDELT)' });
    expect(run.log.some(l => /read the publisher's link from GDELT instead of Google News/.test(l))).toBe(true);
    expect(aiFetch.calls.extract).toHaveLength(1);
    expect(aiFetch.calls.extract[0]).toMatch(/overturned on NICE Road/);
    // The GDELT copy was dropped at search as the same story: no triage, no second read.
    expect(run.items.find(i => i.url === nice)).toMatchObject({ step: 'search', status: 'duplicate' });
    expect(aiFetch.calls.triage).toEqual([]);
  });

  it('when that publisher link was already processed, the Google News item is a duplicate: no read, no AI call', async () => {
    const fetchUrl = makeFeedFetch({ rss: noGoogle });
    const { agent, store, aiFetch } = makeAgent({ dataDir: withQueued(queued(), [urlKey(nice)]), fetchUrl });
    const run = await runOnce(agent);
    expect(run.items.find(i => i.url === googleLink)).toMatchObject({ step: 'read', status: 'duplicate', reason: `same story as ${nice} (already processed)` });
    expect(aiFetch.calls.extract).toHaveLength(0);
    expect(fetchedUrls(fetchUrl)).not.toContain(googleLink);
    expect(fetchedUrls(fetchUrl)).not.toContain(nice);
    expect(store.inserted).toHaveLength(0);
  });

  it('another publisher\'s story is not used: the Google link and headline are, as before', async () => {
    const fetchUrl = makeFeedFetch({ rss: noGoogle });
    const { agent, store } = makeAgent({ dataDir: withQueued(queued({ publisher: 'Deccan Herald', publisherUrl: 'https://www.deccanherald.com' })), fetchUrl });
    const run = await runOnce(agent);
    expect(fetchedUrls(fetchUrl)).toContain(googleLink);
    expect(fetchedUrls(fetchUrl)).not.toContain(nice);
    expect(store.inserted[0].link).toBe(googleLink);
    expect(run.items.find(i => i.url === googleLink).reason).toMatch(/used the headline/);
  });
});

describe('reading more of the page', () => {
  it('reads the description and og:title (any quote style, entities decoded), never the keywords', () => {
    const meta = pageMeta(SILK_BOARD_ARTICLE);
    expect(meta).toMatchObject({
      siteName: 'Deccan Herald',
      title: 'Delhi youth dies as bike hits flyover wall',
      description: "Silk Board accident: A Delhi youth's bike hit the flyover wall late on Saturday & he died on the spot.",
    });
    expect(meta.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(meta)).not.toMatch(/KR Puram|Mysuru Road crash/);
    expect(metaContent(`<meta name='description' content='Said "hello" at the junction'>`, 'description')).toBe('Said "hello" at the junction');
    expect(metaContent('<meta name="description" content="a > b">', 'description')).toBe('a > b');
    expect(metaContent('<meta property="og:title" content="  ">', 'og:title')).toBeNull();
    expect(pageMeta('<meta property="og:description" content="From og"><meta name="description" content="From meta">').description).toBe('From og');
  });

  it('takes the story from JSON-LD (NewsArticle / Article articleBody) when the page has it', () => {
    const body = 'A 32-year-old driver was injured when his car overturned on NICE Road near Kengeri late on Friday. Passers-by pulled him out and took him to a hospital. The Kengeri traffic police have registered a case and are checking CCTV footage.';
    expect(jsonLdArticle(jsonLdPage(body))).toEqual({ body, publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    const raw = (json) => `<script type="application/ld+json">${json}</script>`;
    // A raw newline inside the JSON string (invalid, but common) is read as a space.
    expect(jsonLdArticle(raw(`{"@type":"Article","articleBody":"${body.slice(0, 100)}\n${body.slice(100)}"}`)).body).toMatch(/^A 32-year-old driver.*CCTV footage\.$/);
    expect(jsonLdArticle(raw(`[{"@type":"BreadcrumbList"},{"@type":"ReportageNewsArticle","articleBody":${JSON.stringify(body)}}]`)).body).toBe(body);
    expect(jsonLdArticle(raw('{not json'))).toBeNull();
    expect(jsonLdArticle(raw(JSON.stringify({ '@type': 'WebPage', articleBody: body })))).toBeNull();
    expect(jsonLdArticle(raw(JSON.stringify({ '@type': 'NewsArticle', articleBody: 'too short' })))).toBeNull();
  });

  it('the JSON-LD story is what the AI reads, even when menus fill the page', async () => {
    const body = 'A 32-year-old driver was injured when his car overturned on NICE Road near Kengeri late on Friday. Passers-by pulled him out and took him to a hospital. The Kengeri traffic police have registered a case and are checking CCTV footage.';
    const url = 'https://timesofindia.indiatimes.com/city/bengaluru/car-overturns-on-nice-road/articleshow/1001.cms';
    const page = jsonLdPage(body);
    expect(htmlToText(page).slice(0, 6000)).not.toContain('overturned on NICE Road'); // without JSON-LD the story would be pushed out
    const fetchUrl = makeFeedFetch({ gdelt: gdeltOf({ url, title: 'Car overturns on NICE Road near Kengeri, driver hurt', domain: 'timesofindia.indiatimes.com' }), rss: noGoogle, articles: { [url]: page } });
    const aiFetch = makeAi({ extract: () => extraction({ location: 'NICE Road near Kengeri', area: 'Kengeri' }) });
    const { agent, store } = makeAgent({ fetchUrl, aiFetch });
    await runOnce(agent);
    const prompt = aiFetch.calls.extract[0];
    expect(prompt.slice(prompt.indexOf('\nText:\n') + 7).startsWith(body)).toBe(true);
    expect(prompt).not.toMatch(/Trending now/);
    expect(store.inserted[0]).toMatchObject({ link: url, source: 'The Times of India', has_coords: true });
  });

  it('story #1228: the description and the police-station line reach the AI, and the place they give is pinned', async () => {
    const fetchUrl = makeFeedFetch({ gdelt: gdeltOf({ url: SILK_BOARD_URL, title: 'Delhi youth dies as bike hits flyover wall', domain: 'deccanherald.com' }), rss: noGoogle, articles: { [SILK_BOARD_URL]: SILK_BOARD_ARTICLE } });
    const aiFetch = makeAi({ extract: () => extraction({ location: 'Silk Board junction flyover', area: 'Madiwala' }) });
    const { agent, store, geocode } = makeAgent({ fetchUrl, aiFetch, env: { AGENT_MAX_RELATED_PER_RUN: '0' } });
    await runOnce(agent);
    const prompt = aiFetch.calls.extract[0];
    expect(prompt).toContain("Description (meta description): Silk Board accident: A Delhi youth's bike hit the flyover wall late on Saturday & he died on the spot.");
    expect(prompt).toContain('Madiwala Traffic Police registered a case');
    expect(prompt).not.toMatch(/KR Puram|Mysuru Road crash/);
    expect(prompt).not.toMatch(/Page title \(og:title\)/); // same as the headline
    expect(geocode).toHaveBeenCalledWith('Silk Board junction flyover', 'Madiwala');
    expect(store.inserted[0]).toMatchObject({ link: SILK_BOARD_URL, source: 'Deccan Herald', has_coords: true, location: 'Silk Board junction flyover' });
  });

  it('a place the page never mentions is saved with no pin, and the run log says so', async () => {
    const fetchUrl = makeFeedFetch({ gdelt: gdeltOf({ url: SILK_BOARD_URL, title: 'Delhi youth dies as bike hits flyover wall', domain: 'deccanherald.com' }), rss: noGoogle, articles: { [SILK_BOARD_URL]: SILK_BOARD_ARTICLE } });
    const aiFetch = makeAi({ extract: () => extraction({ location: 'Hosur Road near Electronic City toll', area: 'Electronic City' }) });
    const { agent, store, geocode } = makeAgent({ fetchUrl, aiFetch, env: { AGENT_MAX_RELATED_PER_RUN: '0' } });
    const run = await runOnce(agent);
    expect(geocode).not.toHaveBeenCalled();
    expect(store.inserted[0]).toMatchObject({ location: NO_PLACE_LOCATION, area: null, has_coords: false });
    expect(run.items[0].reason).toMatch(/place "Hosur Road near Electronic City toll" not found in the article/);
  });
});

describe('related-story links', () => {
  const base = 'https://www.deccanherald.com/india/karnataka/bengaluru/';
  const techie = `${base}techie-killed-as-lorry-hits-scooter-in-hebbal-3712400`;
  const biker = `${base}biker-dies-after-skidding-on-outer-ring-road-3712403`;
  const pedestrian = `${base}pedestrian-killed-in-yelahanka-hit-and-run-3712404`;
  const truck = `${base}truck-overturns-on-tumakuru-road-driver-injured-3712300`;
  const silkBoardRun = () => makeFeedFetch({ gdelt: gdeltOf({ url: SILK_BOARD_URL, title: 'Delhi youth dies as bike hits flyover wall', domain: 'deccanherald.com' }), rss: noGoogle, articles: { [SILK_BOARD_URL]: SILK_BOARD_ARTICLE } });
  const page = (paras, { head = '', body = '' } = {}) => articleHtml(paras, 'Deccan Herald').replace('</head>', `${head}</head>`).replace('</body>', `${body}</body>`);
  const relatedPages = () => ({
    [biker]: page(['A 26-year-old biker died after his motorcycle skidded on the Outer Ring Road near Marathahalli early on Sunday, police said.', 'He was not wearing a helmet. The HAL traffic police have registered a case and are investigating the accident.'],
      { body: `<div class="related"><a href="${base}car-crash-in-whitefield-injures-two-3712500">Car crash in Whitefield injures two</a></div>` }),
    [pedestrian]: page(['A 60-year-old pedestrian was killed by an unidentified vehicle in Yelahanka New Town while crossing the road on Saturday night.', 'The Yelahanka traffic police have registered a hit-and-run case and are checking footage from nearby shops.']),
    [truck]: page(['A truck overturned on Tumakuru Road near Nelamangala and its driver was injured, police said, after the vehicle lost control on the slope.', 'Traffic was slow for two hours on the stretch while the truck was cleared by a crane, the traffic police said.'],
      { head: `<meta property="article:published_time" content="${new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()}">` }),
  });

  it('collects same-site links from related blocks and "Also Read" lines', () => {
    const links = relatedLinks(SILK_BOARD_ARTICLE, SILK_BOARD_URL);
    expect(links.map(l => l.url)).toEqual([
      techie,
      `${base}bbmp-announces-new-parking-policy-3712401`,
      'https://www.deccanherald.com/india/maharashtra/two-die-in-crash-on-mumbai-pune-expressway-3712402',
      biker,
      pedestrian,
      truck,
    ]);
    expect(links[0].text).toBe('Techie killed as lorry hits scooter in Hebbal');
    expect(relatedLinks(`<div class="related"><a href="${SILK_BOARD_URL}">Delhi youth dies as bike hits flyover wall</a></div>`, SILK_BOARD_URL)).toEqual([]);
  });

  it('knows Bengaluru and its places', () => {
    expect(mentionsBengaluru('Techie killed as lorry hits scooter in Hebbal')).toBe(true);
    expect(mentionsBengaluru("Biker dies after skidding on Bengaluru's Outer Ring Road")).toBe(true);
    expect(mentionsBengaluru('ಬೆಂಗಳೂರು: ಬೈಕ್ ಅಪಘಾತ')).toBe(true);
    expect(mentionsBengaluru('Accident on K R Puram bridge')).toBe(true);
    expect(mentionsBengaluru('Two die in crash on Mumbai-Pune expressway')).toBe(false);
  });

  it('keeps at most 3 new Bengaluru crash links per run for the next run, and follows them then (one hop only)', async () => {
    const dataDir = tmpDir();
    const store = makeStore({ rows: [{ id: '900', link: techie }] }); // already in the database
    const first = silkBoardRun();
    const run1 = await runOnce(makeAgent({ dataDir, store, fetchUrl: first }).agent);
    // Not crashes (BBMP), not Bengaluru (Mumbai), other sites and stored links are skipped; the cap is 3.
    expect(stateFile(dataDir).related.map(r => r.url)).toEqual([biker, pedestrian, truck]);
    expect(stateFile(dataDir).related[0]).toMatchObject({ title: "Biker dies after skidding on Bengaluru's Outer Ring Road", from: 'Deccan Herald' });
    expect(run1.log.some(l => l.endsWith('RELATED: 3 links from Deccan Herald kept for the next run'))).toBe(true);
    expect(fetchedUrls(first).filter(u => u.startsWith(base) && u !== SILK_BOARD_URL)).toEqual([]); // nothing followed yet

    const second = makeFeedFetch({ gdelt: { articles: [] }, rss: noGoogle, articles: relatedPages() });
    const aiFetch = makeAi();
    const run2 = await runOnce(makeAgent({ dataDir, store, fetchUrl: second, aiFetch }).agent);
    expect(run2.sources['Related links']).toEqual({ ok: true, count: 3 });
    expect(aiFetch.calls.triage).toEqual([3]); // they go through triage like any other headline
    expect(aiFetch.calls.extract).toHaveLength(2); // the 90-day-old story costs no AI call
    const byUrl = Object.fromEntries(run2.items.map(i => [i.url, i]));
    expect(byUrl[biker]).toMatchObject({ status: 'imported', feed: 'related', publisher: 'related link from Deccan Herald' });
    expect(byUrl[pedestrian]).toMatchObject({ status: 'imported', publisher: 'related link from Deccan Herald' });
    expect(byUrl[truck]).toMatchObject({ step: 'read', status: 'error', reason: expect.stringMatching(/^article published \d{4}-\d{2}-\d{2}, older than 60 days$/) });
    expect(store.inserted.map(r => r.link)).toEqual(expect.arrayContaining([biker, pedestrian]));
    expect(stateFile(dataDir).related).toEqual([]); // links on a related page are not followed
  });

  it('AGENT_MAX_RELATED_PER_RUN=0 keeps none', async () => {
    const dataDir = tmpDir();
    const run = await runOnce(makeAgent({ dataDir, fetchUrl: silkBoardRun(), env: { AGENT_MAX_RELATED_PER_RUN: '0' } }).agent);
    expect(stateFile(dataDir).related).toEqual([]);
    expect(run.log.some(l => /RELATED:/.test(l))).toBe(false);
  });

  it('related links held back by the AI budget wait for the following run', async () => {
    const dataDir = tmpDir();
    await runOnce(makeAgent({ dataDir, fetchUrl: silkBoardRun() }).agent);
    expect(stateFile(dataDir).related).toHaveLength(3);
    const low = await runOnce(makeAgent({ dataDir, fetchUrl: makeFeedFetch({ gdelt: { articles: [] }, rss: noGoogle }), budgetStatus: () => ({ limit: 45, used: 40, remaining: 5 }) }).agent);
    expect(low.items.filter(i => i.deferred && i.publisher === 'related link from Deccan Herald')).toHaveLength(3);
    expect(stateFile(dataDir).related).toHaveLength(3);
    const later = await runOnce(makeAgent({ dataDir, fetchUrl: makeFeedFetch({ gdelt: { articles: [] }, rss: noGoogle, articles: relatedPages() }) }).agent);
    expect(later.sources['Related links']).toEqual({ ok: true, count: 3 });
  });
});
