/**
 * Emergency dispatch service.
 *
 * Flow for one alert:
 *   1. A bystander sends an SOS (location + quick triage, optional photo).
 *      Reports of the same crash (≤200 m, ≤15 min) are merged into one alert;
 *      only the first reporter's link can change or cancel it.
 *   2. Emergency-capable hospitals near the scene are ranked by drive time
 *      (OSRM), adjusted for the alert's priority and each hospital's live ER
 *      status. The best `roundSize` are notified (round 1).
 *   3. The first hospital to accept owns the alert (atomic compare-and-set).
 *      If nobody accepts within `roundTimeoutSec`, the next hospitals are
 *      notified (escalation), up to `maxRounds`; then the reporter is told to
 *      rely on 108.
 *   4. The accepting hospital moves the alert through
 *      accepted → dispatched → on_scene → transporting → closed, and the
 *      ambulance crew can share live GPS so the reporter sees it approach.
 *
 * Every change is written to the alert's event timeline and published on the
 * bus so reporter / hospital / crew pages update in real time.
 */
import { haversineKm } from '../ai/geo.mjs';
import { DISPATCHABLE_LEVELS } from './hospitals.mjs';
import { normalizeTriage, mergeTriage, priorityFromTriage, severityFor, triageSummary, PRIORITIES } from './triage.mjs';
import { newToken, hashToken, tokenMatches, newAlertId, inBbox, zoneFor, HttpError, cleanText, cleanPhone } from './util.mjs';

export const STATUS_FLOW = ['new', 'accepted', 'dispatched', 'on_scene', 'transporting', 'closed'];
export const OPEN_STATUSES = ['new', 'accepted', 'dispatched', 'on_scene', 'transporting'];
export const CLOSE_OUTCOMES = ['handed_over', 'treated_on_scene', 'refused_care', 'not_found', 'other'];
const STATUS_TIME = { accepted: 'accepted_at', dispatched: 'dispatched_at', on_scene: 'on_scene_at', transporting: 'transporting_at', closed: 'closed_at' };
const REPORTER_CANCELLABLE = ['new', 'accepted', 'dispatched'];
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTOS = 5;

// Minutes added to the drive time when ranking hospitals. Critical patients go
// to trauma centres unless a general hospital is much closer; minor cases are
// kept away from trauma centres.
const LEVEL_PENALTY = {
  critical: { trauma: 0, emergency: 3, general: 10 },
  urgent: { trauma: 0, emergency: 0, general: 4 },
  standard: { trauma: 3, emergency: 0, general: 0 },
};
const BUSY_PENALTY = 8;
const CAMPUS_KM = 0.25;

export const DEFAULT_CONFIG = {
  roundSize: 3,          // hospitals notified per round
  maxRounds: 3,          // escalation rounds before giving up
  roundTimeoutSec: 90,   // time a round has to accept before escalating
  candidatePool: 15,     // nearest hospitals considered for ranking
  dedupeRadiusM: 200,
  dedupeWindowMin: 15,
  consoleRadiusKm: 15,   // hospitals also see un-accepted alerts this close
  listWindowHours: 24,
  etaRefreshSec: 30,     // how often live ambulance ETA is re-routed via OSRM
  publicBaseUrl: 'http://localhost:3000',
};

const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const higherPriority = (a, b) => (PRIORITIES.indexOf(a) <= PRIORITIES.indexOf(b) ? a : b);
const loc = (x) => ({ lat: Number(x.lat), lng: Number(x.lng) });

export function createEmergencyService({ store, router, bus, notify = null, geocode = null, vision = null, imageProcessor = null, logger = console, now = () => new Date(), config = {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const pending = new Set();
  const etaState = new Map(); // alertId -> { at, eta, source } of the last OSRM route
  let sweeping = null;

  /** Run work after the response is sent; failures are logged, never thrown. */
  function background(label, fn) {
    const p = Promise.resolve().then(fn)
      .catch(e => logger.warn?.(`[emergency] ${label} failed:`, e.message))
      .finally(() => pending.delete(p));
    pending.add(p);
    return p;
  }
  async function idle() { while (pending.size) await Promise.all([...pending]); }

  const publish = (alertId) => bus?.publish({ type: 'alert', alertId });
  const event = (alert_id, type, actor, data = {}, hospital_id = null) => store.addEvent({ alert_id, type, actor, hospital_id, data });

  async function getOr404(id) {
    const a = await store.getAlert(String(id || ''));
    if (!a) throw new HttpError(404, 'Alert not found');
    return a;
  }

  // ── Ranking & notification ───────────────────────────────────────────────

  async function rankCandidates(alert, excludeIds = []) {
    const scene = loc(alert);
    let pool = await store.nearestHospitals({ ...scene, limit: cfg.candidatePool, levels: DISPATCHABLE_LEVELS, excludeIds });
    if (alert.priority === 'critical') {
      // Always consider the nearest trauma centres for critical patients.
      const trauma = await store.nearestHospitals({ ...scene, limit: 2, levels: ['trauma'], excludeIds });
      const seen = new Set(pool.map(h => h.id));
      pool = [...pool, ...trauma.filter(h => !seen.has(h.id))];
    }
    pool = pool.filter(h => h.er_status !== 'diverting' && h.lat != null);
    if (!pool.length) return [];
    const etas = await router.toDestination(pool.map(loc), scene);
    const penalty = LEVEL_PENALTY[alert.priority] || LEVEL_PENALTY.urgent;
    return pool.map((h, i) => ({
      hospital: h,
      distance_km: r1(Number(h.distance_km)),
      road_km: etas[i].distanceKm,
      eta_min: etas[i].durationMin,
      eta_source: etas[i].source,
      rank_score: r1(etas[i].durationMin + (penalty[h.emergency_level] ?? 10) + (h.er_status === 'busy' ? BUSY_PENALTY : 0)),
    })).sort((a, b) => a.rank_score - b.rank_score);
  }

  function messageFor(alert) {
    return {
      ...alert,
      triage_summary: triageSummary(alert.triage),
      console_url: `${cfg.publicBaseUrl}/hospital.html#alert=${encodeURIComponent(alert.id)}`,
    };
  }

  async function exhaust(alert, reason) {
    const updated = await store.updateAlert(alert.id, { escalation_exhausted_at: now(), next_escalation_at: null }, { expect: { status: 'new' } });
    if (updated) {
      await event(alert.id, 'escalation_exhausted', 'system', { reason });
      publish(alert.id);
    }
    return updated;
  }

  async function notifyRound(alert, round) {
    const existing = await store.getTargets(alert.id);
    const ranked = await rankCandidates(alert, existing.map(t => t.hospital_id));
    // One entry per campus: OSM often maps a hospital and its emergency block
    // separately, and notifying both wastes a slot in the round.
    const taken = (await store.getHospitals(existing.map(t => t.hospital_id))).filter(h => h.lat != null);
    const picks = [];
    for (const c of ranked) {
      if (picks.length >= cfg.roundSize) break;
      const sameCampus = [...taken, ...picks.map(p => p.hospital)].some(h => haversineKm(h.lat, h.lng, c.hospital.lat, c.hospital.lng) < CAMPUS_KM);
      if (!sameCampus) picks.push(c);
    }
    if (!picks.length) { await exhaust(alert, 'no emergency-capable hospital left in range'); return { ranked, picks }; }

    await store.addTargets(alert.id, picks.map(c => ({
      hospital_id: c.hospital.id, hospital_name: c.hospital.name, round,
      distance_km: c.distance_km, eta_min: c.eta_min, eta_source: c.eta_source, rank_score: c.rank_score,
    })));
    const updated = await store.updateAlert(alert.id, {
      escalation_round: round,
      next_escalation_at: new Date(now().getTime() + cfg.roundTimeoutSec * 1000),
    }, { expect: { status: 'new' } });
    await event(alert.id, round === 1 ? 'notified' : 'escalated', 'system', {
      round, hospitals: picks.map(c => ({ id: c.hospital.id, name: c.hospital.name, eta_min: c.eta_min })),
    });
    if (notify) {
      const msg = messageFor(updated || alert);
      background('notify', async () => {
        const results = await notify(msg, picks.map(c => c.hospital));
        for (const r of results || []) {
          if (r?.hospital_id && (r.sms || r.email || r.webhook || r.error)) await store.upsertTarget(alert.id, r.hospital_id, { notify_result: r });
        }
      });
    }
    publish(alert.id);
    return { ranked, picks };
  }

  /** Escalate alerts whose round timed out. Safe to call concurrently (claims each alert atomically). */
  async function sweep() {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const due = await store.dueForEscalation(now());
      for (const a of due) {
        const claimed = await store.updateAlert(a.id, { next_escalation_at: null }, { expect: { status: 'new', escalation_round: a.escalation_round } });
        if (!claimed) continue;
        try {
          await store.markPendingTargets(a.id, 'missed');
          if ((a.escalation_round || 0) >= cfg.maxRounds) await exhaust(claimed, 'no hospital accepted in time');
          else await notifyRound(claimed, (a.escalation_round || 0) + 1);
        } catch (e) {
          logger.warn?.(`[emergency] escalation of ${a.id} failed:`, e.message);
          await store.updateAlert(a.id, { next_escalation_at: new Date(now().getTime() + 15000) }, { expect: { status: 'new' } });
        }
      }
    })().finally(() => { sweeping = null; });
    return sweeping;
  }

  // ── Reporter actions ─────────────────────────────────────────────────────

  async function createAlert(input = {}, ctx = {}) {
    const lat = num(input.lat), lng = num(input.lng);
    if (!inBbox(lat, lng)) throw new HttpError(400, 'Location must be inside the Bengaluru region (lat 12.5–13.5, lng 77.0–78.2).');
    const triage = normalizeTriage(input.triage);
    const reportedSeverity = ['fatal', 'serious', 'minor'].includes(input.severity) ? input.severity : null;
    const note = cleanText(input.note ?? input.description, 500);
    const reporter_phone = cleanPhone(input.reporter_phone);
    const isDrill = !!ctx.isDrill;
    const token = newToken();
    const t = now();

    const dup = await store.findOpenAlertNear({ lat, lng, radiusM: cfg.dedupeRadiusM, since: new Date(t.getTime() - cfg.dedupeWindowMin * 60000), isDrill });
    if (dup) return mergeReport(dup, { triage, reportedSeverity, note, reporter_phone, token });

    const { priority, reasons } = priorityFromTriage(triage, { reportedSeverity });
    const legacyPhoto = typeof input.photo_url === 'string' && /^https:\/\//i.test(input.photo_url) ? input.photo_url.slice(0, 500) : null;
    const alert = await store.insertAlert({
      id: newAlertId(), lat, lng, accuracy_m: num(input.accuracy_m), address: cleanText(input.address, 300),
      triage, note, reporter_phone, reporter_id: ctx.userId || null,
      source: isDrill ? 'drill' : input.source === 'report' ? 'report' : 'sos', report_id: cleanText(input.report_id, 40),
      priority, severity: severityFor(priority), photo_url: legacyPhoto, status: 'new', zone: zoneFor(lat, lng),
      is_drill: isDrill, track_token_hashes: [hashToken(token)], created_at: t,
    });
    await event(alert.id, 'created', 'reporter', { priority, reasons, source: alert.source });

    let ranked = [];
    try {
      ({ ranked } = await notifyRound(alert, 1));
    } catch (e) {
      // Never lose an SOS because routing/notification failed: retry via the sweeper.
      logger.warn?.(`[emergency] first notification round for ${alert.id} failed:`, e.message);
      await store.updateAlert(alert.id, { next_escalation_at: now() }, { expect: { status: 'new' } });
    }

    if (!alert.address && geocode) {
      background('reverse geocode', async () => {
        const address = await geocode(lat, lng);
        if (address) { await store.updateAlert(alert.id, { address: String(address).slice(0, 300) }); publish(alert.id); }
      });
    }
    if (legacyPhoto && vision) background('photo assessment', () => assessPhoto(alert.id, legacyPhoto));
    publish(alert.id);
    return { alert: await store.getAlert(alert.id), token, merged: false, hospitals: ranked.slice(0, 5) };
  }

  async function mergeReport(existing, { triage, reportedSeverity, note, reporter_phone, token }) {
    const merged = mergeTriage(existing.triage, triage);
    const { priority } = priorityFromTriage(merged, { reportedSeverity, visionSeverity: existing.vision_severity });
    const newPriority = higherPriority(priority, existing.priority || 'urgent');
    const patch = {
      triage: merged, priority: newPriority, severity: severityFor(newPriority, existing.vision_severity),
      report_count: (existing.report_count || 1) + 1,
    };
    if (note) patch.note = existing.note ? `${existing.note}\n— ${note}`.slice(0, 1500) : note;
    if (reporter_phone && !existing.reporter_phone) patch.reporter_phone = reporter_phone;
    await store.updateAlert(existing.id, patch);
    await store.addTokenHash(existing.id, 'track_token_hashes', hashToken(token));
    await event(existing.id, 'merged_report', 'reporter', { report_count: patch.report_count, priority: newPriority });
    publish(existing.id);
    const alert = await store.getAlert(existing.id);
    return { alert, token, merged: true, hospitals: await targetHospitals(alert.id) };
  }

  async function updateReport(alertId, input = {}) {
    const alert = await getOr404(alertId);
    if (!OPEN_STATUSES.includes(alert.status)) throw new HttpError(409, 'This alert is already closed.');
    const patch = {};
    if (input.triage) {
      patch.triage = mergeTriage(alert.triage, input.triage);
      const { priority } = priorityFromTriage(patch.triage, { visionSeverity: alert.vision_severity });
      patch.priority = higherPriority(priority, alert.priority || 'urgent');
      patch.severity = severityFor(patch.priority, alert.vision_severity);
    }
    const note = cleanText(input.note, 500);
    if (note) patch.note = alert.note ? `${alert.note}\n— ${note}`.slice(0, 1500) : note;
    const phone = cleanPhone(input.reporter_phone);
    if (phone) patch.reporter_phone = phone;
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
    const updated = await store.updateAlert(alert.id, patch);
    await event(alert.id, 'reporter_update', 'reporter', { fields: Object.keys(patch).filter(k => k !== 'severity') });
    publish(alert.id);
    return updated;
  }

  async function addPhoto(alertId, bytes, mime) {
    if (!PHOTO_TYPES.includes(mime)) throw new HttpError(415, 'Send a JPEG, PNG or WebP image.');
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(400, 'Empty image.');
    const alert = await getOr404(alertId);
    if ((alert.photo_count || 0) >= MAX_PHOTOS) throw new HttpError(409, `An alert can have at most ${MAX_PHOTOS} photos.`);
    let out = bytes, outMime = mime;
    if (imageProcessor) {
      try { out = await imageProcessor(bytes); outMime = 'image/jpeg'; } catch { throw new HttpError(400, 'Could not read that image.'); }
    }
    await store.addPhoto(alert.id, outMime, out);
    await event(alert.id, 'photo_added', 'reporter', {});
    if (vision && OPEN_STATUSES.includes(alert.status)) background('photo assessment', () => assessPhoto(alert.id, out));
    publish(alert.id);
    return { photo_count: (alert.photo_count || 0) + 1 };
  }

  async function assessPhoto(alertId, image) {
    const v = await vision(image);
    if (!v?.severity) return;
    const alert = await store.getAlert(alertId);
    if (!alert) return;
    const { priority } = priorityFromTriage(alert.triage, { visionSeverity: v.severity });
    const newPriority = higherPriority(priority, alert.priority || 'urgent');
    await store.updateAlert(alertId, {
      vision_severity: v.severity, vision_description: v.description || null, description: v.description || alert.description,
      priority: newPriority, severity: severityFor(newPriority, v.severity),
    });
    await event(alertId, 'photo_assessed', 'system', { severity: v.severity, priority_raised: newPriority !== alert.priority });
    publish(alertId);
  }

  async function cancelAlert(alertId, actor, reason) {
    const alert = await getOr404(alertId);
    const allowed = actor.kind === 'admin' ? OPEN_STATUSES : REPORTER_CANCELLABLE;
    if (!allowed.includes(alert.status)) throw new HttpError(409, alert.status === 'cancelled' ? 'Already cancelled.' : 'This alert can no longer be cancelled.');
    const updated = await store.updateAlert(alert.id, {
      status: 'cancelled', cancelled_at: now(), cancel_reason: cleanText(reason, 200) || 'Cancelled', next_escalation_at: null,
    }, { expect: { status: alert.status } });
    if (!updated) throw new HttpError(409, 'The alert changed, please retry.');
    await store.markPendingTargets(alert.id, 'missed');
    await event(alert.id, 'cancelled', actor.kind, { reason: updated.cancel_reason });
    publish(alert.id);
    return updated;
  }

  // ── Hospital actions ─────────────────────────────────────────────────────

  function requireHospital(responder) {
    if (!responder?.hospital) throw new HttpError(403, 'Your account is not linked to a hospital yet — ask an admin to link it.', { code: 'not_linked' });
    return responder.hospital;
  }

  async function acceptAlert(alertId, responder) {
    const h = requireHospital(responder);
    const t = now();
    const updated = await store.updateAlert(String(alertId), {
      status: 'accepted', accepted_hospital_id: h.id, accepted_hospital_name: h.name, accepted_by: responder.userId || null,
      accepted_at: t, next_escalation_at: null,
    }, { expect: { status: 'new' } });
    if (!updated) {
      const cur = await getOr404(alertId);
      if (cur.accepted_hospital_id === h.id) return cur;
      if (cur.status === 'cancelled') throw new HttpError(409, 'This alert was cancelled by the reporter.', { code: 'cancelled' });
      throw new HttpError(409, `Already accepted by ${cur.accepted_hospital_name || 'another hospital'}.`, { code: 'already_taken', by: cur.accepted_hospital_name });
    }
    const [eta] = h.lat != null ? await router.toDestination([loc(h)], loc(updated)) : [{ durationMin: null, source: null }];
    await store.upsertTarget(updated.id, h.id, {
      hospital_name: h.name, response: 'accepted', responded_at: t, eta_min: eta.durationMin, eta_source: eta.source,
      distance_km: h.lat != null ? r1(haversineKm(h.lat, h.lng, updated.lat, updated.lng)) : null,
    });
    await store.markPendingTargets(updated.id, 'missed', h.id);
    const final = await store.updateAlert(updated.id, { ambulance_eta_min: eta.durationMin, ambulance_eta_source: eta.source });
    await event(updated.id, 'accepted', 'hospital', { hospital: h.name, eta_min: eta.durationMin }, h.id);
    publish(updated.id);
    return final;
  }

  async function declineAlert(alertId, responder, reason) {
    const h = requireHospital(responder);
    const alert = await getOr404(alertId);
    if (alert.status !== 'new') throw new HttpError(409, 'Only alerts waiting for a hospital can be declined.');
    const why = cleanText(reason, 200) || 'No reason given';
    await store.upsertTarget(alert.id, h.id, { hospital_name: h.name, response: 'declined', responded_at: now(), decline_reason: why });
    await event(alert.id, 'declined', 'hospital', { hospital: h.name, reason: why }, h.id);
    const targets = await store.getTargets(alert.id);
    if (!targets.some(t => t.response === 'pending')) {
      // Everyone asked so far said no — escalate right away instead of waiting.
      await store.updateAlert(alert.id, { next_escalation_at: now() }, { expect: { status: 'new' } });
      background('escalation', sweep);
    }
    publish(alert.id);
    return store.getAlert(alert.id);
  }

  /** The accepting hospital can hand the case back (e.g. no ambulance free); it is re-dispatched immediately. */
  async function releaseAlert(alertId, responder, reason) {
    const h = requireHospital(responder);
    const why = cleanText(reason, 200) || 'Released by hospital';
    const updated = await store.updateAlert(String(alertId), {
      status: 'new', accepted_hospital_id: null, accepted_hospital_name: null, accepted_by: null, accepted_at: null,
      dispatched_at: null, ambulance_lat: null, ambulance_lng: null, ambulance_accuracy_m: null, ambulance_updated_at: null,
      ambulance_eta_min: null, ambulance_eta_source: null, crew_token_hashes: [], escalation_exhausted_at: null,
      next_escalation_at: now(),
    }, { expect: { status: ['accepted', 'dispatched'], accepted_hospital_id: h.id } });
    if (!updated) throw new HttpError(409, 'Only the accepting hospital can release an alert before the ambulance reaches the scene.');
    etaState.delete(updated.id);
    await store.upsertTarget(updated.id, h.id, { hospital_name: h.name, response: 'declined', responded_at: now(), decline_reason: `Released: ${why}` });
    await event(updated.id, 'released', 'hospital', { hospital: h.name, reason: why }, h.id);
    background('escalation', sweep);
    publish(updated.id);
    return updated;
  }

  function assertOwner(alert, actor) {
    if (actor.kind === 'admin') return;
    if (!actor.hospital || alert.accepted_hospital_id !== actor.hospital.id) {
      throw new HttpError(403, 'Only the hospital that accepted this alert can update it.');
    }
  }

  async function setStatus(alertId, status, actor, { outcome } = {}) {
    if (!['dispatched', 'on_scene', 'transporting', 'closed'].includes(status)) throw new HttpError(400, 'status must be dispatched, on_scene, transporting or closed');
    const alert = await getOr404(alertId);
    assertOwner(alert, actor);
    const from = STATUS_FLOW.indexOf(alert.status), to = STATUS_FLOW.indexOf(status);
    if (from < 1 || to <= from) throw new HttpError(409, `Cannot change status from ${alert.status} to ${status}.`);
    const patch = { status, [STATUS_TIME[status]]: now() };
    if (status === 'on_scene') { patch.ambulance_eta_min = 0; etaState.delete(alert.id); }
    if (status === 'closed') patch.close_outcome = CLOSE_OUTCOMES.includes(outcome) ? outcome : 'handed_over';
    const updated = await store.updateAlert(alert.id, patch, { expect: { status: alert.status } });
    if (!updated) throw new HttpError(409, 'The alert changed, please refresh.');
    await event(alert.id, 'status', actor.kind, { status, outcome: patch.close_outcome }, alert.accepted_hospital_id);
    publish(alert.id);
    return updated;
  }

  /** Live ambulance position from the responder console or crew link. */
  async function updateLocation(alertId, actor, input = {}) {
    const lat = num(input.lat), lng = num(input.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 12.2 || lat > 13.8 || lng < 76.7 || lng > 78.5) throw new HttpError(400, 'Invalid position.');
    const alert = await getOr404(alertId);
    assertOwner(alert, actor);
    if (!['accepted', 'dispatched', 'on_scene', 'transporting'].includes(alert.status)) throw new HttpError(409, 'Location sharing is only possible while the case is active.');
    const t = now();
    const patch = { ambulance_lat: lat, ambulance_lng: lng, ambulance_accuracy_m: num(input.accuracy), ambulance_updated_at: t };
    const autoDispatch = alert.status === 'accepted';
    if (autoDispatch) { patch.status = 'dispatched'; patch.dispatched_at = t; }
    const status = patch.status || alert.status;

    let dest = null;
    if (status === 'dispatched') dest = loc(alert);
    else if (status === 'transporting' && alert.accepted_hospital_id) {
      const h = await store.getHospital(alert.accepted_hospital_id);
      if (h?.lat != null) dest = loc(h);
    }
    if (dest) {
      const last = etaState.get(alert.id);
      const straightKm = haversineKm(lat, lng, dest.lat, dest.lng);
      if (!last || last.status !== status || t - last.at >= cfg.etaRefreshSec * 1000) {
        const r = await router.route({ lat, lng }, dest);
        etaState.set(alert.id, { at: t, eta: r.durationMin, source: r.source, status, km: straightKm });
        patch.ambulance_eta_min = r.durationMin;
        patch.ambulance_eta_source = r.source;
      } else {
        // Between re-routes, scale the last road ETA by how much closer the ambulance got.
        const ratio = last.km > 0.05 ? Math.min(1.5, straightKm / last.km) : 1;
        patch.ambulance_eta_min = r1(Math.max(0, last.eta * ratio));
        patch.ambulance_eta_source = last.source;
      }
    } else if (status === 'on_scene') {
      patch.ambulance_eta_min = 0;
    }

    const updated = await store.updateAlert(alert.id, patch, { expect: { status: alert.status } });
    if (!updated) throw new HttpError(409, 'The alert changed, please refresh.');
    if (autoDispatch) await event(alert.id, 'status', actor.kind, { status: 'dispatched', auto: true }, alert.accepted_hospital_id);
    if (!alert.ambulance_updated_at) await event(alert.id, 'tracking_started', actor.kind, {}, alert.accepted_hospital_id);
    publish(alert.id);
    return { status: updated.status, eta_min: updated.ambulance_eta_min, eta_source: updated.ambulance_eta_source };
  }

  async function issueCrewLink(alertId, actor) {
    const alert = await getOr404(alertId);
    assertOwner(alert, actor);
    if (!['accepted', 'dispatched', 'on_scene', 'transporting'].includes(alert.status)) throw new HttpError(409, 'Crew links can only be created for active cases.');
    const token = newToken();
    await store.addTokenHash(alert.id, 'crew_token_hashes', hashToken(token));
    await event(alert.id, 'crew_link_issued', actor.kind, {}, alert.accepted_hospital_id);
    return { token, url: `${cfg.publicBaseUrl}/crew.html?id=${encodeURIComponent(alert.id)}&t=${token}` };
  }

  async function setErStatus(responder, status, note) {
    const h = requireHospital(responder);
    const value = status === 'unknown' || status === '' || status == null ? null : status;
    if (value !== null && !['accepting', 'busy', 'diverting'].includes(value)) throw new HttpError(400, 'er_status must be accepting, busy, diverting or unknown');
    const updated = await store.updateHospital(h.id, {
      er_status: value, er_status_note: cleanText(note, 140), er_status_updated_at: now(), er_status_updated_by: responder.userId || null,
    });
    bus?.publish({ type: 'hospital', hospitalId: h.id });
    return updated;
  }

  // ── Access checks ────────────────────────────────────────────────────────

  // The first tracking token belongs to whoever raised the SOS ('owner').
  // Reports merged in later get their own token, appended after it, which is
  // view-only ('viewer'): it cannot change or cancel the alert and does not
  // see other people's notes.
  function trackRole(alert, token) {
    const hashes = Array.isArray(alert?.track_token_hashes) ? alert.track_token_hashes : [];
    if (tokenMatches(token, hashes.slice(0, 1))) return 'owner';
    if (tokenMatches(token, hashes.slice(1))) return 'viewer';
    return null;
  }
  const trackAllowed = (alert, token) => trackRole(alert, token) !== null;
  const crewAllowed = (alert, token) => tokenMatches(token, alert.crew_token_hashes);

  function responderCanSee(alert, responder, targets) {
    if (responder.isAdmin) return true;
    const h = responder.hospital;
    if (!h) return false;
    if (alert.accepted_hospital_id === h.id || targets.some(t => t.hospital_id === h.id)) return true;
    return alert.status === 'new' && h.lat != null && haversineKm(h.lat, h.lng, alert.lat, alert.lng) <= cfg.consoleRadiusKm;
  }

  // ── Views ────────────────────────────────────────────────────────────────

  async function targetHospitals(alertId, targets = null) {
    const ts = targets || await store.getTargets(alertId);
    const hs = new Map((await store.getHospitals(ts.map(t => t.hospital_id))).map(h => [h.id, h]));
    return ts.map(t => {
      const h = hs.get(t.hospital_id) || {};
      return {
        id: t.hospital_id, name: t.hospital_name || h.name, phone: h.phone || null, address: h.address || null,
        lat: h.lat ?? null, lng: h.lng ?? null, emergency_level: h.emergency_level || null,
        distance_km: r1(t.distance_km), eta_min: r1(t.eta_min), eta_source: t.eta_source, round: t.round, response: t.response,
      };
    }).sort((a, b) => (a.eta_min ?? 1e9) - (b.eta_min ?? 1e9));
  }

  const PUBLIC_EVENTS = new Set(['created', 'notified', 'escalated', 'accepted', 'status', 'tracking_started', 'photo_added', 'photo_assessed', 'merged_report', 'reporter_update', 'released', 'cancelled', 'escalation_exhausted']);

  function common(alert) {
    return {
      id: alert.id, status: alert.status, priority: alert.priority, severity: alert.severity, source: alert.source, is_drill: !!alert.is_drill,
      created_at: alert.created_at, updated_at: alert.updated_at, lat: alert.lat, lng: alert.lng, accuracy_m: alert.accuracy_m,
      address: alert.address, zone: alert.zone, report_count: alert.report_count || 1, photo_count: alert.photo_count || 0,
      triage: normalizeTriage(alert.triage), triage_summary: triageSummary(alert.triage),
      vision: alert.vision_severity ? { severity: alert.vision_severity, description: alert.vision_description } : null,
      accepted_hospital_id: alert.accepted_hospital_id, accepted_hospital_name: alert.accepted_hospital_name,
      accepted_at: alert.accepted_at, dispatched_at: alert.dispatched_at, on_scene_at: alert.on_scene_at,
      transporting_at: alert.transporting_at, closed_at: alert.closed_at, cancelled_at: alert.cancelled_at,
      cancel_reason: alert.cancel_reason, close_outcome: alert.close_outcome,
      escalation: { round: alert.escalation_round || 0, exhausted: !!alert.escalation_exhausted_at, next_at: alert.next_escalation_at },
      ambulance: alert.accepted_hospital_id ? {
        lat: alert.ambulance_lat, lng: alert.ambulance_lng, accuracy_m: alert.ambulance_accuracy_m,
        updated_at: alert.ambulance_updated_at, eta_min: r1(alert.ambulance_eta_min), eta_source: alert.ambulance_eta_source,
      } : null,
    };
  }

  /**
   * What the reporter's tracking page sees (no hospital-internal details such as declines).
   * A view-only link (a merged report) gets no notes or cancel reason and cannot cancel.
   */
  async function publicView(alert, { role = 'owner' } = {}) {
    const viewOnly = role !== 'owner';
    const [targets, events] = await Promise.all([store.getTargets(alert.id), store.getEvents(alert.id)]);
    const hospitals = await targetHospitals(alert.id, targets);
    const accepted = alert.accepted_hospital_id ? await store.getHospital(alert.accepted_hospital_id) : null;
    return {
      ...common(alert),
      ...(viewOnly ? { cancel_reason: null } : {}),
      note: viewOnly ? null : alert.note,
      reporter_phone_set: !!alert.reporter_phone,
      view_only: viewOnly,
      can_cancel: !viewOnly && REPORTER_CANCELLABLE.includes(alert.status),
      accepted_hospital: accepted && { id: accepted.id, name: accepted.name, phone: accepted.phone, address: accepted.address, lat: accepted.lat, lng: accepted.lng, emergency_level: accepted.emergency_level },
      hospitals: hospitals.map(({ response, round, ...h }) => ({ ...h, accepted: response === 'accepted' })),
      hospitals_notified: targets.filter(t => t.round > 0).length,
      timeline: events.filter(e => PUBLIC_EVENTS.has(e.type)).map(e => ({ type: e.type, at: e.created_at, data: publicEventData(e, viewOnly) })),
    };
  }

  function publicEventData(e, viewOnly = false) {
    const d = e.data || {};
    switch (e.type) {
      case 'notified': case 'escalated': return { round: d.round, count: (d.hospitals || []).length };
      case 'accepted': return { hospital: d.hospital, eta_min: d.eta_min };
      case 'status': return { status: d.status, outcome: d.outcome, auto: !!d.auto };
      case 'photo_assessed': return { severity: d.severity };
      case 'merged_report': return { report_count: d.report_count };
      case 'released': return {};
      case 'cancelled': return viewOnly ? {} : { reason: d.reason };
      default: return {};
    }
  }

  /** What a hospital console sees. Reporter phone only goes to hospitals involved in the case. */
  function responderView(alert, responder, targets, events = null) {
    const h = responder.hospital;
    const mine = h ? targets.find(t => t.hospital_id === h.id) : null;
    const acceptedByMe = !!h && alert.accepted_hospital_id === h.id;
    const involved = responder.isAdmin || !!mine || acceptedByMe;
    return {
      ...common(alert),
      description: alert.description, photo_url: alert.photo_url, note: involved ? alert.note : null,
      reporter_phone: involved ? alert.reporter_phone : null,
      accepted_by_me: acceptedByMe,
      my_target: mine ? { round: mine.round, eta_min: r1(mine.eta_min), eta_source: mine.eta_source, distance_km: r1(mine.distance_km), response: mine.response, notified_at: mine.notified_at } : null,
      distance_km_from_me: h?.lat != null ? r1(haversineKm(h.lat, h.lng, alert.lat, alert.lng)) : null,
      targets: (responder.isAdmin || acceptedByMe) ? targets.map(t => ({ hospital_id: t.hospital_id, name: t.hospital_name, round: t.round, response: t.response, eta_min: r1(t.eta_min), decline_reason: t.decline_reason })) : undefined,
      hospitals_notified: targets.filter(t => t.round > 0).length,
      timeline: events ? events.map(e => ({ type: e.type, at: e.created_at, actor: e.actor, data: e.data })) : undefined,
    };
  }

  async function crewView(alert) {
    const hospital = alert.accepted_hospital_id ? await store.getHospital(alert.accepted_hospital_id) : null;
    return {
      ...common(alert),
      note: alert.note, reporter_phone: alert.reporter_phone,
      hospital: hospital && { id: hospital.id, name: hospital.name, phone: hospital.phone, address: hospital.address, lat: hospital.lat, lng: hospital.lng },
    };
  }

  // ── Queries used by the routes ───────────────────────────────────────────

  async function listForResponder(responder, { scope = 'mine' } = {}) {
    const since = new Date(now().getTime() - cfg.listWindowHours * 3600 * 1000);
    const h = responder.hospital;
    let rows;
    if (responder.isAdmin && (scope === 'all' || !h)) rows = await store.listAlerts({ since, limit: 200 });
    else if (h) rows = await store.listAlerts({ since, hospitalId: h.id, center: h.lat != null ? loc(h) : null, radiusKm: cfg.consoleRadiusKm, limit: 200 });
    else return [];
    const targets = await store.getTargetsForAlerts(rows.map(r => r.id));
    return rows.map(a => responderView(a, responder, targets.get(a.id) || []));
  }

  async function responderDetail(alertId, responder) {
    const alert = await getOr404(alertId);
    const targets = await store.getTargets(alert.id);
    if (!responderCanSee(alert, responder, targets)) throw new HttpError(404, 'Alert not found');
    return responderView(alert, responder, targets, await store.getEvents(alert.id));
  }

  /** View for one bus message, or null if this responder should not see it. */
  async function responderUpdate(alertId, responder) {
    const alert = await store.getAlert(alertId);
    if (!alert) return null;
    const targets = await store.getTargets(alert.id);
    return responderCanSee(alert, responder, targets) ? responderView(alert, responder, targets) : null;
  }

  async function responderPhoto(alertId, responder, index = null) {
    const alert = await getOr404(alertId);
    const targets = await store.getTargets(alert.id);
    if (!responderCanSee(alert, responder, targets)) throw new HttpError(404, 'Alert not found');
    const p = await store.getPhoto(alert.id, index);
    if (!p) throw new HttpError(404, 'No photo');
    return p;
  }

  async function nearbyHospitals({ lat, lng, limit = 5, emergencyOnly = false, withEta = false }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, 'lat and lng required');
    const n = Math.min(50, Math.max(1, limit));
    // Pull extra candidates when ranking by drive time: the closest by air is not always the quickest by road.
    const rows = await store.nearestHospitals({ lat, lng, limit: withEta ? Math.min(50, n * 3) : n, levels: emergencyOnly ? DISPATCHABLE_LEVELS : null });
    let out = rows.map(h => ({
      id: h.id, name: h.name, phone: h.phone, address: h.address, lat: h.lat, lng: h.lng,
      facility_type: h.facility_type, emergency_level: h.emergency_level, er_status: h.er_status,
      distance_km: r1(Number(h.distance_km)),
    }));
    if (withEta && out.length) {
      const etas = await router.toDestination(out.map(loc), { lat, lng });
      out = out.map((h, i) => ({ ...h, eta_min: etas[i].durationMin, eta_source: etas[i].source, road_km: etas[i].distanceKm }))
        .sort((a, b) => a.eta_min - b.eta_min);
    }
    return out.slice(0, n);
  }

  return {
    config: cfg,
    // reporter
    createAlert, updateReport, addPhoto, cancelAlert,
    // hospital / crew
    acceptAlert, declineAlert, releaseAlert, setStatus, updateLocation, issueCrewLink, setErStatus,
    // access + views
    trackRole, trackAllowed, crewAllowed, publicView, crewView, listForResponder, responderDetail, responderUpdate, responderPhoto,
    nearbyHospitals, rankCandidates,
    // lifecycle
    sweep, idle, getAlert: getOr404,
  };
}
