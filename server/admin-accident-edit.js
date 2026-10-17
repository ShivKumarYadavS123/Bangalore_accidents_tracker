/**
 * Title and accident-date edits for PATCH /api/admin/accidents/:id (the route
 * stays in index.js; it calls titleDateEdit and merges the result into its
 * updates). So an admin can fix what the News Agent got wrong from the Edit
 * modal, without the Supabase Table Editor.
 *
 *   title          5-200 characters, whitespace collapsed
 *   accident_date  YYYY-MM-DD, a real date, not after today (IST)
 *
 * A new date also rewrites date_raw to that date, keeping the HH:MM time the
 * old date_raw had, so hour-of-day analytics keep working.
 */

export const TITLE_MIN = 5;
export const TITLE_MAX = 200;

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export function istToday(ms = Date.now()) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Validates the title / accident_date in a PATCH body. Fields that are absent
 * are left alone. Returns { updates } (possibly empty) or { error }.
 */
export function parseTitleDateEdit(body, { today = istToday() } = {}) {
  const { title, accident_date: date } = body || {};
  const updates = {};
  if (title !== undefined) {
    if (typeof title !== 'string') return { error: 'Title must be text' };
    const t = title.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < TITLE_MIN || t.length > TITLE_MAX) return { error: `Title must be ${TITLE_MIN} to ${TITLE_MAX} characters` };
    updates.title = t;
  }
  if (date !== undefined) {
    const d = typeof date === 'string' ? date.trim() : '';
    if (!isRealDate(d)) return { error: 'Accident date must be a real date written YYYY-MM-DD' };
    if (d > today) return { error: 'Accident date cannot be in the future' };
    updates.accident_date = d;
  }
  return { updates };
}

/**
 * date_raw for a new accident date: the date, plus the time from the old
 * date_raw when it had one ("2026-10-12 23:30", "...T07:05", "11:30 PM").
 */
export function dateRawFor(date, oldRaw) {
  const m = String(oldRaw ?? '').match(/(?:^|[\sT,])(\d{1,2}):([0-5]\d)(?::\d{2})?(?:\s*([ap])\.?\s?m\b\.?)?/i);
  if (!m) return date;
  let h = Number(m[1]);
  const ampm = m[3]?.toLowerCase();
  if (ampm && (h < 1 || h > 12)) return date;
  if (ampm === 'p' && h < 12) h += 12;
  if (ampm === 'a' && h === 12) h = 0;
  return h <= 23 ? `${date} ${String(h).padStart(2, '0')}:${m[2]}` : date;
}

/**
 * The record's current date_raw: { found, dateRaw }. Supabase first, then the
 * Postgres pool, like the rest of the PATCH route. Throws when neither answers.
 */
export async function readDateRaw(id, { supabase = null, q = null } = {}) {
  let answered = false;
  let lastErr = null;
  if (supabase) {
    try {
      const { data, error } = await supabase.from('accidents').select('id, date_raw').eq('id', String(id)).limit(1);
      if (error) lastErr = error;
      else if (data?.length) return { found: true, dateRaw: data[0].date_raw ?? null };
      else answered = true;
    } catch (e) { lastErr = e; }
  }
  if (q) {
    try {
      const rows = await q('SELECT id, date_raw FROM accidents WHERE id = $1 LIMIT 1', [String(id)]);
      if (rows?.length) return { found: true, dateRaw: rows[0].date_raw ?? null };
      answered = true;
    } catch (e) { lastErr = e; }
  }
  if (answered) return { found: false, dateRaw: null };
  throw new Error(lastErr ? `could not read the record: ${lastErr.message}` : 'no database configured');
}

/**
 * Everything the PATCH route needs for title / accident_date:
 * { updates } with title, accident_date and date_raw as asked for (empty when
 * the body has neither), or { status, error } with nothing to save.
 */
export async function titleDateEdit(body, { id, supabase = null, q = null, today = istToday(), logger = console } = {}) {
  const parsed = parseTitleDateEdit(body, { today });
  if (parsed.error) return { status: 400, error: parsed.error };
  const { updates } = parsed;
  if (updates.accident_date) {
    let current;
    try {
      current = await readDateRaw(id, { supabase, q });
    } catch (e) {
      logger.warn?.('Accident date edit: ', e.message);
      return { status: 500, error: 'Could not read the record to keep its time; nothing saved' };
    }
    if (!current.found) return { status: 404, error: 'Accident not found' };
    updates.date_raw = dateRawFor(updates.accident_date, current.dateRaw);
  }
  return { updates };
}
