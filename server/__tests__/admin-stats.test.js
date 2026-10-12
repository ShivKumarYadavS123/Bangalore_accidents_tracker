/**
 * GET /api/admin/stats: admin-only database totals for the stat cards.
 * Supabase and Postgres are fakes; nothing touches the network.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createStatsStore, registerAdminStatsRoute, STAT_KEYS } from '../admin-stats.js';

/** Same contract as index.js adminAuth = [validateJwt, requireAdmin]. */
const adminAuth = [
  (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing authentication credentials' });
    const token = auth.slice(7);
    if (token !== 'admin-token' && token !== 'user-token') return res.status(401).json({ error: 'Authentication failed' });
    req.jwtPayload = { sub: token, app_metadata: { role: token === 'admin-token' ? 'admin' : 'authenticated' } };
    next();
  },
  (req, res, next) => (req.jwtPayload?.app_metadata?.role === 'admin' ? next() : res.status(403).json({ error: 'insufficient permissions' })),
];

const ROWS = [
  { id: '1', status: 'active', severity: 'fatal' },
  { id: '2', status: 'active', severity: 'minor' },
  { id: '3', status: 'active', severity: 'serious' },
  { id: '4', status: 'pending', severity: 'fatal' },
  { id: '5', status: 'pending', severity: 'minor' },
  { id: '6', status: 'hidden', severity: 'minor' },
  { id: '7', status: 'rejected', severity: 'serious' },
];
const EXPECTED = { total: 7, active: 3, pending: 2, hidden: 1, rejected: 1, fatal: 2, serious: 2, minor: 3 };

/** Supabase stand-in that only answers count-only (head) queries, and records them. */
function countingSupabase(rows, { failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    from: (table) => ({
      select: (cols, opts) => {
        const filters = [];
        const call = { table, cols, opts, filters };
        calls.push(call);
        const run = () => {
          if (!opts?.head || opts?.count !== 'exact') return Promise.resolve({ data: rows, count: null, error: null });
          if (failOn && filters.some(([c, v]) => `${c}=${v}` === failOn)) return Promise.resolve({ data: null, count: null, error: { message: 'timeout' } });
          const count = rows.filter(r => filters.every(([c, v]) => r[c] === v)).length;
          return Promise.resolve({ data: null, count, error: null });
        };
        const builder = {
          eq: (c, v) => { filters.push([c, v]); return builder; },
          then: (ok, fail) => run().then(ok, fail),
        };
        return builder;
      },
    }),
  };
}

function appWith(statsStore) {
  const app = express();
  registerAdminStatsRoute(app, { adminAuth, statsStore });
  return app;
}

describe('GET /api/admin/stats', () => {
  it('rejects missing, invalid and non-admin tokens', async () => {
    const statsStore = { getStats: vi.fn() };
    const app = appWith(statsStore);
    expect((await request(app).get('/api/admin/stats')).status).toBe(401);
    expect((await request(app).get('/api/admin/stats').set('Authorization', 'Bearer forged')).status).toBe(401);
    const res = await request(app).get('/api/admin/stats').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
    expect(statsStore.getStats).not.toHaveBeenCalled();
  });

  it('returns the totals for admins, uncached', async () => {
    const app = appWith({ getStats: async () => EXPECTED });
    const res = await request(app).get('/api/admin/stats').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(EXPECTED);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('does not leak database errors', async () => {
    const app = appWith({ getStats: async () => { const e = new Error('stats unavailable: password authentication failed for user x'); e.status = 500; throw e; } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/admin/stats').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not load the record counts');
    expect(JSON.stringify(res.body)).not.toMatch(/password/);
  });

  it('answers 503 when no database is configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appWith(createStatsStore({ logger: { warn() {} } }));
    const res = await request(app).get('/api/admin/stats').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(503);
  });
});

describe('stats store', () => {
  it('counts with Supabase count-only queries (no rows downloaded)', async () => {
    const supabase = countingSupabase(ROWS);
    const stats = await createStatsStore({ supabase }).getStats();
    expect(stats).toEqual(EXPECTED);
    expect(Object.keys(stats)).toEqual(STAT_KEYS);
    expect(supabase.calls).toHaveLength(8);
    for (const c of supabase.calls) {
      expect(c.table).toBe('accidents');
      expect(c.opts).toEqual({ count: 'exact', head: true });
    }
  });

  it('falls back to one Postgres count query when Supabase fails', async () => {
    const supabase = countingSupabase(ROWS, { failOn: 'status=pending' });
    const q = vi.fn(async (sql) => {
      expect(sql).toMatch(/count\(\*\) FILTER \(WHERE status = 'pending'\)/);
      expect(sql).not.toMatch(/SELECT \*/);
      return [{ total: '7', active: '3', pending: '2', hidden: '1', rejected: '1', fatal: '2', serious: '2', minor: '3' }];
    });
    const stats = await createStatsStore({ supabase, q, logger: { warn() {} } }).getStats();
    expect(stats).toEqual(EXPECTED);
    expect(q).toHaveBeenCalledTimes(1);
  });

  it('throws a 500-style error when every database fails', async () => {
    const store = createStatsStore({ q: async () => { throw new Error('connection refused'); }, logger: { warn() {} } });
    await expect(store.getStats()).rejects.toMatchObject({ status: 500 });
  });
});
