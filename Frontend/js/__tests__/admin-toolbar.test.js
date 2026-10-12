/**
 * Admin toolbar layout and stat cards (structure only; no behaviour change).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const html = fs.readFileSync(new URL('../../admin.html', import.meta.url), 'utf8');

/** ids of the elements with an id inside the first element that has `cls` in its class list. */
function idsIn(cls) {
  const start = html.search(new RegExp(`class="[^"]*\\b${cls}\\b`));
  expect(start, cls).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<div', start);
  let depth = 0;
  let i = open;
  const re = /<\/?div\b/g;
  re.lastIndex = open;
  for (let m; (m = re.exec(html));) {
    depth += m[0] === '<div' ? 1 : -1;
    if (depth === 0) { i = m.index; break; }
  }
  return [...html.slice(open, i).matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
}

describe('admin toolbar', () => {
  it('row 1 holds the filters, in order', () => {
    expect(idsIn('toolbar-filters')).toEqual(['search-box', 'f-status', 'f-severity', 'f-sort', 'apply-btn', 'record-count']);
  });

  it('row 2: records and tools on the left, selected-record actions on the right', () => {
    expect(idsIn('tb-group--tools')).toEqual(['pending-reports-tab', 'upload-btn', 'agent-btn', 'x-import-btn', 'image-lab-btn', 'map-view-toggle']);
    expect(idsIn('tb-group--bulk')).toEqual(['approve-selected', 'reject-selected', 'delete-selected']);
  });

  it('buttons keep their own colours: orange, green, indigo, dark, primary, outlined, red', () => {
    const cls = (id) => (html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0].match(/class="([^"]+)"/) || [])[1] || '';
    const expected = {
      'pending-reports-tab': 'tb-btn--pending',
      'upload-btn': 'tb-btn--add',
      'agent-btn': 'tb-btn--agent',
      'x-import-btn': 'tb-btn--x',
      'apply-btn': 'tb-btn--primary',
      'approve-selected': 'tb-btn--primary',
      'reject-selected': 'tb-btn--primary',
      'image-lab-btn': 'tb-btn--outline',
      'map-view-toggle': 'tb-btn--outline',
      'delete-selected': 'tb-btn--danger',
    };
    for (const [id, modifier] of Object.entries(expected)) {
      expect(cls(id), id).toMatch(new RegExp(`\\btb-btn\\b`));
      expect(cls(id), id).toMatch(new RegExp(`\\b${modifier}\\b`));
    }
    const css = fs.readFileSync(new URL('../../css/admin.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.tb-btn--pending \{ background: var\(--color-serious\)/);
    expect(css).toMatch(/\.tb-btn--add \{ background: var\(--color-minor\)/);
    expect(css).toMatch(/\.tb-btn--agent \{ background: #4f46e5/);
    expect(css).toMatch(/\.tb-btn--agent:hover \{ background: #4338ca/);
    expect(css).toMatch(/\.tb-btn--x \{ background: #0f172a/);
    expect(css).toMatch(/\.tb-btn--x:hover \{ background: #1e293b/);
    expect(css).toMatch(/\.tb-btn--pending\.is-showing-pending \{ background: var\(--color-primary\)/);
    expect(css).toMatch(/\.tb-btn:focus-visible \{ outline:/);
  });

  it('the table header sticks to the top of its own scroll box', () => {
    const css = fs.readFileSync(new URL('../../css/admin.css', import.meta.url), 'utf8');
    const th = css.match(/\.data-table th \{[^}]*\}/)[0];
    expect(th).toMatch(/position: sticky;/);
    expect(th).toMatch(/top: 0;/);
    expect(css).not.toMatch(/top: 64px/);
    expect(html).not.toMatch(/colspan="9"/);
  });

  it('has no emoji on toolbar buttons and no inline styles anywhere', () => {
    const toolbar = html.slice(html.indexOf('<div class="toolbar">'), html.indexOf('<!-- Map View'));
    const labels = [...toolbar.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1]);
    expect(labels).toHaveLength(10);
    for (const l of labels) expect(l, l).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('the map toggle label in admin-app.js has no emoji either', () => {
    const src = fs.readFileSync(new URL('../admin-app.js', import.meta.url), 'utf8');
    const toggle = src.match(/function toggleMapView\(\) \{[\s\S]*?\n {2}\}/)[0];
    const label = toggle.match(/btn\.textContent = [^;]+;/)[0];
    expect(label).toBe("btn.textContent = mapViewActive ? 'Table View' : 'Map View';");
    expect(toggle).toMatch(/btn\.classList\.toggle\('is-active', mapViewActive\)/);
    expect(toggle).not.toMatch(/btn\.style\./);
  });
});

describe('admin stat cards', () => {
  it('include a Pending card next to the others', () => {
    for (const id of ['s-total', 's-active', 's-pending', 's-hidden', 's-fatal', 's-serious', 's-minor']) {
      expect(html, id).toMatch(new RegExp(`id="${id}"`));
    }
  });

  it('are filled from the database totals endpoint, not from the rows on the page', () => {
    const src = fs.readFileSync(new URL('../admin-app.js', import.meta.url), 'utf8');
    expect(src).toMatch(/\/api\/admin\/stats/);
    expect(src).not.toMatch(/function updateStats/);
  });
});
