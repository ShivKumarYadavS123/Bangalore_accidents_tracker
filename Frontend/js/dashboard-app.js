(function () {
  'use strict';

  const CFG      = window.BAT_CONFIG || {};
  const API_BASE = (CFG.apiBase || '').replace(/\/$/, '');

  const SEV_COLOR = { fatal: '#ef4444', serious: '#f59e0b', minor: '#10b981' };
  let urlFilterState = null;

  // ── Utilities ──────────────────────────────────────────────────────────────

  function inferZone(area) {
    const s = String(area || '').toLowerCase();
    if (/east|whitefield|kr puram|indiranagar|marathahalli|varthur|kadubeesanahalli|hopefarm|kadugodi|sarjapur|domlur|carmelaram|mahadevapura|bellandur|hsr|koramangala/.test(s)) return 'East';
    if (/north|hebbal|yelahanka|jakkur|kodigehalli|bellary|tumkur|peenya|mathikere|rt nagar|yeshwanthpur|nagavara|manyata|kamanahalli|banaswadi/.test(s)) return 'North';
    if (/south|jayanagar|jp nagar|bannerghatta|arekere|banashankari|btm|silk|hosur|electronic|nice|kengeri|mysore/.test(s)) return 'South';
    if (/west|rajajinagar|vijayanagar|magadi|jalahalli/.test(s)) return 'West';
    if (/central|mg road|majestic|shivaji|richmond|cantonment|ulsoor|cbd/.test(s)) return 'Central';
    if (/nh|highway|outer ring|orr|nh-44/.test(s)) return 'Highway / ORR';
    return 'Other';
  }

  function sevLabel(sev) {
    return sev === 'fatal' ? 'Critical' : sev === 'serious' ? 'Moderate' : 'Minor';
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  // Where a record came from, for the popup and detail panel. These are news
  // reports and Traffic Police posts added after an admin's review, so the
  // wording never claims they are live or real-time.
  function sourceInfo(p) {
    const link = String(p.link || '');
    const href = link !== '#' && /^https?:\/\//i.test(link) ? link : null;
    if (href && /^https:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]{1,15}\/status\/\d+/i.test(href)) {
      // Only rows the X importer labelled as Traffic Police are credited to them.
      const source = String(p.source || '');
      const handle = (source.match(/^X: @([A-Za-z0-9_]{1,15})$/) || [])[1];
      const label = source === 'Bengaluru Traffic Police (X)' ? 'Bengaluru Traffic Police on X'
        : handle ? `@${handle} on X`
        : 'Post on X';
      return { label, linkText: 'View post on X ↗', href };
    }
    if (p.foundBy === 'agent') {
      return { label: `${p.source || 'News report'} (found by BAT News Agent)`, linkText: 'Read article ↗', href };
    }
    return { label: p.source || '—', linkText: 'Read article ↗', href };
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatDistance(km) {
    return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  function rowToFeature(row) {
    if (!row.hasCoords || row.lat == null || row.lng == null) return null;
    const sev = row.severity;
    if (!['fatal', 'serious', 'minor'].includes(sev)) return null;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [+row.lng, +row.lat] },
      properties: {
        id: row.id, title: row.title, source: row.source || '',
        link: row.link || '', location: row.location || '',
        area: row.area || '', zone: row.zone || inferZone(row.area),
        severity: sev, score: row.score ?? null,
        date: row.date || row.date_raw || '—',
        isUser: row.source === 'user',
      },
    };
  }

  async function loadJsonFallback() {
    const res = await fetch('accident_data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('accident_data.json not found');
    const rows = (await res.json()).filter(r => r && r.status === 'active');
    return { type: 'FeatureCollection', features: rows.map(rowToFeature).filter(Boolean) };
  }

  async function loadFromApi(query) {
    const qs = new URLSearchParams();
    if (query.from)                              qs.set('from',     query.from);
    if (query.to)                                qs.set('to',       query.to);
    if (query.severity && query.severity !== 'all') qs.set('severity', query.severity);
    if (query.area     && query.area     !== 'all') qs.set('area',     query.area);
    if (query.zone     && query.zone     !== 'all') qs.set('zone',     query.zone);
    const res = await fetch(`${API_BASE}/api/accidents?${qs}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const fc = await res.json();
    if (!fc || fc.type !== 'FeatureCollection') return emptyFC();
    fc.features = (fc.features || []).map(f => ({
      ...f,
      properties: {
        ...f.properties,
        zone: f.properties.zone || inferZone(f.properties.area),
        date: f.properties.date || f.properties.date_raw || '—',
        isUser: false,
      },
    }));
    return fc;
  }

  function mergeUserReports(fc) {
    if (!window.DB?.getAccidents) return fc;
    const extra = window.DB.getAccidents()
      .filter(a => a.source === 'user' && a.lat != null && a.lng != null)
      .map(a => rowToFeature({ ...a, hasCoords: true }))
      .filter(Boolean);
    return { type: 'FeatureCollection', features: fc.features.concat(extra) };
  }

  function clientFilter(fc, filters) {
    let feats = fc.features.slice();
    if (filters.severity && filters.severity !== 'all') feats = feats.filter(f => f.properties.severity === filters.severity);
    if (filters.area     && filters.area     !== 'all') feats = feats.filter(f => f.properties.area     === filters.area);
    if (filters.zone     && filters.zone     !== 'all') feats = feats.filter(f => f.properties.zone     === filters.zone);
    if (filters.from) feats = feats.filter(f => { const d = f.properties.date; return d && d !== '—' && String(d) >= filters.from; });
    if (filters.to)   feats = feats.filter(f => { const d = f.properties.date; return d && d !== '—' && String(d) <= filters.to;   });
    if (filters.distanceKm && userLocation) {
      feats = feats.filter(f => {
        const [lng, lat] = f.geometry.coordinates;
        return haversineKm(userLocation.lat, userLocation.lng, lat, lng) <= filters.distanceKm;
      });
    }
    return { type: 'FeatureCollection', features: feats };
  }

  async function loadAll(filters) {
    let fc = emptyFC(), label = 'Local JSON';
    if (API_BASE) {
      try   { fc = await loadFromApi(filters); label = 'PostgreSQL + PostGIS'; }
      catch (e) {
        console.warn('API offline — falling back to JSON', e);
        try { fc = await loadJsonFallback(); label = 'Local JSON (API offline)'; } catch {}
      }
    } else {
      try { fc = await loadJsonFallback(); } catch {}
    }
    // API data is authoritative. Local storage is used only by the offline fallback.
    if (label !== 'PostgreSQL + PostGIS') fc = mergeUserReports(fc);
    fc = clientFilter(fc, filters);
    return { fc, label };
  }

  // ── MapLibre GL JS Map ──────────────────────────────────────────────────────

  let map          = null;
  let isMapLoaded  = false;
  let pendingData  = null;
  let heatOn       = false;
  let lastFC        = emptyFC();
  let userLocation  = null;
  let userMarker    = null;
  let hasAutoCentered = false;
  let watchId       = null;

  function initMap() {
    if (map) return;

    map = new maplibregl.Map({
      container: 'accident-map',
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [77.5946, 12.9716],
      zoom: 11.5,
      pitch: 45, // tilt for 3D buildings view
    });

    // Add navigation controls (zoom, rotate)
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      isMapLoaded = true;

      // Add dynamic accidents GeoJSON source
      map.addSource('accidents', {
        type: 'geojson',
        data: pendingData || emptyFC()
      });

      // Heatmap layer configuration (calculates on GPU)
      map.addLayer({
        id: 'accidents-heat',
        type: 'heatmap',
        source: 'accidents',
        maxzoom: 15,
        layout: {
          visibility: heatOn ? 'visible' : 'none'
        },
        paint: {
          'heatmap-weight': [
            'interpolate',
            ['linear'],
            ['get', 'score'],
            0, 0,
            10, 1
          ],
          'heatmap-intensity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            0, 1,
            15, 3
          ],
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0, 'rgba(0,0,0,0)',
            0.2, '#10b981',
            0.5, '#f59e0b',
            0.8, '#ef4444',
            1.0, '#991b1b'
          ],
          'heatmap-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            0, 5,
            15, 25
          ],
          'heatmap-opacity': 0.85
        }
      });

      // Point marker layer configuration
      map.addLayer({
        id: 'accidents-point',
        type: 'circle',
        source: 'accidents',
        minzoom: 8,
        layout: {
          visibility: heatOn ? 'none' : 'visible'
        },
        paint: {
          'circle-radius': [
            'match',
            ['get', 'severity'],
            'fatal', 8,
            'serious', 6,
            'minor', 5,
            5
          ],
          'circle-color': [
            'match',
            ['get', 'severity'],
            'fatal', '#ef4444',
            'serious', '#f59e0b',
            'minor', '#3b82f6',
            '#3b82f6'
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9
        }
      });

      // Predicted-risk grid (GET /api/risk/grid), drawn beneath the heatmap and points.
      map.addSource('risk-grid', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'risk-grid-fill',
        type: 'fill',
        source: 'risk-grid',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ['match', ['get', 'level'], 'very_high', '#dc2626', 'high', '#fb923c', '#fde68a'],
          'fill-opacity': 0.4,
          'fill-outline-color': 'rgba(0,0,0,0.08)'
        }
      }, 'accidents-heat');
      map.on('click', 'risk-grid-fill', (e) => {
        if (map.queryRenderedFeatures(e.point, { layers: ['accidents-point'] }).length) return;
        const p = e.features[0].properties;
        const box = document.createElement('div');
        box.style.cssText = 'font-size:12px;max-width:230px';
        const title = document.createElement('strong');
        title.textContent = `${String(p.level).replace('_', ' ').toUpperCase()} predicted risk`;
        const lines = [
          p.name ? `Near ${p.name}` : null,
          `${p.relativeRisk}× the average incident location`,
          `${p.pastIncidents} past incident(s), ${p.pastFatal} fatal`,
          `Risk index ${p.riskIndex}/100`,
        ].filter(Boolean).map(t => { const d = document.createElement('div'); d.textContent = t; return d; });
        box.append(title, ...lines);
        new maplibregl.Popup({ offset: 6 }).setLngLat(e.lngLat).setDOMContent(box).addTo(map);
      });

      // Handle interactive point clicks (Mapbox-style popups)
      map.on('click', 'accidents-point', (e) => {
        const coordinates = e.features[0].geometry.coordinates.slice();
        const p = e.features[0].properties;

        // Open details panel in sidebar
        openDetail({
          ...p,
          date: p.date,
          isUser: p.isUser === 'true' || p.isUser === true
        });

        // Show Leaflet-like styled popup on canvas
        const sev = p.severity;
        const src = sourceInfo(p);
        const html = `
          <div class="popup-inner">
            <span class="popup-sev popup-sev--${sev}">${sevLabel(sev)}</span>
            <div class="popup-title">${esc(p.title)}</div>
            <div class="popup-meta">
              <div><span>Date: </span>${esc(String(p.date))}</div>
              <div><span>Area: </span>${esc(p.area || '—')}</div>
              <div><span>Zone: </span>${esc(p.zone || '—')}</div>
              <div><span>Source: </span>${esc(src.label)}</div>
            </div>
            ${src.href ? `<a class="popup-link" href="${esc(src.href)}" target="_blank" rel="noopener noreferrer">${esc(src.linkText)}</a>` : ''}
          </div>
        `;

        // Ensure popup doesn't clip off map boundaries
        while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
          coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
        }

        new maplibregl.Popup({ offset: 10 })
          .setLngLat(coordinates)
          .setHTML(html)
          .addTo(map);
      });

      // Toggle cursor pointer on point hover
      map.on('mouseenter', 'accidents-point', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'accidents-point', () => {
        map.getCanvas().style.cursor = '';
      });

      // Load pending data if loaded in backend before style resolved
      if (pendingData) {
        updateMap(pendingData);
        pendingData = null;
      }

      // If the browser already resolved a location fix before the map style
      // finished loading, place the live marker now.
      if (userLocation) updateUserMarker();
    });

    window.__BAT_MAP = map;
  }

  function updateMap(fc) {
    if (!isMapLoaded) {
      pendingData = fc;
      return;
    }
    const source = map.getSource('accidents');
    if (source) {
      source.setData(fc);
    }
  }

  // ── Live geolocation ("Near You") ─────────────────────────────────────

  let refreshDashboard = null; // set by bootstrap(); lets geolocation callbacks trigger a re-filter

  function updateUserMarker() {
    if (!map || !isMapLoaded || !userLocation) return;
    if (!userMarker) {
      const el = document.createElement('div');
      el.className = 'user-location-marker';
      userMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([userLocation.lng, userLocation.lat])
        .addTo(map);
    } else {
      userMarker.setLngLat([userLocation.lng, userLocation.lat]);
    }
  }

  function setLocateStatus(state, text) {
    const btn = document.getElementById('locate-btn');
    if (btn) {
      btn.classList.remove('is-locating', 'has-location');
      if (state === 'locating') btn.classList.add('is-locating');
      if (state === 'ok')       btn.classList.add('has-location');
      btn.title = text || 'Find my location';
    }
    const pill = document.getElementById('near-you-status');
    if (pill) {
      pill.textContent = text || '';
      pill.dataset.state = state;
    }
  }

  function refreshNearYou(fc) {
    const list = document.getElementById('near-you-list');
    if (!list) return;

    if (!userLocation) {
      list.innerHTML = '<li class="hotspot-empty">Enable location to see nearby accidents. ' +
        '<button class="ny-retry-btn" id="ny-retry-btn" type="button">Try again</button></li>';
      document.getElementById('ny-retry-btn')?.addEventListener('click', () => requestLocation({ recenter: true, watch: true }));
      return;
    }

    const source = (fc || lastFC).features;
    if (!source.length) {
      list.innerHTML = '<li class="hotspot-empty">No accidents match the current filters.</li>';
      return;
    }

    const nearest = source
      .map(f => {
        const [lng, lat] = f.geometry.coordinates;
        return { f, distance: haversineKm(userLocation.lat, userLocation.lng, lat, lng) };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);

    list.innerHTML = nearest.map(({ f, distance }) => {
      const p = f.properties;
      const dotColor = SEV_COLOR[p.severity] || '#94a3b8';
      const meta = [p.area, p.date && p.date !== '—' ? p.date : null].filter(Boolean).join(' · ');
      return `
        <li class="hotspot-item near-you-item" data-lat="${f.geometry.coordinates[1]}" data-lng="${f.geometry.coordinates[0]}">
          <span class="ny-dot" style="background:${dotColor}"></span>
          <div class="h-info">
            <div class="h-name">${esc(p.title || p.area || 'Accident')}</div>
            <div class="h-dots">${esc(meta || '—')}</div>
          </div>
          <div class="h-distance">${formatDistance(distance)}</div>
        </li>`;
    }).join('');

    list.querySelectorAll('.near-you-item').forEach(item => {
      item.addEventListener('click', () => {
        if (map && isMapLoaded) {
          map.flyTo({
            center: [parseFloat(item.dataset.lng), parseFloat(item.dataset.lat)],
            zoom: 15,
            essential: true,
            speed: 1.2,
          });
        }
      });
    });
  }

  function handlePosition(pos, { recenter = false } = {}) {
    userLocation = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    };
    setLocateStatus('ok', 'Location found · tap to re-center');
    updateUserMarker();

    if ((recenter || !hasAutoCentered) && map) {
      hasAutoCentered = true;
      map.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: 14, essential: true, speed: 1.1 });
    }

    refreshNearYou(lastFC);

    // If a "within X km" filter is active, re-run the main query/filter now that we have a fix.
    const distSel = document.getElementById('filter-distance');
    if (distSel && distSel.value !== 'all' && refreshDashboard) refreshDashboard();
  }

  function handleLocationError(err) {
    console.warn('Geolocation error:', err && err.message);
    let msg = 'Location unavailable';
    if (err && err.code === 1) msg = 'Location access denied';
    else if (err && err.code === 2) msg = 'Location unavailable';
    else if (err && err.code === 3) msg = 'Location request timed out';

    setLocateStatus('denied', msg);
    refreshNearYou(lastFC);

    // Don't silently filter by distance if we no longer trust the location fix.
    const distSel = document.getElementById('filter-distance');
    if (distSel && distSel.value !== 'all') {
      distSel.value = 'all';
      if (refreshDashboard) refreshDashboard();
    }
  }

  function requestLocation({ recenter = false, watch = false } = {}) {
    console.log('[BAT] requestLocation called. isSecureContext =', window.isSecureContext, 'protocol =', window.location.protocol);

    if (!('geolocation' in navigator)) {
      console.warn('[BAT] navigator.geolocation is not available in this browser/context.');
      setLocateStatus('denied', 'Geolocation not supported by this browser');
      refreshNearYou(lastFC);
      return;
    }
    if (!window.isSecureContext) {
      console.warn('[BAT] Not a secure context — browsers block geolocation outside https/localhost. Serve the site via the Express server (http://localhost:3000) rather than opening the file directly.');
    }

    setLocateStatus('locating', 'Locating…');
    navigator.geolocation.getCurrentPosition(
      pos => { console.log('[BAT] getCurrentPosition success', pos.coords); handlePosition(pos, { recenter }); },
      err => { console.error('[BAT] getCurrentPosition error', err); handleLocationError(err); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
    if (watch && watchId == null) {
      watchId = navigator.geolocation.watchPosition(
        pos => handlePosition(pos, { recenter: false }),
        err => { console.error('[BAT] watchPosition error', err); handleLocationError(err); },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 }
      );
    }
  }

  // ── Detail panel ──────────────────────────────────────────────────────────

  function openDetail(p) {
    const panel = document.getElementById('detail-panel');
    const body  = document.getElementById('detail-panel-body');
    if (!panel || !body) return;
    const sev = p.severity;
    const src = sourceInfo(p);
    body.innerHTML = `
      <span class="dp-badge dp-badge--${sev}">${sevLabel(sev)}</span>
      <div class="dp-headline">${esc(p.title)}</div>
      <div class="dp-rows">
        <div class="dp-row"><span class="dp-key">Date</span>    <span class="dp-val">${esc(String(p.date))}</span></div>
        <div class="dp-row"><span class="dp-key">Area</span>    <span class="dp-val">${esc(p.area || '—')}</span></div>
        <div class="dp-row"><span class="dp-key">Zone</span>    <span class="dp-val">${esc(p.zone || '—')}</span></div>
        <div class="dp-row"><span class="dp-key">Location</span><span class="dp-val">${esc(p.location || '—')}</span></div>
        <div class="dp-row"><span class="dp-key">Source</span>  <span class="dp-val">${esc(src.label)}${p.isUser ? ' <em>(user report)</em>' : ''}</span></div>
      </div>
      ${src.href ? `<a class="dp-link" href="${esc(src.href)}" target="_blank" rel="noopener noreferrer">${esc(src.linkText)}</a>` : ''}
    `;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
  }

  function closeDetail() {
    const panel = document.getElementById('detail-panel');
    if (panel) { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); }
  }

  // ── Stats & hotspots ──────────────────────────────────────────────────────

  function updateStats(fc) {
    const f = fc.features;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('stat-total',   f.length);
    set('stat-fatal',   f.filter(x => x.properties.severity === 'fatal').length);
    set('stat-serious', f.filter(x => x.properties.severity === 'serious').length);
    set('stat-minor',   f.filter(x => x.properties.severity === 'minor').length);
  }

  function updateHotspots(fc) {
    const areaMap = {};
    fc.features.forEach(f => {
      const p = f.properties;
      const a = p.area || 'Unknown';
      if (!areaMap[a]) areaMap[a] = { area: a, total: 0, fatal: 0, serious: 0, minor: 0, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
      areaMap[a].total++;
      areaMap[a][p.severity]++;
    });

    const list = Object.values(areaMap)
      .sort((a, b) => b.total - a.total)
      .map((h, i) => ({ ...h, rank: i + 1 }));

    const badge = document.getElementById('hotspot-count-badge');
    if (badge) badge.textContent = list.length + ' areas';

    const el = document.getElementById('hotspot-list');
    if (!el) return;
    const max = list[0]?.total || 1;

    el.innerHTML = list.slice(0, 12).map((h, i) => {
      const rc  = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-other';
      const pct = Math.round((h.total / max) * 100);
      return `
        <li class="hotspot-item" data-lat="${h.lat}" data-lng="${h.lng}">
          <div class="h-rank ${rc}">${h.rank}</div>
          <div class="h-info">
            <div class="h-name">${esc(h.area)}</div>
            <div class="h-dots">
              <span style="color:#dc2626">● ${h.fatal}</span>
              <span style="color:#d97706">● ${h.serious}</span>
              <span style="color:#3b82f6">● ${h.minor}</span>
            </div>
            <div class="h-bar-wrap"><div class="h-bar" style="width:${pct}%"></div></div>
          </div>
          <div class="h-count">${h.total}</div>
        </li>`;
    }).join('');

    el.querySelectorAll('.hotspot-item').forEach(item => {
      item.addEventListener('click', () => {
        if (map && isMapLoaded) {
          map.flyTo({
            center: [parseFloat(item.dataset.lng), parseFloat(item.dataset.lat)],
            zoom: 14,
            essential: true,
            speed: 1.2
          });
        }
      });
    });
  }

  // ── Filter helpers ─────────────────────────────────────────────────────────

  function readFilters() {
    const distanceRaw = document.getElementById('filter-distance')?.value || 'all';
    return {
      severity:   document.getElementById('filter-severity')?.value || 'all',
      area:       (document.getElementById('filter-area')?.value === 'all' && urlFilterState?.area) ? urlFilterState.area : (document.getElementById('filter-area')?.value || 'all'),
      zone:       (document.getElementById('filter-zone')?.value === 'all' && urlFilterState?.zone) ? urlFilterState.zone : (document.getElementById('filter-zone')?.value || 'all'),
      from:       document.getElementById('filter-from')?.value     || '',
      to:         document.getElementById('filter-to')?.value       || '',
      distanceKm: distanceRaw !== 'all' ? parseFloat(distanceRaw) : null,
    };
  }

  function restoreFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    urlFilterState = Object.fromEntries(params.entries());
    const values = { severity: 'filter-severity', area: 'filter-area', zone: 'filter-zone', from: 'filter-from', to: 'filter-to', distance: 'filter-distance' };
    Object.entries(values).forEach(([key, id]) => {
      const el = document.getElementById(id); const value = params.get(key);
      if (el && value) el.value = value;
    });
  }

  function writeFiltersToUrl(filters) {
    const params = new URLSearchParams();
    if (filters.severity !== 'all') params.set('severity', filters.severity);
    if (filters.area !== 'all') params.set('area', filters.area);
    if (filters.zone !== 'all') params.set('zone', filters.zone);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    if (filters.distanceKm) params.set('distance', String(filters.distanceKm));
    const target = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
    window.history.replaceState(null, '', target);
  }

  async function loadRiskOutlook() {
    const list = document.getElementById('risk-list'); const note = document.getElementById('risk-note');
    if (!list || !API_BASE) return;
    try {
      const response = await fetch(`${API_BASE}/api/risk/hotspots?hour=${new Date().getHours()}`, { cache: 'no-store' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      note.textContent = data.methodology || 'Historical risk indicators.';
      list.innerHTML = (data.hotspots || []).slice(0, 4).map(item => `<li class="hotspot-item"><div class="h-rank" style="width:30px;height:30px;color:#fff;background:${item.risk_level === 'high' ? '#dc2626' : item.risk_level === 'medium' ? '#d97706' : '#0ea5a4'}">${item.risk_score}</div><div class="h-info"><div class="h-name">${esc(item.area)}</div><div class="h-dots">${esc(item.factors[0] || 'Historical incident concentration')}</div></div></li>`).join('') || '<li class="hotspot-empty">No risk data available.</li>';
    } catch (error) { list.innerHTML = '<li class="hotspot-empty">Risk outlook unavailable offline.</li>'; }
  }

  function fillSelect(id, values, current) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const label = id === 'filter-zone' ? 'All Zones' : 'All Areas';
    const prev  = current && current !== 'all' ? current : (sel.value || 'all');
    sel.innerHTML = `<option value="all">${label}</option>`;
    values.forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    if (id === 'filter-area' || id === 'filter-zone') urlFilterState = null;
  }

  function unique(arr) {
    return [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  function setDownloadLinks(filters) {
    const qs = new URLSearchParams();
    if (filters.severity && filters.severity !== 'all') qs.set('severity', filters.severity);
    if (filters.area && filters.area !== 'all') qs.set('area', filters.area);
    if (filters.zone && filters.zone !== 'all') qs.set('zone', filters.zone);
    if (filters.from) qs.set('from', filters.from);
    if (filters.to) qs.set('to', filters.to);
    const suffix = qs.toString() ? '?' + qs.toString() : '';
    const csv = document.getElementById('download-csv');
    const geojson = document.getElementById('download-geojson');
    if (csv) csv.href = API_BASE + '/api/accidents?format=csv' + (qs.toString() ? '&' + qs.toString() : '');
    if (geojson) geojson.href = API_BASE + '/api/export/geojson' + suffix;
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  async function bootstrap() {
    try { initMap(); } catch (e) { console.error('[BAT] Map init failed:', e); }

    async function refresh() {
      const filters = readFilters();
      const { fc, label } = await loadAll(filters);
      lastFC = fc;

      const badge = document.getElementById('data-source-badge');
      if (badge) badge.textContent = label;

      setDownloadLinks(filters);
      fillSelect('filter-area', unique(fc.features.map(f => f.properties.area)), filters.area);
      fillSelect('filter-zone', unique(fc.features.map(f => f.properties.zone)), filters.zone);

      updateStats(fc);
      updateHotspots(fc);
      updateMap(fc);
      refreshNearYou(fc);
      writeFiltersToUrl(filters);
      loadRiskOutlook();
    }
    refreshDashboard = refresh;

    document.getElementById('apply-filters-btn')?.addEventListener('click', refresh);
    document.getElementById('share-view-btn')?.addEventListener('click', async () => {
      const button = document.getElementById('share-view-btn');
      try { await navigator.clipboard.writeText(window.location.href); button.textContent = 'Link copied'; }
      catch (_) { window.prompt('Copy this map view:', window.location.href); }
      setTimeout(() => { button.textContent = 'Share this view'; }, 1600);
    });
    document.getElementById('reset-filters-btn')?.addEventListener('click', () => {
      ['filter-severity', 'filter-area', 'filter-zone', 'filter-distance', 'filter-from', 'filter-to'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = el.tagName === 'SELECT' ? 'all' : '';
      });
      refresh();
    });

    document.getElementById('filter-distance')?.addEventListener('change', e => {
      if (e.target.value !== 'all' && !userLocation) requestLocation({ recenter: true, watch: true });
    });

    document.getElementById('locate-btn')?.addEventListener('click', () => {
      requestLocation({ recenter: true, watch: true });
    });

    document.getElementById('toggle-heatmap')?.addEventListener('change', e => {
      heatOn = e.target.checked;
      if (!map || !isMapLoaded) return;
      if (map.getLayer('accidents-heat')) {
        map.setLayoutProperty('accidents-heat', 'visibility', heatOn ? 'visible' : 'none');
      }
      if (map.getLayer('accidents-point')) {
        map.setLayoutProperty('accidents-point', 'visibility', heatOn ? 'none' : 'visible');
      }
    });

    let riskLoaded = false;
    document.getElementById('toggle-risk')?.addEventListener('change', async e => {
      const on = e.target.checked;
      const legend = document.getElementById('risk-legend');
      if (legend) legend.classList.toggle('on', on);
      if (!map || !isMapLoaded || !map.getLayer('risk-grid-fill')) return;
      if (on && !riskLoaded) {
        try {
          const res = await fetch(`${API_BASE}/api/risk/grid?minLevel=medium`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const grid = await res.json();
          map.getSource('risk-grid').setData({ type: 'FeatureCollection', features: grid.features });
          const note = document.getElementById('risk-note');
          const cv = grid.model?.metrics?.crossValidation;
          if (note && cv) {
            note.textContent = `Poisson model · 500 m cells · ${grid.model.nIncidents} incidents. Top 10% of cells held ${Math.round(cv.model.hit10 * 100)}% of held-out incidents.`;
            note.title = grid.model.metrics.explanation || '';
          }
          riskLoaded = true;
        } catch (err) {
          console.warn('[BAT] Risk grid unavailable:', err);
          const note = document.getElementById('risk-note');
          if (note) note.textContent = 'Risk prediction is unavailable (is the API server running?).';
        }
      }
      map.setLayoutProperty('risk-grid-fill', 'visibility', on ? 'visible' : 'none');
    });

    document.getElementById('detail-panel-close')?.addEventListener('click', closeDetail);

    window.addEventListener('beforeunload', () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    });

    // Live location fetch: ask for permission as soon as the dashboard opens.
    // This runs before/independently of the accident-data fetch below so a
    // slow or failed API/map load can never prevent the permission prompt.
    requestLocation({ recenter: true, watch: true });

    restoreFiltersFromUrl();
    try {
      await refresh();
    } catch (e) {
      console.error('[BAT] Dashboard refresh failed:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

})();
