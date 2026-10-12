/**
 * Admin paste box: import Bengaluru Traffic Police posts from X.
 *
 * Only X's free official oEmbed endpoint (publish.x.com/oembed) is called.
 * The pasted URL itself is never fetched, and x.com pages are never scraped.
 * Each post goes through the shared pipeline (AI check, geocode, dedupe) and
 * lands as a pending accident for approval.
 */
import { fetchCapped, decodeEntities } from './sources.mjs';
import { X_MARKER, MAX_AGE_DAYS, STATUS_CHECK_PROBLEM, istDate, addDays } from './pipeline.mjs';
import { createAiGate, agentModels, SITE_RESERVE } from './news-agent.mjs';

export const MAX_X_LINKS = 20;
const TWITTER_EPOCH = 1288834974657n;

/**
 * https://(www.|mobile.)?(x.com|twitter.com)/<handle>/status/<digits>, optional query.
 * Returns { handle, postId, canonicalUrl } or null. Never fetches anything.
 */
export function parseXStatusUrl(input) {
  const s = String(input ?? '').trim();
  if (!s || s.length > 300) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null;
  if (!/^(?:www\.|mobile\.)?(?:x\.com|twitter\.com)$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,20})\/?$/);
  if (!m) return null;
  return { handle: m[1], postId: m[2], canonicalUrl: `https://x.com/${m[1]}/status/${m[2]}` };
}

/** Any x.com / twitter.com address (used to keep those links away from the article scraper). */
export function isXHost(input) {
  try { return /(^|\.)(x\.com|twitter\.com)$/i.test(new URL(String(input ?? '').trim()).hostname); } catch { return false; }
}

/** Post time from the snowflake id: (id >> 22) + Twitter epoch, shown in Asia/Kolkata. */
export function postDateFromId(id) {
  const s = String(id ?? '');
  if (!/^\d{1,20}$/.test(s)) return null;
  const ms = Number((BigInt(s) >> 22n) + TWITTER_EPOCH);
  if (!Number.isFinite(ms)) return null;
  const ist = new Date(ms + 5.5 * 3600 * 1000).toISOString();
  return { ms, iso: new Date(ms).toISOString(), date: ist.slice(0, 10), time: ist.slice(11, 16) };
}

export function oembedUrl(canonicalUrl) {
  return `https://publish.x.com/oembed?url=${encodeURIComponent(canonicalUrl)}&omit_script=1&dnt=true`;
}

/** Post text from oEmbed html: the first <p>, tags stripped, entities decoded. */
export function textFromOembedHtml(html) {
  const m = String(html ?? '').match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export function handleFromAuthorUrl(authorUrl) {
  const m = String(authorUrl ?? '').match(/^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?$/i);
  return m ? m[1] : null;
}

export function trafficPoliceHandles(env = process.env) {
  const list = String(env.X_TRAFFIC_POLICE_HANDLES || 'blrcitytraffic').split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  return new Set(list.length ? list : ['blrcitytraffic']);
}

function short(e) { return String(e?.message || e).replace(/\s+/g, ' ').slice(0, 200); }

export function createXImporter({
  pipeline, store, env = process.env, fetchUrl = fetchCapped,
  chat, aiFetch = null, budgetStatus, logger = console, sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = () => Date.now(),
} = {}) {
  const btpHandles = trafficPoliceHandles(env);
  const models = agentModels(env);

  async function fetchPost(canonicalUrl) {
    let r;
    try {
      r = await fetchUrl(oembedUrl(canonicalUrl), { maxBytes: 256 * 1024, timeoutMs: 10000, accept: 'application/json' });
    } catch (e) {
      return { error: 'error', reason: `could not reach X's embed service (${short(e)})` };
    }
    if (r.status === 404) return { error: 'invalid_link', reason: 'X says this post does not exist or is not public' };
    if (r.status === 403) return { error: 'invalid_link', reason: 'X will not embed this post (protected or restricted account)' };
    if (!r.ok) return { error: 'error', reason: `X's embed service returned HTTP ${r.status}` };
    let json;
    try { json = JSON.parse(r.text); } catch { return { error: 'error', reason: "X's embed service did not return JSON" }; }
    const text = textFromOembedHtml(json?.html);
    if (!text) return { error: 'error', reason: 'X returned no post text (the post may be deleted, protected or age-restricted)' };
    return { text, handle: handleFromAuthorUrl(json?.author_url), authorName: typeof json?.author_name === 'string' ? json.author_name.slice(0, 80) : null };
  }

  async function importOne(parsed, input, gate) {
    const base = { input, canonicalUrl: parsed.canonicalUrl };
    const posted = postDateFromId(parsed.postId);
    const today = istDate(now());
    if (!posted || posted.ms > now() + 24 * 3600 * 1000) return { ...base, status: 'invalid_link', reason: 'not a valid post id' };
    if (posted.date < addDays(today, -MAX_AGE_DAYS)) return { ...base, status: 'error', reason: `post is from ${posted.date}, older than ${MAX_AGE_DAYS} days` };

    // Cheap database check before calling X at all.
    try {
      const existing = await store.findByXPostId(parsed.postId);
      if (existing) return { ...base, status: 'duplicate', reason: `duplicate of #${existing.id}`, duplicateOf: String(existing.id) };
    } catch (e) {
      return { ...base, status: 'error', reason: `could not check for duplicates (${short(e)}); nothing saved` };
    }

    // No point asking X for the post if the AI can't check it today.
    if (gate.allowance() < 1) return { ...base, status: 'error', reason: `AI budget low (${gate.stopReason}); try again later` };

    const post = await fetchPost(parsed.canonicalUrl);
    if (post.error) return { ...base, status: post.error, reason: post.reason };

    // The author comes from X, not from the pasted URL, so a post can't be
    // passed off as Traffic Police by editing the handle in the link.
    const handle = post.handle || parsed.handle;
    const isTrafficPolice = Boolean(post.handle) && btpHandles.has(post.handle.toLowerCase());
    const canonicalUrl = `https://x.com/${handle}/status/${parsed.postId}`;

    const res = await pipeline.importItem({
      kind: 'x',
      title: `Post by @${handle} on X`,
      text: post.text,
      link: canonicalUrl,
      xPostId: parsed.postId,
      publishedAt: `${posted.date} ${posted.time} IST`,
      fallbackDate: posted.date,
      publisher: isTrafficPolice ? 'Bengaluru Traffic Police' : `@${handle} on X`,
      sourceName: isTrafficPolice ? 'Bengaluru Traffic Police (X)' : `X: @${handle}`,
      titleStyle: isTrafficPolice ? 'traffic-police' : 'severity',
      marker: X_MARKER,
    }, { llm: gate.call, models, today });
    // The database refusing Pending rows is a setup problem, not a bad post: say what fixes it.
    const reason = res.statusCheck ? `${STATUS_CHECK_PROBLEM}; import the post again once that is done` : res.reason;
    const out = { ...base, canonicalUrl, status: res.status, reason };
    if (res.id) out.id = res.id;
    if (res.duplicateOf) out.duplicateOf = res.duplicateOf;
    return out;
  }

  /** One result per input line, in order; one failure never stops the rest. */
  async function importLinks(urls) {
    const list = (Array.isArray(urls) ? urls : []).slice(0, MAX_X_LINKS);
    // No per-batch cap beyond the site-wide reserve: X imports don't use the agent's daily budget.
    const gate = createAiGate({ chat, aiFetch, budgetStatus, siteReserve: SITE_RESERVE });
    const firstLine = new Map();
    const results = [];
    let calledX = false;
    for (const [i, raw] of list.entries()) {
      const input = String(raw ?? '').trim().slice(0, 300);
      const parsed = parseXStatusUrl(input);
      if (!parsed) {
        results.push({ input, status: 'invalid_link', reason: 'not an X post link (https://x.com/<handle>/status/<id>)' });
        continue;
      }
      if (firstLine.has(parsed.postId)) {
        results.push({ input, canonicalUrl: parsed.canonicalUrl, status: 'duplicate', reason: `same post as line ${firstLine.get(parsed.postId)}` });
        continue;
      }
      firstLine.set(parsed.postId, i + 1);
      try {
        if (calledX) await sleep(1000);
        calledX = true;
        results.push(await importOne(parsed, input, gate));
      } catch (e) {
        logger.warn?.('[x-import] failed:', short(e));
        results.push({ input, canonicalUrl: parsed.canonicalUrl, status: 'error', reason: short(e) });
      }
    }
    return results;
  }

  return { importLinks, importOne };
}
