/**
 * News sources for the BAT News Agent, plus the fetch and text helpers they share.
 *
 *  - Google News RSS search feeds: headline, Google News link, publisher, date.
 *  - GDELT DOC 2.0 API (artlist mode): publisher URL, title, domain, first-seen time.
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

/** <meta property|name="..." content="..."> in either attribute order. */
export function metaContent(html, prop) {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = String(html ?? '').match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']{1,200})["']`, 'i'));
  const b = a || String(html ?? '').match(new RegExp(`<meta[^>]+content=["']([^"']{1,200})["'][^>]*(?:property|name)=["']${p}["']`, 'i'));
  return b ? decodeEntities(b[1]).trim() : null;
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
