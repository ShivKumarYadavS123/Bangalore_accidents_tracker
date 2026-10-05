import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import { OpenRouter } from '@openrouter/sdk';
import { createClient } from '@supabase/supabase-js';
import { notifyHospitals } from './notify.mjs';
import { safeFetch, readSafeResponseText } from './ssrf.js';
import { createEmergencyFeatures } from './emergency/index.mjs';
import { assessScenePhoto, processScenePhoto } from './emergency/vision.mjs';
import { createAiFeatures } from './ai/index.mjs';
import { ensureFreeModel } from './ai/llm.mjs';
import { resolveSupabaseConfig, parseTrustProxy } from './config.js';
import { readActiveAccidents, appendPublicAccident } from './accident-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// Supabase without the service-role key is a deployment mistake: refuse to
// start instead of quietly running every query with the anon key.
let supabaseConfig = null;
try {
  supabaseConfig = resolveSupabaseConfig(process.env);
} catch (e) {
  console.error(`Refusing to start: ${e.message}`);
  process.exit(1);
}
export const supabase = supabaseConfig ? createClient(supabaseConfig.url, supabaseConfig.key) : null;

const databaseUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
let pool = null;

if (databaseUrl) {
  try {
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.warn('PostgreSQL pool event error:', err.message);
    });
  } catch (err) {
    console.warn('PostgreSQL pool init failed, falling back to Supabase REST / local data:', err.message);
  }
}

const openrouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY
});

// ── Database & Fallback helpers ──────────────────────────────────────────────

async function q(text, params = []) {
  if (!pool) throw new Error('PostgreSQL pool is not configured');
  const res = await pool.query(text, params);
  return res.rows;
}

async function rpcResult(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0]?.result ?? null;
}

const JSON_PATH = path.join(__dirname, '..', 'Frontend', 'accident_data.json');

async function getAccidentsFC(from, to, severity, area, zone) {
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('get_accidents_fc', {
        p_from: from || null,
        p_to: to || null,
        p_severity: severity && severity !== 'all' ? severity : null,
        p_area: area && area !== 'all' ? area : null,
        p_zone: zone && zone !== 'all' ? zone : null
      });
      if (!error && data) return data;
      if (error) console.warn('Supabase get_accidents_fc RPC warning:', error.message);
    } catch (e) {
      console.warn('Supabase get_accidents_fc error:', e.message);
    }
  }
  if (pool) {
    try {
      return await rpcResult(
        `SELECT get_accidents_fc($1::text, $2::text, $3::text, $4::text, $5::text) AS result`,
        [from || null, to || null, severity && severity !== 'all' ? severity : null, area && area !== 'all' ? area : null, zone && zone !== 'all' ? zone : null]
      );
    } catch (e) { }
  }
  return null;
}

// Analytics RPC helpers — prefer server-side aggregation (Supabase RPC, then
// direct Postgres RPC) so full tables are never pulled into the client.
async function callStatsRpc(fnName) {
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc(fnName);
      if (!error && data) return data;
      if (error) console.warn(`Supabase ${fnName} RPC warning:`, error.message);
    } catch (e) {
      console.warn(`Supabase ${fnName} error:`, e.message);
    }
  }
  if (pool) {
    try {
      return await rpcResult(`SELECT ${fnName}() AS result`);
    } catch (e) { }
  }
  return null;
}

const getStatsMonthly = () => callStatsRpc('get_stats_monthly');
const getStatsByTimeRpc = () => callStatsRpc('get_stats_by_time');
const getStatsByAreaRpc = () => callStatsRpc('get_stats_by_area');

const app = express();
app.disable('x-powered-by');
// Off unless TRUST_PROXY is set. Behind a reverse proxy set it (usually 1) so
// rate limits see the client IP rather than the proxy's.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
const PORT = Number(process.env.PORT || 3000);

const defaultOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];
const corsOrigin = process.env.CORS_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = corsOrigin?.length ? corsOrigin : defaultOrigins;
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

// Security Headers
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  next();
});

// ── AI features (Ask BAT, risk prediction, safe routes, digest, integrity) ──
// Free services only: OpenRouter ":free" models, local ONNX models, OSRM + Nominatim.
const ai = createAiFeatures({ supabase, pool, jsonPath: JSON_PATH, cacheDir: path.join(__dirname, '.cache') });
app.use(ai.invalidateOnWrite);

// ── Emergency response (SOS → hospital dispatch → live ambulance tracking) ──
// Hospitals, alerts, accounts and coverage analytics live in ./emergency/.
const emergency = createEmergencyFeatures({
  pool,
  supabase,
  getAccidents: () => ai.dataset.active(),
  reverseGeocode,
  notify: notifyHospitals,
  vision: assessScenePhoto,
  imageProcessor: processScenePhoto,
  cacheDir: path.join(__dirname, '.cache'),
  hospitalsJsonPath: path.join(__dirname, 'seed-hospitals.json'),
  config: { publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '') },
});

// Rate limiting for public API endpoints (100 requests per 15 minutes per IP)
const limiterPublic = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Mutating public-safety routes are deliberately tighter than map reads.
const limiterContributions = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

const limiterAdminSlug = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Discrete Admin Access ───────────────────────────────────────────────────

const frontendDir = path.join(__dirname, '..', 'Frontend');
const ADMIN_SLUG = process.env.ADMIN_SLUG || '';

app.get('/admin.html', (_req, res) => res.status(404).send('Not Found'));

app.get('/manage-:slug', limiterAdminSlug, (req, res) => {
  const requestSlug = req.params.slug || '';
  if (!ADMIN_SLUG || requestSlug.length !== ADMIN_SLUG.length) {
    return res.status(404).send('Not Found');
  }
  const requestBuf = Buffer.from(requestSlug, 'utf8');
  const expectedBuf = Buffer.from(ADMIN_SLUG, 'utf8');
  if (!crypto.timingSafeEqual(requestBuf, expectedBuf)) {
    return res.status(404).send('Not Found');
  }
  res.sendFile(path.join(frontendDir, 'admin.html'));
});

if (fs.existsSync(frontendDir)) {
  app.use(express.static(frontendDir));
  console.log(`Serving Frontend at http://localhost:${PORT}/dashboard.html`);
}

// ── JWT Middleware ──────────────────────────────────────────────────────────

/**
 * Validates a bearer token with Supabase Auth. Decoding a JWT only reveals
 * its contents; it never proves who signed it. getUser() verifies the token
 * with Supabase before any role or user id is trusted.
 */
async function validateJwt(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing authentication credentials' });
  }

  const token = auth.slice(7);

  // Local/offline dev fallback tokens created in the browser when Supabase is
  // unreachable. These tokens are intentionally not JWTs and carry no proof of
  // identity, so they are honoured only when this server has no Supabase
  // configured (fresh-clone / offline dev). With Supabase they would let anyone
  // act as any user id.
  if (token.startsWith('devtoken_')) {
    if (supabase) return res.status(401).json({ error: 'Authentication failed' });
    const userId = token.slice('devtoken_'.length) || 'anonymous-dev-user';
    req.jwtPayload = {
      sub: userId,
      role: 'authenticated',
      app_metadata: { role: 'authenticated' },
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    };
    return next();
  }

  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return res.status(401).json({ error: 'Authentication failed' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Authentication service is not configured' });
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Authentication failed' });
    }

    // Claims are read only after the signature and issuer have been verified.
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const payload = {
      ...claims,
      sub: data.user.id,
      role: data.user.role,
      app_metadata: data.user.app_metadata || {},
      user_metadata: data.user.user_metadata || {},
    };

    if (payload.exp) {
      const now = Math.floor(Date.now() / 1000);
      if (now > payload.exp + 30) {
        return res.status(401).json({ error: 'Authentication failed' });
      }
    }

    req.jwtPayload = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * Requires admin role from JWT payload.
 * Supabase stores custom roles in app_metadata.role.
 */
function requireAdmin(req, res, next) {
  const payload = req.jwtPayload;
  const role = payload?.role;
  const appRole = payload?.app_metadata?.role;

  if (!payload || (role !== 'admin' && appRole !== 'admin')) {
    return res.status(403).json({ error: 'insufficient permissions' });
  }

  if (payload.iat) {
    const now = Math.floor(Date.now() / 1000);
    if (now - payload.iat > 12 * 3600) {
      return res.status(401).json({ error: 'Authentication failed' });
    }
  }

  next();
}

const adminAuth = [validateJwt, requireAdmin];

// ── Public Routes ──────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/accidents', limiterPublic, async (req, res) => {
  try {
    const { from, to, severity, area, zone } = req.query;
    let data = null;

    try {
      data = await getAccidentsFC(from, to, severity, area, zone);
    } catch (dbErr) {
      // Database query failed
    }

    if (!data || !data.features || !data.features.length) {
      // Fallback to the local JSON copy (public, status 'active' records only)
      try {
        let list = readActiveAccidents(JSON_PATH);
        if (severity && severity !== 'all') list = list.filter(d => d.severity === severity);
        if (area && area !== 'all') list = list.filter(d => d.area === area);
        if (zone && zone !== 'all') list = list.filter(d => d.zone === zone);
        if (from) list = list.filter(d => !d.date || d.date >= from);
        if (to) list = list.filter(d => !d.date || d.date <= to);

        const features = list
          .filter(d => d.hasCoords && d.lat != null && d.lng != null)
          .map(d => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
            properties: {
              id: String(d.id),
              title: d.title,
              source: d.source,
              link: d.link,
              location: d.location,
              area: d.area,
              zone: d.zone,
              severity: d.severity,
              score: d.score,
              date: d.date || '—',
              isUser: Boolean(d.isUser || d.reporter_id)
            }
          }));
        data = { type: 'FeatureCollection', features };
      } catch (jsonErr) {
        console.error('Fallback accidents error:', jsonErr.message);
      }
    }

    // Support CSV export as a convenience: ?format=csv
    const format = (req.query.format || '').toLowerCase();
    if (format === 'csv') {
      const fc = data || {};
      const features = Array.isArray(fc.features) ? fc.features : [];
      const esc = v => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        if (s.includes(',') || s.includes('\"') || s.includes('\n') || s.includes('"')) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      };
      const rows = [];
      rows.push(['id', 'date', 'severity', 'area', 'zone', 'lat', 'lng', 'location'].join(','));
      for (const f of features) {
        const p = f.properties || {};
        const g = f.geometry || {};
        const lng = g.coordinates?.[0] ?? '';
        const lat = g.coordinates?.[1] ?? '';
        rows.push([esc(p.id), esc(p.date), esc(p.severity), esc(p.area), esc(p.zone), esc(lat), esc(lng), esc(p.location)].join(','));
      }
      const csv = '\uFEFF' + rows.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="accidents.csv"');
      return res.send(csv);
    }

    res.json(data || { type: 'FeatureCollection', features: [] });
  } catch (e) {
    console.error('/api/accidents error:', e.message);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

app.get('/api/meta', limiterPublic, async (_req, res) => {
  try {
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('accidents')
          .select('area, zone, severity')
          .eq('status', 'active');
        if (!error && data && data.length > 0) {
          const areas = [...new Set(data.map(d => d.area).filter(Boolean))].sort();
          const zones = [...new Set(data.map(d => d.zone).filter(Boolean))].sort();
          const counts = {
            total: data.length,
            fatal: data.filter(d => d.severity === 'fatal').length,
            serious: data.filter(d => d.severity === 'serious').length,
            minor: data.filter(d => d.severity === 'minor').length,
          };
          return res.json({ areas, zones, counts });
        }
      } catch (sbErr) {
        console.warn('Supabase meta error:', sbErr.message);
      }
    }

    if (pool) {
      try {
        const [areas, zones, counts] = await Promise.all([
          q(`SELECT DISTINCT area FROM accidents WHERE geom IS NOT NULL AND status = 'active' AND area IS NOT NULL ORDER BY area`),
          q(`SELECT DISTINCT zone FROM accidents WHERE geom IS NOT NULL AND status = 'active' AND zone IS NOT NULL ORDER BY zone`),
          q(`SELECT
               count(*) AS total,
               count(*) FILTER (WHERE severity = 'fatal')   AS fatal,
               count(*) FILTER (WHERE severity = 'serious') AS serious,
               count(*) FILTER (WHERE severity = 'minor')   AS minor
             FROM accidents WHERE geom IS NOT NULL AND status = 'active'`),
        ]);
        return res.json({
          areas: areas.map(r => r.area),
          zones: zones.map(r => r.zone),
          counts: {
            total: Number(counts[0]?.total || 0),
            fatal: Number(counts[0]?.fatal || 0),
            serious: Number(counts[0]?.serious || 0),
            minor: Number(counts[0]?.minor || 0),
          },
        });
      } catch (dbErr) { }
    }

    const data = readActiveAccidents(JSON_PATH);
    const areas = [...new Set(data.map(d => d.area).filter(Boolean))].sort();
    const zones = [...new Set(data.map(d => d.zone).filter(Boolean))].sort();
    const counts = {
      total: data.length,
      fatal: data.filter(d => d.severity === 'fatal').length,
      serious: data.filter(d => d.severity === 'serious').length,
      minor: data.filter(d => d.severity === 'minor').length,
    };
    res.json({ areas, zones, counts });
  } catch (e) {
    console.error('/api/meta error:', e.message);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

// ── Analytics / Trends Endpoints ──────────────────────────────────────────

app.get('/api/stats/trends', limiterPublic, async (_req, res) => {
  try {
    const rpcData = await getStatsMonthly();
    if (rpcData) return res.json(rpcData);

    // Fallback: aggregate in Node if the RPC isn't available yet (e.g. schema.sql not run).
    let rows = [];
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('accidents')
          .select('accident_date, date_raw, severity')
          .eq('status', 'active');
        if (!error && data && data.length) rows = data;
      } catch (sbErr) {
        console.warn('Supabase trends error:', sbErr.message);
      }
    }

    if (!rows.length) {
      rows = readActiveAccidents(JSON_PATH);
    }

    const monthly = {};
    for (const d of rows) {
      const dt = d.accident_date || d.date || d.date_raw;
      if (!dt || typeof dt !== 'string') continue;
      const m = dt.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(m)) continue;
      if (!monthly[m]) monthly[m] = { month: m, total: 0, fatal: 0, serious: 0, minor: 0 };
      monthly[m].total++;
      if (d.severity === 'fatal') monthly[m].fatal++;
      else if (d.severity === 'serious') monthly[m].serious++;
      else monthly[m].minor++;
    }
    const result = Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month));
    res.json(result);
  } catch (e) {
    console.error('/api/stats/trends error:', e.message);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

app.get('/api/stats/by-time', limiterPublic, async (_req, res) => {
  try {
    const rpcData = await getStatsByTimeRpc();
    if (rpcData) return res.json(rpcData);

    // Fallback: aggregate in Node if the RPC isn't available yet (e.g. schema.sql not run).
    let rows = [];
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('accidents')
          .select('accident_date, date_raw')
          .eq('status', 'active');
        if (!error && data && data.length) rows = data;
      } catch (sbErr) {
        console.warn('Supabase by-time error:', sbErr.message);
      }
    }

    if (!rows.length) {
      rows = readActiveAccidents(JSON_PATH);
    }

    const byHour = new Array(24).fill(0);
    const byDay = new Array(7).fill(0);
    const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const d of rows) {
      let dow = null;
      const dtStr = d.accident_date || d.date || d.date_raw;
      if (dtStr) {
        const dt = new Date(dtStr);
        if (!isNaN(dt.getTime())) {
          dow = dt.getDay();
          byDay[dow]++;
        }
      }
      const raw = String(d.date_raw || d.time || '');
      const m = raw.match(/([0-2]?[0-9]):([0-5][0-9])/);
      let hour = null;
      if (m) {
        hour = parseInt(m[1], 10);
        if (hour >= 0 && hour < 24) byHour[hour]++;
        else hour = null;
      }
      if (dow !== null && hour !== null) matrix[dow][hour]++;
    }
    res.json({ byHour, byDay, matrix });
  } catch (e) {
    console.error('/api/stats/by-time error:', e.message);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

app.get('/api/stats/by-area', limiterPublic, async (_req, res) => {
  try {
    const rpcData = await getStatsByAreaRpc();
    if (rpcData) return res.json(rpcData);

    // Fallback: aggregate in Node if the RPC isn't available yet (e.g. schema.sql not run).
    let rows = [];
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('accidents')
          .select('area, zone, severity')
          .eq('status', 'active');
        if (!error && data && data.length) rows = data;
      } catch (sbErr) {
        console.warn('Supabase by-area error:', sbErr.message);
      }
    }

    if (!rows.length) {
      rows = readActiveAccidents(JSON_PATH);
    }

    const map = {};
    for (const d of rows) {
      const area = d.area || 'Unknown';
      const zone = d.zone || 'Unknown';
      const k = `${area}||${zone}`;
      if (!map[k]) map[k] = { area, zone, total: 0, fatal: 0, serious: 0, minor: 0 };
      map[k].total++;
      if (d.severity === 'fatal') map[k].fatal++;
      else if (d.severity === 'serious') map[k].serious++;
      else map[k].minor++;
    }
    const result = Object.values(map).sort((a, b) => b.total - a.total);
    res.json(result);
  } catch (e) {
    console.error('/api/stats/by-area error:', e.message);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

// ── Explainable risk outlook ──────────────────────────────────────────────
// This is intentionally a transparent historical-risk score, not a claim that
// an individual crash will occur. The factors returned let the UI explain every
// score to the public.
async function loadRiskRows() {
  if (pool) {
    try {
      return await q(`SELECT area, zone, severity, accident_date, date_raw FROM accidents
                       WHERE status = 'active' AND geom IS NOT NULL`);
    } catch (_) { }
  }
  if (supabase) {
    try {
      const { data, error } = await supabase.from('accidents')
        .select('area, zone, severity, accident_date, date_raw')
        .eq('status', 'active').not('geom', 'is', null);
      if (!error && data) return data;
    } catch (_) { }
  }
  try { return readActiveAccidents(JSON_PATH); } catch (_) { return []; }
}

app.get('/api/risk/hotspots', limiterPublic, async (req, res) => {
  try {
    const hour = Number.isInteger(Number(req.query.hour)) ? Math.min(23, Math.max(0, Number(req.query.hour))) : new Date().getHours();
    const groups = new Map();
    for (const row of await loadRiskRows()) {
      const area = row.area || 'Unknown area';
      const zone = row.zone || inferZone(area);
      const item = groups.get(area) || { area, zone, incidents: 0, weighted: 0, critical: 0, hourMatches: 0, latest: null };
      item.incidents += 1;
      item.weighted += row.severity === 'fatal' ? 5 : row.severity === 'serious' ? 3 : 1;
      if (row.severity === 'fatal') item.critical += 1;
      const time = String(row.date_raw || '').match(/(?:^|\s)([0-2]?\d):[0-5]\d/);
      if (time && Number(time[1]) === hour) item.hourMatches += 1;
      const date = String(row.accident_date || row.date || '').slice(0, 10);
      if (date && (!item.latest || date > item.latest)) item.latest = date;
      groups.set(area, item);
    }
    const maxWeighted = Math.max(1, ...[...groups.values()].map(x => x.weighted));
    const hotspots = [...groups.values()].map(item => {
      const score = Math.min(100, Math.round((item.weighted / maxWeighted) * 78 + Math.min(12, item.hourMatches * 3) + Math.min(10, item.critical * 2)));
      const factors = [];
      if (item.critical) factors.push(`${item.critical} recorded fatal incident${item.critical === 1 ? '' : 's'}`);
      if (item.hourMatches) factors.push(`${item.hourMatches} incident${item.hourMatches === 1 ? '' : 's'} recorded around ${String(hour).padStart(2, '0')}:00`);
      factors.push(`${item.incidents} recorded incident${item.incidents === 1 ? '' : 's'} overall`);
      return { ...item, risk_score: score, risk_level: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low', factors };
    }).sort((a, b) => b.risk_score - a.risk_score).slice(0, 12);
    res.json({ generated_at: new Date().toISOString(), hour, methodology: 'Historical severity-weighted incident concentration; not a real-time prediction.', hotspots });
  } catch (e) {
    console.error('/api/risk/hotspots error:', e.message);
    res.status(500).json({ error: 'Failed to build risk outlook' });
  }
});

// ── Civic action tracker and near-miss signals ────────────────────────────
// Uses the direct Postgres pool when DATABASE_URL is set, else Supabase REST.
const CIVIC_COLUMNS = 'id, type, title, description, area, lat, lng, status, action_note, created_at, updated_at';
const CIVIC_STATUS_ORDER = { open: 0, in_progress: 1, resolved: 2 };

app.get('/api/civic/issues', limiterPublic, async (_req, res) => {
  try {
    let rows;
    if (pool) {
      rows = await q(`SELECT ${CIVIC_COLUMNS} FROM civic_issues
                      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, created_at DESC LIMIT 200`);
    } else if (supabase) {
      const { data, error } = await supabase.from('civic_issues').select(CIVIC_COLUMNS)
        .order('created_at', { ascending: false }).limit(200);
      if (error) throw new Error(error.message);
      rows = (data || []).sort((a, b) => (CIVIC_STATUS_ORDER[a.status] ?? 3) - (CIVIC_STATUS_ORDER[b.status] ?? 3));
    } else {
      throw new Error('No database configured');
    }
    res.json(rows || []);
  } catch (e) {
    console.error('/api/civic/issues error:', e.message);
    res.status(500).json({ error: 'Civic tracking is not configured. Run the latest schema migration.' });
  }
});

app.post('/api/civic/issues', limiterContributions, validateJwt, async (req, res) => {
  const { type, title, description, area, lat, lng } = req.body || {};
  if (!['near_miss', 'road_hazard', 'action_request'].includes(type)) return res.status(400).json({ error: 'Invalid issue type' });
  if (!title || String(title).trim().length < 5 || String(title).trim().length > 120) return res.status(400).json({ error: 'Title must be 5–120 characters' });
  if (!description || String(description).trim().length < 20 || String(description).trim().length > 1000) return res.status(400).json({ error: 'Description must be 20–1000 characters' });
  const latN = Number(lat), lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN) || latN < 12.5 || latN > 13.5 || lngN < 77 || lngN > 78.2) return res.status(400).json({ error: 'A valid Bangalore location is required' });
  try {
    const row = {
      id: `civ_${crypto.randomUUID()}`, type, title: String(title).trim(), description: String(description).trim(),
      area: String(area || '').trim() || null, lat: latN, lng: lngN, reporter_id: req.jwtPayload.sub,
    };
    if (pool) {
      await q(`INSERT INTO civic_issues (id, type, title, description, area, lat, lng, reporter_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [row.id, row.type, row.title, row.description, row.area, row.lat, row.lng, row.reporter_id]);
    } else if (supabase) {
      const { error } = await supabase.from('civic_issues').insert(row);
      if (error) throw new Error(error.message);
    } else {
      throw new Error('No database configured');
    }
    res.status(201).json({ id: row.id, status: 'open' });
  } catch (e) {
    console.error('/api/civic/issues POST error:', e.message);
    res.status(500).json({ error: 'Could not create civic issue' });
  }
});

app.patch('/api/civic/issues/:id', adminAuth, async (req, res) => {
  const { status, action_note } = req.body || {};
  if (!['open', 'in_progress', 'resolved'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    let rows;
    if (pool) {
      rows = await q(`UPDATE civic_issues SET status = $2, action_note = $3, updated_at = now() WHERE id = $1
                      RETURNING id, status, action_note, updated_at`, [req.params.id, status, action_note || null]);
    } else if (supabase) {
      const { data, error } = await supabase.from('civic_issues')
        .update({ status, action_note: action_note || null, updated_at: new Date().toISOString() })
        .eq('id', req.params.id).select('id, status, action_note, updated_at');
      if (error) throw new Error(error.message);
      rows = data || [];
    } else {
      throw new Error('No database configured');
    }
    if (!rows.length) return res.status(404).json({ error: 'Issue not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('/api/civic/issues PATCH error:', e.message);
    res.status(500).json({ error: 'Could not update civic issue' });
  }
});

// Export current filters as GeoJSON file
app.get('/api/export/geojson', limiterPublic, async (req, res) => {
  try {
    const { from, to, severity, area, zone } = req.query;
    const data = await getAccidentsFC(from, to, severity, area, zone);
    const geojson = data || { type: 'FeatureCollection', features: [] };
    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="accidents.geojson"');
    res.send(JSON.stringify(geojson));
  } catch (e) {
    console.error('/api/export/geojson error:', e.message);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

// ── User Report Submission ─────────────────────────────────────────────────

function validateReportFields(body) {
  const errors = [];
  const { latitude, longitude, location, area, severity, date, description } = body || {};

  if (latitude === undefined || latitude === null || latitude === '') {
    errors.push('latitude is required');
  } else {
    const lat = parseFloat(latitude);
    if (isNaN(lat) || lat < 12.5 || lat > 13.5) {
      errors.push('latitude must be between 12.5 and 13.5 (Bangalore metropolitan region)');
    }
  }

  if (longitude === undefined || longitude === null || longitude === '') {
    errors.push('longitude is required');
  } else {
    const lng = parseFloat(longitude);
    if (isNaN(lng) || lng < 77.0 || lng > 78.2) {
      errors.push('longitude must be between 77.0 and 78.2 (Bangalore metropolitan region)');
    }
  }

  if (!location || typeof location !== 'string' || location.trim().length === 0) {
    errors.push('location is required');
  } else if (location.trim().length > 100) {
    errors.push('location must be between 1 and 100 characters');
  }

  if (!area || typeof area !== 'string' || area.trim().length === 0) {
    errors.push('area is required');
  } else if (area.trim().length > 60) {
    errors.push('area must be between 1 and 60 characters');
  }

  if (!severity) {
    errors.push('severity is required');
  } else if (!['fatal', 'serious', 'minor'].includes(severity)) {
    errors.push('severity must be one of: fatal, serious, minor');
  }

  if (!date) {
    errors.push('date is required');
  }

  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    errors.push('description is required');
  } else if (description.trim().length < 20) {
    errors.push('description must be between 20 and 500 characters');
  } else if (description.trim().length > 500) {
    errors.push('description must be between 20 and 500 characters');
  }

  return { valid: errors.length === 0, errors };
}

app.post('/api/reports', limiterContributions, validateJwt, async (req, res) => {
  try {
    const validation = validateReportFields(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    }

    const { latitude, longitude, location, area, severity, date, description, proof_url, time } = req.body;
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const reporterId = req.jwtPayload.sub;
    // Keep the reported time of day (HH:MM) in date_raw so hour-of-day analytics
    // (get_stats_by_time, Ask BAT, risk-by-hour) can use it.
    const timeOfDay = typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time.trim()) ? time.trim() : null;

    const nextId = await nextAccidentId(`rpt_${Date.now()}`);

    const wkt = `SRID=4326;POINT(${lng} ${lat})`;
    const newRecord = {
      id: nextId,
      title: `User Report: ${location.trim()}`,
      source: 'User Report',
      link: null,
      location: location.trim(),
      area: area.trim(),
      zone: inferZone(area),
      severity,
      score: severity === 'fatal' ? 10 : severity === 'serious' ? 5 : 1,
      date_raw: timeOfDay ? `${date} ${timeOfDay}` : date,
      accident_date: date,
      has_coords: true,
      geom: wkt,
      status: 'pending',
      reporter_id: reporterId,
      description: description.trim(),
      proof_url: typeof proof_url === 'string' ? proof_url : null
    };

    let saved = false;
    if (supabase) {
      try {
        const { error: insErr } = await supabase.from('accidents').insert({
          id: newRecord.id,
          title: newRecord.title,
          source: newRecord.source,
          link: newRecord.link,
          location: newRecord.location,
          area: newRecord.area,
          zone: newRecord.zone,
          severity: newRecord.severity,
          score: newRecord.score,
          date_raw: newRecord.date_raw,
          accident_date: newRecord.accident_date,
          has_coords: newRecord.has_coords,
          status: newRecord.status,
          reporter_id: newRecord.reporter_id,
          description: newRecord.description,
          proof_url: newRecord.proof_url
        });
        if (insErr) console.error('Supabase report insert error:', insErr.message);
        if (!insErr) {
          saved = true;
          // PostgREST can't accept raw PostGIS WKT for a `geometry` column via
          // a JSON insert, so set the pin location via RPC right afterwards.
          try {
            const { error: geomErr } = await supabase.rpc('set_accident_geom', { p_id: newRecord.id, p_lat: lat, p_lng: lng });
            if (geomErr) console.error('set_accident_geom RPC error:', geomErr.message);
          } catch (geomEx) {
            console.error('set_accident_geom RPC exception:', geomEx.message);
          }
        }
      } catch (e) {
        console.warn('Supabase report insert error:', e.message);
      }
    }

    if (!saved && pool) {
      try {
        await q(
          `INSERT INTO accidents (id, title, source, link, location, area, zone, severity, score, date_raw, accident_date, has_coords, geom, status, reporter_id, description, proof_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::geometry, $14, $15, $16, $17)`,
          [newRecord.id, newRecord.title, newRecord.source, newRecord.link, newRecord.location, newRecord.area, newRecord.zone, newRecord.severity, newRecord.score, newRecord.date_raw, newRecord.accident_date, newRecord.has_coords, newRecord.geom, newRecord.status, newRecord.reporter_id, newRecord.description, newRecord.proof_url]
        );
        saved = true;
      } catch (e) {
        console.error('Report insert error:', e.message);
      }
    }

    if (saved) {
      // User reports live in the database only; the public JSON copy never gets them.
      // Background duplicate / spam / fake-image screening for the moderation queue.
      ai.onReportCreated(nextId);
      return res.status(201).json({ id: nextId });
    }

    return res.status(500).json({ error: 'Report could not be saved' });
  } catch (e) {
    console.error('POST /api/reports error:', e.message);
    return res.status(500).json({ error: 'Report could not be saved' });
  }
});

app.get('/api/reports/mine', validateJwt, async (req, res) => {
  try {
    const userId = req.jwtPayload.sub;
    if (supabase) {
      try {
        const { data: rows, error } = await supabase
          .from('accidents')
          .select('*')
          .eq('reporter_id', userId)
          .order('accident_date', { ascending: false });
        if (!error && rows) {
          const reports = rows.map(report => {
            let lat = null, lng = null;
            if (report.geom) {
              if (typeof report.geom === 'object' && report.geom.coordinates) {
                lng = report.geom.coordinates[0];
                lat = report.geom.coordinates[1];
              } else if (typeof report.geom === 'string') {
                const m = report.geom.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
                if (m) { lng = parseFloat(m[1]); lat = parseFloat(m[2]); }
              }
            }
            return {
              id: report.id,
              title: report.title,
              location: report.location,
              area: report.area,
              severity: report.severity,
              date: report.accident_date,
              status: report.status === 'active' ? 'verified'
                : report.status === 'hidden' ? 'rejected'
                  : report.status || 'pending',
              description: report.description,
              proof_url: report.proof_url || null,
              latitude: lat,
              longitude: lng
            };
          });
          return res.json(reports);
        }
      } catch (sbErr) {
        console.warn('Supabase reports/mine error:', sbErr.message);
      }
    }

    if (pool) {
      const data = await q(
        `SELECT id, title, location, area, severity, accident_date, status, description, proof_url,
                ST_Y(geom) AS latitude, ST_X(geom) AS longitude
         FROM accidents WHERE reporter_id = $1 ORDER BY accident_date DESC NULLS LAST`,
        [userId]
      );

      const reports = (data || []).map(report => ({
        id: report.id,
        title: report.title,
        location: report.location,
        area: report.area,
        severity: report.severity,
        date: report.accident_date,
        status: report.status === 'active' ? 'verified'
          : report.status === 'hidden' ? 'rejected'
            : report.status || 'pending',
        description: report.description,
        proof_url: report.proof_url || null,
        latitude: report.latitude === null ? null : Number(report.latitude),
        longitude: report.longitude === null ? null : Number(report.longitude)
      }));

      return res.json(reports);
    }

    return res.json([]);
  } catch (e) {
    console.error('GET /api/reports/mine error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// ── Admin Routes ───────────────────────────────────────────────────────────

app.get('/api/admin/me', adminAuth, (req, res) => {
  res.json({ ok: true, user: req.jwtPayload.sub || req.jwtPayload.email || 'admin' });
});

app.get('/api/admin/config', adminAuth, (_req, res) => {
  res.json({ mapboxToken: process.env.MAPBOX_ACCESS_TOKEN || '' });
});

app.get('/api/admin/accidents', adminAuth, async (req, res) => {
  try {
    const { search, status, severity, sortBy = 'accident_date', sortOrder = 'desc' } = req.query;
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    if (supabase) {
      try {
        let query = supabase.from('accidents').select('*', { count: 'exact' });
        // (description, created_at, reporter_id, proof_url are included via '*')
        if (status && status !== 'all') query = query.eq('status', status);
        if (severity && severity !== 'all') query = query.eq('severity', severity);
        if (search) {
          query = query.or(`title.ilike.%${search}%,location.ilike.%${search}%,area.ilike.%${search}%`);
        }
        const finalSortBy = ['id', 'accident_date', 'severity', 'score'].includes(sortBy) ? sortBy : 'accident_date';
        query = query.order(finalSortBy, { ascending: sortOrder === 'asc', nullsFirst: false })
          .range(offset, offset + limitNum - 1);

        const { data: rows, count, error } = await query;
        if (!error && rows) {
          const mapped = rows.map(r => {
            let lat = null, lng = null;
            if (r.geom) {
              if (typeof r.geom === 'object' && r.geom.coordinates) {
                lng = r.geom.coordinates[0];
                lat = r.geom.coordinates[1];
              } else if (typeof r.geom === 'string') {
                const m = r.geom.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
                if (m) { lng = parseFloat(m[1]); lat = parseFloat(m[2]); }
              }
            }
            return {
              id: r.id,
              title: r.title,
              source: r.source,
              link: r.link,
              location: r.location,
              area: r.area,
              zone: r.zone,
              severity: r.severity,
              score: r.score,
              status: r.status,
              date: r.accident_date,
              date_raw: r.date_raw,
              lat,
              lng,
              reporter_id: r.reporter_id || null,
              rejection_reason: r.rejection_reason || null,
              proof_url: r.proof_url || null,
              description: r.description || null,
              created_at: r.created_at || null
            };
          });
          return res.json({ total: count ?? mapped.length, page: pageNum, limit: limitNum, rows: mapped });
        }
      } catch (sbErr) {
        console.warn('Supabase admin/accidents error:', sbErr.message);
      }
    }

    if (pool) {
      const where = [];
      const params = [];
      if (status && status !== 'all') { params.push(status); where.push(`status = $${params.length}`); }
      if (severity && severity !== 'all') { params.push(severity); where.push(`severity = $${params.length}`); }
      if (search) { params.push(`%${search}%`); where.push(`(title ILIKE $${params.length} OR location ILIKE $${params.length} OR area ILIKE $${params.length})`); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const finalSortBy = ['id', 'accident_date', 'severity', 'score'].includes(sortBy) ? sortBy : 'accident_date';
      const dir = sortOrder === 'asc' ? 'ASC' : 'DESC';

      const rows = await q(
        `SELECT id, title, source, link, location, area, zone, severity, score, status,
                accident_date, date_raw, ST_AsGeoJSON(geom) AS geom, reporter_id, rejection_reason, proof_url,
                description, created_at,
                count(*) OVER() AS total
         FROM accidents ${whereSql}
         ORDER BY ${finalSortBy} ${dir} NULLS LAST
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      );

      const total = rows.length ? Number(rows[0].total) : 0;
      const mapped = rows.map(r => {
        const g = r.geom ? JSON.parse(r.geom) : null;
        const lat = g?.coordinates?.[1] ?? null;
        const lng = g?.coordinates?.[0] ?? null;
        return { id: r.id, title: r.title, source: r.source, link: r.link, location: r.location, area: r.area, zone: r.zone, severity: r.severity, score: r.score, status: r.status, date: r.accident_date, date_raw: r.date_raw, lat, lng, reporter_id: r.reporter_id || null, rejection_reason: r.rejection_reason || null, proof_url: r.proof_url || null, description: r.description || null, created_at: r.created_at || null };
      });

      return res.json({ total, page: pageNum, limit: limitNum, rows: mapped });
    }

    return res.json({ total: 0, page: pageNum, limit: limitNum, rows: [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

app.patch('/api/admin/accidents/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, lat, lng, location, area, rejection_reason } = req.body || {};
    const updates = {};

    if (status !== undefined) {
      if (!['active', 'hidden'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
      updates.status = status;
      if (status === 'active') updates.rejection_reason = null;
      if (status === 'hidden' && rejection_reason !== undefined) updates.rejection_reason = rejection_reason;
    }

    let latN = undefined, lngN = undefined;
    if (lat !== undefined && lng !== undefined) {
      latN = parseFloat(lat);
      lngN = parseFloat(lng);
      if (isNaN(latN) || isNaN(lngN)) return res.status(400).json({ error: 'Invalid coords' });
      updates.has_coords = true;

      // Reverse geocode new address & area if location was not explicitly provided (e.g. pin drag-and-drop)
      if (!location) {
        try {
          const geoInfo = await reverseGeocodeDetails(latN, lngN);
          if (geoInfo) {
            if (geoInfo.location) updates.location = geoInfo.location;
            if (geoInfo.area && !area) {
              updates.area = geoInfo.area;
              updates.zone = inferZone(geoInfo.area);
            }
          }
        } catch (e) {
          console.warn('Reverse geocode warning during patch:', e.message);
        }
      }
    }

    if (location !== undefined) updates.location = location;
    if (area !== undefined) {
      updates.area = area;
      updates.zone = inferZone(area);
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

    // 1. Supabase update with native GeoJSON Point
    if (supabase) {
      try {
        const sbUpdates = { ...updates };
        if (latN !== undefined && lngN !== undefined) {
          sbUpdates.geom = { type: 'Point', coordinates: [lngN, latN] };
        }
        const { error: sbErr } = await supabase.from('accidents').update(sbUpdates).eq('id', String(id));
        if (sbErr) console.warn('Supabase patch error:', sbErr.message);
      } catch (sbErr) {
        console.warn('Supabase patch exception:', sbErr.message);
      }
    }

    // 2. Direct Postgres Pool update (if pool is active)
    if (pool) {
      try {
        const poolUpdates = { ...updates };
        if (latN !== undefined && lngN !== undefined) {
          poolUpdates.geom = `SRID=4326;POINT(${lngN} ${latN})`;
        }
        const sets = [];
        const params = [];
        for (const [k, v] of Object.entries(poolUpdates)) {
          params.push(v);
          sets.push(`${k} = $${params.length}${k === 'geom' ? '::geometry' : ''}`);
        }
        params.push(String(id));
        await q(`UPDATE accidents SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      } catch (poolErr) {
        console.warn('PostgreSQL pool patch error:', poolErr.message);
      }
    }

    // 3. Sync to local accident_data.json fallback
    syncPatchToJson(id, {
      lat: latN,
      lng: lngN,
      location: updates.location,
      area: updates.area,
      zone: updates.zone,
      status: updates.status
    });

    res.json({
      ok: true,
      accident: {
        id,
        lat: latN,
        lng: lngN,
        location: updates.location,
        area: updates.area,
        zone: updates.zone,
        status: updates.status
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

app.delete('/api/admin/accidents/:id', adminAuth, async (req, res) => {
  try {
    if (supabase) {
      try {
        await supabase.from('accidents').delete().eq('id', req.params.id);
      } catch (sbErr) {
        console.warn('Supabase delete error:', sbErr.message);
      }
    }
    if (pool) {
      await q(`DELETE FROM accidents WHERE id = $1`, [req.params.id]);
    }
    syncDeleteToJson(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

// Get pending reports (user-submitted) for admin review
app.get('/api/admin/reports/pending', adminAuth, async (_req, res) => {
  try {
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('accidents')
          .select('id, title, location, area, severity, accident_date, reporter_id, description')
          .eq('status', 'pending')
          .not('reporter_id', 'is', null)
          .order('accident_date', { ascending: false });
        if (!error && data) return res.json(data);
      } catch (sbErr) {
        console.warn('Supabase admin/reports/pending error:', sbErr.message);
      }
    }

    if (pool) {
      const data = await q(
        `SELECT id, title, location, area, severity, accident_date, reporter_id, description
         FROM accidents
         WHERE status = 'pending' AND reporter_id IS NOT NULL
         ORDER BY accident_date DESC NULLS LAST`
      );
      return res.json(data || []);
    }

    res.json([]);
  } catch (e) {
    console.error('/api/admin/reports/pending error:', e.message);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

// Bulk actions: verify (set active), hide (set hidden), delete
app.post('/api/admin/accidents/bulk', adminAuth, async (req, res) => {
  try {
    const { ids, action, rejection_reason } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
    if (!['verify', 'hide', 'delete'].includes(action)) return res.status(400).json({ error: 'invalid action' });

    if (action === 'delete') {
      if (supabase) {
        try { await supabase.from('accidents').delete().in('id', ids); } catch (e) { }
      }
      if (pool) {
        await q(`DELETE FROM accidents WHERE id = ANY($1::text[])`, [ids]);
      }
      ids.forEach(id => syncDeleteToJson(id));
      return res.json({ ok: true });
    }

    if (action === 'verify') {
      if (supabase) {
        try { await supabase.from('accidents').update({ status: 'active', rejection_reason: null }).in('id', ids); } catch (e) { }
      }
      if (pool) {
        await q(`UPDATE accidents SET status = 'active', rejection_reason = NULL WHERE id = ANY($1::text[])`, [ids]);
      }
      return res.json({ ok: true });
    }

    if (action === 'hide') {
      if (supabase) {
        try { await supabase.from('accidents').update({ status: 'hidden', rejection_reason: rejection_reason || null }).in('id', ids); } catch (e) { }
      }
      if (pool) {
        await q(`UPDATE accidents SET status = 'hidden', rejection_reason = COALESCE($2, rejection_reason) WHERE id = ANY($1::text[])`, [ids, rejection_reason ?? null]);
      }
      return res.json({ ok: true });
    }

    res.status(400).json({ error: 'Unhandled action' });
  } catch (e) {
    console.error('/api/admin/accidents/bulk error:', e.message);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

// Duplicate detection endpoint for admin
app.get('/api/admin/accidents/:id/duplicates', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const lat = req.query.lat ? parseFloat(req.query.lat) : null;
    const lng = req.query.lng ? parseFloat(req.query.lng) : null;
    const date = req.query.date || null; // optional YYYY-MM-DD
    let data;
    const byPoint = lat != null && lng != null && !isNaN(lat) && !isNaN(lng);
    if (pool) {
      data = byPoint
        ? await rpcResult(`SELECT find_duplicates_by_point($1::double precision, $2::double precision, $3::float, $4::date) AS result`, [lat, lng, 100, date || null])
        : await rpcResult(`SELECT find_duplicates($1::text, $2::float) AS result`, [id, 100]);
    } else if (supabase) {
      const { data: rows, error } = byPoint
        ? await supabase.rpc('find_duplicates_by_point', { p_lat: lat, p_lng: lng, p_radius_m: 100, p_date: date || null })
        : await supabase.rpc('find_duplicates', { p_id: id, p_radius_m: 100 });
      if (error) throw new Error(error.message);
      data = rows;
    }
    res.json(data || []);
  } catch (e) {
    console.error('/api/admin/accidents/:id/duplicates error:', e.message);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

app.post('/api/admin/accidents', adminAuth, async (req, res) => {
  try {
    let { title, source, link, content } = req.body || {};

    if (!link && (!title || !content)) {
      return res.status(400).json({ error: 'Either Article Link, or Title and Content are required.' });
    }

    if (link) {
      const response = await safeFetch(link, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!response.ok) throw new Error(`Failed to fetch URL (HTTP ${response.status})`);
      const rawHtml = await readSafeResponseText(response, 2 * 1024 * 1024);
      content = stripHtml(rawHtml);
      if (!content || content.length < 50) {
        return res.status(400).json({ error: 'Scraped content is too short or empty.' });
      }
    }

    const extracted = await verifyAndExtractArticle(title, link, content);
    if (!extracted.is_in_bangalore) {
      return res.status(400).json({ error: 'Accident not in Bangalore' });
    }

    const finalTitle = title || extracted.title || 'Untitled Accident';
    const finalSource = source || extracted.source || 'News Article';

    let lat = extracted.lat;
    let lng = extracted.lng;
    if (!lat || !lng) {
      const coords = await geocodeLocation(extracted.location, extracted.area);
      lat = coords.lat;
      lng = coords.lng;
    }

    const nextId = await nextAccidentId(`art_${Date.now()}`);

    const wkt = lat && lng ? `SRID=4326;POINT(${lng} ${lat})` : null;
    const newRecord = {
      id: nextId,
      title: finalTitle,
      source: finalSource,
      link: link || null,
      location: extracted.location || finalTitle,
      area: extracted.area,
      zone: inferZone(extracted.area),
      severity: extracted.severity,
      score: extracted.severity === 'fatal' ? 10 : extracted.severity === 'serious' ? 5 : 1,
      date_raw: extracted.date,
      accident_date: extracted.date !== 'Unknown' ? extracted.date : null,
      has_coords: lat != null && lng != null,
      geom: wkt
    };

    if (pool) {
      await q(
        `INSERT INTO accidents (id, title, source, link, location, area, zone, severity, score, date_raw, accident_date, has_coords, geom)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::geometry)`,
        [newRecord.id, newRecord.title, newRecord.source, newRecord.link, newRecord.location, newRecord.area, newRecord.zone, newRecord.severity, newRecord.score, newRecord.date_raw, newRecord.accident_date, newRecord.has_coords, newRecord.geom]
      );
    } else if (supabase) {
      const { geom, ...row } = newRecord;
      const { error } = await supabase.from('accidents').insert(row);
      if (error) throw new Error(error.message);
      // PostgREST can't take PostGIS WKT in a JSON insert; set the pin via RPC.
      if (lat != null && lng != null) {
        const { error: geomErr } = await supabase.rpc('set_accident_geom', { p_id: newRecord.id, p_lat: lat, p_lng: lng });
        if (geomErr) console.error('set_accident_geom RPC error:', geomErr.message);
      }
    } else {
      throw new Error('No database configured');
    }

    appendPublicAccident(JSON_PATH, { id: nextId, title: finalTitle, source: finalSource, link, location: newRecord.location, area: newRecord.area, lat, lng, score: newRecord.score, severity: newRecord.severity, date: extracted.date, hasCoords: newRecord.has_coords, status: 'active' });
    res.json({ ok: true, id: nextId });
  } catch (e) {
    console.error('Failed to upload/verify accident:', e);
    res.status(500).json({ error: e.message || 'Verification and upload failed' });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Next numeric accident id. Ids are TEXT, so they must be compared as numbers:
 * sorting as strings puts "99" above "684" and hands out an id that exists.
 */
async function nextAccidentId(fallback) {
  try {
    let ids = [];
    if (pool) {
      ids = (await q(`SELECT id FROM accidents WHERE id ~ '^[0-9]+$'`)).map(r => r.id);
    } else if (supabase) {
      const { data, error } = await supabase.from('accidents').select('id').range(0, 99999);
      if (!error && data) ids = data.map(r => r.id);
    }
    const max = Math.max(0, ...ids.map(v => (/^\d+$/.test(v) ? parseInt(v, 10) : 0)));
    return max > 0 ? String(max + 1) : fallback;
  } catch {
    return fallback;
  }
}

function inferZone(area) {
  const s = String(area || '').toLowerCase();
  if (!s) return 'Central';
  if (/east|whitefield|kr puram|indiranagar|marathahalli|varthur|kadubeesanahalli|hopefarm|kadugodi|sarjapur|domlur|carmelaram|mahadevapura|bellandur|hsr|koramangala/.test(s)) return 'East';
  if (/north|hebbal|yelahanka|jakkur|kodigehalli|bellary|tumkur|peenya|mathikere|rt nagar|yeshwanthpur|nagavara|manyata|kamanahalli|banaswadi/.test(s)) return 'North';
  if (/south|jayanagar|jp nagar|bannerghatta|arekere|banashankari|btm|silk|hosur|electronic|nice|kengeri|mysore/.test(s)) return 'South';
  if (/west|rajajinagar|vijayanagar|magadi|jalahalli/.test(s)) return 'West';
  if (/central|mg road|majestic|shivaji|richmond|cantonment|ulsoor|cbd/.test(s)) return 'Central';
  if (/nh|highway|outer ring|orr|nh-44/.test(s)) return 'Highway / ORR';
  return 'Other';
}

async function geocodeLocation(loc, area) {
  const query = loc ? `${loc}, Bangalore` : `${area}, Bangalore`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&viewbox=77.35,13.25,77.85,12.7&bounded=1&format=json&limit=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'BangaloreAccidentsTracker/1.0' } });
    if (res.ok) {
      const data = await res.json();
      if (data?.length) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (e) {
    console.error('Geocoding error:', e.message);
  }
  return { lat: null, lng: null };
}

function stripHtml(html) {
  if (!html) return '';
  let text = html.replace(/<(script|style|iframe)\b[^>]*>([\s\S]*?)<\/\1>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  text = text.replace(/\s+/g, ' ').trim();
  return text.substring(0, 15000);
}

async function verifyAndExtractArticle(title, link, content) {
  const model = ensureFreeModel(process.env.OPENROUTER_MODEL || 'openrouter/free');
  const prompt = `You are an expert accident data extraction AI.
Analyze this news article or accident report text and extract the details.
Provided Title: "${title || ''}"
URL: "${link || ''}"
Content: "${content || ''}"

Return a valid JSON object ONLY, with no markdown code blocks, no backticks, and no extra text.
The JSON object must have exactly these keys:
{
  "title": "The title or summary headline of the accident.",
  "source": "The source (e.g. 'The Hindu', 'Deccan Herald'). Default to 'News Article' if unknown.",
  "location": "A precise landmark or street in Bangalore. If outside Bangalore, set to null.",
  "area": "The general neighborhood name in Bangalore.",
  "is_in_bangalore": true,
  "date": "The accident date in 'YYYY-MM-DD' format. Use 'Unknown' if undetermined.",
  "severity": "Must be exactly one of: 'fatal', 'serious', or 'minor'.",
  "time": "The time of the accident (e.g. '22:15') if mentioned, otherwise null.",
  "lat": 12.9716,
  "lng": 77.5946
}`;

  const response = await openrouter.chat.send({
    chatRequest: { model, messages: [{ role: "user", content: prompt }], stream: false }
  });

  const rawText = response.choices[0]?.message?.content;
  if (!rawText) throw new Error('Empty response from AI model.');

  const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  return {
    title: parsed.title || null,
    source: parsed.source || null,
    location: parsed.location || title || null,
    area: parsed.area || 'Bangalore',
    is_in_bangalore: parsed.is_in_bangalore ?? true,
    date: parsed.date || 'Unknown',
    severity: ['fatal', 'serious', 'minor'].includes(parsed.severity) ? parsed.severity : 'minor',
    time: parsed.time || null,
    lat: typeof parsed.lat === 'number' ? parsed.lat : null,
    lng: typeof parsed.lng === 'number' ? parsed.lng : null
  };
}

// Reverse geocode lat/lng to address using Nominatim
async function reverseGeocodeDetails(lat, lng) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&format=jsonv2`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BangaloreAccidentsTracker/1.0' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      const addr = data.address || {};
      const road = addr.road || addr.pedestrian || addr.cycleway || addr.path || '';
      const suburb = addr.suburb || addr.neighbourhood || addr.quarter || addr.residential || '';
      const loc = road ? (suburb && road !== suburb ? `${road}, ${suburb}` : road) : (suburb || data.name || data.display_name?.split(',')[0]);
      return {
        location: loc || null,
        area: suburb || addr.city_district || 'Bangalore',
        displayName: data.display_name || null
      };
    }
  } catch (e) { }
  return null;
}

async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&format=jsonv2`;
    const res = await fetch(url, { headers: { 'User-Agent': 'BangaloreAccidentsTracker/1.0' } });
    if (res.ok) {
      const data = await res.json();
      return data.display_name || null;
    }
  } catch (e) { console.error('Reverse geocode error:', e.message); }
  return null;
}

// ── JSON Sync Helpers ──────────────────────────────────────────────────────

function syncPatchToJson(id, { lat, lng, location, area, zone, status }) {
  try {
    if (!fs.existsSync(JSON_PATH)) return;
    const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    const item = data.find(r => String(r.id) === String(id));
    if (!item) return;
    if (lat !== undefined && lng !== undefined) {
      item.lat = parseFloat(lat);
      item.lng = parseFloat(lng);
      item.hasCoords = true;
    }
    if (location !== undefined) item.location = location;
    if (area !== undefined) {
      item.area = area;
      item.zone = zone || inferZone(area);
    }
    if (status !== undefined) item.status = status;
    fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { console.error('JSON sync patch error:', e.message); }
}

function syncDeleteToJson(id) {
  try {
    if (!fs.existsSync(JSON_PATH)) return;
    const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    const filtered = data.filter(r => r.id !== id);
    if (filtered.length !== data.length) {
      fs.writeFileSync(JSON_PATH, JSON.stringify(filtered, null, 2), 'utf8');
    }
  } catch (e) { console.error('JSON sync delete error:', e.message); }
}

// ── Start ──────────────────────────────────────────────────────────────────

ai.registerRoutes(app, { validateJwt, adminAuth });
emergency.registerRoutes(app);

app.listen(PORT, () => {
  console.log(`BAT API listening on http://localhost:${PORT}`);
  ai.prewarm();
  emergency.start();
});
