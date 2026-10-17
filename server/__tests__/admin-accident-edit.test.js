/**
 * Admin Edit: title and accident date for PATCH /api/admin/accidents/:id.
 * The helper is tested directly; the route in index.js is checked to stay
 * behind adminAuth and to call it. Supabase and Postgres are fakes.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { parseTitleDateEdit, dateRawFor, readDateRaw, titleDateEdit, istToday } from '../admin-accident-edit.js';

const TODAY = '2026-10-17';

/** Supabase stand-in for `from('accidents').select(...).eq('id', id).limit(1)`. */
function fakeSupabase(rows, { error = null } = {}) {
  const calls = [];
  return {
    calls,
    from: vi.fn((table) => ({
      select: (cols) => ({
        eq: (col, v) => ({
          limit: async (n) => {
            calls.push({ table, cols, col, v, n });
            return error ? { data: null, error } : { data: rows.filter(r => r.id === v), error: null };
          },
        }),
      }),
    })),
  };
}

/** Same contract as index.js adminAuth = [validateJwt, requireAdmin]. */
const adminAuth = [
  (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing authentication credentials' });
    const token = auth.slice(7);
    if (token !== 'admin-token' && token !== 'user-token') return res.status(401).json({ error: 'Authentication failed' });
    req.jwtPayload = { app_metadata: { role: token === 'admin-token' ? 'admin' : 'authenticated' } };
    next();
  },
  (req, res, next) => (req.jwtPayload?.app_metadata?.role === 'admin' ? next() : res.status(403).json({ error: 'insufficient permissions' })),
];

describe('title and accident date validation', () => {
  it('trims the title and collapses its whitespace', () => {
    expect(parseTitleDateEdit({ title: '  Fatal accident:\n Silk   Board junction ' }, { today: TODAY })).toEqual({ updates: { title: 'Fatal accident: Silk Board junction' } });
  });

  it('title must be text of 5 to 200 characters', () => {
    expect(parseTitleDateEdit({ title: 'Crash' }, { today: TODAY })).toEqual({ updates: { title: 'Crash' } });
    expect(parseTitleDateEdit({ title: ' Cra ' }, { today: TODAY }).error).toBe('Title must be 5 to 200 characters');
    expect(parseTitleDateEdit({ title: 'x'.repeat(201) }, { today: TODAY }).error).toBe('Title must be 5 to 200 characters');
    expect(parseTitleDateEdit({ title: 'x'.repeat(200) }, { today: TODAY }).updates.title).toHaveLength(200);
    expect(parseTitleDateEdit({ title: 12345 }, { today: TODAY }).error).toBe('Title must be text');
    expect(parseTitleDateEdit({ title: null }, { today: TODAY }).error).toBe('Title must be text');
  });

  it('accident date must be a real YYYY-MM-DD date, not in the future (IST)', () => {
    expect(parseTitleDateEdit({ accident_date: '2026-10-12' }, { today: TODAY })).toEqual({ updates: { accident_date: '2026-10-12' } });
    expect(parseTitleDateEdit({ accident_date: ' 2026-10-17 ' }, { today: TODAY }).updates.accident_date).toBe('2026-10-17');
    for (const bad of ['12-10-2026', '2026-02-30', '2026-13-01', '2026-10-1', '', 'yesterday', 20261012, null]) {
      expect(parseTitleDateEdit({ accident_date: bad }, { today: TODAY }).error, String(bad)).toBe('Accident date must be a real date written YYYY-MM-DD');
    }
    expect(parseTitleDateEdit({ accident_date: '2026-10-18' }, { today: TODAY }).error).toBe('Accident date cannot be in the future');
    expect(istToday(Date.parse('2026-10-16T19:00:00Z'))).toBe('2026-10-17'); // 00:30 IST
  });

  it('leaves the other fields alone when neither is sent', () => {
    expect(parseTitleDateEdit({ status: 'active', lat: 12.9, lng: 77.6, location: 'x', area: 'y' }, { today: TODAY })).toEqual({ updates: {} });
    expect(parseTitleDateEdit(undefined, { today: TODAY })).toEqual({ updates: {} });
  });
});

describe('date_raw follows the new date, keeping the time', () => {
  it('keeps an HH:MM time in any common spelling', () => {
    expect(dateRawFor('2026-10-11', '2026-10-12 23:30')).toBe('2026-10-11 23:30');
    expect(dateRawFor('2026-10-11', '2026-10-12T07:05:00Z')).toBe('2026-10-11 07:05');
    expect(dateRawFor('2026-10-11', '12 Oct 2026, 11:30 PM')).toBe('2026-10-11 23:30');
    expect(dateRawFor('2026-10-11', '12:15 am')).toBe('2026-10-11 00:15');
    expect(dateRawFor('2026-10-11', '2026-10-12 9:05')).toBe('2026-10-11 09:05');
  });

  it('is just the date when there was no time', () => {
    expect(dateRawFor('2026-10-11', '2026-10-12')).toBe('2026-10-11');
    expect(dateRawFor('2026-10-11', 'Unknown')).toBe('2026-10-11');
    expect(dateRawFor('2026-10-11', null)).toBe('2026-10-11');
    expect(dateRawFor('2026-10-11', '2026-10-12 25:61')).toBe('2026-10-11');
  });
});

describe('titleDateEdit (what the PATCH route merges into its updates)', () => {
  it('reads the old date_raw and keeps its time', async () => {
    const supabase = fakeSupabase([{ id: '1228', date_raw: '2026-10-12 23:30' }]);
    const r = await titleDateEdit({ title: 'Fatal accident: Silk Board junction', accident_date: '2026-10-11' }, { id: '1228', supabase, today: TODAY });
    expect(r).toEqual({ updates: { title: 'Fatal accident: Silk Board junction', accident_date: '2026-10-11', date_raw: '2026-10-11 23:30' } });
    expect(supabase.calls[0]).toMatchObject({ table: 'accidents', col: 'id', v: '1228', n: 1 });
  });

  it('only a title: no database read', async () => {
    const supabase = fakeSupabase([]);
    expect(await titleDateEdit({ title: 'Minor accident: Hebbal flyover' }, { id: '1', supabase, today: TODAY })).toEqual({ updates: { title: 'Minor accident: Hebbal flyover' } });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('invalid input is a 400 and nothing is read', async () => {
    const supabase = fakeSupabase([{ id: '1', date_raw: null }]);
    expect(await titleDateEdit({ accident_date: '2099-01-01' }, { id: '1', supabase, today: TODAY })).toEqual({ status: 400, error: 'Accident date cannot be in the future' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('falls back to Postgres, says 404 for an unknown record and 500 when nothing can be read', async () => {
    const broken = fakeSupabase([], { error: { message: 'timeout' } });
    const q = vi.fn(async () => [{ id: '7', date_raw: '2026-10-01 08:10' }]);
    expect(await titleDateEdit({ accident_date: '2026-10-02' }, { id: '7', supabase: broken, q, today: TODAY })).toEqual({ updates: { accident_date: '2026-10-02', date_raw: '2026-10-02 08:10' } });
    expect(q.mock.calls[0]).toEqual(['SELECT id, date_raw FROM accidents WHERE id = $1 LIMIT 1', ['7']]);

    expect(await titleDateEdit({ accident_date: '2026-10-02' }, { id: 'nope', supabase: fakeSupabase([]), today: TODAY })).toEqual({ status: 404, error: 'Accident not found' });

    const logger = { warn: vi.fn() };
    const down = await titleDateEdit({ accident_date: '2026-10-02' }, { id: '7', supabase: broken, q: async () => { throw new Error('connection refused'); }, today: TODAY, logger });
    expect(down).toEqual({ status: 500, error: 'Could not read the record to keep its time; nothing saved' });
    await expect(readDateRaw('7', {})).rejects.toThrow(/no database configured/);
  });
});

describe('PATCH /api/admin/accidents/:id', () => {
  const route = () => {
    const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    return { src, patch: src.slice(src.indexOf("app.patch('/api/admin/accidents/:id'"), src.indexOf("app.delete('/api/admin/accidents/:id'")) };
  };

  it('in index.js, stays behind adminAuth and merges the helper\'s result before saving', () => {
    const { src, patch } = route();
    expect(src).toMatch(/const adminAuth = \[validateJwt, requireAdmin\];/);
    expect(patch.startsWith("app.patch('/api/admin/accidents/:id', adminAuth, async (req, res) => {")).toBe(true);
    expect(patch).toMatch(/const edit = await titleDateEdit\(req\.body, \{ id, supabase, q: pool \? q : null \}\);\s+if \(edit\.error\) return res\.status\(edit\.status\)\.json\(\{ error: edit\.error \}\);\s+Object\.assign\(updates, edit\.updates\);\s+if \(!Object\.keys\(updates\)\.length\)/);
    // status / lat / lng / location / area handling is untouched.
    expect(patch).toMatch(/if \(!\['active', 'hidden'\]\.includes\(status\)\) return res\.status\(400\)\.json\(\{ error: 'Invalid status' \}\);/);
    expect(patch).toMatch(/if \(location !== undefined\) updates\.location = location;/);
  });

  // The same wiring as index.js, with the same adminAuth contract.
  function appWith(deps) {
    const app = express();
    app.use(express.json());
    app.patch('/api/admin/accidents/:id', adminAuth, async (req, res) => {
      const edit = await titleDateEdit(req.body, { id: req.params.id, today: TODAY, ...deps });
      if (edit.error) return res.status(edit.status).json({ error: edit.error });
      res.json({ ok: true, updates: edit.updates });
    });
    return app;
  }

  it('rejects missing, invalid and non-admin tokens before reading anything', async () => {
    const supabase = fakeSupabase([{ id: '1', date_raw: '2026-10-12 23:30' }]);
    const app = appWith({ supabase });
    const body = { title: 'Fatal accident: Silk Board junction', accident_date: '2026-10-11' };
    expect((await request(app).patch('/api/admin/accidents/1').send(body)).status).toBe(401);
    expect((await request(app).patch('/api/admin/accidents/1').set('Authorization', 'Bearer forged').send(body)).status).toBe(401);
    const user = await request(app).patch('/api/admin/accidents/1').set('Authorization', 'Bearer user-token').send(body);
    expect(user.status).toBe(403);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('admins get validation errors as 400 and good edits through', async () => {
    const app = appWith({ supabase: fakeSupabase([{ id: '1', date_raw: '2026-10-12 23:30' }]) });
    const bad = await request(app).patch('/api/admin/accidents/1').set('Authorization', 'Bearer admin-token').send({ title: 'abc' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Title must be 5 to 200 characters');
    const ok = await request(app).patch('/api/admin/accidents/1').set('Authorization', 'Bearer admin-token').send({ title: ' Fatal accident: Silk Board ', accident_date: '2026-10-11' });
    expect(ok.status).toBe(200);
    expect(ok.body.updates).toEqual({ title: 'Fatal accident: Silk Board', accident_date: '2026-10-11', date_raw: '2026-10-11 23:30' });
  });
});
