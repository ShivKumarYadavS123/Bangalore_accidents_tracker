/**
 * Admin News Agent + X import endpoints: admin-only, input validation, 202 /
 * 409 run handling, and the batch import over HTTP. All services are fakes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerAgentRoutes, createNewsFeatures } from '../agent/index.mjs';
import { createXImporter, postDateFromId } from '../agent/x-import.mjs';
import { createImportPipeline } from '../agent/pipeline.mjs';
import { resetBudget, clearLlmCache } from '../ai/llm.mjs';
import { extraction, notAccident, makeAi, makeStore, fetched, oembedReply, postIdAt, silentLogger, tmpDir } from './fixtures/agent-fixtures.js';

beforeEach(() => { process.env.OPENROUTER_API_KEY = 'test-key'; resetBudget(); clearLlmCache(); });
afterEach(() => { delete process.env.OPENROUTER_API_KEY; vi.restoreAllMocks(); });

/** Same contract as index.js adminAuth = [validateJwt, requireAdmin]. */
const adminAuth = [
  (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing authentication credentials' });
    const token = auth.slice(7);
    if (token !== 'admin-token' && token !== 'user-token') return res.status(401).json({ error: 'Authentication failed' });
    req.jwtPayload = { sub: token, role: 'authenticated', app_metadata: { role: token === 'admin-token' ? 'admin' : 'authenticated' } };
    next();
  },
  (req, res, next) => (req.jwtPayload?.app_metadata?.role === 'admin' ? next() : res.status(403).json({ error: 'insufficient permissions' })),
];

function fakeAgent(over = {}) {
  let running = false;
  return {
    status: vi.fn(() => ({ enabled: true, running, aiCallsToday: 3, dailyAiBudget: 20, lastRuns: [] })),
    getRun: vi.fn((id) => (id === 'run_20261011T093000_ab12' ? { id, items: [{ title: 'x', status: 'imported' }] } : null)),
    runAgent: vi.fn(({ backfillDays } = {}) => {
      if (running) return { started: false, reason: 'running', message: 'A run is already in progress', runId: 'run_1' };
      running = true;
      return { started: true, runId: `run_${backfillDays || 0}`, done: Promise.resolve() };
    }),
    ...over,
  };
}

function makeApp({ agent = fakeAgent(), xImporter = { importLinks: vi.fn(async (urls) => urls.map(input => ({ input, status: 'invalid_link' }))) } } = {}) {
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, { adminAuth, agent, xImporter });
  return { app, agent, xImporter };
}

const ENDPOINTS = [
  ['get', '/api/admin/agent/status'],
  ['get', '/api/admin/agent/runs/run_20261011T093000_ab12'],
  ['post', '/api/admin/agent/run'],
  ['post', '/api/admin/x-import'],
];

describe('admin-only access', () => {
  it.each(ENDPOINTS)('%s %s rejects missing, invalid and non-admin tokens', async (method, url) => {
    const { app, agent, xImporter } = makeApp();
    const body = { urls: ['https://x.com/a/status/1'], backfillDays: 2 };
    expect((await request(app)[method](url).send(body)).status).toBe(401);
    expect((await request(app)[method](url).set('Authorization', 'Bearer forged.jwt.token').send(body)).status).toBe(401);
    const res = await request(app)[method](url).set('Authorization', 'Bearer user-token').send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient permissions');
    expect(agent.status).not.toHaveBeenCalled();
    expect(agent.getRun).not.toHaveBeenCalled();
    expect(agent.runAgent).not.toHaveBeenCalled();
    expect(xImporter.importLinks).not.toHaveBeenCalled();
  });
});

describe('agent endpoints', () => {
  const admin = (r) => r.set('Authorization', 'Bearer admin-token');

  it('GET status returns the agent status', async () => {
    const { app } = makeApp();
    const res = await admin(request(app).get('/api/admin/agent/status'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, aiCallsToday: 3, dailyAiBudget: 20 });
  });

  it('GET runs/:id returns a run, 404 when unknown, 400 for a bad id', async () => {
    const { app } = makeApp();
    expect((await admin(request(app).get('/api/admin/agent/runs/run_20261011T093000_ab12'))).body.items).toHaveLength(1);
    expect((await admin(request(app).get('/api/admin/agent/runs/run_nope'))).status).toBe(404);
    expect((await admin(request(app).get('/api/admin/agent/runs/..%2F..%2Fetc'))).status).toBe(400);
  });

  it('POST run starts a run (202) and refuses a second one (409)', async () => {
    const { app, agent } = makeApp();
    const first = await admin(request(app).post('/api/admin/agent/run').send({}));
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ started: true, runId: 'run_0' });
    const second = await admin(request(app).post('/api/admin/agent/run').send({}));
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ reason: 'running', error: 'A run is already in progress' });
    expect(agent.runAgent).toHaveBeenCalledTimes(2);
  });

  it('POST run validates backfillDays (1 to 30)', async () => {
    for (const bad of [0, 31, -1, 2.5, 'abc', true]) {
      const { app, agent } = makeApp();
      const res = await admin(request(app).post('/api/admin/agent/run').send({ backfillDays: bad }));
      expect(res.status, String(bad)).toBe(400);
      expect(agent.runAgent).not.toHaveBeenCalled();
    }
    const { app, agent } = makeApp();
    expect((await admin(request(app).post('/api/admin/agent/run').send({ backfillDays: 30 }))).status).toBe(202);
    expect(agent.runAgent).toHaveBeenCalledWith({ backfillDays: 30 });
  });

  it('POST run explains when the agent is off', async () => {
    const { app } = makeApp({ agent: fakeAgent({ runAgent: vi.fn(() => ({ started: false, reason: 'disabled', message: 'News Agent is turned off (AGENT_ENABLED=false)' })) }) });
    const res = await admin(request(app).post('/api/admin/agent/run').send({}));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/AGENT_ENABLED=false/);
  });

  it('POST x-import validates the list', async () => {
    const { app, xImporter } = makeApp();
    for (const body of [{}, { urls: 'https://x.com/a/status/1' }, { urls: [] }, { urls: [1, 2] }, { urls: Array(21).fill('https://x.com/a/status/1') }]) {
      expect((await admin(request(app).post('/api/admin/x-import').send(body))).status).toBe(400);
    }
    expect(xImporter.importLinks).not.toHaveBeenCalled();
    expect((await admin(request(app).post('/api/admin/x-import').send({ urls: Array(20).fill('https://x.com/a/status/1') }))).status).toBe(200);
  });
});

describe('POST /api/admin/x-import (real importer, mocked X / AI / database)', () => {
  it('returns mixed statuses, one per link', async () => {
    const realId = '2108526123160424481';
    const NOW = postDateFromId(realId).ms + 3600 * 1000;
    const jamId = postIdAt(NOW - 10 * 60 * 1000);
    const store = makeStore({ rows: [{ id: '650', link: `https://x.com/blrcitytraffic/status/${postIdAt(NOW - 20 * 60 * 1000)}` }] });
    const fetchUrl = vi.fn(async (url) => {
      const post = new URL(url).searchParams.get('url').split('/').pop();
      if (post === realId) return fetched(oembedReply({ text: 'Accident at Silk Board junction: two-wheeler hit by a lorry, rider critical.' }), { url, contentType: 'application/json' });
      if (post === jamId) return fetched(oembedReply({ text: 'Slow-moving traffic on Hosur Road near Bommanahalli due to waterlogging.' }), { url, contentType: 'application/json' });
      return fetched('', { status: 404, url, bodySkipped: true });
    });
    const aiFetch = makeAi({ extract: (u) => (u.includes('near Bommanahalli') ? notAccident() : extraction({ location: 'Silk Board junction', severity: 'serious', date: null, time: null })) });
    const pipeline = createImportPipeline({ store, geocode: async () => ({ lat: 12.9177, lng: 77.6233 }), inferZone: () => 'South', sleep: async () => {}, now: () => NOW, logger: silentLogger });
    const xImporter = createXImporter({ pipeline, store, fetchUrl, aiFetch, budgetStatus: () => ({ limit: 45, used: 0, remaining: 45 }), env: {}, logger: silentLogger, sleep: async () => {}, now: () => NOW });
    const { app } = makeApp({ xImporter });

    const res = await request(app).post('/api/admin/x-import').set('Authorization', 'Bearer admin-token').send({
      urls: [
        `https://x.com/blrcitytraffic/status/${realId}`,
        `https://x.com/blrcitytraffic/status/${jamId}`,
        `https://x.com/blrcitytraffic/status/${postIdAt(NOW - 20 * 60 * 1000)}`,
        'https://www.youtube.com/watch?v=abc',
        `https://x.com/blrcitytraffic/status/${realId}`,
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.status)).toEqual(['imported', 'not_accident', 'duplicate', 'invalid_link', 'duplicate']);
    expect(res.body.results[0]).toMatchObject({ id: '1191', reason: 'imported #1191' });
    expect(res.body.results[2].reason).toBe('duplicate of #650');
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]).toMatchObject({ status: 'pending', source: 'Bengaluru Traffic Police (X)', title: 'Traffic Police: Silk Board junction' });
  });
});

describe('map tagging for News Agent rows', () => {
  it('marks approved agent rows with foundBy: "agent" and caches the lookup', async () => {
    const q = vi.fn(async (sql) => (/description LIKE/.test(sql) ? [{ id: '5' }] : []));
    const news = createNewsFeatures({ q, nextAccidentId: async () => '1', dataDir: tmpDir(), env: { AGENT_ENABLED: 'false' }, logger: silentLogger });
    const fc = { type: 'FeatureCollection', features: [{ properties: { id: '5' } }, { properties: { id: 6 } }] };
    await news.tagAgentRows(fc);
    expect(fc.features[0].properties.foundBy).toBe('agent');
    expect(fc.features[1].properties.foundBy).toBeUndefined();
    await news.tagAgentRows({ features: [{ properties: { id: '5' } }] });
    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0][1]).toEqual(['%(Found by BAT News Agent)%']);
  });

  // Rows for the tagging lookup: only id 5 is an approved row the agent found.
  const MARKER = 'A biker died near Silk Board. (Found by BAT News Agent)';
  const TAG_ROWS = [
    { id: '5', status: 'active', reporter_id: null, description: MARKER },
    { id: '6', status: 'active', reporter_id: 'user-1', description: `I copied this: ${MARKER}` }, // citizen report quoting the marker
    { id: '7', status: 'pending', reporter_id: null, description: MARKER },
    { id: '8', status: 'active', reporter_id: null, description: 'Old news row' },
  ];
  const featuresFor = () => ({ features: TAG_ROWS.map(r => ({ properties: { id: r.id } })) });
  const tagged = (fc) => fc.features.filter(f => f.properties.foundBy === 'agent').map(f => f.properties.id);

  /** Supabase query builder over an in-memory table that really applies eq / is / like. */
  function memorySupabase(rows) {
    return {
      from: () => {
        const filters = [];
        const b = {
          select: () => b,
          eq: (col, v) => { filters.push(r => r[col] === v); return b; },
          is: (col, v) => { filters.push(r => (r[col] ?? null) === v); return b; },
          like: (col, pattern) => {
            const re = new RegExp(`^${pattern.split('%').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
            filters.push(r => re.test(r[col] ?? ''));
            return b;
          },
          order: () => b,
          range: async (from, to) => ({ data: rows.filter(r => filters.every(f => f(r))).slice(from, to + 1), error: null }),
        };
        return b;
      },
    };
  }

  /** Postgres stand-in that applies only the conditions actually written in the SQL. */
  const memoryPg = (rows) => vi.fn(async (sql, params = []) => rows.filter(r =>
    (!/status = 'active'/.test(sql) || r.status === 'active')
    && (!/reporter_id IS NULL/.test(sql) || r.reporter_id == null)
    && (!/description LIKE \$1/.test(sql) || String(r.description || '').includes(params[0].replace(/%/g, '')))));

  it('does not tag citizen reports that contain the marker (Supabase)', async () => {
    const news = createNewsFeatures({ supabase: memorySupabase(TAG_ROWS), nextAccidentId: async () => '1', dataDir: tmpDir(), env: { AGENT_ENABLED: 'false' }, logger: silentLogger });
    expect(tagged(await news.tagAgentRows(featuresFor()))).toEqual(['5']);
  });

  it('does not tag citizen reports that contain the marker (Postgres)', async () => {
    const q = memoryPg(TAG_ROWS);
    const news = createNewsFeatures({ q, nextAccidentId: async () => '1', dataDir: tmpDir(), env: { AGENT_ENABLED: 'false' }, logger: silentLogger });
    expect(tagged(await news.tagAgentRows(featuresFor()))).toEqual(['5']);
    expect(q.mock.calls[0][0]).toMatch(/reporter_id IS NULL/);
  });

  it('never throws when the lookup fails', async () => {
    const news = createNewsFeatures({ q: async () => { throw new Error('db down'); }, nextAccidentId: async () => '1', dataDir: tmpDir(), env: { AGENT_ENABLED: 'false' }, logger: silentLogger });
    const fc = { features: [{ properties: { id: '5' } }] };
    await expect(news.tagAgentRows(fc)).resolves.toBe(fc);
    expect(fc.features[0].properties.foundBy).toBeUndefined();
  });
});
