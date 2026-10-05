/**
 * Wires the emergency-response features into the Express app.
 *
 * Public (hospital directory):
 *   GET  /api/hospitals?q=&level=&offset=&limit=     searchable directory (+ capability stats)
 *   GET  /api/hospitals/near?lat=&lng=&limit=&eta=1&emergency=1   nearest, optionally by drive time
 * Reporter (SOS) — the tracking token returned on creation is the credential.
 * A report merged into an existing alert gets a view-only token (GET routes only):
 *   POST  /api/emergency                              raise an SOS {lat,lng,triage,note,reporter_phone,...}
 *   GET   /api/emergency/:id?token=                   tracking view
 *   GET   /api/emergency/:id/stream?token=            live updates (SSE)
 *   GET   /api/emergency/:id/route?token=             ambulance/hospital → scene route
 *   PATCH /api/emergency/:id?token=                   add triage / note / callback number (first reporter only)
 *   POST  /api/emergency/:id/photo?token=             scene photo, raw image body (first reporter only)
 *   POST  /api/emergency/:id/cancel?token=            cancel: false alarm, patient already taken… (first reporter only)
 * Hospital responders (Supabase login, app_metadata.role = hospital | admin):
 *   GET   /api/hospital/me                            role + linked hospital
 *   PATCH /api/hospital/me/status                     ER status: accepting | busy | diverting | unknown
 *   GET   /api/hospital/alerts[?scope=all]            alerts for my hospital (admins: everything)
 *   GET   /api/hospital/stream                        live updates (SSE, Authorization header)
 *   GET   /api/hospital/alerts/:id                    detail + timeline
 *   GET   /api/hospital/alerts/:id/photo?n=           scene photo
 *   POST  /api/hospital/alerts/:id/accept|decline|release|status|location|crew-link|cancel
 *   POST  /api/hospital/alerts/:id/ack                (legacy alias of accept)
 * Ambulance crew (crew-link token):
 *   GET  /api/crew/:id?token=, /stream, /route;  POST /api/crew/:id/location|status?token=
 * Analytics:
 *   GET  /api/coverage                                ambulance-desert analysis
 *   GET  /api/emergency-metrics?days=30&drills=0      response-time (golden hour) metrics
 * Admin:
 *   GET/POST /api/admin/hospital-users, DELETE /api/admin/hospital-users/:userId
 *   PATCH /api/admin/hospitals/:id, POST /api/admin/coverage/refresh, POST /api/admin/emergency/drills/clear
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createBus, openStream, debouncer } from './bus.mjs';
import { createRouter } from './routing.mjs';
import { createEmergencyService } from './service.mjs';
import { createCoverageService } from './coverage.mjs';
import { computeResponseMetrics } from './metrics.mjs';
import { createPgStore } from './store-pg.mjs';
import { createMemoryStore } from './store-memory.mjs';
import { createSupabaseStore } from './store-supabase.mjs';
import { fromSeedRow, dedupeHospitals, EMERGENCY_LEVELS } from './hospitals.mjs';
import { HttpError, hashToken, cleanText, cleanPhone } from './util.mjs';

const PUBLIC_HOSPITAL_FIELDS = ['id', 'name', 'phone', 'address', 'lat', 'lng', 'facility_type', 'emergency_level', 'level_source', 'er_status', 'er_status_note', 'er_status_updated_at', 'verified'];
const publicHospital = (h) => (h ? Object.fromEntries(PUBLIC_HOSPITAL_FIELDS.map(k => [k, h[k] ?? null])) : null);

export function loadSeedHospitals(file) {
  try {
    if (!file || !fs.existsSync(file)) return [];
    return dedupeHospitals(JSON.parse(fs.readFileSync(file, 'utf8')).map(fromSeedRow).filter(Boolean)).rows;
  } catch { return []; }
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()); } catch { return null; }
}

/**
 * Verifies a Supabase access token with Supabase itself (not just by decoding
 * it), so role changes apply immediately and forged tokens are rejected.
 * Results are cached briefly. Without Supabase (offline dev) claims are
 * trusted only when trustUnverified is set.
 */
export function createUserVerifier({ supabase, trustUnverified = false }) {
  const cache = new Map();
  return async function verifyUser(token) {
    if (!token) return null;
    const key = hashToken(token);
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.user;
    let user = null;
    if (supabase && !token.startsWith('devtoken_')) {
      const { data, error } = await supabase.auth.getUser(token);
      if (error) {
        if (!(error.status >= 400 && error.status < 500) && !/jwt|token|expired|invalid|not found/i.test(error.message || '')) throw error;
      } else if (data?.user) {
        user = { id: data.user.id, email: data.user.email, role: data.user.app_metadata?.role || 'user' };
      }
    } else if (trustUnverified) {
      const p = decodeJwt(token);
      if (p?.sub) user = { id: p.sub, email: p.email || null, role: p.app_metadata?.role || p.role || 'user' };
    }
    cache.set(key, { user, exp: Date.now() + (user ? 60000 : 10000) });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return user;
  };
}

/** Supabase admin API wrapper used to grant/revoke the hospital role. */
export function createUserDirectory({ supabase }) {
  const need = () => { if (!supabase?.auth?.admin) throw new HttpError(503, 'Supabase admin API is not configured on the server.'); };
  return {
    async findByEmail(email) {
      need();
      const target = String(email || '').trim().toLowerCase();
      for (let page = 1; page <= 25; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw error;
        const u = data.users.find(x => (x.email || '').toLowerCase() === target);
        if (u) return { id: u.id, email: u.email, role: u.app_metadata?.role || null };
        if (data.users.length < 200) break;
      }
      return null;
    },
    async setRole(userId, role) {
      need();
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error) throw error;
      const app_metadata = { ...(data?.user?.app_metadata || {}) };
      if (app_metadata.role === 'admin') return; // never downgrade an admin
      if (role) app_metadata.role = role; else delete app_metadata.role;
      const { error: upErr } = await supabase.auth.admin.updateUserById(userId, { app_metadata });
      if (upErr) throw upErr;
    },
  };
}

export function createEmergencyFeatures({
  pool = null, supabase = null, logger = console, getAccidents = async () => [], reverseGeocode = null,
  notify = null, vision = null, imageProcessor = null, cacheDir = null, hospitalsJsonPath = null,
  verifyUser = null, userDirectory = null, router = null, store: injectedStore = null, now = () => new Date(), config = {}, limits = {},
} = {}) {
  const memory = () => createMemoryStore({ hospitals: loadSeedHospitals(hospitalsJsonPath), now });
  // Direct Postgres when DATABASE_URL is set; otherwise Supabase over REST when the
  // service key is available; in-memory only for tests / fully offline dev.
  const supabaseStore = () => createSupabaseStore({ supabase, hospitals: loadSeedHospitals(hospitalsJsonPath), logger, now });
  const holder = { current: injectedStore || (pool ? createPgStore({ pool, logger }) : supabase ? supabaseStore() : memory()) };
  // Delegate to whichever store is active (Postgres, or a fallback if the DB is unreachable at startup).
  const store = new Proxy({}, { get: (_, k) => holder.current[k] });
  const bus = createBus();
  const routing = router || createRouter({ logger, now });
  const service = createEmergencyService({ store, router: routing, bus, notify, geocode: reverseGeocode, vision, imageProcessor, logger, now, config });
  const coverage = createCoverageService({ getAccidents, store, router: routing, cacheFile: cacheDir ? path.join(cacheDir, 'coverage.json') : null, logger, now });
  const verify = verifyUser || createUserVerifier({ supabase, trustUnverified: !supabase });
  const directory = userDirectory || createUserDirectory({ supabase });
  let sweepTimer = null;

  async function init() {
    if (holder.current.kind === 'postgres') {
      try {
        await holder.current.ready();
        await pool.query('SELECT 1 FROM hospitals LIMIT 1');
      } catch (e) {
        logger.warn?.(`[emergency] Postgres unavailable, using ${supabase ? 'Supabase REST' : 'in-memory'} store:`, e.message);
        holder.current = supabase ? supabaseStore() : memory();
      }
    }
    await holder.current.ready();
    return holder.current.kind;
  }

  function start({ sweepMs = 10000, prewarmCoverage = true } = {}) {
    const ready = init().then(kind => logger.log?.(`[emergency] dispatch ready (${kind} store)`));
    sweepTimer = setInterval(() => { service.sweep().catch(e => logger.warn?.('[emergency] sweep failed:', e.message)); }, sweepMs);
    sweepTimer.unref?.();
    if (prewarmCoverage) setTimeout(() => { ready.then(() => coverage.get()); }, 15000).unref?.();
    return ready;
  }
  function stop() { clearInterval(sweepTimer); }

  // ── HTTP helpers ─────────────────────────────────────────────────────────

  const limiter = (max, windowMin = 10, message = 'Too many requests, please slow down.') =>
    rateLimit({ windowMs: windowMin * 60000, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });
  const L = {
    sos: limiter(limits.sos ?? 8, 10, 'Too many emergency alerts from this device. If this is a real emergency call 108 now.'),
    photo: limiter(limits.photo ?? 30),
    read: limiter(limits.read ?? 900),
    write: limiter(limits.write ?? 1500),
    directory: limiter(limits.directory ?? 300),
  };

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) logger.error?.(`[emergency] ${req.method} ${req.path}:`, e.message);
      res.status(status).json({ error: status >= 500 ? 'Something went wrong. If this is an emergency, call 108.' : e.message, ...(e.code ? { code: e.code } : {}), ...(e.by ? { by: e.by } : {}) });
    }
  };

  /** Resolves a tracking token to { alert, role }; pass { owner: true } for actions that change the alert. */
  async function withTrackToken(req, { owner = false } = {}) {
    const alert = await service.getAlert(req.params.id);
    const role = service.trackRole(alert, String(req.query.token || req.get('x-track-token') || ''));
    if (!role) throw new HttpError(404, 'Alert not found');
    if (owner && role !== 'owner') {
      throw new HttpError(403, 'This tracking link is view-only. Only the person who sent the first SOS can update or cancel it.', { code: 'view_only' });
    }
    return { alert, role };
  }
  async function withCrewToken(req) {
    const alert = await service.getAlert(req.params.id);
    if (!service.crewAllowed(alert, String(req.query.token || req.get('x-crew-token') || ''))) throw new HttpError(404, 'Alert not found');
    return alert;
  }
  const crewActor = (alert) => ({ kind: 'crew', hospital: { id: alert.accepted_hospital_id } });

  async function resolveResponder(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Sign in required.' });
    try {
      const user = await verify(token);
      if (!user) return res.status(401).json({ error: 'Your session has expired — please sign in again.' });
      const link = await store.getHospitalUser(user.id);
      req.responder = { userId: user.id, email: user.email, role: user.role, isAdmin: user.role === 'admin', hospital: link?.hospital || null, linked: !!link };
      next();
    } catch (e) {
      logger.warn?.('[emergency] session verification failed:', e.message);
      res.status(503).json({ error: 'Could not verify your session right now, please retry.' });
    }
  }
  const requireResponder = (req, res, next) => (req.responder.isAdmin || req.responder.role === 'hospital')
    ? next() : res.status(403).json({ error: 'Emergency alerts are restricted to hospital responders.', code: 'not_responder' });
  const requireAdmin = (req, res, next) => (req.responder.isAdmin ? next() : res.status(403).json({ error: 'Admins only.' }));
  const responderAuth = [resolveResponder, requireResponder];
  const adminOnly = [resolveResponder, requireAdmin];
  const actorOf = (r) => ({ kind: r.isAdmin ? 'admin' : 'hospital', hospital: r.hospital, userId: r.userId });

  async function routeFor(alert) {
    const scene = { lat: alert.lat, lng: alert.lng };
    let from = null, kind = null;
    if (alert.ambulance_lat != null && ['dispatched', 'transporting'].includes(alert.status)) {
      from = { lat: alert.ambulance_lat, lng: alert.ambulance_lng }; kind = 'ambulance';
    } else if (alert.accepted_hospital_id) {
      const h = await store.getHospital(alert.accepted_hospital_id);
      if (h?.lat != null) { from = { lat: h.lat, lng: h.lng }; kind = 'hospital'; }
    }
    if (!from) return null;
    if (alert.status === 'transporting' && alert.accepted_hospital_id) {
      const h = await store.getHospital(alert.accepted_hospital_id);
      if (h?.lat != null) return { kind: 'to_hospital', ...(await routing.route(from, { lat: h.lat, lng: h.lng })) };
    }
    return { kind, ...(await routing.route(from, scene)) };
  }

  /** SSE: stream the view of one alert, re-rendered on every change. */
  function streamAlert(req, res, alert, render) {
    const s = openStream(req, res);
    const d = debouncer(150);
    const push = async () => { try { s.send('alert', await render(await service.getAlert(alert.id))); } catch { /* alert gone */ } };
    push();
    const off = bus.subscribe(msg => { if (msg.type === 'alert' && msg.alertId === alert.id) d.run(alert.id, push); });
    s.onClose(() => { off(); d.clear(); });
  }

  function registerRoutes(app) {
    // ── Directory ──────────────────────────────────────────────────────────
    app.get('/api/hospitals', L.directory, wrap(async (req, res) => {
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '60', 10) || 60));
      const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
      const level = ['dispatchable', ...EMERGENCY_LEVELS].includes(req.query.level) ? req.query.level : null;
      const q = String(req.query.q || '').trim().slice(0, 80);
      const [{ total, hospitals }, stats] = await Promise.all([store.searchHospitals({ q, level, offset, limit }), store.hospitalStats()]);
      res.json({ total, offset, limit, hospitals: hospitals.map(publicHospital), stats });
    }));

    app.get('/api/hospitals/near', L.directory, wrap(async (req, res) => {
      const out = await service.nearbyHospitals({
        lat: parseFloat(req.query.lat), lng: parseFloat(req.query.lng), limit: parseInt(req.query.limit || '5', 10) || 5,
        emergencyOnly: req.query.emergency === '1' || req.query.emergencyOnly === 'true', withEta: req.query.eta === '1',
      });
      res.json(out);
    }));

    // ── Reporter ───────────────────────────────────────────────────────────
    app.post('/api/emergency', L.sos, wrap(async (req, res) => {
      let userId = null;
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) { try { userId = (await verify(auth.slice(7)))?.id || null; } catch { /* anonymous SOS is fine */ } }
      const { alert, token, merged, hospitals } = await service.createAlert(req.body || {}, { userId });
      res.status(merged ? 200 : 201).json({
        alertId: alert.id, trackToken: token, trackUrl: `track.html?id=${encodeURIComponent(alert.id)}&t=${token}`, merged,
        status: alert.status, priority: alert.priority, severity: alert.severity, description: alert.description || null,
        hospitals: hospitals.map(c => (c.hospital
          ? { id: c.hospital.id, name: c.hospital.name, phone: c.hospital.phone, address: c.hospital.address, lat: c.hospital.lat, lng: c.hospital.lng, emergency_level: c.hospital.emergency_level, distance_km: c.distance_km, eta_min: c.eta_min, eta_source: c.eta_source }
          : c)),
      });
    }));

    app.get('/api/emergency/:id', L.read, wrap(async (req, res) => {
      const { alert, role } = await withTrackToken(req);
      res.json(await service.publicView(alert, { role }));
    }));

    app.get('/api/emergency/:id/stream', L.read, wrap(async (req, res) => {
      const { alert, role } = await withTrackToken(req);
      streamAlert(req, res, alert, a => service.publicView(a, { role }));
    }));

    app.get('/api/emergency/:id/route', L.read, wrap(async (req, res) => {
      const { alert } = await withTrackToken(req);
      res.json(await routeFor(alert) || { kind: null });
    }));

    app.patch('/api/emergency/:id', L.write, wrap(async (req, res) => {
      const { alert } = await withTrackToken(req, { owner: true });
      await service.updateReport(alert.id, req.body || {});
      res.json(await service.publicView(await service.getAlert(alert.id), { role: 'owner' }));
    }));

    app.post('/api/emergency/:id/photo', L.photo, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '8mb' }), wrap(async (req, res) => {
      const { alert } = await withTrackToken(req, { owner: true });
      res.json(await service.addPhoto(alert.id, req.body, String(req.headers['content-type'] || '').split(';')[0].trim()));
    }));

    app.post('/api/emergency/:id/cancel', L.write, wrap(async (req, res) => {
      const { alert } = await withTrackToken(req, { owner: true });
      await service.cancelAlert(alert.id, { kind: 'reporter' }, req.body?.reason);
      res.json(await service.publicView(await service.getAlert(alert.id), { role: 'owner' }));
    }));

    // ── Hospital responders ────────────────────────────────────────────────
    app.get('/api/hospital/me', resolveResponder, wrap(async (req, res) => {
      const r = req.responder;
      res.json({ user: { id: r.userId, email: r.email }, role: r.role, isAdmin: r.isAdmin, isResponder: r.isAdmin || r.role === 'hospital', linked: r.linked, hospital: publicHospital(r.hospital) });
    }));

    app.patch('/api/hospital/me/status', L.write, ...responderAuth, wrap(async (req, res) => {
      res.json(publicHospital(await service.setErStatus(req.responder, req.body?.er_status, req.body?.note)));
    }));

    app.get('/api/hospital/alerts', L.read, ...responderAuth, wrap(async (req, res) => {
      res.json(await service.listForResponder(req.responder, { scope: req.query.scope === 'all' ? 'all' : 'mine' }));
    }));

    app.get('/api/hospital/stream', ...responderAuth, (req, res) => {
      const responder = req.responder;
      const s = openStream(req, res);
      const d = debouncer(150);
      const seen = new Set();
      s.send('hello', { hospital: publicHospital(responder.hospital) });
      const off = bus.subscribe(msg => {
        if (msg.type === 'alert') {
          d.run(msg.alertId, async () => {
            try {
              const view = await service.responderUpdate(msg.alertId, responder);
              if (view) { seen.add(msg.alertId); s.send('alert', view); } else if (seen.has(msg.alertId)) { seen.delete(msg.alertId); s.send('gone', { id: msg.alertId }); }
            } catch { /* ignore */ }
          });
        } else if (msg.type === 'hospital' && responder.hospital && msg.hospitalId === responder.hospital.id) {
          store.getHospital(msg.hospitalId).then(h => { if (h) { responder.hospital = h; s.send('hospital', publicHospital(h)); } }).catch(() => {});
        }
      });
      s.onClose(() => { off(); d.clear(); });
    });

    app.get('/api/hospital/alerts/:id', L.read, ...responderAuth, wrap(async (req, res) => {
      res.json(await service.responderDetail(req.params.id, req.responder));
    }));

    app.get('/api/hospital/alerts/:id/photo', L.read, ...responderAuth, wrap(async (req, res) => {
      const n = req.query.n != null ? Math.max(0, parseInt(req.query.n, 10) || 0) : null;
      const p = await service.responderPhoto(req.params.id, req.responder, n);
      res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=300' }).send(Buffer.from(p.bytes));
    }));

    const accept = wrap(async (req, res) => {
      await service.acceptAlert(req.params.id, req.responder);
      res.json(await service.responderDetail(req.params.id, req.responder));
    });
    app.post('/api/hospital/alerts/:id/accept', L.write, ...responderAuth, accept);
    app.post('/api/hospital/alerts/:id/ack', L.write, ...responderAuth, accept);

    app.post('/api/hospital/alerts/:id/decline', L.write, ...responderAuth, wrap(async (req, res) => {
      await service.declineAlert(req.params.id, req.responder, req.body?.reason);
      res.json(await service.responderDetail(req.params.id, req.responder).catch(() => ({ id: req.params.id })));
    }));

    app.post('/api/hospital/alerts/:id/release', L.write, ...responderAuth, wrap(async (req, res) => {
      await service.releaseAlert(req.params.id, req.responder, req.body?.reason);
      res.json(await service.responderDetail(req.params.id, req.responder).catch(() => ({ id: req.params.id })));
    }));

    app.post('/api/hospital/alerts/:id/status', L.write, ...responderAuth, wrap(async (req, res) => {
      await service.setStatus(req.params.id, req.body?.status, actorOf(req.responder), { outcome: req.body?.outcome });
      res.json(await service.responderDetail(req.params.id, req.responder));
    }));

    app.post('/api/hospital/alerts/:id/location', L.write, ...responderAuth, wrap(async (req, res) => {
      res.json(await service.updateLocation(req.params.id, actorOf(req.responder), req.body || {}));
    }));

    app.post('/api/hospital/alerts/:id/crew-link', L.write, ...responderAuth, wrap(async (req, res) => {
      res.json(await service.issueCrewLink(req.params.id, actorOf(req.responder)));
    }));

    app.post('/api/hospital/alerts/:id/cancel', L.write, ...adminOnly, wrap(async (req, res) => {
      await service.cancelAlert(req.params.id, { kind: 'admin' }, req.body?.reason);
      res.json(await service.responderDetail(req.params.id, req.responder));
    }));

    app.get('/api/hospital/alerts/:id/route', L.read, ...responderAuth, wrap(async (req, res) => {
      await service.responderDetail(req.params.id, req.responder); // access check
      res.json(await routeFor(await service.getAlert(req.params.id)) || { kind: null });
    }));

    // ── Ambulance crew ─────────────────────────────────────────────────────
    app.get('/api/crew/:id', L.read, wrap(async (req, res) => { res.json(await service.crewView(await withCrewToken(req))); }));
    app.get('/api/crew/:id/stream', L.read, wrap(async (req, res) => {
      const alert = await withCrewToken(req);
      streamAlert(req, res, alert, a => service.crewView(a));
    }));
    app.get('/api/crew/:id/route', L.read, wrap(async (req, res) => { res.json(await routeFor(await withCrewToken(req)) || { kind: null }); }));
    app.post('/api/crew/:id/location', L.write, wrap(async (req, res) => {
      const alert = await withCrewToken(req);
      res.json(await service.updateLocation(alert.id, crewActor(alert), req.body || {}));
    }));
    app.post('/api/crew/:id/status', L.write, wrap(async (req, res) => {
      const alert = await withCrewToken(req);
      await service.setStatus(alert.id, req.body?.status, crewActor(alert), { outcome: req.body?.outcome });
      res.json(await service.crewView(await service.getAlert(alert.id)));
    }));

    // ── Analytics ──────────────────────────────────────────────────────────
    app.get('/api/coverage', L.directory, wrap(async (req, res) => {
      res.json(coverage.get());
    }));

    app.get('/api/emergency-metrics', L.directory, wrap(async (req, res) => {
      const days = Math.min(365, Math.max(1, parseInt(req.query.days || '30', 10) || 30));
      const includeDrills = req.query.drills === '1';
      const rows = await store.alertsForMetrics({ since: new Date(now().getTime() - days * 86400000), includeDrills });
      res.json({ days, includeDrills, ...computeResponseMetrics(rows, { now: now(), days }) });
    }));

    // ── Admin ──────────────────────────────────────────────────────────────
    app.get('/api/admin/hospital-users', ...adminOnly, wrap(async (_req, res) => { res.json(await store.listHospitalUsers()); }));

    app.post('/api/admin/hospital-users', ...adminOnly, wrap(async (req, res) => {
      const hospitalId = String(req.body?.hospital_id || '');
      const hospital = await store.getHospital(hospitalId);
      if (!hospital) throw new HttpError(404, 'Hospital not found.');
      let user = null;
      if (req.body?.user_id) user = { id: String(req.body.user_id), email: cleanText(req.body.email, 200) };
      else {
        const email = cleanText(req.body?.email, 200);
        if (!email) throw new HttpError(400, 'email or user_id is required.');
        user = await directory.findByEmail(email);
        if (!user) throw new HttpError(404, 'No account with that email. Ask them to sign up first.');
      }
      await directory.setRole(user.id, 'hospital');
      const link = await store.linkHospitalUser({ userId: user.id, hospitalId, email: user.email || null, createdBy: req.responder.userId });
      res.status(201).json({ ...link, hospital_name: hospital.name });
    }));

    app.delete('/api/admin/hospital-users/:userId', ...adminOnly, wrap(async (req, res) => {
      const removed = await store.unlinkHospitalUser(req.params.userId);
      if (!removed) throw new HttpError(404, 'That account is not linked.');
      await directory.setRole(req.params.userId, null).catch(e => logger.warn?.('[emergency] could not clear role:', e.message));
      res.json({ ok: true });
    }));

    app.patch('/api/admin/hospitals/:id', ...adminOnly, wrap(async (req, res) => {
      const b = req.body || {};
      const patch = {};
      if (b.emergency_level !== undefined) {
        if (!EMERGENCY_LEVELS.includes(b.emergency_level)) throw new HttpError(400, `emergency_level must be one of ${EMERGENCY_LEVELS.join(', ')}`);
        patch.emergency_level = b.emergency_level; patch.level_source = 'admin';
      }
      if (b.name !== undefined) patch.name = cleanText(b.name, 200);
      if (b.address !== undefined) patch.address = cleanText(b.address, 300);
      if (b.phone !== undefined) patch.phone = b.phone ? cleanPhone(b.phone) : null;
      if (b.email !== undefined) patch.email = b.email ? cleanText(b.email, 200) : null;
      if (b.webhook_url !== undefined) {
        if (b.webhook_url && !/^https:\/\//i.test(b.webhook_url)) throw new HttpError(400, 'webhook_url must be an https URL');
        patch.webhook_url = b.webhook_url || null;
      }
      if (b.verified !== undefined) patch.verified = !!b.verified;
      if (b.phone && !patch.phone) throw new HttpError(400, 'Invalid phone number');
      const updated = await store.updateHospital(req.params.id, patch);
      if (!updated) throw new HttpError(404, 'Hospital not found.');
      res.json({ ...publicHospital(updated), email: updated.email, webhook_url: updated.webhook_url });
    }));

    app.post('/api/admin/coverage/refresh', ...adminOnly, wrap(async (_req, res) => {
      coverage.get({ refresh: true });
      res.status(202).json({ status: 'computing' });
    }));

    app.post('/api/admin/emergency/drills/clear', ...adminOnly, wrap(async (_req, res) => {
      res.json({ deleted: await store.deleteDrills() });
    }));
  }

  return { service, store, bus, coverage, registerRoutes, start, stop, init };
}
