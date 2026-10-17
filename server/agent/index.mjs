/**
 * Wires the BAT News Agent, the BAT Review Agent and the X paste box into the Express app.
 *
 *   Admin (JWT + admin role, rate limited):
 *   GET  /api/admin/agent/status      on/off, next run, AI calls used today, last 10 runs
 *   GET  /api/admin/agent/runs/:id    full log of one run
 *   POST /api/admin/agent/run         { backfillDays? } starts a run (202) unless one is running
 *   POST /api/admin/x-import          { urls: [...] } up to 20 X post links, one result per link
 *
 *   Review Agent (review-agent.mjs):
 *   POST /api/admin/agent/review              start a review (202), 409 when off or running
 *   GET  /api/admin/agent/review/status       mode, AI calls today, agreement, latest decisions
 *   GET  /api/admin/agent/review/stats        agree / disagree and counts per decision
 *   GET  /api/admin/agent/review/rows/:id     the verdict and fix suggestion for one row
 *   POST /api/admin/agent/review/mode         { mode: off|shadow|auto, confirm: true for auto }
 *   POST /api/admin/agent/review/undo/:id     an agent approval back to pending
 *
 * Also: tagAgentRows() marks map features the agent found (foundBy: 'agent') so
 * the public popup can credit the publisher and the agent.
 */
import { createAccidentStore } from './store.mjs';
import { createImportPipeline } from './pipeline.mjs';
import { createNewsAgent } from './news-agent.mjs';
import { createReviewAgent, REVIEW_MODES } from './review-agent.mjs';
import { createXImporter, isXHost, parseXStatusUrl, MAX_X_LINKS } from './x-import.mjs';

const RUN_ID = /^run_[A-Za-z0-9_]{1,60}$/;
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_IDS_TTL_MS = 5 * 60 * 1000;

export function registerReviewRoutes(app, { adminAuth, read, write, review }) {
  app.get('/api/admin/agent/review/status', read, adminAuth, (_req, res) => {
    res.json(review.status());
  });

  app.get('/api/admin/agent/review/stats', read, adminAuth, (_req, res) => {
    res.json(review.stats());
  });

  app.get('/api/admin/agent/review/rows/:id', read, adminAuth, (req, res) => {
    if (!ROW_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    res.json(review.rowInfo(req.params.id));
  });

  app.post('/api/admin/agent/review', write, adminAuth, (_req, res) => {
    const r = review.runReview({ trigger: 'manual' });
    if (!r.started) return res.status(409).json({ error: r.message, reason: r.reason, runId: r.runId || null });
    r.done.catch(() => {});
    res.status(202).json({ started: true, runId: r.runId });
  });

  app.post('/api/admin/agent/review/mode', write, adminAuth, (req, res) => {
    const mode = req.body?.mode;
    if (!REVIEW_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${REVIEW_MODES.join(', ')}` });
    // Auto mode changes the database by itself: the admin UI asks first, and the request must say so.
    if (mode === 'auto' && req.body?.confirm !== true) return res.status(400).json({ error: 'Switching to auto needs confirm: true' });
    res.json(review.setMode(mode));
  });

  app.post('/api/admin/agent/review/undo/:id', write, adminAuth, async (req, res) => {
    if (!ROW_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    try {
      const r = await review.undo(req.params.id);
      if (r.error) return res.status(r.status || 500).json({ error: r.error });
      res.json(r);
    } catch (e) {
      console.error('/api/admin/agent/review/undo error:', e.message);
      res.status(500).json({ error: 'Undo failed' });
    }
  });
}

export function registerAgentRoutes(app, { adminAuth, readLimiter, writeLimiter, agent, xImporter, review = null }) {
  const pass = (_req, _res, next) => next();
  const read = readLimiter || pass;
  const write = writeLimiter || pass;

  app.get('/api/admin/agent/status', read, adminAuth, (_req, res) => {
    res.json(agent.status());
  });

  app.get('/api/admin/agent/runs/:id', read, adminAuth, (req, res) => {
    if (!RUN_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid run id' });
    const run = agent.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  app.post('/api/admin/agent/run', write, adminAuth, (req, res) => {
    const raw = req.body?.backfillDays;
    let backfillDays = 0;
    if (raw !== undefined && raw !== null && raw !== '') {
      const n = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 30) return res.status(400).json({ error: 'backfillDays must be a whole number from 1 to 30' });
      backfillDays = n;
    }
    const r = agent.runAgent({ backfillDays });
    if (!r.started) return res.status(409).json({ error: r.message, reason: r.reason, runId: r.runId || null });
    r.done.catch(() => {});
    res.status(202).json({ started: true, runId: r.runId });
  });

  app.post('/api/admin/x-import', write, adminAuth, async (req, res) => {
    const urls = req.body?.urls;
    if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: 'urls must be a non-empty list of X post links' });
    if (urls.length > MAX_X_LINKS) return res.status(400).json({ error: `At most ${MAX_X_LINKS} links at a time` });
    if (urls.some(u => typeof u !== 'string')) return res.status(400).json({ error: 'Every link must be text' });
    try {
      res.json({ results: await xImporter.importLinks(urls) });
    } catch (e) {
      console.error('/api/admin/x-import error:', e.message);
      res.status(500).json({ error: 'X import failed' });
    }
  });

  if (review) registerReviewRoutes(app, { adminAuth, read, write, review });
}

/**
 * setStatus:     (ids, status, opts) => { ok, error }, the bulk route's queries
 *                (admin-accident-write.js); the Review Agent approves through it in auto mode
 * onDataChanged: called after the Review Agent changed rows (index.js refreshes the AI data cache)
 */
export function createNewsFeatures({
  supabase = null, q = null, nextAccidentId, geocode = null, inferZone, dataDir,
  env = process.env, logger = console, fetchUrl, aiFetch = null, setStatus = null, onDataChanged = null,
} = {}) {
  const store = createAccidentStore({ supabase, q, nextAccidentId, logger });
  const pipeline = createImportPipeline({ store, geocode, inferZone, logger });
  let review = null;
  // The Review Agent looks at what each News Agent run found, right after it.
  const agent = createNewsAgent({ pipeline, store, env, dataDir, logger, aiFetch, ...(fetchUrl ? { fetchUrl } : {}), onRunDone: (run) => review?.afterFinderRun(run) });
  const xImporter = createXImporter({ pipeline, store, env, logger, aiFetch, ...(fetchUrl ? { fetchUrl } : {}) });

  let agentIds = { ids: null, at: 0, pending: null };

  review = createReviewAgent({
    store, pipeline, setStatus, env, dataDir, logger, aiFetch, ...(fetchUrl ? { fetchUrl } : {}),
    // Agent approvals don't come through an admin HTTP write, so refresh what that would have.
    onWrite: () => { agentIds.at = 0; onDataChanged?.(); },
  });

  function agentRowIds() {
    if (agentIds.ids && Date.now() - agentIds.at < AGENT_IDS_TTL_MS) return Promise.resolve(agentIds.ids);
    if (!agentIds.pending) {
      agentIds.pending = store.agentRowIds()
        .then(ids => { agentIds = { ids, at: Date.now(), pending: null }; return ids; })
        .catch(e => {
          logger.warn?.('[agent] map tagging lookup failed:', e.message);
          agentIds = { ids: agentIds.ids || new Set(), at: Date.now(), pending: null };
          return agentIds.ids;
        });
    }
    return agentIds.pending;
  }

  /** Adds properties.foundBy = 'agent' to features of approved rows the agent found. Never throws. */
  async function tagAgentRows(fc) {
    if (!fc || !Array.isArray(fc.features) || !fc.features.length || !store.available()) return fc;
    try {
      const ids = await agentRowIds();
      if (ids.size) {
        for (const f of fc.features) {
          if (f?.properties && ids.has(String(f.properties.id))) f.properties.foundBy = 'agent';
        }
      }
    } catch { /* label is optional */ }
    return fc;
  }

  /** Approvals and edits change which rows are public: refresh the agent-row list after admin writes. */
  function invalidateOnWrite(req, res, next) {
    if (req.method !== 'GET' && req.path.startsWith('/api/admin/')) {
      res.on('finish', () => { if (res.statusCode < 400) agentIds.at = 0; });
    }
    next();
  }

  return {
    store,
    pipeline,
    agent,
    review,
    xImporter,
    tagAgentRows,
    invalidateOnWrite,
    isXHost,
    parseXStatusUrl,
    registerRoutes: (app, opts) => registerAgentRoutes(app, { ...opts, agent, xImporter, review }),
    start: () => agent.start(),
  };
}
