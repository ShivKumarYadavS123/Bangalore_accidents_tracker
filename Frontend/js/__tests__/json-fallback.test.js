/**
 * Security batch 1, item 3 — the browser's accident_data.json fallbacks show
 * only records whose status is 'active' (the file is public).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

describe('JSON fallback in the browser', () => {
  it('dashboard map keeps only active records', () => {
    const fn = src('dashboard-app.js').match(/async function loadJsonFallback\(\) \{[\s\S]*?\n {2}\}/)[0];
    expect(fn).toMatch(/\.filter\(r => r && r\.status === 'active'\)/);
  });

  it('trends charts keep only active records', () => {
    const block = src('trends-app.js').match(/fetch\('accident_data\.json'[\s\S]*?\}\s*catch/)[0];
    expect(block).toMatch(/\.filter\(r => r && r\.status === 'active'\)/);
  });

  it('every record in the public file is active', () => {
    const data = JSON.parse(fs.readFileSync(new URL('../../accident_data.json', import.meta.url), 'utf8'));
    expect(data.length).toBeGreaterThan(0);
    expect(data.every(r => r.status === 'active')).toBe(true);
  });
});
