/**
 * emergency-app.js — SOS page: capture location (GPS or pin), optional quick
 * triage / photo / note, send to /api/emergency, then go to live tracking.
 */
(function () {
  'use strict';
  const E = window.BATE;
  const $ = (id) => document.getElementById(id);

  const state = { lat: null, lng: null, accuracy: null, manual: false, sending: false };
  const triage = { vehicles: [] };
  let map = null, marker = null, meMarker = null, watchId = null, nearbyTimer = null;
  let gps = null;         // latest trusted GPS fix { lat, lng, accuracy, at }
  let framedAcc = null;   // accuracy the camera was last fitted to
  let userMoved = false;  // the user panned / zoomed the map themselves

  // ── Nav ────────────────────────────────────────────────────────────────
  window.Auth?.updateNavAuth?.();

  // ── Resume an SOS sent earlier from this device ────────────────────────
  const prev = E.lastSos(6);
  if (prev) {
    $('resume').innerHTML = `<div class="notice notice--info">You sent an SOS ${E.esc(E.ago(prev.at))}. <a href="track.html?id=${encodeURIComponent(prev.id)}&t=${encodeURIComponent(prev.t)}">Open live tracking →</a></div>`;
  }

  function setOffline() { $('offline').hidden = navigator.onLine; }
  window.addEventListener('online', setOffline);
  window.addEventListener('offline', setOffline);
  setOffline();

  // ── Location ───────────────────────────────────────────────────────────
  function setLocStatus(kind, text) {
    $('loc-dot').className = 'loc-dot' + (kind === 'ok' ? ' loc-dot--ok' : kind === 'bad' ? ' loc-dot--bad' : '');
    $('loc-text').textContent = text;
  }

  function gpsStatus(accuracy) {
    setLocStatus('ok', `Located within ±${Math.round(accuracy)} m` + (accuracy > 100 ? ' — drag the pin to the exact spot if needed' : ''));
  }

  /** [dLng, dLat] in degrees spanning `metres` at latitude `lat`. */
  function metresToDeg(lat, metres) {
    const dLat = metres / 111320;
    return [dLat / Math.cos(lat * Math.PI / 180), dLat];
  }
  function accuracyCircle(lat, lng, radius) {
    const [dLng, dLat] = metresToDeg(lat, radius);
    const ring = [];
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * 2 * Math.PI;
      ring.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
  }

  function placePin(lat, lng, { manual = false, accuracy = null } = {}) {
    state.lat = lat; state.lng = lng; state.manual = manual || state.manual;
    state.accuracy = manual ? null : accuracy;
    if (map) {
      if (!marker) {
        marker = new maplibregl.Marker({ color: '#dc2626', draggable: true }).setLngLat([lng, lat]).addTo(map);
        marker.getElement().title = 'Accident location — drag to move';
        marker.on('dragend', () => { const p = marker.getLngLat(); placePin(p.lat, p.lng, { manual: true }); });
      } else {
        marker.setLngLat([lng, lat]);
      }
    }
    if (manual) setLocStatus('ok', 'Pin placed by you');
    updateSend();
    clearTimeout(nearbyTimer);
    nearbyTimer = setTimeout(loadNearby, 600);
  }

  // Blue "you are here" dot + shaded accuracy circle, as on the dashboard.
  function showGps() {
    if (!map || !gps) return;
    if (!meMarker) {
      const el = document.createElement('div');
      el.className = 'user-location-marker';
      el.title = 'Your GPS location';
      meMarker = new maplibregl.Marker({ element: el }).setLngLat([gps.lng, gps.lat]).addTo(map);
    } else {
      meMarker.setLngLat([gps.lng, gps.lat]);
    }
    const src = map.getSource('gps-accuracy');
    if (src) src.setData(accuracyCircle(gps.lat, gps.lng, gps.accuracy));
  }

  // Zoom so the whole accuracy circle is visible (street level when precise).
  function frame() {
    if (!map || !gps) return;
    const [dLng, dLat] = metresToDeg(gps.lat, gps.accuracy);
    map.fitBounds([[gps.lng - dLng, gps.lat - dLat], [gps.lng + dLng, gps.lat + dLat]],
      { padding: 32, maxZoom: 17, duration: framedAcc == null ? 0 : 700 });
    framedAcc = gps.accuracy;
  }

  function onFix(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    // A much vaguer reading right after a good one is usually the phone falling
    // back to Wi-Fi / cell positioning for a moment — don't let it drag the pin away.
    if (gps && accuracy > gps.accuracy * 2 && pos.timestamp - gps.at < 30000) return;
    gps = { lat, lng, accuracy, at: pos.timestamp };
    showGps();
    if (state.manual) return; // keep the user's pin; the blue dot still shows where they are
    placePin(lat, lng, { accuracy });
    gpsStatus(accuracy);
    if (!map) return;
    const inView = map.getBounds().contains([lng, lat]);
    if (framedAcc == null || (!userMoved && (accuracy < framedAcc * 0.7 || !inView))) frame();
  }

  // Keeps following the GPS (it usually gets more precise over the first
  // seconds) until the user places the pin themselves.
  function startGps() {
    if (!navigator.geolocation) { setLocStatus('bad', 'Location is not available on this device — tap the map to place the pin.'); return; }
    if (!gps) setLocStatus('', 'Finding your location…');
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(onFix, (err) => {
      if (gps || state.manual) return; // keep what we have; the watch carries on
      setLocStatus('bad', err.code === 1
        ? (window.isSecureContext ? 'Location permission denied' : 'Location needs an https (or localhost) address')
          + ' — tap the map to place the pin at the accident.'
        : 'Could not get your location yet — tap the map to place the pin.');
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  function initMap() {
    if (!window.maplibregl) { setLocStatus('bad', 'Map failed to load — your GPS location will still be used.'); return; }
    try {
      map = E.glMap($('sos-map'), E.BLR, 11);
    } catch (e) {
      map = null;
      setLocStatus('bad', 'Map failed to load — your GPS location will still be used.');
      return;
    }
    map.on('load', () => {
      map.addSource('gps-accuracy', { type: 'geojson', data: gps ? accuracyCircle(gps.lat, gps.lng, gps.accuracy) : { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'gps-accuracy-fill', type: 'fill', source: 'gps-accuracy', paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.1 } });
      map.addLayer({ id: 'gps-accuracy-line', type: 'line', source: 'gps-accuracy', paint: { 'line-color': '#2563eb', 'line-opacity': 0.45, 'line-width': 1.5 } });
    });
    map.on('dragstart', () => { userMoved = true; });
    map.on('zoomstart', (e) => { if (e.originalEvent) userMoved = true; });
    // A tap moves the pin — but not the two clicks of a double-click zoom.
    let clickTimer = null;
    map.on('click', (e) => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => placePin(e.lngLat.lat, e.lngLat.lng, { manual: true }), 250);
    });
    map.on('dblclick', () => clearTimeout(clickTimer));
  }

  $('relocate').addEventListener('click', () => {
    state.manual = false; userMoved = false;
    if (gps) { placePin(gps.lat, gps.lng, { accuracy: gps.accuracy }); gpsStatus(gps.accuracy); frame(); }
    startGps();
  });

  // ── Nearest emergency hospitals (by drive time) ────────────────────────
  async function loadNearby() {
    if (state.lat == null) return;
    try {
      const list = await E.api(`/api/hospitals/near?lat=${state.lat}&lng=${state.lng}&limit=3&eta=1&emergency=1`);
      if (!list.length) return;
      $('nearby-card').hidden = false;
      $('nearby').innerHTML = list.map(h => `
        <div class="hrow">
          <div class="hrow-main">
            <div class="hrow-name">${E.esc(h.name)}</div>
            <div class="hrow-meta">${E.esc(E.LEVEL[h.emergency_level] || '')}${h.er_status ? ' · ' + E.esc(E.ER[h.er_status]) : ''} · ${E.km(h.road_km || h.distance_km)}</div>
          </div>
          <div class="hrow-eta">${E.esc(E.eta(h.eta_min, h.eta_source))}</div>
          ${h.phone ? `<a class="icon-btn icon-btn--call" href="${E.telHref(h.phone)}" aria-label="Call ${E.esc(h.name)}">Call</a>` : `<a class="icon-btn" href="${E.directions(h.lat, h.lng)}" target="_blank" rel="noopener">Map</a>`}
        </div>`).join('');
    } catch { /* optional */ }
  }

  // ── Triage chips ───────────────────────────────────────────────────────
  document.querySelectorAll('.chips').forEach(group => {
    const field = group.dataset.field;
    const multi = group.dataset.multi === 'true';
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const v = chip.dataset.value;
      if (multi) {
        const on = chip.getAttribute('aria-pressed') !== 'true';
        chip.setAttribute('aria-pressed', String(on));
        triage[field] = on ? [...new Set([...(triage[field] || []), v])] : (triage[field] || []).filter(x => x !== v);
      } else {
        const wasOn = chip.getAttribute('aria-pressed') === 'true';
        group.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
        if (!wasOn) { chip.setAttribute('aria-pressed', 'true'); triage[field] = v; } else { delete triage[field]; }
      }
      updateSend();
    });
    group.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
  });

  function updateSend() {
    const ready = state.lat != null && !state.sending;
    $('send').disabled = !ready;
    const n = Object.keys(triage).filter(k => k !== 'vehicles').length + (triage.vehicles.length ? 1 : 0);
    const sub = state.sending ? 'Sending…' : state.lat == null ? 'Waiting for location…' : n ? `${n} detail${n > 1 ? 's' : ''} included — you can add more later` : 'Details are optional — send now, add them later';
    $('send-label').innerHTML = `Send SOS to nearby hospitals<small>${E.esc(sub)}</small>`;
  }

  // ── Send ───────────────────────────────────────────────────────────────
  async function send() {
    if (state.lat == null || state.sending) return;
    state.sending = true; updateSend();
    $('send-error').innerHTML = '';
    const payload = {
      lat: state.lat, lng: state.lng, accuracy_m: state.accuracy,
      triage: { ...triage, called_108: $('called-108').checked },
      note: $('note').value.trim() || undefined,
      reporter_phone: $('phone').value.trim() || undefined,
      source: 'sos',
    };
    try {
      const res = await E.api('/api/emergency', { method: 'POST', json: payload, auth: true });
      // A report merged into someone else's alert gets a view-only link (no photos,
      // no cancel). If this device raised that alert itself (e.g. a retry), keep
      // using its own full-access link.
      const mine = E.lastSos();
      const own = res.merged && mine && mine.id === res.alertId;
      const viewOnly = res.merged && !own;
      const token = own ? mine.t : res.trackToken;
      if (!own) E.rememberSos(res.alertId, res.trackToken);
      const file = $('photo').files[0];
      if (file && !viewOnly) {
        $('send-label').innerHTML = 'SOS sent<small>Uploading photo…</small>';
        try {
          const blob = await E.shrinkImage(file, 1600);
          const up = await fetch(`${E.API}/api/emergency/${encodeURIComponent(res.alertId)}/photo?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
          if (!up.ok) throw new Error();
        } catch { E.toast('The photo could not be uploaded — you can add it from the tracking page.', 'warning'); }
      }
      location.href = `track.html?id=${encodeURIComponent(res.alertId)}&t=${encodeURIComponent(token)}${viewOnly ? '&merged=1' : ''}`;
    } catch (e) {
      state.sending = false; updateSend();
      const offline = !navigator.onLine || !e.status;
      $('send-error').innerHTML = `<div class="notice notice--danger" style="margin-top:8px;">
        <strong>${offline ? 'Could not reach the server.' : E.esc(e.message)}</strong><br>
        Call <a href="tel:108">108</a> now, then tap Send again to retry.</div>`;
      $('send-error').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  $('send').addEventListener('click', send);

  // ── Photo preview ──────────────────────────────────────────────────────
  $('photo').addEventListener('change', () => {
    const file = $('photo').files[0];
    const img = $('photo-img');
    if (img.src) URL.revokeObjectURL(img.src);
    $('photo-preview').hidden = !file;
    $('photo-preview').style.display = file ? 'flex' : 'none';
    if (file) img.src = URL.createObjectURL(file);
  });
  $('photo-remove').addEventListener('click', () => {
    $('photo').value = '';
    $('photo').dispatchEvent(new Event('change'));
    $('photo').click();
  });

  initMap();
  startGps();
  updateSend();
}());
