/**
 * News Agent / X import UI helpers: the map popup's source wording and the
 * admin source badges. Runs the real functions from the shipped files.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

function loadSourceInfo() {
  const fn = src('dashboard-app.js').match(/function sourceInfo\(p\) \{[\s\S]*?\n {2}\}/)[0];
  return new Function(`${fn}; return sourceInfo;`)();
}

function loadAdminAgent() {
  const window = {};
  new Function('window', 'document', src('admin-agent.js'))(window, {});
  return window.BATAgent;
}

describe('map popup source wording', () => {
  const sourceInfo = loadSourceInfo();

  it('credits Bengaluru Traffic Police for their X posts', () => {
    const info = sourceInfo({ source: 'Bengaluru Traffic Police (X)', link: 'https://x.com/blrcitytraffic/status/2108526123160424481' });
    expect(info).toEqual({ label: 'Bengaluru Traffic Police on X', linkText: 'View post on X ↗', href: 'https://x.com/blrcitytraffic/status/2108526123160424481' });
  });

  it('names other X accounts by handle', () => {
    expect(sourceInfo({ source: 'X: @someone', link: 'https://x.com/someone/status/1' }).label).toBe('@someone on X');
  });

  it('calls any other x.com link just "Post on X"', () => {
    for (const source of ['User Report', 'Bengaluru Traffic Police', 'Deccan Herald', 'X: @not a handle', '', undefined]) {
      const info = sourceInfo({ source, link: 'https://x.com/blrcitytraffic/status/2108526123160424481' });
      expect(info.label, String(source)).toBe('Post on X');
      expect(info.linkText).toBe('View post on X ↗');
    }
  });

  it('credits the publisher and the News Agent', () => {
    const info = sourceInfo({ source: 'Deccan Herald', link: 'https://www.deccanherald.com/a', foundBy: 'agent' });
    expect(info).toEqual({ label: 'Deccan Herald (found by BAT News Agent)', linkText: 'Read article ↗', href: 'https://www.deccanherald.com/a' });
  });

  it('leaves older rows as they were and drops unsafe links', () => {
    expect(sourceInfo({ source: 'The Hindu', link: 'https://www.thehindu.com/x' })).toEqual({ label: 'The Hindu', linkText: 'Read article ↗', href: 'https://www.thehindu.com/x' });
    expect(sourceInfo({ source: 'User Report', link: null }).href).toBeNull();
    expect(sourceInfo({ source: 'X', link: 'javascript:alert(1)' }).href).toBeNull();
    expect(sourceInfo({ link: '#' }).label).toBe('—');
  });

  it('never calls these records live or real-time', () => {
    const cases = [
      { source: 'Bengaluru Traffic Police (X)', link: 'https://x.com/blrcitytraffic/status/1' },
      { source: 'Deccan Herald', link: 'https://a.com', foundBy: 'agent' },
      { source: 'X: @a', link: 'https://twitter.com/a/status/2' },
    ];
    for (const c of cases) {
      const { label, linkText } = sourceInfo(c);
      expect(`${label} ${linkText}`).not.toMatch(/\blive\b|real[- ]?time/i);
    }
  });
});

describe('admin source badges', () => {
  const agent = loadAdminAgent();

  it('tells agent, X and citizen rows apart', () => {
    expect(agent.sourceKind({ description: 'A biker died. (Found by BAT News Agent)', link: 'https://a.com' })).toBe('agent');
    expect(agent.sourceKind({ link: 'https://x.com/blrcitytraffic/status/123', description: 'x (Imported from X by a BAT admin)' })).toBe('x');
    expect(agent.sourceKind({ reporter_id: 'u1', description: 'I saw a crash' })).toBe('user');
    expect(agent.sourceKind({ source: 'The Hindu', link: 'https://a.com' })).toBeNull();
  });

  it('badge markup is fixed text only', () => {
    expect(agent.sourceBadgeHtml({ description: '(Found by BAT News Agent)' })).toMatch(/>Agent</);
    expect(agent.sourceBadgeHtml({ link: 'https://twitter.com/a/status/1' })).toMatch(/>X</);
    expect(agent.sourceBadgeHtml({ reporter_id: 'u1' })).toBe('');
  });

  it('recognises X post links the same way as the server', () => {
    expect(agent.isXPostUrl('https://mobile.twitter.com/blrcitytraffic/status/123?s=20')).toBe(true);
    expect(agent.isXPostUrl('https://x.com/blrcitytraffic')).toBe(false);
    expect(agent.isXPostUrl('http://x.com/a/status/1')).toBe(false);
    expect(agent.isXHost('https://x.com/blrcitytraffic')).toBe(true);
    expect(agent.isXHost('https://www.thehindu.com/x.com/status/1')).toBe(false);
  });

  it('splits pasted links one per line', () => {
    expect(agent.parseLines(' https://x.com/a/status/1 \r\n\n https://x.com/b/status/2\n')).toEqual(['https://x.com/a/status/1', 'https://x.com/b/status/2']);
  });

  it('exposes openRun for the panel', () => {
    expect(typeof agent.openRun).toBe('function');
  });

  it('labels every pipeline status', () => {
    for (const s of ['imported', 'duplicate', 'not_accident', 'outside_bangalore', 'invalid_link', 'error', 'deferred']) {
      expect(agent.statusLabel(s)).not.toBe(s);
    }
    expect(agent.statusLabel('outside_bangalore')).toBe('Not in Bangalore');
  });
});

/** Just enough DOM for admin-agent.js: elements, text, children, click listeners. */
function fakeDom(ids) {
  class FakeEl {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this.className = ''; this._text = ''; this.classList = { toggle() {}, add() {}, remove() {} }; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    appendChild(c) { this.children.push(c); return c; }
    replaceChildren(...kids) { this._text = ''; this.children = kids; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { (this.listeners.click || []).forEach(fn => fn({ target: this, currentTarget: {} })); }
    focus() {}
  }
  const byId = Object.fromEntries(ids.map(id => [id, new FakeEl('div')]));
  const document = {
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (t) => ({ textContent: String(t) }),
    getElementById: (id) => byId[id],
    addEventListener() {},
  };
  return { document, byId };
}

describe('News Agent panel: run detail follows a running run', () => {
  afterEach(() => vi.useRealTimers());

  it('re-fetches the open run when the status poll sees it finish', async () => {
    vi.useFakeTimers();
    const ids = ['agent-btn', 'agent-close', 'agent-close-btn', 'agent-back', 'agent-run-btn', 'agent-backfill-btn', 'agent-modal',
      'agent-status', 'agent-run-hint', 'agent-runs-view', 'agent-run-detail', 'agent-run-detail-body', 'agent-runs'];
    const { document, byId } = fakeDom(ids);
    byId['agent-modal'].hidden = true;
    byId['agent-run-detail'].hidden = true;

    const base = { enabled: true, ready: true, aiCallsToday: 1, dailyAiBudget: 20, maxAiCallsPerRun: 8, siteAi: { remaining: 40, limit: 45, reserve: 10 }, queueLength: 0 };
    const summary = { id: 'run_A', trigger: 'manual', days: 2, startedAt: '2026-10-12T10:00:00.000Z', aiCalls: 1, counts: { imported: 0 } };
    const statuses = [
      { ...base, running: true, currentRun: { ...summary, status: 'running' }, lastRuns: [] }, // panel opens
      { ...base, running: true, currentRun: { ...summary, status: 'running' }, lastRuns: [] }, // first poll: still going
      { ...base, running: false, currentRun: null, lastRuns: [{ ...summary, status: 'completed', aiCalls: 3, counts: { imported: 2 } }] }, // second poll: done
    ];
    const runningDetail = { ...summary, running: true, status: 'running', sources: {}, items: [], log: ['Run started'] };
    const doneDetail = {
      ...summary, status: 'completed', aiCalls: 3, counts: { imported: 2, not_accident: 1 },
      sources: { GDELT: { ok: false, skipped: true, count: 0, error: 'rate-limited' }, 'Google News: Bengaluru accident': { ok: true, count: 3 } },
      items: [{ title: 'Two killed as lorry rams bike on Hosur Road', url: 'https://news.google.com/rss/articles/A', status: 'imported', reason: 'imported #1191' }],
      log: ['Run started', 'SEARCH GDELT: rate-limited, skipped', 'DONE: 2 imported'],
    };
    let statusCalls = 0;
    let runCalls = 0;
    const fetch = vi.fn(async (url) => {
      let body;
      if (url.endsWith('/api/admin/agent/status')) body = statuses[Math.min(statusCalls++, statuses.length - 1)];
      else if (url.endsWith('/api/admin/agent/runs/run_A')) body = runCalls++ === 0 ? runningDetail : doneDetail;
      else throw new Error(`unexpected ${url}`);
      return { ok: true, status: 200, json: async () => body };
    });

    const window = { confirm: () => true };
    new Function('window', 'document', src('admin-agent.js'))(window, document);
    window.BATAgent.init({ fetch, api: 'http://api', toast: vi.fn(), onChange: vi.fn() });

    byId['agent-btn'].click();
    await vi.advanceTimersByTimeAsync(0);
    await window.BATAgent.openRun('run_A');
    const detail = () => byId['agent-run-detail-body'].textContent;
    expect(detail()).toMatch(/Running/);
    expect(runCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(5000); // poll 1: still running, no re-fetch
    expect(runCalls).toBe(1);
    expect(detail()).toMatch(/Running/);

    await vi.advanceTimersByTimeAsync(5000); // poll 2: finished, re-fetch the open run
    expect(runCalls).toBe(2);
    expect(detail()).toMatch(/Completed/);
    expect(detail()).not.toMatch(/Running/);
    expect(detail()).toMatch(/2 imported/);
    expect(detail()).toMatch(/Two killed as lorry rams bike on Hosur Road/);
    expect(detail()).toMatch(/GDELT: rate-limited, skipped/);

    await vi.advanceTimersByTimeAsync(20000); // polling stopped once the run finished
    expect(statusCalls).toBe(3);
  });
});
