/**
 * Admin records table: the Pending Reports button toggles to "All Records",
 * the Status and Severity dropdowns reload the table, and status pills have
 * plain labels. Runs the real admin-app.js against a tiny fake page.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

const src = fs.readFileSync(new URL('../admin-app.js', import.meta.url), 'utf8');

/** A forgiving DOM: any id exists, events can be fired, classList and attributes work. */
function fakePage() {
  class FakeEl {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.dataset = {}; this.style = {};
      this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this.title = ''; this.innerHTML = ''; this._text = '';
      const set = new Set();
      this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => { const want = on === undefined ? !set.has(c) : on; if (want) set.add(c); else set.delete(c); return want; } };
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
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  const els = {};
  const document = {
    getElementById: (id) => (els[id] ||= new FakeEl()),
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (t) => ({ textContent: String(t) }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  return { document, el: (id) => document.getElementById(id) };
}

describe('Pending Reports toggle and filter dropdowns', () => {
  afterEach(() => vi.useRealTimers());

  async function loadAdmin() {
    vi.useFakeTimers();
    const { document, el } = fakePage();
    el('f-status').value = 'all';
    el('f-severity').value = 'all';
    el('f-sort').value = 'date-desc';
    el('search-box').value = '';
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ total: 0, rows: [] }) }));
    const sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const window = { BAT_CONFIG: { apiBase: 'http://api' } };
    new Function('window', 'document', 'sessionStorage', 'fetch', 'requestAnimationFrame', src)(window, document, sessionStorage, fetch, (fn) => fn());
    await vi.advanceTimersByTimeAsync(1500); // boot() waits for the auth client, then shows the login screen
    const lastUrl = () => new URL(fetch.mock.calls.at(-1)[0]);
    return { el, fetch, lastUrl };
  }

  it('Pending Reports switches to pending rows and reads "All Records" (pressed); clicking again goes back', async () => {
    const { el, fetch, lastUrl } = await loadAdmin();
    const btn = el('pending-reports-tab');
    el('search-box').value = 'hebbal';

    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el('f-status').value).toBe('pending');
    expect(el('search-box').value).toBe('');
    expect(lastUrl().pathname).toBe('/api/admin/accidents');
    expect(lastUrl().searchParams.get('status')).toBe('pending');
    expect(btn.textContent).toBe('All Records');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('is-showing-pending')).toBe(true);

    const calls = fetch.mock.calls.length;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls.length).toBe(calls + 1);
    expect(el('f-status').value).toBe('all');
    expect(lastUrl().searchParams.has('status')).toBe(false);
    expect(btn.textContent).toBe('Pending Reports');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.classList.contains('is-showing-pending')).toBe(false);
  });

  it('the Status and Severity dropdowns reload the table on change, and keep the button in step', async () => {
    const { el, lastUrl } = await loadAdmin();
    el('f-status').value = 'pending';
    el('f-status').fire('change');
    await vi.advanceTimersByTimeAsync(0);
    expect(lastUrl().searchParams.get('status')).toBe('pending');
    expect(el('pending-reports-tab').textContent).toBe('All Records');

    el('f-severity').value = 'fatal';
    el('f-severity').fire('change');
    await vi.advanceTimersByTimeAsync(0);
    expect(lastUrl().searchParams.get('severity')).toBe('fatal');

    el('f-status').value = 'active';
    el('f-status').fire('change');
    await vi.advanceTimersByTimeAsync(0);
    expect(lastUrl().searchParams.get('status')).toBe('active');
    expect(el('pending-reports-tab').textContent).toBe('Pending Reports');
  });

  it('an empty result spans all 10 columns', async () => {
    const { el } = await loadAdmin();
    el('pending-reports-tab').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el('table-body').innerHTML).toBe('<tr><td colspan="10" class="t-loading">No records found.</td></tr>');
  });
});

describe('status pills', () => {
  it('use plain labels (the CSS draws the dot)', () => {
    const line = src.match(/const stLabel = [^;]+;/)[0];
    expect(line).toBe("const stLabel = r.status === 'active' ? 'Active' : r.status === 'pending' ? 'Pending' : 'Hidden';");
    expect(line).not.toMatch(/[●◌○•]/);
  });
});
