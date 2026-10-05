/**
 * Security batch 1, item 3 — the public JSON copy (Frontend/accident_data.json).
 * User reports are never written into it, and every JSON fallback shows only
 * records whose status is 'active'.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readActiveAccidents, appendPublicAccident, isPublicRecord } from '../accident-json.js';

const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const publicJson = new URL('../../Frontend/accident_data.json', import.meta.url);

let tmp, file;
const rows = [
  { id: '1', title: 'News crash', status: 'active', hasCoords: true, lat: 12.9, lng: 77.6 },
  { id: '2', title: 'User Report: Silk Board', status: 'pending', reporter_id: 'u1', description: 'private text' },
  { id: '3', title: 'Hidden by a moderator', status: 'hidden' },
  { id: '4', title: 'No status at all' },
];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bat-json-'));
  file = path.join(tmp, 'accident_data.json');
  fs.writeFileSync(file, JSON.stringify(rows));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('readActiveAccidents', () => {
  it('returns only records with status === "active"', () => {
    expect(readActiveAccidents(file).map(r => r.id)).toEqual(['1']);
  });

  it('returns [] when the file is missing', () => {
    expect(readActiveAccidents(path.join(tmp, 'missing.json'))).toEqual([]);
    expect(readActiveAccidents(null)).toEqual([]);
  });
});

describe('appendPublicAccident', () => {
  it('refuses user reports and anything that is not active', () => {
    expect(appendPublicAccident(file, { id: 'r1', status: 'pending', reporter_id: 'u1' })).toBe(false);
    expect(appendPublicAccident(file, { id: 'r2', status: 'active', reporter_id: 'u1' })).toBe(false);
    expect(appendPublicAccident(file, { id: 'r3' })).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(rows.length);
  });

  it('adds an admin-verified active record at the top', () => {
    expect(appendPublicAccident(file, { id: 'art_1', title: 'Verified article', status: 'active' })).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data[0].id).toBe('art_1');
    expect(isPublicRecord(data[0])).toBe(true);
  });
});

describe('server wiring', () => {
  const reportsRoute = indexSource.slice(indexSource.indexOf("app.post('/api/reports'"), indexSource.indexOf("app.get('/api/reports/mine'"));

  it('POST /api/reports no longer writes the report into the public JSON file', () => {
    expect(reportsRoute.length).toBeGreaterThan(100);
    expect(reportsRoute).not.toMatch(/syncNewToJson|appendPublicAccident|writeFileSync|JSON_PATH/);
  });

  it('every JSON fallback read goes through readActiveAccidents', () => {
    // Only the admin patch/delete helpers still read the raw file (to rewrite it).
    expect(indexSource.match(/JSON\.parse\(fs\.readFileSync\(JSON_PATH/g)).toHaveLength(2);
    expect(indexSource.match(/readActiveAccidents\(JSON_PATH\)/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('the admin article upload marks its JSON record active so it still syncs', () => {
    expect(indexSource).toMatch(/appendPublicAccident\(JSON_PATH, \{[^}]*status: 'active' \}\)/);
  });
});

describe('Frontend/accident_data.json', () => {
  const data = JSON.parse(fs.readFileSync(publicJson, 'utf8'));

  it('holds only public, active records (no user reports)', () => {
    expect(data.length).toBeGreaterThan(0);
    expect(data.filter(r => r.status !== 'active').map(r => r.id)).toEqual([]);
    expect(data.filter(r => r.reporter_id || r.source === 'User Report').map(r => r.id)).toEqual([]);
  });
});
