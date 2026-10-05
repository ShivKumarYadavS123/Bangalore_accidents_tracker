/**
 * track-app.js — reporter's live view of an SOS: status, responding hospital,
 * ambulance position + ETA, first aid, timeline, add details, cancel.
 * Credential: ?id=<alert>&t=<tracking token> from the SOS response.
 */
(function () {
  'use strict';
  const E = window.BATE;
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const id = qs.get('id'), token = qs.get('t');
  const base = `/api/emergency/${encodeURIComponent(id || '')}`;
  const tq = `token=${encodeURIComponent(token || '')}`;

  let alert = null, map = null, layers = {}, routeCoords = null, lastRouteAt = 0, lastRouteFrom = null, lastStatus = null, fitted = false;

  window.Auth?.updateNavAuth?.();

  if (!id || !token) {
    $('banner').className = 'status-banner status-banner--danger';
    $('banner').innerHTML = '<h1>Tracking link incomplete</h1><p>Open the link from the device that sent the SOS, or call 108.</p>';
    return;
  }
  E.rememberSos(id, token);
  if (qs.get('merged') === '1') {
    $('notices').innerHTML = '<div class="notice notice--info">Someone already reported this crash — your report was added to the same alert, so hospitals see both. This tracking link is view-only: the first reporter can add details or cancel the alert.</div>';
  }

  // ── Rendering ──────────────────────────────────────────────────────────
  function banner(a) {
    const b = $('banner');
    const h = a.accepted_hospital;
    const amb = a.ambulance || {};
    const drill = a.is_drill ? '<span class="dbadge" style="margin-bottom:8px;">Drill</span> ' : '';
    const fresh = amb.updated_at ? ` · location updated ${E.ago(amb.updated_at)}` : '';
    let cls = 'waiting', html = '';
    switch (a.status) {
      case 'new':
        if (a.escalation.exhausted) {
          cls = 'danger';
          html = `<h1>No hospital has accepted yet</h1><p>Please call 108 now. Nearby hospitals can still accept this alert and you will see it here.</p><a class="btn btn-lg" style="background:#fff;color:#b91c1c;font-weight:900;" href="tel:108">📞 Call 108 now</a>`;
        } else {
          const next = a.escalation.next_at ? Math.max(0, Math.round((new Date(a.escalation.next_at) - Date.now()) / 1000)) : null;
          html = `<h1><span class="pulse-dot"></span>Alerting nearby hospitals…</h1>
            <p>${a.hospitals_notified} hospital${a.hospitals_notified === 1 ? '' : 's'} notified${a.escalation.round > 1 ? ` (round ${a.escalation.round})` : ''}.
            ${next != null ? `If none accepts, more hospitals will be alerted in <strong data-countdown>${next}s</strong>.` : ''}</p>`;
        }
        break;
      case 'accepted':
        cls = 'ok';
        html = `<h1>${E.esc(h ? h.name : a.accepted_hospital_name)} accepted your SOS</h1><p>They are preparing an ambulance.</p>${amb.eta_min != null ? `<div class="big-eta">${E.esc(E.eta(amb.eta_min, amb.eta_source))}</div><p>estimated drive to the scene</p>` : ''}`;
        break;
      case 'dispatched':
        cls = 'moving';
        html = `<h1>🚑 Ambulance on the way</h1>${amb.eta_min != null ? `<div class="big-eta">${E.esc(E.eta(amb.eta_min, amb.eta_source))}</div>` : ''}<p>from ${E.esc(h ? h.name : a.accepted_hospital_name)}${E.esc(fresh)}</p>`;
        break;
      case 'on_scene':
        cls = 'ok';
        html = `<h1>The ambulance has arrived</h1><p>Please guide the crew to the injured.</p>`;
        break;
      case 'transporting':
        cls = 'moving';
        html = `<h1>Patient on the way to hospital</h1><p>${E.esc(h ? h.name : a.accepted_hospital_name)}${amb.eta_min != null ? ' · ' + E.esc(E.eta(amb.eta_min, amb.eta_source)) : ''}</p>`;
        break;
      case 'closed':
        cls = 'muted';
        html = `<h1>Case closed</h1><p>${E.esc(E.OUTCOME[a.close_outcome] || 'Completed')}. Thank you for helping.</p>`;
        break;
      case 'cancelled':
        cls = 'muted';
        html = `<h1>Alert cancelled</h1><p>${E.esc(a.cancel_reason || '')}</p>`;
        break;
    }
    b.className = 'status-banner status-banner--' + cls;
    b.innerHTML = drill + html;
  }

  function stepper(a) {
    const labels = ['Sent', 'Accepted', 'On the way', 'Arrived', 'To hospital', 'Closed'];
    const cur = a.status === 'cancelled' ? -1 : E.STEPS.indexOf(a.status);
    $('stepper').innerHTML = labels.map((l, i) => `<li class="${i < cur || (i === cur && a.status === 'closed') ? 'done' : i === cur ? 'current' : ''}">${l}</li>`).join('');
  }

  function renderHospital(a) {
    const h = a.accepted_hospital;
    $('hospital-card').hidden = !h;
    if (!h) return;
    $('hospital').innerHTML = `
      <div class="hrow">
        <div class="hrow-main">
          <div class="hrow-name">${E.esc(h.name)}</div>
          <div class="hrow-meta">${E.esc(E.LEVEL[h.emergency_level] || '')}${h.address ? ' · ' + E.esc(h.address) : ''}</div>
        </div>
        ${h.phone ? `<a class="icon-btn icon-btn--call" href="${E.telHref(h.phone)}">Call</a>` : ''}
        <a class="icon-btn" href="${E.directions(h.lat, h.lng)}" target="_blank" rel="noopener">Map</a>
      </div>`;
  }

  function renderAlerted(a) {
    if (!a.hospitals.length) { $('alerted').innerHTML = '<p class="hint">Finding hospitals…</p>'; return; }
    $('alerted').innerHTML = a.hospitals.slice(0, 8).map(h => `
      <div class="hrow">
        <div class="hrow-main">
          <div class="hrow-name">${E.esc(h.name)} ${h.accepted ? '<span class="erbadge erbadge--accepting">Accepted</span>' : ''}</div>
          <div class="hrow-meta">${E.esc(E.LEVEL[h.emergency_level] || '')} · ${E.esc(E.km(h.distance_km))}</div>
        </div>
        <div class="hrow-eta">${E.esc(E.eta(h.eta_min, h.eta_source))}</div>
        ${h.phone ? `<a class="icon-btn icon-btn--call" href="${E.telHref(h.phone)}" aria-label="Call ${E.esc(h.name)}">Call</a>` : ''}
      </div>`).join('');
  }

  function renderReport(a) {
    $('report-summary').textContent = `${E.PRIORITY[a.priority] || ''} · ${a.triage_summary}${a.report_count > 1 ? ` · reported by ${a.report_count} people` : ''}${a.photo_count ? ` · ${a.photo_count} photo${a.photo_count > 1 ? 's' : ''}` : ''}`;
    $('report-note').textContent = a.note || '';
    $('aid').innerHTML = E.firstAid(a.triage).map(t => `<li class="${['cpr', 'bleed', 'fire'].includes(t.k) ? 'urgent' : ''}"><strong>${E.esc(t.title)}</strong>${E.esc(t.text)}</li>`).join('');
    const open = ['new', 'accepted', 'dispatched', 'on_scene', 'transporting'].includes(a.status);
    $('details-card').querySelector('details').hidden = !open || !!a.view_only;
    $('cancel-card').hidden = !a.can_cancel;
  }

  function renderTimeline(a) {
    $('timeline').innerHTML = a.timeline.map(e => `<li><time>${E.esc(E.clock(e.at))}</time>${E.esc(E.timelineLabel(e))}</li>`).join('');
  }

  function initMap(a) {
    try { map = E.glMap($('track-map'), [a.lat, a.lng], 15); } catch { map = null; return; }
    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: routeData() });
      map.addLayer({
        id: 'route', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.7 },
      });
    });
  }

  function routeData() {
    return routeCoords
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: routeCoords } }
      : { type: 'FeatureCollection', features: [] };
  }
  function setRoute(coords) { // [[lng, lat], ...] or null
    routeCoords = coords;
    const src = map && map.getSource('route');
    if (src) src.setData(routeData());
  }

  function renderMap(a) {
    if (!window.maplibregl) return;
    if (!map) initMap(a);
    if (!map) return;
    const set = (key, ll, kind, title) => {
      if (!ll) { if (layers[key]) { layers[key].remove(); delete layers[key]; } return; }
      const lngLat = [ll[1], ll[0]];
      if (!layers[key]) layers[key] = new maplibregl.Marker({ element: E.glPin(kind, title) }).setLngLat(lngLat).addTo(map);
      else layers[key].setLngLat(lngLat);
    };
    set('scene', [a.lat, a.lng], 'scene', 'Accident');
    const h = a.accepted_hospital;
    set('hospital', h && h.lat != null ? [h.lat, h.lng] : null, 'hospital', h ? h.name : '');
    const amb = a.ambulance;
    const ambLL = amb && amb.lat != null && ['dispatched', 'on_scene', 'transporting'].includes(a.status) ? [amb.lat, amb.lng] : null;
    set('ambulance', ambLL, 'ambulance', 'Ambulance');

    const pts = Object.values(layers).map(m => m.getLngLat());
    if (!fitted || lastStatus !== a.status) {
      if (pts.length > 1) {
        const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
        map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: fitted ? 700 : 0 });
      } else {
        map.jumpTo({ center: [a.lng, a.lat], zoom: 15 });
      }
      fitted = true;
    }
    $('map-caption').textContent = ambLL ? 'Blue marker: ambulance (live).' : h ? 'Green marker: responding hospital. Red: accident.' : 'Red marker: accident location.';
    maybeRoute(a, ambLL);
  }

  async function maybeRoute(a, ambLL) {
    const active = ['accepted', 'dispatched', 'transporting'].includes(a.status) && a.accepted_hospital;
    if (!active) { if (routeCoords) setRoute(null); return; }
    const from = ambLL ? ambLL.join(',') : 'hospital';
    const moved = from !== lastRouteFrom;
    if (!moved && Date.now() - lastRouteAt < 60000) return;
    if (moved && Date.now() - lastRouteAt < 20000 && routeCoords) return;
    lastRouteAt = Date.now(); lastRouteFrom = from;
    try {
      const r = await E.api(`${base}/route?${tq}`);
      if (!r.coordinates) return;
      setRoute(r.coordinates);
    } catch { /* route is optional */ }
  }

  function render(a) {
    const prevStatus = alert && alert.status;
    alert = a;
    banner(a); stepper(a); renderHospital(a); renderAlerted(a); renderReport(a); renderTimeline(a); renderMap(a);
    if (prevStatus && prevStatus !== a.status) {
      try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch { /* ignore */ }
      document.title = `${E.STATUS[a.status]} — SOS`;
    }
    lastStatus = a.status;
    if (['closed', 'cancelled'].includes(a.status)) E.forgetSos();
  }

  // ── Data ───────────────────────────────────────────────────────────────
  async function load() {
    try { render(await E.api(`${base}?${tq}`)); } catch (e) {
      if (e.status === 404) {
        $('banner').className = 'status-banner status-banner--danger';
        $('banner').innerHTML = '<h1>Alert not found</h1><p>This tracking link is not valid. If someone needs help, call 108.</p>';
        E.forgetSos();
      }
    }
  }
  load();
  E.stream(`${base}/stream?${tq}`, { alert: render });
  setInterval(load, 20000); // safety net if the live stream drops
  setInterval(() => { // countdown + "updated Xs ago"
    if (alert && alert.status === 'new' && !alert.escalation.exhausted) {
      const el = document.querySelector('[data-countdown]');
      if (el && alert.escalation.next_at) el.textContent = Math.max(0, Math.round((new Date(alert.escalation.next_at) - Date.now()) / 1000)) + 's';
    } else if (alert && alert.status === 'dispatched') banner(alert);
  }, 1000);

  // ── Actions ────────────────────────────────────────────────────────────
  $('upd-save').addEventListener('click', async () => {
    const t = {};
    document.querySelectorAll('#update-box input[data-t]').forEach(cb => { if (cb.checked) t[cb.dataset.t] = cb.dataset.t === 'called_108' ? true : cb.dataset.v; });
    const body = { triage: Object.keys(t).length ? t : undefined, note: $('upd-note').value.trim() || undefined, reporter_phone: $('upd-phone').value.trim() || undefined };
    if (!body.triage && !body.note && !body.reporter_phone) { E.toast('Nothing to send yet.', 'warning'); return; }
    try {
      render(await E.api(`${base}?${tq}`, { method: 'PATCH', json: body }));
      $('upd-note').value = '';
      E.toast('Update sent to the hospital.');
    } catch (e) { E.toast(e.message, 'error'); }
  });

  $('upd-photo').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const blob = await E.shrinkImage(file, 1600);
      const res = await fetch(`${E.API}${base}/photo?${tq}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Upload failed');
      E.toast('Photo sent.');
      ev.target.value = '';
    } catch (e) { E.toast(e.message, 'error'); }
  });

  $('cancel-btn').addEventListener('click', async () => {
    if (!confirm('Cancel this emergency alert? Hospitals will be told it is no longer needed.')) return;
    try {
      render(await E.api(`${base}/cancel?${tq}`, { method: 'POST', json: { reason: $('cancel-reason').value } }));
      E.toast('Alert cancelled.');
    } catch (e) { E.toast(e.message, 'error'); }
  });
}());
