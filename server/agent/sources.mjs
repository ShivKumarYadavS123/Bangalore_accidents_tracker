/**
 * News sources for the BAT News Agent, plus the fetch and text helpers they share.
 *
 *  - Google News RSS search feeds: headline, Google News link, publisher, date.
 *  - GDELT DOC 2.0 API (artlist mode): publisher URL, title, domain, first-seen time.
 *  - Publisher RSS/Atom feeds (AGENT_RSS_FEEDS): headline, publisher link, date, summary.
 *
 * Every request goes through safeFetch (SSRF checks on every redirect hop) with
 * a timeout, and the body is read with a byte cap enforced while it streams in.
 * Nothing here scrapes Google Search result pages or x.com.
 */
import { safeFetch } from '../ssrf.js';

export const AGENT_USER_AGENT = 'Mozilla/5.0 (compatible; BATNewsAgent/1.0; +https://github.com/shreyastk/Bangalore_accidents_tracker)';

export const DEFAULT_QUERIES = [
  'Bengaluru accident',
  'Bengaluru road accident killed',
  'Bengaluru crash injured',
  'Bengaluru hit-and-run',
  'ಬೆಂಗಳೂರು ಅಪಘಾತ',
];

const KANNADA = /[ಀ-೿]/;

/** AGENT_QUERIES is '|'-separated; empty or missing means the defaults. */
export function parseQueries(raw) {
  const list = String(raw || '').split('|').map(s => s.trim()).filter(Boolean).slice(0, 12);
  return list.length ? list.map(s => s.slice(0, 120)) : DEFAULT_QUERIES.slice();
}

export const isKannada = (s) => KANNADA.test(String(s ?? ''));

/** At least 30% of the letters are Kannada: a Kannada article, not an English one quoting a word. */
export function mostlyKannada(s) {
  const str = String(s ?? '');
  const kn = (str.match(/[ಀ-೿]/g) || []).length;
  const latin = (str.match(/[a-z]/gi) || []).length;
  return kn > 0 && kn / (kn + latin) >= 0.3;
}

/**
 * Google News RSS search feed. `edition` is 'kn' (Kannada) or 'en' (English
 * India); by default Kannada queries use the Kannada edition.
 */
export function googleNewsUrl(query, days = 2, edition = isKannada(query) ? 'kn' : 'en') {
  const q = encodeURIComponent(`${query} when:${days}d`);
  return edition === 'kn'
    ? `https://news.google.com/rss/search?q=${q}&hl=kn&gl=IN&ceid=IN:kn`
    : `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
}

/**
 * Bengaluru city sections of publishers whose RSS feeds link straight to their
 * articles (checked in a browser, October 2026).
 */
export const DEFAULT_FEEDS = [
  'https://www.thehindu.com/news/cities/bangalore/feeder/default.rss',
  'https://timesofindia.indiatimes.com/rssfeeds/-2128833038.cms',
];

/**
 * AGENT_RSS_FEEDS is '|'-separated; empty or missing means the defaults, "off"
 * or "none" means no publisher feeds. Only http(s) addresses that are not
 * Google are kept, at most 10.
 */
export function parseFeedList(raw) {
  const s = String(raw ?? '').trim();
  if (/^(off|none|false)$/i.test(s)) return [];
  const out = new Map();
  for (const part of s.split('|')) {
    const url = normalizeUrl(part.trim());
    if (url && !isGoogleHost(url) && !out.has(urlKey(url))) out.set(urlKey(url), url);
  }
  return out.size ? [...out.values()].slice(0, 10) : DEFAULT_FEEDS.slice();
}

export const GDELT_QUERY = '(accident OR crash OR collision) (Bengaluru OR Bangalore) sourcecountry:india';

export function gdeltUrl(days = 2, maxRecords = 100) {
  return `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(GDELT_QUERY)}`
    + `&mode=artlist&format=json&timespan=${days}d&maxrecords=${maxRecords}&sort=datedesc`;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•',
};

/** Decode HTML entities in one pass (so "&amp;lt;" becomes "&lt;", not "<"). */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Tags → spaces, entities decoded, whitespace collapsed (newlines kept). */
export function plainText(html) {
  return decodeEntities(String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v\r ]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
}

/**
 * Readable text from an article page. News pages are mostly menus and ads, so
 * prefer the <article> element, then its paragraphs, then the whole page.
 */
export function htmlToText(html, maxChars = 15000) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|iframe|svg|template|nav|header|footer|aside|form|button|select|figcaption)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const article = (s.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i) || [])[1];
  const scope = article && plainText(article).length > 300 ? article : s;
  const paras = (scope.match(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi) || []).map(plainText).filter(t => t.length > 40);
  const joined = paras.join('\n');
  return (joined.length > 300 ? joined : plainText(scope)).slice(0, maxChars);
}

// One tag, with quoted attribute values that may contain ">".
const META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ANCHOR = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi;

/** Attributes of one tag: names lower-cased, first value wins, values not yet decoded. */
function tagAttrs(tagText) {
  const out = {};
  const re = /([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tagText))) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/**
 * <meta property|name="..." content="..."> in any attribute order and quote
 * style (so "youth's" in a double-quoted value is kept), entities decoded,
 * whitespace collapsed, at most maxChars. null when missing or empty.
 */
export function metaContent(html, prop, maxChars = 300) {
  const want = String(prop).toLowerCase();
  for (const t of String(html ?? '').match(META_TAG) || []) {
    const a = tagAttrs(t);
    if (String(a.property ?? a.name ?? '').toLowerCase() !== want) continue;
    const v = decodeEntities(a.content ?? '').replace(/\s+/g, ' ').trim();
    if (v) return v.slice(0, maxChars);
  }
  return null;
}

/**
 * What the page says about itself: site name, og:title and the description
 * (og:description, else meta description). Meta keywords are never read:
 * they are SEO tags, often about other stories.
 */
export function pageMeta(html) {
  return {
    siteName: metaContent(html, 'og:site_name', 80),
    title: metaContent(html, 'og:title', 300) || metaContent(html, 'twitter:title', 300),
    description: metaContent(html, 'og:description', 500) || metaContent(html, 'description', 500) || metaContent(html, 'twitter:description', 500),
    publishedAt: isoOrNull(metaContent(html, 'article:published_time', 40)),
  };
}

const ARTICLE_TYPE = /^(?:\w*NewsArticle|Article)$/;

function findArticle(node, depth) {
  if (!node || typeof node !== 'object' || depth > 4) return null;
  if (Array.isArray(node)) {
    for (const n of node.slice(0, 50)) { const f = findArticle(n, depth + 1); if (f) return f; }
    return null;
  }
  const types = [].concat(node['@type'] ?? []).map(String);
  if (types.some(t => ARTICLE_TYPE.test(t)) && typeof node.articleBody === 'string') return node;
  return findArticle(node['@graph'], depth + 1) || findArticle(node.mainEntity, depth + 1);
}

/**
 * The story from the page's JSON-LD (application/ld+json) when it is a
 * NewsArticle / Article with an articleBody: { body, publishedAt } or null.
 * This is the article without menus or "trending" lists, so the part the AI
 * reads (the first 6,000 characters) is the story itself.
 */
export function jsonLdArticle(html, maxChars = 15000) {
  const scripts = String(html ?? '').match(/<script\b[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script\s*>/gi) || [];
  for (const s of scripts.slice(0, 20)) {
    const raw = s.replace(/^<script\b[^>]*>/i, '').replace(/<\/script\s*>$/i, '');
    let data;
    // Raw newlines inside JSON strings are invalid but common; spaces are safe anywhere.
    try { data = JSON.parse(raw.replace(/[\u0000-\u001F]+/g, ' ')); } catch { continue; }
    const a = findArticle(data, 0);
    const body = a ? plainText(a.articleBody) : '';
    if (body.length >= 200) return { body: body.slice(0, maxChars), publishedAt: isoOrNull(a.datePublished) };
  }
  return null;
}

/** Tokens for near-identical headline detection (English and Kannada letters kept). */
export function titleTokens(title, publisher = '') {
  let t = String(title ?? '').toLowerCase();
  if (publisher) {
    const suffix = ` - ${String(publisher).toLowerCase()}`;
    if (t.endsWith(suffix)) t = t.slice(0, -suffix.length);
  }
  return [...new Set(t.replace(/[^a-z0-9ಀ-೿]+/g, ' ').split(' ').filter(w => w.length > 1))];
}

/** Same story if the word sets overlap by 80% (Jaccard) with enough words to judge. */
export function similarTitles(a, b) {
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  const B = new Set(b);
  const inter = a.filter(w => B.has(w)).length;
  return inter / (a.length + b.length - inter) >= 0.8;
}

// ── Feed parsers ─────────────────────────────────────────────────────────────

function cdata(s) { return String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); }

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? { attrs: m[1] || '', text: cdata(m[2]) } : { attrs: '', text: '' };
}

function isoOrNull(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Items from a Google News RSS search feed. */
export function parseGoogleNewsRss(xml) {
  const out = [];
  const blocks = String(xml ?? '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks.slice(0, 200)) {
    const src = tag(b, 'source');
    const publisher = plainText(src.text) || null;
    const publisherUrl = decodeEntities((src.attrs.match(/url="([^"]+)"/i) || [])[1] || '') || null;
    let title = plainText(tag(b, 'title').text);
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3)).trim();
    const link = decodeEntities(tag(b, 'link').text).trim();
    if (!title || !/^https?:\/\//i.test(link)) continue;
    // The description repeats the headline and publisher; keep only what it adds.
    let snippet = plainText(decodeEntities(tag(b, 'description').text));
    for (const part of [title, publisher]) if (part) snippet = snippet.split(part).join(' ');
    snippet = snippet.replace(/\s+/g, ' ').trim();
    out.push({
      source: 'google-news',
      title: title.slice(0, 300),
      url: link,
      publisher,
      publisherUrl,
      domain: null,
      publishedAt: isoOrNull(tag(b, 'pubDate').text.trim()),
      snippet: snippet.length >= 20 ? snippet.slice(0, 300) : '',
    });
  }
  return out;
}

function gdeltDate(s) {
  const m = String(s ?? '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null;
}

/** Articles from a GDELT DOC API artlist response (JSON text or parsed object). */
export function parseGdelt(body) {
  let data = body;
  if (typeof body === 'string') {
    try { data = body.trim() ? JSON.parse(body) : {}; }
    catch { throw new Error(`GDELT returned non-JSON: ${body.replace(/\s+/g, ' ').slice(0, 80)}`); }
  }
  const articles = Array.isArray(data?.articles) ? data.articles : [];
  return articles.slice(0, 250).map(a => ({
    source: 'gdelt',
    title: plainText(String(a?.title ?? '')).slice(0, 300),
    url: String(a?.url ?? '').trim(),
    publisher: null,
    publisherUrl: null,
    domain: String(a?.domain ?? '').trim() || null,
    publishedAt: gdeltDate(a?.seendate),
    snippet: '',
  })).filter(i => i.title && /^https?:\/\//i.test(i.url));
}

/**
 * Items from a publisher's own RSS 2.0 or Atom feed. Only links on the feed's
 * own site are kept, so every item points straight at the publisher.
 */
export function parsePublisherRss(xml, feedUrl) {
  const publisher = publisherFromUrl(feedUrl);
  const out = [];
  const blocks = String(xml ?? '').match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks.slice(0, 200)) {
    const title = plainText(tag(b, 'title').text);
    const atomHref = (b.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    const link = decodeEntities(tag(b, 'link').text.trim() || atomHref || '').trim();
    if (!title || !/^https?:\/\//i.test(link) || !sameSite(link, feedUrl)) continue;
    const date = tag(b, 'pubDate').text || tag(b, 'dc:date').text || tag(b, 'published').text || tag(b, 'updated').text;
    const snippet = plainText(decodeEntities(tag(b, 'description').text || tag(b, 'summary').text)).replace(/\s+/g, ' ').trim();
    out.push({
      source: 'publisher-feed',
      title: title.slice(0, 300),
      url: link,
      publisher,
      publisherUrl: originOf(feedUrl),
      domain: siteOf(link) || null,
      publishedAt: isoOrNull(date.trim()),
      snippet: snippet.length >= 20 ? snippet.slice(0, 300) : '',
    });
  }
  return out;
}

// ── URLs ─────────────────────────────────────────────────────────────────────

const TRACKING_PARAMS = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ocid|cmpid|ref_src|igshid|_ga)$/i;

/** http(s) URL with the fragment and tracking parameters removed, or null. */
export function normalizeUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(k) || (k === 'oc' && u.hostname === 'news.google.com')) u.searchParams.delete(k);
  }
  return u.toString().replace(/\?$/, '');
}

/** Comparison key: no scheme, "www."/"m." dropped, no trailing slash. */
export function urlKey(raw) {
  const n = normalizeUrl(raw);
  if (!n) return null;
  const u = new URL(n);
  const host = u.hostname.replace(/^(www|m)\./, '');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  return `${host}${p}${u.search}`;
}

/** Spellings of the same link that may already be stored in accidents.link. */
export function linkVariants(raw) {
  const out = new Set();
  const trimmed = String(raw ?? '').trim();
  if (trimmed) out.add(trimmed);
  const n = normalizeUrl(trimmed);
  if (n) {
    const flip = n.endsWith('/') ? n.replace(/\/+$/, '') : (new URL(n).search ? null : `${n}/`);
    for (const v of [n, flip]) {
      if (!v) continue;
      out.add(v);
      out.add(v.startsWith('https:') ? `http:${v.slice(6)}` : `https:${v.slice(5)}`);
    }
  }
  return [...out].slice(0, 8);
}

export function hostOf(raw) {
  try { return new URL(String(raw ?? '')).hostname.toLowerCase(); } catch { return ''; }
}

function originOf(raw) {
  try { return new URL(String(raw ?? '')).origin; } catch { return null; }
}

/** The publisher's site: the host without "www.", "m." or "amp.". */
export function siteOf(raw) {
  return hostOf(raw).replace(/^(www|m|amp)\./, '');
}

/** Same publisher site: equal hosts, or one a subdomain of the other. */
export function sameSite(a, b) {
  const x = siteOf(a), y = siteOf(b);
  return Boolean(x && y) && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
}

export function isGoogleHost(raw) {
  const h = hostOf(raw);
  return h === 'google.com' || /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h) || h.endsWith('.googleusercontent.com');
}

const KNOWN_PUBLISHERS = {
  'deccanherald.com': 'Deccan Herald',
  'thehindu.com': 'The Hindu',
  'timesofindia.indiatimes.com': 'The Times of India',
  'bangaloremirror.indiatimes.com': 'Bangalore Mirror',
  'newindianexpress.com': 'The New Indian Express',
  'indianexpress.com': 'The Indian Express',
  'hindustantimes.com': 'Hindustan Times',
  'thenewsminute.com': 'The News Minute',
  'ndtv.com': 'NDTV',
  'news18.com': 'News18',
  'indiatoday.in': 'India Today',
  'livemint.com': 'Mint',
  'economictimes.indiatimes.com': 'The Economic Times',
  'moneycontrol.com': 'Moneycontrol',
  'oneindia.com': 'Oneindia',
  'prajavani.net': 'Prajavani',
  'vijaykarnataka.com': 'Vijay Karnataka',
  'udayavani.com': 'Udayavani',
  'kannadaprabha.com': 'Kannada Prabha',
  'publictv.in': 'Public TV',
  'tv9kannada.com': 'TV9 Kannada',
  'asianetnews.com': 'Asianet News',
  'citizenmatters.in': 'Citizen Matters',
};

/** Publisher name for a link: known outlets by name, otherwise the bare domain. */
export function publisherFromUrl(raw) {
  const h = hostOf(raw).replace(/^(www|m|amp)\./, '');
  if (!h) return null;
  for (const [domain, name] of Object.entries(KNOWN_PUBLISHERS)) {
    if (h === domain || h.endsWith(`.${domain}`)) return name;
  }
  return h;
}

// ── Related stories ──────────────────────────────────────────────────────────

const BENGALURU_PLACE_NAMES = [
  'bengaluru', 'bangalore', 'blr', 'whitefield', 'k\\.?\\s?r\\.?\\s?puram', 'indiranagar', 'marathahalli', 'varthur', 'sarjapur',
  'domlur', 'mahadevapura', 'bellandur', 'hsr layout', 'koramangala', 'madiwala', 'hebbal', 'yelahanka', 'jakkur', 'peenya',
  'yeshwant?h?pur', 'yeswanthpur', 'nagavara', 'banaswadi', 'hennur', 'jayanagar', 'j\\.?\\s?p\\.?\\s?nagar', 'bannerghatta',
  'banashankari', 'btm layout', 'silk\\s?board', 'hosur road', 'electronic city', 'nice road', 'kengeri', 'mysuru road',
  'mysore road', 'rajajinagar', 'vijayanagar', 'magadi road', 'jalahalli', 'malleswaram', 'basavanagudi', 'm\\.?\\s?g\\.? road',
  'majestic', 'shivajinagar', 'ulsoor', 'outer ring road', 'airport road', 'tumakuru road', 'tumkur road', 'bellary road',
  'ballari road', 'old madras road', 'kanakapura road', 'hoskote', 'devanahalli', 'nelamangala', 'anekal', 'attibele',
  'doddaballapura?', 'bommanahalli', 'begur', 'hulimavu', 'chandapura', 'r\\.?\\s?t\\.?\\s?nagar', 'kalyan nagar',
];
const BENGALURU_PLACES = new RegExp(`\\b(?:${BENGALURU_PLACE_NAMES.join('|')})\\b|ಬೆಂಗಳೂರು`, 'i');

/** The text names Bengaluru (in English or Kannada) or a well-known place in it. */
export const mentionsBengaluru = (text) => BENGALURU_PLACES.test(String(text ?? ''));

const RELATED_BLOCK = /<(?:div|section|aside|ul|ol|nav|footer)\b[^>]*\b(?:class|id)\s*=\s*["'][^"']*(?:related|also[-_\s]?read|read[-_\s]?more|more[-_\s]?(?:stories|news|from)|recommended)[^"']*["'][^>]*>/gi;
const ALSO_READ = /\balso\s+read\b/gi;

/**
 * Same-site story links from "Also Read" lines (the first link after the
 * words) and related-story blocks (a class or id saying related, also-read,
 * read-more, more-stories or recommended): [{ url, text }], at most `max`.
 * Only collects; the caller decides which are worth following.
 */
export function relatedLinks(html, pageUrl, max = 30) {
  const s = String(html ?? '');
  const self = urlKey(pageUrl);
  const windows = [];
  for (const m of s.matchAll(RELATED_BLOCK)) windows.push({ html: s.slice(m.index, m.index + 6000), first: false });
  for (const m of s.matchAll(ALSO_READ)) windows.push({ html: s.slice(m.index, m.index + 600), first: true });
  const out = new Map();
  for (const w of windows.slice(0, 40)) {
    for (const a of w.html.matchAll(ANCHOR)) {
      const attrs = tagAttrs(a[1]);
      const href = decodeEntities(attrs.href ?? '').trim();
      let url = null;
      try { url = href && !href.startsWith('#') ? normalizeUrl(new URL(href, pageUrl).toString()) : null; } catch { /* bad href */ }
      const key = url && urlKey(url);
      const text = (plainText(a[2]) || decodeEntities(attrs.title ?? '')).replace(/\s+/g, ' ').trim();
      if (key && key !== self && !out.has(key) && sameSite(url, pageUrl) && text.length >= 15) {
        out.set(key, { url, text: text.slice(0, 300) });
        if (out.size >= max) return [...out.values()];
      }
      if (w.first) break;
    }
  }
  return [...out.values()];
}

// ── Fetching ─────────────────────────────────────────────────────────────────

async function discardBody(res) {
  try { await res.body?.cancel?.(); } catch { /* already closed */ }
}

/** Read a response body, stopping as soon as it passes maxBytes or timeoutMs. */
export async function readCapped(res, maxBytes, timeoutMs = 12000) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(res);
    throw new Error(`Response larger than ${maxBytes} bytes`);
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`Response larger than ${maxBytes} bytes`);
    return buf.toString('utf8');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out reading the response')), timeoutMs); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Response larger than ${maxBytes} bytes`);
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * GET through safeFetch with a size cap. Returns { ok, status, url, contentType, text, bodySkipped }.
 * `url` is the final address after redirects. `skipBodyIf(finalUrl)` lets the
 * caller leave a body unread (used so Google News pages are never parsed), and
 * error responses are not read at all.
 */
export async function fetchCapped(url, { maxBytes = 2 * 1024 * 1024, timeoutMs = 12000, accept = '*/*', skipBodyIf = null } = {}) {
  const res = await safeFetch(url, { timeoutMs, headers: { 'User-Agent': AGENT_USER_AGENT, Accept: accept } });
  const out = { ok: res.ok, status: res.status, url: res.url || url, contentType: res.headers?.get?.('content-type') || '', text: '', bodySkipped: false };
  if (!res.ok || (skipBodyIf && skipBodyIf(out.url))) {
    await discardBody(res);
    out.bodySkipped = true;
    return out;
  }
  out.text = await readCapped(res, maxBytes, timeoutMs);
  return out;
}
