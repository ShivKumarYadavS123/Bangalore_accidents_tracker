/**
 * Import from X: URL parsing, snowflake dates, oEmbed parsing and the batch
 * importer. oEmbed, the database and OpenRouter are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseXStatusUrl, postDateFromId, textFromOembedHtml, handleFromAuthorUrl, oembedUrl, isXHost, createXImporter,
} from '../agent/x-import.mjs';
import { createImportPipeline, addDays } from '../agent/pipeline.mjs';
import { resetBudget, clearLlmCache } from '../ai/llm.mjs';
import { chatReply } from './fixtures/ai-fixtures.js';
import { extraction, notAccident, makeAi, makeStore, fetched, oembedReply, postIdAt, silentLogger } from './fixtures/agent-fixtures.js';

beforeEach(() => { process.env.OPENROUTER_API_KEY = 'test-key'; resetBudget(); clearLlmCache(); });
afterEach(() => { delete process.env.OPENROUTER_API_KEY; vi.restoreAllMocks(); });

const REAL_ID = '2108526123160424481';

describe('parseXStatusUrl', () => {
  it('accepts x.com, twitter.com, www., mobile. and a query string', () => {
    expect(parseXStatusUrl('https://x.com/blrcitytraffic/status/2108526123160424481')).toEqual({
      handle: 'blrcitytraffic', postId: REAL_ID, canonicalUrl: 'https://x.com/blrcitytraffic/status/2108526123160424481',
    });
    expect(parseXStatusUrl('https://twitter.com/blrcitytraffic/status/123')?.canonicalUrl).toBe('https://x.com/blrcitytraffic/status/123');
    expect(parseXStatusUrl('https://www.twitter.com/blrcitytraffic/status/123')?.postId).toBe('123');
    expect(parseXStatusUrl('https://mobile.twitter.com/BlrCityTraffic/status/123')?.handle).toBe('BlrCityTraffic');
    expect(parseXStatusUrl('https://mobile.x.com/blrcitytraffic/status/123/')?.postId).toBe('123');
    expect(parseXStatusUrl('  https://x.com/blrcitytraffic/status/123?s=20&t=abc  ')?.canonicalUrl).toBe('https://x.com/blrcitytraffic/status/123');
  });

  it('rejects other hosts, non-status pages, other schemes and tricks', () => {
    for (const bad of [
      'https://evil.com/blrcitytraffic/status/123',
      'https://x.com.evil.com/blrcitytraffic/status/123',
      'https://notx.com/blrcitytraffic/status/123',
      'https://x.com/blrcitytraffic',
      'https://x.com/blrcitytraffic/likes',
      'https://x.com/blrcitytraffic/status/123/photo/1',
      'https://x.com/i/web/status/123',
      'https://x.com/blrcitytraffic/status/abc',
      'http://x.com/blrcitytraffic/status/123',
      'javascript:alert(1)//x.com/a/status/1',
      'javascript://x.com/blrcitytraffic/status/123',
      'https://user:pass@x.com/blrcitytraffic/status/123',
      'https://x.com:8443/blrcitytraffic/status/123',
      'https://x.com/blrcitytraffic/status/123#frag',
      'https://x.com/this_handle_is_too_long/status/123',
      'x.com/blrcitytraffic/status/123',
      '',
      null,
    ]) expect(parseXStatusUrl(bad), String(bad)).toBeNull();
  });

  it('recognises any x.com / twitter.com address', () => {
    expect(isXHost('https://x.com/anything')).toBe(true);
    expect(isXHost('https://mobile.twitter.com/a')).toBe(true);
    expect(isXHost('https://www.thehindu.com/x.com')).toBe(false);
    expect(isXHost('not a url')).toBe(false);
  });
});

describe('postDateFromId', () => {
  it('decodes the post time in Asia/Kolkata', () => {
    const d = postDateFromId(REAL_ID);
    expect(d.date).toBe('2026-10-09');
    expect(d.date.startsWith('2026-')).toBe(true);
    expect(d.time).toBe('17:22');
    expect(d.iso).toBe('2026-10-09T11:52:56.939Z');
  });

  it('round-trips and rejects junk', () => {
    const ms = Date.UTC(2026, 9, 1, 3, 4, 5);
    expect(postDateFromId(postIdAt(ms)).ms).toBe(ms);
    expect(postDateFromId('abc')).toBeNull();
    expect(postDateFromId('')).toBeNull();
    expect(postDateFromId('1'.repeat(21))).toBeNull();
  });
});

describe('oEmbed parsing', () => {
  it('takes the <p> text, strips tags and decodes entities', () => {
    const html = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Accident at Hebbal flyover &amp; BMTC bus involved.<br>Expect slow traffic &lt;towards&gt; city. <a href="https://t.co/x">pic.twitter.com/abc</a> &#x1F6A8;</p>&mdash; BTP (@blrcitytraffic) <a href="https://twitter.com/blrcitytraffic/status/1">October 9, 2026</a></blockquote>';
    expect(textFromOembedHtml(html)).toBe('Accident at Hebbal flyover & BMTC bus involved.\nExpect slow traffic <towards> city. pic.twitter.com/abc 🚨');
    expect(textFromOembedHtml('<blockquote>no paragraph</blockquote>')).toBe('');
    expect(textFromOembedHtml(undefined)).toBe('');
  });

  it('reads the real author handle and builds the official oEmbed URL', () => {
    expect(handleFromAuthorUrl('https://twitter.com/blrcitytraffic')).toBe('blrcitytraffic');
    expect(handleFromAuthorUrl('https://evil.com/blrcitytraffic')).toBeNull();
    expect(oembedUrl('https://x.com/blrcitytraffic/status/1')).toBe('https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2Fblrcitytraffic%2Fstatus%2F1&omit_script=1&dnt=true');
  });
});

describe('X batch import', () => {
  const NOW = postDateFromId(REAL_ID).ms + 2 * 3600 * 1000;
  const id = (minutesAgo) => postIdAt(NOW - minutesAgo * 60 * 1000);
  const IDS = { congestion: id(30), existing: id(40), missing: id(50), spoof: id(60), old: postIdAt(NOW - 70 * 24 * 3600 * 1000) };

  function setup({ store = makeStore({ rows: [{ id: '700', link: `https://twitter.com/BlrCityTraffic/status/${IDS.existing}` }] }), budgetStatus } = {}) {
    const posts = {
      [REAL_ID]: oembedReply({ text: 'Accident at Hebbal flyover: a car rammed into a BMTC bus, one person injured. Traffic is slow towards the city.' }),
      [IDS.congestion]: oembedReply({ text: 'Heavy traffic on ORR near Marathahalli due to a breakdown. Please plan your travel.' }),
      [IDS.spoof]: oembedReply({ text: 'Bike rider killed after hitting a divider on Bellary Road near Hebbal.', handle: 'randomuser', name: 'Random' }),
    };
    const fetchUrl = vi.fn(async (url) => {
      const post = new URL(url).searchParams.get('url').split('/').pop();
      if (posts[post]) return fetched(posts[post], { url, contentType: 'application/json' });
      return fetched('', { status: 404, url, bodySkipped: true });
    });
    const aiFetch = makeAi({
      // Match on words that only appear in the post text (the prompt's rules mention "breakdowns").
      extract: (user) => {
        if (user.includes('near Marathahalli')) return notAccident();
        if (user.includes('Bellary Road near Hebbal')) return extraction({ location: 'Bellary Road near Hebbal', severity: 'fatal', date: null, time: null });
        return extraction({ location: 'Hebbal flyover', area: 'Hebbal', severity: 'serious', date: null, time: null });
      },
    });
    const pipeline = createImportPipeline({ store, geocode: async () => ({ lat: 13.0358, lng: 77.597 }), inferZone: () => 'North', sleep: async () => {}, now: () => NOW, logger: silentLogger });
    const importer = createXImporter({ pipeline, store, fetchUrl, aiFetch, budgetStatus: budgetStatus || (() => ({ limit: 45, used: 0, remaining: 45 })), env: {}, logger: silentLogger, sleep: async () => {}, now: () => NOW });
    return { importer, store, fetchUrl, aiFetch };
  }

  it('returns one result per link, in order, with mixed statuses', async () => {
    const { importer, store, fetchUrl, aiFetch } = setup();
    const results = await importer.importLinks([
      `https://x.com/blrcitytraffic/status/${REAL_ID}`,
      `https://twitter.com/blrcitytraffic/status/${REAL_ID}?s=20`,
      'https://evil.com/blrcitytraffic/status/1',
      'javascript:alert(1)',
      `https://x.com/blrcitytraffic/status/${IDS.congestion}`,
      `https://x.com/someone/status/${IDS.existing}`,
      `https://x.com/blrcitytraffic/status/${IDS.missing}`,
      `https://x.com/blrcitytraffic/status/${IDS.spoof}`,
      `https://x.com/blrcitytraffic/status/${IDS.old}`,
    ]);
    expect(results.map(r => r.status)).toEqual([
      'imported', 'duplicate', 'invalid_link', 'invalid_link', 'not_accident', 'duplicate', 'invalid_link', 'imported', 'error',
    ]);
    expect(results[0]).toMatchObject({ canonicalUrl: `https://x.com/blrcitytraffic/status/${REAL_ID}`, id: '1191', reason: 'imported #1191' });
    expect(results[1].reason).toBe('same post as line 1');
    expect(results[5]).toMatchObject({ reason: 'duplicate of #700', duplicateOf: '700' });
    expect(results[6].reason).toMatch(/does not exist or is not public/);
    expect(results[8].reason).toMatch(/older than 60 days/);

    const btp = store.inserted.find(r => r.link.endsWith(REAL_ID));
    expect(btp).toMatchObject({
      status: 'pending', reporter_id: null, source: 'Bengaluru Traffic Police (X)', title: 'Traffic Police: Hebbal flyover',
      link: `https://x.com/blrcitytraffic/status/${REAL_ID}`, accident_date: '2026-10-09', severity: 'serious', zone: 'North',
    });
    expect(btp.description).toMatch(/Date taken from the post's publish date/);
    expect(btp.description.endsWith('(Imported from X by a BAT admin)')).toBe(true);

    // The author comes from X, not the pasted handle: no "Traffic Police" label for someone else's post.
    const spoof = store.inserted.find(r => r.link.includes(IDS.spoof));
    expect(spoof).toMatchObject({ source: 'X: @randomuser', title: 'Fatal accident: Bellary Road near Hebbal', link: `https://x.com/randomuser/status/${IDS.spoof}` });
    expect(results[7].canonicalUrl).toBe(`https://x.com/randomuser/status/${IDS.spoof}`);
    expect(store.inserted).toHaveLength(2);

    // Extraction uses the agent model order and 2500 tokens.
    const firstAiBody = JSON.parse(aiFetch.mock.calls[0][1].body);
    expect(firstAiBody).toMatchObject({ model: 'google/gemma-4-31b-it:free', max_tokens: 2500, reasoning: { effort: 'low', exclude: true } });

    // Only X's official oEmbed endpoint is called, never the pasted URL; no call for duplicates, bad links or old posts.
    for (const [u] of fetchUrl.mock.calls) expect(u.startsWith('https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2F')).toBe(true);
    expect(fetchUrl).toHaveBeenCalledTimes(4);
  });

  it('stops using AI when fewer than 10 site-wide calls are left', async () => {
    const { importer, aiFetch, store } = setup({ budgetStatus: () => ({ limit: 45, used: 40, remaining: 5 }) });
    const [r] = await importer.importLinks([`https://x.com/blrcitytraffic/status/${REAL_ID}`]);
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/AI budget low/);
    expect(aiFetch).not.toHaveBeenCalled();
    expect(store.inserted).toHaveLength(0);
  });

  it('one failure does not stop the rest', async () => {
    const { importer, store } = setup();
    store.findByXPostId = vi.fn()
      .mockRejectedValueOnce(new Error('database lookup failed: timeout'))
      .mockResolvedValue(null);
    const results = await importer.importLinks([
      `https://x.com/blrcitytraffic/status/${IDS.congestion}`,
      `https://x.com/blrcitytraffic/status/${REAL_ID}`,
    ]);
    expect(results.map(r => r.status)).toEqual(['error', 'imported']);
    expect(results[0].reason).toMatch(/could not check for duplicates/);
  });

  it('an AI date outside the 60-day window is an error, not an import', async () => {
    const { importer, store, aiFetch } = setup();
    aiFetch.mockImplementation(async () => chatReply(extraction({ date: addDays('2026-10-09', -61) })));
    const [r] = await importer.importLinks([`https://x.com/blrcitytraffic/status/${REAL_ID}`]);
    expect(r).toMatchObject({ status: 'error', reason: expect.stringMatching(/older than 60 days/) });
    expect(store.inserted).toHaveLength(0);
  });
});
