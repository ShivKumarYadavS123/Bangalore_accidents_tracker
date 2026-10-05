/**
 * Security batch 1, items 2, 4, 5 and 28 — row-level security policies and
 * column privileges. The SQL is never executed here (no database); these
 * checks read Database/schema.sql, Database/supabase-setup.sql and
 * Database/migrations/001_security_batch_1.sql, and scan the browser code for
 * direct Supabase table reads.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const schema = read('../../Database/schema.sql');
const setup = read('../../Database/supabase-setup.sql');
const emergency = read('../../Database/emergency.sql');
const migration = read('../../Database/migrations/001_security_batch_1.sql');
const rollback = migration.slice(migration.indexOf('-- BEGIN;')).replace(/^-- ?/gm, '');

const FILES = { 'schema.sql': schema, 'supabase-setup.sql': setup, 'migrations/001': migration };

/** SQL without "--" comments (none of these files use "--" inside a string). */
const code = (sql) => sql.replace(/--[^\n]*/g, '');

function policies(sql) {
  const re = /CREATE POLICY\s+"([^"]+)"\s+ON\s+([\w.]+)\s+FOR\s+(\w+)([\s\S]*?);/gi;
  return [...code(sql).matchAll(re)].map(m => ({ name: m[1], table: m[2].replace(/^public\./, ''), cmd: m[3].toUpperCase(), body: m[4] }));
}

/** Allow-lists from the column-privileges DO block: { table: [public columns] }. */
function publicColumns(sql) {
  const out = {};
  for (const m of code(sql).matchAll(/\('(\w+)',\s*ARRAY\[([^\]]*)\]\)/g)) out[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map(x => x[1]);
  return out;
}

const PRIVATE = {
  accidents: ['reporter_id', 'description', 'proof_url', 'rejection_reason', 'integrity', 'image_phash'],
  hospitals: ['email', 'webhook_url', 'er_status_updated_by'],
  civic_issues: ['reporter_id'],
};

/** Every direct Supabase table read in the browser code: table, select list, filter/order columns. */
function browserReads() {
  const root = new URL('../../Frontend/', import.meta.url);
  const files = [
    ...fs.readdirSync(new URL('js/', root)).filter(f => f.endsWith('.js')).map(f => new URL(`js/${f}`, root)),
    ...fs.readdirSync(root).filter(f => f.endsWith('.html')).map(f => new URL(f, root)),
  ];
  const reads = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?<!storage)\.from\(\s*['"`](\w+)['"`]\s*\)([\s\S]*?);/g)) {
      const [, table, chain] = m;
      if (/\.(insert|update|upsert|delete)\(/.test(chain)) continue; // writes are governed by policies, not SELECT grants
      const select = chain.match(/\.select\(\s*['"`]([^'"`]*)['"`]/);
      const filters = [...chain.matchAll(/\.(?:eq|neq|gt|gte|lt|lte|in|is|like|ilike|not|order|match|contains)\(\s*['"`](\w+)['"`]/g)].map(x => x[1]);
      reads.push({ where: `${file.pathname.split('/Frontend/')[1]} → ${table}`, table, select: select ? select[1] : null, filters });
    }
  }
  return reads;
}

describe('#2 emergency_alerts: no hospital SELECT / UPDATE policies', () => {
  it.each(Object.entries(FILES))('%s creates no policy on emergency_alerts', (_, sql) => {
    expect(policies(sql).filter(p => p.table === 'emergency_alerts')).toEqual([]);
  });

  it('the migration drops both hospital policies', () => {
    expect(code(migration)).toContain('DROP POLICY IF EXISTS "Hospital and admin read emergency alerts" ON emergency_alerts;');
    expect(code(migration)).toContain('DROP POLICY IF EXISTS "Hospital acknowledge emergency alerts" ON emergency_alerts;');
  });
});

describe('#4 accidents: no authenticated INSERT policy', () => {
  it.each(Object.entries(FILES))('%s creates no INSERT policy on accidents', (_, sql) => {
    expect(policies(sql).filter(p => p.table === 'accidents' && p.cmd === 'INSERT')).toEqual([]);
  });

  it('the migration drops it, and schema.sql keeps the other accidents policies', () => {
    expect(code(migration)).toContain('DROP POLICY IF EXISTS "Authenticated users submit accident reports" ON accidents;');
    expect(policies(schema).filter(p => p.table === 'accidents').map(p => p.cmd).sort()).toEqual(['DELETE', 'SELECT', 'UPDATE']);
  });
});

describe('#28 civic_issues: reporters cannot change status or the action note', () => {
  const clause = (body, kind) => {
    const m = kind === 'USING' ? body.match(/USING\s*\(([\s\S]*?)\)\s*WITH CHECK/) : body.match(/WITH CHECK\s*\(([\s\S]*)\)\s*$/);
    return m ? m[1] : '';
  };

  it.each(Object.entries(FILES))('%s: reporter UPDATE is limited to open issues with no note, before and after', (_, sql) => {
    const updates = policies(sql).filter(p => p.table === 'civic_issues' && p.cmd === 'UPDATE');
    expect(updates.map(p => p.name).sort()).toEqual(['Admin update civic issues', 'Reporter edit own open civic issues']);

    const reporter = updates.find(p => p.name.startsWith('Reporter'));
    for (const kind of ['USING', 'WITH CHECK']) {
      const c = clause(reporter.body, kind);
      expect(c, kind).toContain('reporter_id = auth.uid()::text');
      expect(c, kind).toContain("status = 'open'");
      expect(c, kind).toContain('action_note IS NULL');
      expect(c, kind).not.toMatch(/\bOR\b/i);
    }

    const admin = updates.find(p => p.name.startsWith('Admin'));
    for (const kind of ['USING', 'WITH CHECK']) {
      expect(clause(admin.body, kind).trim()).toBe("auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'");
    }
  });

  it('the old reporter-or-admin policy is dropped', () => {
    expect(code(migration)).toContain('DROP POLICY IF EXISTS "Reporter or admin update civic issues" ON civic_issues;');
  });
});

describe('#5 the anon key reads public columns only', () => {
  it.each(Object.entries(FILES))('%s revokes table-wide SELECT and grants an allow-list without private columns', (_, sql) => {
    const cols = publicColumns(sql);
    expect(Object.keys(cols).sort()).toEqual(['accidents', 'civic_issues', 'hospitals']);
    for (const [table, priv] of Object.entries(PRIVATE)) {
      expect(cols[table].filter(c => priv.includes(c)), table).toEqual([]);
    }
    expect(code(sql)).toContain("EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', t.tbl);");
    expect(code(sql)).toContain("EXECUTE format('GRANT SELECT (%s) ON public.%I TO anon, authenticated', pub_cols, t.tbl);");
  });

  it('the migration uses the same allow-lists as schema.sql', () => {
    expect(publicColumns(migration)).toEqual(publicColumns(schema));
  });

  it('the migration fails (and rolls back) if any private column is still readable', () => {
    const checked = [...code(migration).matchAll(/\('(\w+)', '(\w+)'\)/g)].map(m => `${m[1]}.${m[2]}`).sort();
    const expected = Object.entries(PRIVATE).flatMap(([t, cs]) => cs.map(c => `${t}.${c}`)).sort();
    expect(checked).toEqual(expected);
    expect(code(migration)).toMatch(/RAISE EXCEPTION 'Private column/);
  });

  it('every direct browser read lists its columns, and all of them are granted', () => {
    const reads = browserReads();
    const allowed = publicColumns(schema);
    expect(reads.map(r => r.table).sort()).toEqual(expect.arrayContaining(['accidents', 'civic_issues']));
    for (const r of reads) {
      expect(r.select, `${r.where}: select('*') or select() is refused by column grants`).toBeTruthy();
      expect(r.select.trim(), r.where).not.toBe('*');
      const used = [...r.select.split(',').map(s => s.trim()).filter(Boolean), ...r.filters];
      expect(allowed[r.table], `${r.where}: table has no allow-list`).toBeTruthy();
      expect(used.filter(c => !allowed[r.table].includes(c)), r.where).toEqual([]);
    }
  });
});

describe('migration file and drift', () => {
  it('runs in a single transaction', () => {
    const body = code(migration).trim();
    expect(body.startsWith('BEGIN;')).toBe(true);
    expect(body.endsWith('COMMIT;')).toBe(true);
  });

  it('has a rollback that restores every dropped policy and the table-wide SELECT', () => {
    const restored = policies(rollback).map(p => `${p.table}:${p.cmd}:${p.name}`).sort();
    expect(restored).toEqual([
      'accidents:INSERT:Authenticated users submit accident reports',
      'civic_issues:UPDATE:Reporter or admin update civic issues',
      'emergency_alerts:SELECT:Hospital and admin read emergency alerts',
      'emergency_alerts:UPDATE:Hospital acknowledge emergency alerts',
    ]);
    expect(code(rollback)).toContain('DROP POLICY IF EXISTS "Reporter edit own open civic issues" ON civic_issues;');
    expect(code(rollback)).toContain('DROP POLICY IF EXISTS "Admin update civic issues" ON civic_issues;');
    expect(code(rollback)).toContain('GRANT SELECT ON public.accidents, public.hospitals, public.civic_issues TO anon, authenticated;');
  });

  it('supabase-setup.sql is still exactly schema.sql followed by emergency.sql', () => {
    const s = setup.indexOf(schema);
    const e = setup.indexOf(emergency);
    expect(s).toBeGreaterThan(-1);
    expect(e).toBeGreaterThanOrEqual(s + schema.length);
  });
});
