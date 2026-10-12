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

  it('buttons use one style set: filled, outlined, or red for delete', () => {
    const cls = (id) => (html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0].match(/class="([^"]+)"/) || [])[1] || '';
    for (const id of ['apply-btn', 'pending-reports-tab', 'upload-btn', 'agent-btn', 'x-import-btn']) expect(cls(id), id).toMatch(/\btb-btn--primary\b/);
    for (const id of ['image-lab-btn', 'map-view-toggle', 'approve-selected', 'reject-selected']) expect(cls(id), id).toMatch(/\btb-btn--outline\b/);
    expect(cls('delete-selected')).toMatch(/\btb-btn--danger\b/);
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
