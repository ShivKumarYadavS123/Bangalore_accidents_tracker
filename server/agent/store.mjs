/**
 * Database access for the News Agent and the X importer.
 *
 * Mirrors POST /api/reports: Supabase REST first (insert, then the
 * set_accident_geom RPC because PostgREST can't take PostGIS WKT), then the
 * direct Postgres pool as a fallback. No schema changes: everything uses the
 * existing accidents table and find_duplicates_by_point.
 */
import { urlKey } from './sources.mjs';
import { AGENT_MARKER } from './pipeline.mjs';

const PAGE = 1000; // Supabase returns at most 1000 rows per request by default

const INSERT_SQL = `INSERT INTO accidents (id, title, source, link, location, area, zone, severity, score, date_raw, accident_date, has_coords, geom, status, reporter_id, description, proof_url)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::geometry, $14, $15, $16, $17)`;

export function createAccidentStore({ supabase = null, q = null, nextAccidentId, logger = console } = {}) {
  const available = () => Boolean(supabase || q);

  /** Every row of a Supabase select, page by page (stable order by id). */
  async function selectAll(build) {
    const rows = [];
    for (let from = 0; from < 500000; from += PAGE) {
      const { data, error } = await build().order('id', { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return rows;
  }

  async function first(sbQuery, sql, params) {
    let lastErr = null;
    if (supabase) {
      try {
        const { data, error } = await sbQuery();
        if (!error) return data?.[0] || null;
        lastErr = error;
      } catch (e) { lastErr = e; }
    }
    if (q) {
      try { return (await q(sql, params))[0] || null; } catch (e) { lastErr = e; }
    }
    throw new Error(lastErr ? `database lookup failed: ${lastErr.message}` : 'no database configured');
  }

  /** First row whose link is one of `links`, or null. Throws when the database can't be asked. */
  function findByLink(links) {
    const list = [...new Set((links || []).filter(Boolean))].slice(0, 20);
    if (!list.length) return Promise.resolve(null);
    return first(
      () => supabase.from('accidents').select('id, link').in('link', list).limit(1),
      'SELECT id, link FROM accidents WHERE link = ANY($1::text[]) LIMIT 1',
      [list],
    );
  }

  /** Any stored x.com / twitter.com link to this post id, whatever handle was used. */
  function findByXPostId(postId) {
    const id = String(postId || '');
    if (!/^\d{1,20}$/.test(id)) return Promise.resolve(null);
    return first(
      () => supabase.from('accidents').select('id, link').like('link', `%/status/${id}`).limit(1),
      'SELECT id, link FROM accidents WHERE link LIKE $1 LIMIT 1',
      [`%/status/${id}`],
    );
  }

  /** Comparison keys (see urlKey) of every stored link, for the cheap search-time filter. */
  async function allLinkKeys() {
    let rows = null;
    if (supabase) {
      try { rows = await selectAll(() => supabase.from('accidents').select('id, link').not('link', 'is', null)); }
      catch (e) { logger.warn?.('[agent] Supabase link list failed:', e.message); }
    }
    if (!rows && q) rows = await q('SELECT link FROM accidents WHERE link IS NOT NULL');
    if (!rows) throw new Error('no database configured');
    const keys = new Set();
    for (const r of rows) { const k = urlKey(r.link); if (k) keys.add(k); }
    return keys;
  }

  /** find_duplicates_by_point: rows within radiusM of the point, optionally on the same date. */
  async function findNearby(lat, lng, radiusM, date) {
    if (supabase) {
      try {
        const { data, error } = await supabase.rpc('find_duplicates_by_point', { p_lat: lat, p_lng: lng, p_radius_m: radiusM, p_date: date || null });
        if (!error) return Array.isArray(data) ? data : [];
      } catch { /* fall through to pg */ }
    }
    if (q) {
      const rows = await q(
        'SELECT find_duplicates_by_point($1::double precision, $2::double precision, $3::float, $4::date) AS result',
        [lat, lng, radiusM, date || null],
      );
      return Array.isArray(rows[0]?.result) ? rows[0].result : [];
    }
    return [];
  }

  async function setGeom(id, { lat, lng }) {
    try {
      const { error } = await supabase.rpc('set_accident_geom', { p_id: id, p_lat: lat, p_lng: lng });
      if (!error) return;
      logger.error?.('set_accident_geom RPC error:', error.message);
    } catch (e) {
      logger.error?.('set_accident_geom RPC exception:', e.message);
    }
    // No point stored: don't claim one, so the admin sees "No coords" and sets the pin.
    try { await supabase.from('accidents').update({ has_coords: false }).eq('id', id); } catch { /* best effort */ }
  }

  /** One insert attempt: { ok } | { conflict } (id already taken) | { error }. */
  async function insertOnce(row, loc) {
    let lastErr = null;
    if (supabase) {
      try {
        const { error } = await supabase.from('accidents').insert(row);
        if (!error) {
          if (row.has_coords) await setGeom(row.id, loc);
          return { ok: true };
        }
        if (error.code === '23505') return { conflict: true, error };
        lastErr = error;
        logger.error?.('Supabase agent insert error:', error.message);
      } catch (e) { lastErr = e; }
    }
    if (q) {
      try {
        const geom = row.has_coords ? `SRID=4326;POINT(${loc.lng} ${loc.lat})` : null;
        await q(INSERT_SQL, [row.id, row.title, row.source, row.link, row.location, row.area, row.zone, row.severity, row.score,
          row.date_raw, row.accident_date, row.has_coords, geom, row.status, row.reporter_id, row.description, row.proof_url]);
        return { ok: true };
      } catch (e) {
        if (e.code === '23505') return { conflict: true, error: e };
        lastErr = e;
      }
    }
    return { error: lastErr || new Error('no database configured') };
  }

  /** Insert a pending row; retries once with a fresh id if another insert took it first. Returns the id. */
  async function insertPending(record, loc) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = await nextAccidentId(`agt_${Date.now()}`);
      const row = { ...record, id, status: 'pending', reporter_id: null };
      last = await insertOnce(row, loc);
      if (last.ok) return id;
      if (!last.conflict) break;
    }
    throw new Error(last?.error?.message || 'insert failed');
  }

  /** Ids of approved (active) rows the News Agent found, for the map popup label. */
  async function agentRowIds() {
    const pattern = `%${AGENT_MARKER}%`;
    let rows = null;
    if (supabase) {
      try { rows = await selectAll(() => supabase.from('accidents').select('id').eq('status', 'active').like('description', pattern)); }
      catch (e) { logger.warn?.('[agent] Supabase agent-row lookup failed:', e.message); }
    }
    if (!rows && q) rows = await q(`SELECT id FROM accidents WHERE status = 'active' AND description LIKE $1`, [pattern]);
    return new Set((rows || []).map(r => String(r.id)));
  }

  return { available, findByLink, findByXPostId, allLinkKeys, findNearby, insertPending, agentRowIds };
}
