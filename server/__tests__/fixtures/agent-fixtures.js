/** Fixtures for the News Agent / X import tests. Nothing here touches the network. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { istDate } from '../../agent/pipeline.mjs';
import { urlKey } from '../../agent/sources.mjs';
import { chatReply } from './ai-fixtures.js';

export const TODAY = istDate();

export const silentLogger = { log() {}, warn() {}, error() {} };

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bat-agent-'));
}

/** A valid extraction reply (override any field). */
export function extraction(over = {}) {
  return {
    is_accident: true,
    in_bangalore: true,
    location: 'Hosur Road near Silk Board junction',
    area: 'Madiwala',
    date: TODAY,
    time: '23:30',
    severity: 'fatal',
    vehicles: 'lorry and two-wheeler',
    summary: 'A biker died after a lorry hit his two-wheeler near Silk Board junction late at night.',
    publisher: 'Deccan Herald',
    ...over,
  };
}

export const notAccident = (over = {}) => ({
  is_accident: false, in_bangalore: false, location: null, area: null, date: null, time: null,
  severity: null, vehicles: null, summary: null, publisher: null, ...over,
});

const day = (offsetHours = 0) => new Date(Date.now() - offsetHours * 3600 * 1000).toUTCString();

/** Google News RSS search feed in the real format (CDATA, entity-encoded description, <source>). */
export function googleRss(items) {
  const xml = items.map(it => `
    <item>
      <title>${it.cdata ? `<![CDATA[${it.title} - ${it.publisher}]]>` : `${it.title.replace(/&/g, '&amp;')} - ${it.publisher}`}</title>
      <link>${it.link}</link>
      <guid isPermaLink="false">${it.link.split('/').pop()}</guid>
      <pubDate>${it.pubDate || day(3)}</pubDate>
      <description>&lt;a href="${it.link}" target="_blank"&gt;${it.title.replace(/&/g, '&amp;amp;')}&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;${it.publisher}&lt;/font&gt;</description>
      <source url="${it.publisherUrl || 'https://www.deccanherald.com'}">${it.publisher}</source>
    </item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><generator>NFE/5.0</generator><title>"Bengaluru accident when:2d" - Google News</title><link>https://news.google.com/search?q=Bengaluru+accident</link><language>en-IN</language>${xml}</channel></rss>`;
}

export const GOOGLE_ITEMS = [
  { title: 'Two killed as lorry rams bike on Hosur Road', publisher: 'Deccan Herald', link: 'https://news.google.com/rss/articles/CBMiAAA111?oc=5' },
  { title: 'Waterlogging on Outer Ring Road after heavy rain, traffic diverted', publisher: 'The Hindu', link: 'https://news.google.com/rss/articles/CBMiBBB222?oc=5', publisherUrl: 'https://www.thehindu.com' },
  { title: 'ಹೆಬ್ಬಾಳ ಮೇಲ್ಸೇತುವೆ ಬಳಿ ಬೈಕ್‌ಗೆ ಬಸ್ ಡಿಕ್ಕಿ', publisher: 'Prajavani', link: 'https://news.google.com/rss/articles/CBMiCCC333?oc=5', cdata: true, publisherUrl: 'https://www.prajavani.net' },
];

export const GOOGLE_RSS = googleRss(GOOGLE_ITEMS);

export const GDELT_URLS = {
  crash: 'https://www.thehindu.com/news/cities/bangalore/car-overturns-on-nice-road/article1.ece?utm_source=gdelt',
  other: 'https://www.newindianexpress.com/cities/bengaluru/new-mall-opens-in-whitefield',
};

export const GDELT_JSON = {
  articles: [
    { url: GDELT_URLS.crash, url_mobile: '', title: 'Car overturns on NICE Road, driver injured', seendate: '20261010T091500Z', socialimage: '', domain: 'thehindu.com', language: 'English', sourcecountry: 'India' },
    { url: GDELT_URLS.other, url_mobile: '', title: 'New mall opens in Whitefield', seendate: '20261010T081500Z', socialimage: '', domain: 'newindianexpress.com', language: 'English', sourcecountry: 'India' },
  ],
};

export function articleHtml(paragraphs, siteName = 'The Hindu') {
  return `<!doctype html><html><head><title>News</title><meta property="og:site_name" content="${siteName}"></head>
  <body><nav><a href="/">Home</a> <a href="/city">City</a></nav>
  <article><h1>Headline</h1>${paragraphs.map(p => `<p>${p}</p>`).join('')}</article>
  <footer>Copyright</footer><script>window.ads = 1;</script></body></html>`;
}

export const CRASH_ARTICLE = articleHtml([
  'A 32-year-old driver was injured when his car overturned on NICE Road near the Hosur Road junction on Friday night, police said.',
  'The car hit the median and overturned around 11.30 pm. Passers-by pulled the driver out and he was taken to a hospital in Electronic City.',
  'The Electronic City traffic police have registered a case and are checking CCTV footage from the stretch.',
]);

export const FEED_URLS = {
  hindu: 'https://www.thehindu.com/news/cities/bangalore/feeder/default.rss',
  toi: 'https://timesofindia.indiatimes.com/rssfeeds/-2128833038.cms',
};

/** A publisher's own RSS 2.0 feed, shaped like The Hindu's (CDATA, HTML in the description). */
export function publisherRss(items, { site = 'https://www.thehindu.com' } = {}) {
  const xml = items.map(it => `
    <item>
      <title><![CDATA[${it.title}]]></title>
      <link>${it.link}</link>
      <description><![CDATA[<p>${it.description || ''}</p>]]></description>
      <pubDate>${it.pubDate || day(2)}</pubDate>
      <guid isPermaLink="true">${it.link}</guid>
    </item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Bengaluru</title><link>${site}/</link><atom:link href="${site}/feed" rel="self"/>${xml}</channel></rss>`;
}

/**
 * Story #1228 (Deccan Herald): the body never names the place. Only the meta
 * description ("Silk Board accident: ...") and the last line ("Madiwala
 * Traffic Police registered a case") do. The keywords are about other stories.
 */
export const SILK_BOARD_URL = 'https://www.deccanherald.com/india/karnataka/bengaluru/delhi-youth-dies-as-bike-hits-flyover-wall-3712345';
export const SILK_BOARD_ARTICLE = `<!doctype html><html><head>
  <title>Delhi youth dies as bike hits flyover wall | Deccan Herald</title>
  <meta property="og:site_name" content="Deccan Herald">
  <meta content="Delhi youth dies as bike hits flyover wall" property="og:title">
  <meta name="description" content="Silk Board accident: A Delhi youth's bike hit the flyover wall late on Saturday &amp; he died on the spot.">
  <meta name="keywords" content="KR Puram bridge, Hebbal flyover, Mysuru Road crash">
  <meta property="article:published_time" content="${new Date(Date.now() - 5 * 3600 * 1000).toISOString()}">
  </head><body>
  <nav><a href="/">Home</a> <a href="/india/karnataka/bengaluru">Bengaluru</a></nav>
  <article><h1>Delhi youth dies as bike hits flyover wall</h1>
  <p>A 23-year-old man from Delhi who worked at a tech park died after the motorcycle he was riding hit the side wall of a flyover late on Saturday night, police said.</p>
  <p>He was returning home from work when he lost control of the bike on the flyover and crashed into the wall. He died on the spot before an ambulance could reach him.</p>
  <p>Also Read: <a href="/india/karnataka/bengaluru/truck-overturns-on-tumakuru-road-driver-injured-3712300">Truck overturns on Tumakuru Road, driver injured</a></p>
  <p>Madiwala Traffic Police registered a case and are checking footage from the flyover.</p>
  </article>
  <div class="related-stories"><h3>More from Bengaluru</h3><ul>
    <li><a href="/india/karnataka/bengaluru/techie-killed-as-lorry-hits-scooter-in-hebbal-3712400">Techie killed as lorry hits scooter in Hebbal</a></li>
    <li><a href="/india/karnataka/bengaluru/bbmp-announces-new-parking-policy-3712401">Bengaluru: BBMP announces new parking policy for the city</a></li>
    <li><a href="/india/maharashtra/two-die-in-crash-on-mumbai-pune-expressway-3712402">Two die in crash on Mumbai-Pune expressway</a></li>
    <li><a href="https://www.othersite.com/bengaluru-bus-crash-injures-five">Bengaluru bus crash injures five commuters</a></li>
    <li><a href="/india/karnataka/bengaluru/biker-dies-after-skidding-on-outer-ring-road-3712403">Biker dies after skidding on Bengaluru's Outer Ring Road</a></li>
    <li><a href="/india/karnataka/bengaluru/pedestrian-killed-in-yelahanka-hit-and-run-3712404">Pedestrian killed in Yelahanka hit-and-run</a></li>
    <li><a href="javascript:void(0)">Car rams divider near Silk Board junction</a></li>
  </ul></div>
  <footer>Copyright</footer></body></html>`;

/** A page whose menus come first; its JSON-LD carries the story itself. */
export function jsonLdPage(body, { menuItems = 400, extra = {} } = {}) {
  const menu = Array.from({ length: menuItems }, (_, i) => `<p>Trending now: celebrity wedding photos and cricket scores, part ${i}</p>`).join('');
  const ld = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', name: 'x' }, { '@type': ['NewsArticle'], headline: 'h', articleBody: body, datePublished: new Date().toISOString(), ...extra }] };
  return `<!doctype html><html><head><meta property="og:site_name" content="The Times of India">
  <script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><div class="menu">${menu}</div><article><p>${body}</p></article></body></html>`;
}

/** Response shape returned by fetchCapped. */
export function fetched(text, { status = 200, url, contentType = 'text/html; charset=utf-8', bodySkipped = false } = {}) {
  return { ok: status >= 200 && status < 300, status, url, contentType, text: bodySkipped ? '' : text, bodySkipped };
}

/**
 * Fake fetchUrl for the agent: GDELT, Google News RSS, Google article links
 * (which stay on Google, like the real ones) and publisher pages.
 */
export function makeFeedFetch({ gdelt = GDELT_JSON, rss = GOOGLE_RSS, articles = { [GDELT_URLS.crash.replace('?utm_source=gdelt', '')]: CRASH_ARTICLE }, feeds = {}, fail = [], hold = null, gdeltLimited = [], rssStatuses = {} } = {}) {
  let gdeltCalls = 0;
  // rssStatuses: { 'url part': [404, 503, ...] } answers the next matching Google News requests with those statuses.
  const rssQueue = Object.fromEntries(Object.entries(rssStatuses).map(([k, v]) => [k, [...v]]));
  return vi.fn(async (url, opts = {}) => {
    if (hold) await hold;
    if (fail.some(f => url.includes(f))) throw new Error('connect ECONNREFUSED');
    if (url.startsWith('https://api.gdeltproject.org/')) {
      // gdeltLimited: per call, 429 = HTTP 429, 'text' = GDELT's plain-text "please limit requests" reply.
      const limited = gdeltLimited[gdeltCalls++];
      if (limited === 429) return fetched('', { status: 429, url, bodySkipped: true });
      if (limited === 'text') return fetched('Please limit requests to one every 5 seconds or contact kalev.leetaru5@gmail.com for larger queries.', { url, contentType: 'text/html' });
      return fetched(JSON.stringify(gdelt), { url, contentType: 'application/json' });
    }
    if (url.startsWith('https://news.google.com/rss/search')) {
      const key = Object.keys(rssQueue).find(k => url.includes(k) && rssQueue[k].length);
      const status = key ? rssQueue[key].shift() : 200;
      if (status !== 200) return fetched('', { status, url, bodySkipped: true });
      return fetched(typeof rss === 'function' ? rss(url) : rss, { url, contentType: 'application/rss+xml' });
    }
    if (url.startsWith('https://news.google.com/rss/articles/')) {
      // Real Google News article links answer 200 on news.google.com; the caller must not read them.
      const skipped = typeof opts.skipBodyIf === 'function' && opts.skipBodyIf(url);
      return fetched('<html>GOOGLE PAGE</html>', { url, bodySkipped: skipped });
    }
    // feeds: { url: xml | [status, ...then xml] } — publisher RSS feeds.
    if (feeds[url] !== undefined) {
      const f = feeds[url];
      if (Array.isArray(f) && typeof f[0] === 'number') {
        const status = f.shift();
        return fetched('', { status, url, bodySkipped: true });
      }
      return fetched(Array.isArray(f) ? f[0] : f, { url, contentType: 'application/rss+xml; charset=utf-8' });
    }
    if (articles[url]) return fetched(articles[url], { url });
    return fetched('', { status: 404, url, bodySkipped: true });
  });
}

/** An OpenRouter error response, shaped like the real ones (with clone(), like a fetch Response). */
export function openRouterError(status, message, raw = null) {
  const body = { error: { message, code: status, ...(raw ? { metadata: { raw, provider_name: 'Test provider' } } : {}) } };
  const res = { ok: false, status, headers: { get: () => 'application/json' }, json: async () => body, clone: () => res };
  return res;
}

/** OpenRouter's 429 when one free model is busy at its provider (the next model may work). */
export const upstreamLimited = (model) => openRouterError(429, 'Provider returned error',
  `${model} is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations`);

/** OpenRouter's 429 when the account's free daily allowance is used up. */
export const freeDailyLimit = () => openRouterError(429, 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day');

/**
 * Fake OpenRouter for the budget gate: answers triage prompts with `keep(n)`
 * and extraction prompts with `extract(userPrompt)`.
 */
export function makeAi({ keep = (n) => Array.from({ length: n }, (_, i) => ({ i: i + 1, reason: 'road crash in Bengaluru' })), extract = () => extraction(), status = 200 } = {}) {
  const calls = { triage: [], extract: [] };
  const fn = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages[body.messages.length - 1].content;
    if (status !== 200) return openRouterError(status, 'Rate limit exceeded: free-models-per-day');
    if (user.includes('<<<HEADLINES')) {
      const n = (user.match(/^\[\d+\]/gm) || []).length;
      calls.triage.push(n);
      return chatReply({ keep: keep(n, user) });
    }
    calls.extract.push(user);
    return chatReply(extract(user));
  });
  fn.calls = calls;
  return fn;
}

/** The error Supabase returns while the live table still only allows status 'active'. */
export const STATUS_CHECK_ERROR = 'new row for relation "accidents" violates check constraint "accidents_status_check"';

/**
 * In-memory stand-in for store.mjs. `insertErrors` makes the next inserts fail
 * with those messages, one per insert (a function gets the insert number instead).
 */
export function makeStore({ rows = [], nearby = [], failLookups = false, failAllLinks = false, startId = 1191, insertErrors = [] } = {}) {
  let nextId = startId;
  let inserts = 0;
  const errors = Array.isArray(insertErrors) ? [...insertErrors] : null;
  const store = {
    rows: rows.map(r => ({ ...r })),
    inserted: [],
    insertCalls: [],
    nearbyCalls: [],
    nearby,
    available: () => true,
    async findByLink(links) {
      if (failLookups) throw new Error('database lookup failed: connection refused');
      return store.rows.find(r => r.link && links.includes(r.link)) || null;
    },
    async findByXPostId(id) {
      if (failLookups) throw new Error('database lookup failed: connection refused');
      return store.rows.find(r => r.link && r.link.endsWith(`/status/${id}`)) || null;
    },
    async allLinkKeys() {
      if (failAllLinks) throw new Error('database lookup failed');
      return new Set(store.rows.map(r => urlKey(r.link)).filter(Boolean));
    },
    async findNearby(lat, lng, radius, date) {
      store.nearbyCalls.push({ lat, lng, radius, date });
      return store.nearby;
    },
    async insertPending(record, loc) {
      inserts++;
      store.insertAttempts = inserts;
      const message = errors ? errors.shift() : insertErrors(inserts);
      if (message) throw new Error(message);
      const id = String(nextId++);
      const row = { ...record, id };
      store.rows.push(row);
      store.inserted.push(row);
      store.insertCalls.push({ record, loc });
      return id;
    },
    async agentRowIds() { return new Set(store.rows.filter(r => r.status === 'active' && !r.reporter_id && String(r.description || '').includes('(Found by BAT News Agent)')).map(r => r.id)); },
  };
  return store;
}

/** Snowflake id for a moment in time (inverse of postDateFromId). */
export function postIdAt(ms) {
  return String((BigInt(Math.floor(ms)) - 1288834974657n) << 22n);
}

export function oembedReply({ text, handle = 'blrcitytraffic', name = 'ಬೆಂಗಳೂರು ಸಂಚಾರ ಪೊಲೀಸ್ BTP' }) {
  return JSON.stringify({
    url: `https://twitter.com/${handle}/status/1`,
    author_name: name,
    author_url: `https://twitter.com/${handle}`,
    html: `<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">${text}</p>&mdash; ${name} (@${handle}) <a href="https://twitter.com/${handle}/status/1?ref_src=twsrc%5Etfw">October 9, 2026</a></blockquote>\n`,
    width: 550, height: null, type: 'rich', cache_age: '3153600000', provider_name: 'Twitter', provider_url: 'https://twitter.com', version: '1.0',
  });
}
