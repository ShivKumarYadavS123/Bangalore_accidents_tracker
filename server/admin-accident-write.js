/**
 * Status updates for POST /api/admin/accidents/bulk (verify / hide). The route
 * stays in index.js and calls setAccidentStatus; the BAT Review Agent calls it
 * too, so an agent approval goes through exactly the same queries as the
 * admin's Approve button.
 *
 *   'active'   Approve: status active, rejection_reason cleared
 *   'hidden'   Reject: status hidden, rejection_reason as given
 *   'pending'  Review Agent "Undo" only (the bulk route never accepts it)
 *
 * Supabase first, then the Postgres pool, as the route always did: a Supabase
 * error is not thrown (the pool is the fallback), a pool error is. Returns
 * { ok, error } so a caller without the route's 500 handler can tell whether
 * the change was saved.
 */
export const STATUS_UPDATES = ['active', 'hidden', 'pending'];

export async function setAccidentStatus({ supabase = null, q = null } = {}, ids, status, { rejection_reason } = {}) {
  if (!STATUS_UPDATES.includes(status)) throw new Error(`Invalid status ${status}`);
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'no ids' };
  let supabaseError = null;

  if (status === 'active') {
    if (supabase) {
      try { ({ error: supabaseError } = await supabase.from('accidents').update({ status: 'active', rejection_reason: null }).in('id', ids)); } catch (e) { supabaseError = e; }
    }
    if (q) {
      await q(`UPDATE accidents SET status = 'active', rejection_reason = NULL WHERE id = ANY($1::text[])`, [ids]);
    }
  } else if (status === 'hidden') {
    if (supabase) {
      try { ({ error: supabaseError } = await supabase.from('accidents').update({ status: 'hidden', rejection_reason: rejection_reason || null }).in('id', ids)); } catch (e) { supabaseError = e; }
    }
    if (q) {
      await q(`UPDATE accidents SET status = 'hidden', rejection_reason = COALESCE($2, rejection_reason) WHERE id = ANY($1::text[])`, [ids, rejection_reason ?? null]);
    }
  } else {
    if (supabase) {
      try { ({ error: supabaseError } = await supabase.from('accidents').update({ status: 'pending', rejection_reason: null }).in('id', ids)); } catch (e) { supabaseError = e; }
    }
    if (q) {
      await q(`UPDATE accidents SET status = 'pending', rejection_reason = NULL WHERE id = ANY($1::text[])`, [ids]);
    }
  }

  // The pool answered (it throws otherwise); without it, Supabase's answer decides.
  if (q) return { ok: true, error: null };
  if (supabase && !supabaseError) return { ok: true, error: null };
  return { ok: false, error: supabaseError ? String(supabaseError.message || supabaseError) : 'no database configured' };
}
