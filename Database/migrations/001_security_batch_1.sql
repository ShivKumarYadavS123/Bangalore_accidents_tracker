-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 001 — security batch 1: row-level security policies and column
-- privileges for the public (anon) and signed-in (authenticated) API roles.
--
--   #2  emergency_alerts: drop the hospital/admin SELECT and UPDATE policies.
--       Hospitals and admins work through the API (service role), which
--       decides which hospital may see or change which alert.
--   #4  accidents: drop the authenticated INSERT policy. Reports go through
--       POST /api/reports (validation, rate limits, status 'pending').
--   #5  anon / authenticated may SELECT only the public columns of accidents,
--       hospitals and civic_issues. Private columns (accidents.reporter_id,
--       description, proof_url, rejection_reason, integrity, image_phash;
--       hospitals.email, webhook_url, er_status_updated_by;
--       civic_issues.reporter_id) are readable by the API only. Browser reads
--       must list their columns: select('*') is refused after this.
--   #28 civic_issues: a reporter may edit their own issue only while it is
--       open with no action note, and cannot change status or the note.
--       Admins keep full UPDATE.
--
-- For Supabase (uses auth.uid(), auth.jwt() and the anon / authenticated
-- roles). Idempotent: safe to run more than once. Runs in one transaction and
-- rolls back completely if the final check finds a private column still
-- readable. Database/schema.sql and Database/supabase-setup.sql contain the
-- same end state for fresh installs.
--
-- HOW TO RUN: Supabase dashboard → SQL Editor → paste this file → Run.
-- ROLLBACK: see the commented section at the bottom of this file.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── #2 emergency_alerts: no direct table access for hospitals / admins ─────

DROP POLICY IF EXISTS "Hospital and admin read emergency alerts" ON emergency_alerts;
DROP POLICY IF EXISTS "Hospital acknowledge emergency alerts" ON emergency_alerts;

-- ─── #4 accidents: no direct INSERT for signed-in users ─────────────────────

DROP POLICY IF EXISTS "Authenticated users submit accident reports" ON accidents;

-- ─── #28 civic_issues: reporters cannot change status or the action note ────
-- A reporter may edit their own issue only while it is still open with no
-- action note, and the edit must leave it that way. Status and the resolution
-- note are set by admins (PATCH /api/civic/issues/:id).

DROP POLICY IF EXISTS "Reporter or admin update civic issues" ON civic_issues;

DROP POLICY IF EXISTS "Reporter edit own open civic issues" ON civic_issues;
CREATE POLICY "Reporter edit own open civic issues" ON civic_issues
  FOR UPDATE
  TO authenticated
  USING (reporter_id = auth.uid()::text AND status = 'open' AND action_note IS NULL)
  WITH CHECK (reporter_id = auth.uid()::text AND status = 'open' AND action_note IS NULL);

DROP POLICY IF EXISTS "Admin update civic issues" ON civic_issues;
CREATE POLICY "Admin update civic issues" ON civic_issues
  FOR UPDATE
  TO authenticated
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- ─── #5 Column privileges: browser roles read public columns only ───────────
-- Removes table-wide SELECT (and any earlier column grants) from anon and
-- authenticated, then grants SELECT on the public columns that exist. Any
-- column not listed here, including columns added later, stays private.
-- Direct browser reads today: trends-app.js (accidents) and civic-app.js
-- (civic_issues); both use only columns listed here.

DO $$
DECLARE
  t        record;
  all_cols text;
  pub_cols text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RETURN; -- plain PostgreSQL without the Supabase API roles
  END IF;
  FOR t IN
    SELECT * FROM (VALUES
      ('accidents',    ARRAY['id', 'title', 'source', 'link', 'location', 'area', 'zone', 'severity', 'score',
                             'date_raw', 'accident_date', 'has_coords', 'geom', 'status', 'created_at']),
      ('hospitals',    ARRAY['id', 'name', 'phone', 'address', 'location', 'facility_type', 'emergency_level',
                             'level_source', 'er_status', 'er_status_note', 'er_status_updated_at', 'verified']),
      ('civic_issues', ARRAY['id', 'type', 'title', 'description', 'area', 'lat', 'lng', 'status', 'action_note',
                             'created_at', 'updated_at'])
    ) AS v(tbl, public_cols)
  LOOP
    SELECT string_agg(quote_ident(c.column_name::text), ', ' ORDER BY c.ordinal_position),
           string_agg(quote_ident(c.column_name::text), ', ' ORDER BY c.ordinal_position)
             FILTER (WHERE c.column_name::text = ANY (t.public_cols))
      INTO all_cols, pub_cols
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name::text = t.tbl;
    CONTINUE WHEN all_cols IS NULL; -- table does not exist yet
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', t.tbl);
    EXECUTE format('REVOKE SELECT (%s) ON public.%I FROM anon, authenticated', all_cols, t.tbl);
    IF pub_cols IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO anon, authenticated', pub_cols, t.tbl);
    END IF;
  END LOOP;
END $$;

-- ─── Check: fail (and roll back everything) if a private column is still readable

DO $$
DECLARE
  c record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RETURN;
  END IF;
  FOR c IN
    SELECT * FROM (VALUES
      ('accidents', 'reporter_id'), ('accidents', 'description'), ('accidents', 'proof_url'),
      ('accidents', 'rejection_reason'), ('accidents', 'integrity'), ('accidents', 'image_phash'),
      ('hospitals', 'email'), ('hospitals', 'webhook_url'), ('hospitals', 'er_status_updated_by'),
      ('civic_issues', 'reporter_id')
    ) AS v(tbl, col)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name::text = c.tbl AND column_name::text = c.col)
       AND (has_column_privilege('anon', format('public.%I', c.tbl), c.col, 'SELECT')
            OR has_column_privilege('authenticated', format('public.%I', c.tbl), c.col, 'SELECT')) THEN
      RAISE EXCEPTION 'Private column %.% is still readable by anon/authenticated (granted by another role?)', c.tbl, c.col;
    END IF;
  END LOOP;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — restores the policies and table-wide SELECT exactly as they were
-- before this migration. Do not run unless you are undoing 001. To use it,
-- copy the block below into the SQL editor and remove the leading "-- ".
-- ═══════════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--
-- -- #2 emergency_alerts
-- DROP POLICY IF EXISTS "Hospital and admin read emergency alerts" ON emergency_alerts;
-- CREATE POLICY "Hospital and admin read emergency alerts" ON emergency_alerts
--   FOR SELECT
--   TO authenticated
--   USING (
--     auth.jwt() -> 'app_metadata' ->> 'role' IN ('hospital', 'admin')
--   );
--
-- DROP POLICY IF EXISTS "Hospital acknowledge emergency alerts" ON emergency_alerts;
-- CREATE POLICY "Hospital acknowledge emergency alerts" ON emergency_alerts
--   FOR UPDATE
--   TO authenticated
--   USING (
--     auth.jwt() -> 'app_metadata' ->> 'role' IN ('hospital', 'admin')
--   )
--   WITH CHECK (
--     auth.jwt() -> 'app_metadata' ->> 'role' IN ('hospital', 'admin')
--   );
--
-- -- #4 accidents
-- DROP POLICY IF EXISTS "Authenticated users submit accident reports" ON accidents;
-- CREATE POLICY "Authenticated users submit accident reports" ON accidents
--   FOR INSERT
--   TO authenticated
--   WITH CHECK (
--     reporter_id = auth.uid()::text
--     AND status = 'pending'
--   );
--
-- -- #28 civic_issues
-- DROP POLICY IF EXISTS "Reporter edit own open civic issues" ON civic_issues;
-- DROP POLICY IF EXISTS "Admin update civic issues" ON civic_issues;
-- DROP POLICY IF EXISTS "Reporter or admin update civic issues" ON civic_issues;
-- CREATE POLICY "Reporter or admin update civic issues" ON civic_issues
--   FOR UPDATE
--   TO authenticated
--   USING (
--     reporter_id = auth.uid()::text
--     OR auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'
--   );
--
-- -- #5 table-wide SELECT again (the column grants left behind are then redundant)
-- GRANT SELECT ON public.accidents, public.hospitals, public.civic_issues TO anon, authenticated;
--
-- COMMIT;
