/**
 * Admin stat cards: real totals from the database, whatever filter or page the
 * records table is showing.
 *
 *   GET /api/admin/stats → { total, active, pending, hidden, rejected, fatal, serious, minor }
 *
 * Supabase: count-only requests (count: 'exact', head: true), so no rows are
 * downloaded. Postgres: one count(*) FILTER query. Severity counts cover every
 * record, like the "Total Records" card.
 */

export const STAT_KEYS = ['total', 'active', 'pending', 'hidden', 'rejected', 'fatal', 'serious', 'minor'];

const COUNTS = [
  ['total', null, null],
  ['active', 'status', 'active'],
  ['pending', 'status', 'pending'],
  ['hidden', 'status', 'hidden'],
  ['rejected', 'status', 'rejected'],
  ['fatal', 'severity', 'fatal'],
  ['serious', 'severity', 'serious'],
  ['minor', 'severity', 'minor'],
];

const PG_SQL = `SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE status = 'active')::int AS active,
    count(*) FILTER (WHERE status = 'pending')::int AS pending,
    count(*) FILTER (WHERE status = 'hidden')::int AS hidden,
    count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
    count(*) FILTER (WHERE severity = 'fatal')::int AS fatal,
    count(*) FILTER (WHERE severity = 'serious')::int AS serious,
    count(*) FILTER (WHERE severity = 'minor')::int AS minor
  FROM accidents`;

export function createStatsStore({ supabase = null, q = null, logger = console } = {}) {
  async function fromSupabase() {
    const results = await Promise.all(COUNTS.map(async ([key, column, value]) => {
      let query = supabase.from('accidents').select('id', { count: 'exact', head: true });
      if (column) query = query.eq(column, value);
      const { count, error } = await query;
      if (error) throw new Error(error.message);
      return [key, Number(count) || 0];
    }));
    return Object.fromEntries(results);
  }

  async function fromPg() {
    const row = (await q(PG_SQL))[0] || {};
    return Object.fromEntries(STAT_KEYS.map(k => [k, Number(row[k]) || 0]));
  }

  async function getStats() {
    let lastErr = null;
    if (supabase) {
      try { return await fromSupabase(); } catch (e) { lastErr = e; logger.warn?.('[stats] Supabase counts failed:', e.message); }
    }
    if (q) {
      try { return await fromPg(); } catch (e) { lastErr = e; logger.warn?.('[stats] Postgres counts failed:', e.message); }
    }
    const err = new Error(lastErr ? `stats unavailable: ${lastErr.message}` : 'no database configured');
    err.status = lastErr ? 500 : 503;
    throw err;
  }

  return { getStats };
}

export function registerAdminStatsRoute(app, { adminAuth, readLimiter, statsStore }) {
  const pass = (_req, _res, next) => next();
  app.get('/api/admin/stats', readLimiter || pass, adminAuth, async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await statsStore.getStats());
    } catch (e) {
      console.error('/api/admin/stats error:', e.message);
      res.status(e.status === 503 ? 503 : 500).json({ error: e.status === 503 ? 'No database configured' : 'Could not load the record counts' });
    }
  });
}
