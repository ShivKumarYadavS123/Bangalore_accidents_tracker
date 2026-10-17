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

  /**
   * Rows the News Agent found, with one status: reporter_id null and the agent
   * marker in the description. Citizen reports (reporter_id set) never count,
   * even if their text contains the marker. `full` returns review rows (with
   * lat/lng) instead of bare ids.
   */
  async function agentRows({ status = 'active', full = false } = {}) {
    if (!AGENT_ROW_STATUSES.includes(status)) throw new Error(`Invalid status ${status}`);
    const pattern = `%${AGENT_MARKER}%`;
    let rows = null;
    if (supabase) {
      try { rows = await selectAll(() => supabase.from('accidents').select(full ? ROW_COLUMNS : 'id').eq('status', status).is('reporter_id', null).like('description', pattern)); }
      catch (e) { logger.warn?.('[agent] Supabase agent-row lookup failed:', e.message); }
    }
    if (!rows && q) rows = await q(`${full ? ROW_SELECT : 'SELECT id FROM accidents'} WHERE status = '${status}' AND reporter_id IS NULL AND description LIKE $1`, [pattern]);
    return full ? (rows || []).map(toReviewRow) : (rows || []);
  }

  /** Ids of approved (active) rows the News Agent found, for the map popup label. */
  async function agentRowIds() {
    return new Set((await agentRows({ status: 'active' })).map(r => String(r.id)));
  }

  /** Review rows (with lat/lng) for these ids, any status. Throws when the database can't be asked. */
  async function rowsByIds(ids) {
    const list = [...new Set((ids || []).map(String))].slice(0, 200);
    if (!list.length) return [];
    let lastErr = null;
    if (supabase) {
      try {
        const { data, error } = await supabase.from('accidents').select(ROW_COLUMNS).in('id', list);
        if (!error) return (data || []).map(toReviewRow);
        lastErr = error;
      } catch (e) { lastErr = e; }
    }
    if (q) {
      try { return (await q(`${ROW_SELECT} WHERE id = ANY($1::text[])`, [list])).map(toReviewRow); } catch (e) { lastErr = e; }
    }
    throw new Error(lastErr ? `database lookup failed: ${lastErr.message}` : 'no database configured');
  }

  /** Replace one row's description (Review Agent approval note and its Undo). Throws when nothing saved it. */
  async function setDescription(id, description) {
    let saved = false;
    let lastErr = null;
    if (supabase) {
      try {
        const { error } = await supabase.from('accidents').update({ description }).eq('id', String(id));
        if (!error) saved = true; else lastErr = error;
      } catch (e) { lastErr = e; }
    }
    if (q) {
      try { await q('UPDATE accidents SET description = $2 WHERE id = $1', [String(id), description]); saved = true; } catch (e) { lastErr = e; }
    }
    if (!saved) throw new Error(lastErr ? `could not save the description: ${lastErr.message}` : 'no database configured');
  }

  return { available, findByLink, findByXPostId, allLinkKeys, findNearby, insertPending, agentRows, agentRowIds, rowsByIds, setDescription };
}

const AGENT_ROW_STATUSES = ['active', 'pending'];

const ROW_COLUMNS = 'id, title, source, link, location, area, severity, accident_date, date_raw, has_coords, geom, status, reporter_id, rejection_reason, description, created_at';
const ROW_SELECT = `SELECT id, title, source, link, location, area, severity, accident_date, date_raw, has_coords, status, reporter_id, rejection_reason, description, created_at,
  ST_Y(geom) AS lat, ST_X(geom) AS lng FROM accidents`;

/** 'YYYY-MM-DD' from a date column: node-pg gives a Date at local midnight, Supabase a string. */
function ymd(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = typeof v === 'string' ? v.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Point from Supabase's geom (GeoJSON object, or WKT text) or the pg query's lat/lng columns. */
function pointOf(r) {
  if (r.lat != null && r.lng != null) return { lat: Number(r.lat), lng: Number(r.lng) };
  const g = r.geom;
  if (g && typeof g === 'object' && Array.isArray(g.coordinates)) return { lat: Number(g.coordinates[1]), lng: Number(g.coordinates[0]) };
  const m = typeof g === 'string' ? g.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i) : null;
  return m ? { lat: parseFloat(m[2]), lng: parseFloat(m[1]) } : { lat: null, lng: null };
}

export function toReviewRow(r) {
  const { lat, lng } = pointOf(r);
  const ok = Number.isFinite(lat) && Number.isFinite(lng);
  return {
    id: String(r.id),
    title: r.title ?? null,
    source: r.source ?? null,
    link: r.link ?? null,
    location: r.location ?? null,
    area: r.area ?? null,
    severity: r.severity ?? null,
    accident_date: ymd(r.accident_date),
    date_raw: r.date_raw ?? null,
    has_coords: Boolean(r.has_coords) && ok,
    lat: ok ? lat : null,
    lng: ok ? lng : null,
    status: r.status ?? null,
    reporter_id: r.reporter_id ?? null,
    rejection_reason: r.rejection_reason ?? null,
    description: r.description ?? '',
    created_at: r.created_at ?? null,
  };
}
