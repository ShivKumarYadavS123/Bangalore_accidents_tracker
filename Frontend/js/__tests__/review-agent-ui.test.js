/**
 * BAT Review Agent in the admin UI: the "Agent-approved" badge and Undo, the
 * mode switch (asks before Auto), the Review modal's verdict and "Apply
 * suggestions" (the Edit PATCH), and the Edit save refreshing its table row
 * (the closeEdit() fix). Runs the real shipped files against tiny fake pages.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

/** Just enough DOM for admin-agent.js: elements, text, children, attributes, click listeners. */
function fakeDom() {
  class FakeEl {
    constructor(tag = 'div') { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this.className = ''; this._text = ''; this.innerHTML = ''; this.classList = { toggle() {}, add() {}, remove() {} }; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    appendChild(c) { this.children.push(c); return c; }
    replaceChildren(...kids) { this._text = ''; this.children = kids; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { (this.listeners.click || []).forEach(fn => fn({ target: this, currentTarget: {} })); }
    focus() {}
    find(pred) { if (pred(this)) return this; for (const c of this.children) { const f = c.find?.(pred); if (f) return f; } return null; }
  }
  const byId = {};
  const document = {
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (t) => ({ textContent: String(t) }),
    getElementById: (id) => (byId[id] ||= new FakeEl()),
    addEventListener() {},
  };
  return { document, byId };
}

function loadAgent({ fetch, confirm = () => true } = {}) {
  const { document, byId } = fakeDom();
  const window = { confirm: vi.fn(confirm) };
  new Function('window', 'document', src('admin-agent.js'))(window, document);
  const toast = vi.fn();
  const onChange = vi.fn();
  window.BATAgent.init({ fetch, api: 'http://api', toast, onChange });
  return { agent: window.BATAgent, window, byId, document, toast, onChange };
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const STATUS = { mode: 'shadow', modeSetBy: 'env', aiCallsToday: 2, dailyAiBudget: 10, agreement: { agree: 3, disagree: 1, scored: 4 }, lastRunAt: null, lastRuns: [], latest: [] };

describe('Agent-approved badge and Undo', () => {
  const { agent } = loadAgent({ fetch: vi.fn() });
  const approved = { id: '1201', status: 'active', description: 'A biker died. (Found by BAT News Agent) (Approved by BAT Review Agent)' };

  it('only on active rows the Review Agent approved', () => {
    expect(agent.reviewBadgeHtml(approved)).toMatch(/>Agent-approved</);
    expect(agent.reviewUndoHtml(approved)).toMatch(/data-action="review-undo" data-id="1201"/);
    for (const row of [{ ...approved, status: 'pending' }, { ...approved, status: 'hidden' }, { id: '5', status: 'active', description: 'x (Found by BAT News Agent)' }, null]) {
      expect(agent.reviewBadgeHtml(row)).toBe('');
      expect(agent.reviewUndoHtml(row)).toBe('');
    }
  });

  it('escapes the id in the Undo button', () => {
    expect(agent.reviewUndoHtml({ ...approved, id: '1"><img src=x>' })).not.toMatch(/<img/);
  });

  it('Undo asks first; yes posts to the undo endpoint and refreshes the table', async () => {
    const fetch = vi.fn(async () => okJson({ ok: true, id: '1201', status: 'pending', restored: ['1202'] }));
    const no = loadAgent({ fetch, confirm: () => false });
    expect(await no.agent.undoReview('1201')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    const yes = loadAgent({ fetch });
    expect(await yes.agent.undoReview('1201')).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://api/api/admin/agent/review/undo/1201', expect.objectContaining({ method: 'POST' }));
    expect(yes.onChange).toHaveBeenCalled();
    expect(yes.toast.mock.calls[0][0]).toBe('#1201 is Pending again (and 1 merged report)');
  });
});

describe('Review Agent mode switch', () => {
  it('asks for confirmation before Auto; declining changes nothing', async () => {
    const fetch = vi.fn(async (url, opts = {}) => okJson(opts.method === 'POST' ? { ...STATUS, mode: JSON.parse(opts.body).mode, modeSetBy: 'admin' } : STATUS));
    const { agent, window, byId } = loadAgent({ fetch, confirm: () => false });
    await agent.refreshReview();
    expect(byId['review-mode-shadow'].getAttribute('aria-pressed')).toBe('true');
    expect(byId['review-agent-status'].textContent).toMatch(/agreed with admins on 3 of 4/);
    expect(byId['review-agent-status'].textContent).toMatch(/2 of 10/);

    expect(await agent.setReviewMode('auto')).toBe(false);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0);

    window.confirm.mockReturnValue(true);
    expect(await agent.setReviewMode('auto')).toBe(true);
    const [url, opts] = fetch.mock.calls.find(([, o]) => o?.method === 'POST');
    expect(url).toBe('http://api/api/admin/agent/review/mode');
    expect(JSON.parse(opts.body)).toEqual({ mode: 'auto', confirm: true });
    expect(byId['review-mode-auto'].getAttribute('aria-pressed')).toBe('true');
  });

  it('Shadow and Off switch without asking; the buttons are wired', async () => {
    const fetch = vi.fn(async (url, opts = {}) => okJson(opts.method === 'POST' ? { ...STATUS, mode: JSON.parse(opts.body).mode } : { ...STATUS, mode: 'auto' }));
    const { agent, window, byId } = loadAgent({ fetch });
    await agent.refreshReview();
    byId['review-mode-off'].click();
    await vi.waitFor(() => expect(fetch.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(true));
    expect(JSON.parse(fetch.mock.calls.find(([, o]) => o?.method === 'POST')[1].body)).toEqual({ mode: 'off' });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('lists the latest decisions with their reasons, as text', async () => {
    const latest = [
      { id: 'a', kind: 'decision', rowId: '1202', title: '<b>Fatal accident: Silk Board</b>', decision: 'auto_approve', reason: 'corroborated by #1201', mode: 'shadow', at: '2026-10-17T10:00:00Z' },
      { id: 'b', kind: 'decision', rowId: '1300', title: 'No place', decision: 'needs_human', reason: 'no map pin inside Bengaluru', mode: 'shadow', at: '2026-10-17T10:00:00Z' },
    ];
    const { agent, byId } = loadAgent({ fetch: vi.fn(async () => okJson({ ...STATUS, latest })) });
    await agent.refreshReview();
    const text = byId['review-decisions'].textContent;
    expect(text).toMatch(/Auto-approve#1202 <b>Fatal accident: Silk Board<\/b>corroborated by #1201 · shadow mode: nothing changed/);
    expect(text).toMatch(/Needs a person#1300 No placeno map pin inside Bengaluru/);
  });
});

describe('Review modal: the Review Agent verdict and fix suggestion', () => {
  const ROW = { id: '1300', title: 'Fatal accident: Bengaluru (exact place not in the article)', date: '2026-10-16', description: 'x (Found by BAT News Agent)', status: 'pending' };
  const INFO = {
    id: '1300', mode: 'shadow',
    decision: { decision: 'needs_human', step: 'real_data', reason: 'no map pin inside Bengaluru' },
    checks: [{ check: 'real_data', ok: false, reason: 'no map pin inside Bengaluru' }],
    ai: null,
    suggestion: { title: 'Fatal accident: Silk Board junction', location: 'Silk Board junction', area: 'Madiwala', accident_date: '2026-10-16', lat: 12.9177, lng: 77.6233 },
  };

  it('shows the verdict, the checks and the suggestion; Apply sends the Edit PATCH', async () => {
    const fetch = vi.fn(async (url, opts = {}) => okJson(opts.method === 'PATCH' ? { ok: true } : INFO));
    const { agent, document, toast } = loadAgent({ fetch });
    const box = document.getElementById('review-agent-verdict');
    const onApplied = vi.fn();
    await agent.renderReviewVerdict(box, ROW, { onApplied });
    expect(fetch).toHaveBeenCalledWith('http://api/api/admin/agent/review/rows/1300', undefined);
    expect(box.textContent).toMatch(/Needs a personno map pin inside Bengaluru/);
    expect(box.textContent).toMatch(/✕ Real data: no map pin inside Bengaluru/);
    expect(box.textContent).toMatch(/Silk Board junction/);
    expect(box.textContent).toMatch(/12\.91770, 77\.62330/);

    const apply = box.find(n => n.textContent === 'Apply suggestions' && n.tagName === 'BUTTON');
    apply.click();
    await vi.waitFor(() => expect(onApplied).toHaveBeenCalled());
    const [url, opts] = fetch.mock.calls.find(([, o]) => o?.method === 'PATCH');
    expect(url).toBe('http://api/api/admin/accidents/1300');
    // Same fields as the Edit modal; the date is unchanged so it isn't sent.
    expect(JSON.parse(opts.body)).toEqual({ lat: 12.9177, lng: 77.6233, location: 'Silk Board junction', area: 'Madiwala', title: 'Fatal accident: Silk Board junction' });
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Suggestion applied/), 'success', 5000);
  });

  it('nothing for rows that are not News Agent finds; "not reviewed yet" when there is no verdict', async () => {
    const fetch = vi.fn(async () => okJson({ id: '5', mode: 'shadow', decision: null, checks: [], suggestion: null }));
    const { agent, document } = loadAgent({ fetch });
    const box = document.getElementById('review-agent-verdict');
    await agent.renderReviewVerdict(box, { id: '9', reporter_id: 'u1', description: 'I saw it' });
    expect(fetch).not.toHaveBeenCalled();
    expect(box.children).toEqual([]);
    await agent.renderReviewVerdict(box, { id: '5', description: '(Found by BAT News Agent)' });
    expect(box.textContent).toMatch(/Not reviewed yet/);
  });
});

// ── admin-app.js: Edit save refreshes the row (editingId kept before closeEdit) ──

/** A forgiving page: any id exists; the table row for one record can be looked up. */
function fakeAdminPage() {
  class FakeEl {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.dataset = {}; this.style = {};
      this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this.title = ''; this.innerHTML = ''; this._text = ''; this.max = '';
      const set = new Set();
      this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => { const want = on === undefined ? !set.has(c) : on; if (want) set.add(c); else set.delete(c); return want; } };
      this.queries = {};
    }
    get textContent() { return this._text + this.children.map(c => c.textContent || '').join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type, extra = {}) { (this.listeners[type] || []).forEach(fn => fn({ type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra })); }
    click() { this.fire('click'); }
    appendChild(c) { this.children.push(c); return c; }
    remove() {}
    focus() {}
    scrollIntoView() {}
    querySelector(sel) { return this.queries[sel] || null; }
    querySelectorAll(sel) { return this.queries[sel] ? [].concat(this.queries[sel]) : []; }
  }
  const els = {};
  const rows = {};
  const document = {
    getElementById: (id) => (els[id] ||= new FakeEl()),
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (t) => ({ textContent: String(t) }),
    querySelector: (sel) => { const m = sel.match(/^tr\[data-id="(.*)"\]$/); return m ? rows[m[1]] || null : null; },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  return { document, el: (id) => document.getElementById(id), FakeEl, rows };
}

describe('Edit modal save (pin) refreshes the table row', () => {
  afterEach(() => vi.useRealTimers());

  it('the row shows the new coordinates and location after saving', async () => {
    vi.useFakeTimers();
    const { document, el, FakeEl, rows } = fakeAdminPage();
    el('f-status').value = 'all';
    el('f-severity').value = 'all';
    el('f-sort').value = 'date-desc';
    el('search-box').value = '';
    const record = { id: '5', title: 'Fatal accident: Silk Board junction', date: '2026-10-16', link: 'https://a.com/x', lat: 12.9, lng: 77.6, location: 'Old place', area: 'Old area', severity: 'fatal', status: 'pending', description: '' };

    // The rendered table row and its Edit button, as the real page would have them.
    const editBtn = new FakeEl('button');
    editBtn.dataset.row = JSON.stringify({ id: '5', title: record.title, date: record.date, link: record.link, lat: 12.9, lng: 77.6, location: 'Old place', area: 'Old area' });
    el('table-body').queries['[data-action="edit"]'] = editBtn;
    const tr = new FakeEl('tr');
    const coordCell = new FakeEl('td');
    const locCell = new FakeEl('td');
    tr.queries = { '.cell-coords': coordCell, '.cell-loc': locCell, '[data-action="edit"]': editBtn };
    rows['5'] = tr;

    const fetch = vi.fn(async (url, opts = {}) => {
      if (opts.method === 'PATCH') return okJson({ ok: true });
      if (String(url).includes('/duplicates')) return okJson([]);
      return okJson({ total: 1, rows: [record] });
    });
    const map = { addControl() {}, on() {}, setCenter() {}, resize() {} };
    const marker = { setLngLat() { return marker; }, addTo() { return marker; }, on() {}, getLngLat: () => ({ lat: 12.9, lng: 77.6 }) };
    const maplibregl = { Map: function () { return map; }, Marker: function () { return marker; }, NavigationControl: function () {} };
    const window = { BAT_CONFIG: { apiBase: 'http://api' } };
    const sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    new Function('window', 'document', 'sessionStorage', 'fetch', 'requestAnimationFrame', 'maplibregl', src('admin-app.js'))(window, document, sessionStorage, fetch, (fn) => fn(), maplibregl);
    await vi.advanceTimersByTimeAsync(1500);

    el('pending-reports-tab').click(); // loads and renders the table
    await vi.advanceTimersByTimeAsync(0);
    editBtn.click(); // opens the Edit modal for record 5
    await vi.advanceTimersByTimeAsync(300);
    expect(el('edit-modal').hidden).toBe(false);

    el('edit-lat').value = '12.95';
    el('edit-lng').value = '77.61';
    el('edit-location').value = 'Hosur Road near Silk Board junction';
    el('edit-area').value = 'Madiwala';
    el('modal-save').click();
    await vi.advanceTimersByTimeAsync(0);

    const patch = fetch.mock.calls.find(([, o]) => o?.method === 'PATCH');
    expect(patch[0]).toBe('http://api/api/admin/accidents/5');
    expect(el('edit-modal').hidden).toBe(true);
    expect(coordCell.innerHTML).toBe('<span>12.9500, 77.6100</span>');
    expect(locCell.textContent).toBe('Hosur Road near Silk Board junction');
    expect(JSON.parse(editBtn.dataset.row)).toMatchObject({ lat: 12.95, lng: 77.61, location: 'Hosur Road near Silk Board junction', area: 'Madiwala' });
  });
});
