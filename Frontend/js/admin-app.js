(function () {
  'use strict';

  const API = (window.BAT_CONFIG?.apiBase || 'http://localhost:3000').replace(/\/$/, '');
  const TOKEN_KEY = 'bat_admin_token';
  const PAGE_SIZE = 50;

  let token    = sessionStorage.getItem(TOKEN_KEY) || '';
  let curPage  = 1;
  let editMap  = null;
  let editMarker = null;
  let editingId  = null;
  let editOriginal = { title: '', date: '' }; // title and date when the Edit modal opened
  let deleteId   = null;
  let mapboxToken = '';
  let lastRows   = [];   // most recently loaded table rows
  let allMapRows = [];   // every accident matching current filters (for map view)
  let mapViewActive = false;
  let adminMap   = null; // MapLibre map instance for the drag-to-reposition view
  let adminPins  = new Map(); // accident id -> maplibregl.Marker

  // ── Toast notification system ─────────────────────────────────────────────

  /**
   * Show a toast notification.
   * @param {string} message - The message to display
   * @param {'success'|'error'|'warning'} type - Toast type (default: 'success')
   * @param {number} duration - Auto-dismiss duration in ms (default: 3000)
   */
  function toast(message, type = 'success', duration = 3000, actionLabel = null, onAction = null) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.setAttribute('role', 'alert');

    const icons = { success: '✓', error: '✕', warning: '⚠' };
    el.innerHTML = `<span class="toast-icon">${icons[type] || icons.success}</span><span class="toast-msg">${esc(message)}</span>`;

    let timer;
    if (actionLabel && onAction) {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'toast-action';
      actionBtn.textContent = actionLabel;
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearTimeout(timer);
        dismissToast(el);
        onAction();
      });
      el.appendChild(actionBtn);
    }

    container.appendChild(el);

    // Trigger slide-in animation
    requestAnimationFrame(() => { el.classList.add('toast--visible'); });

    // Auto-dismiss
    timer = setTimeout(() => dismissToast(el), duration);

    // Allow manual dismiss on click (but not when the action button was clicked)
    el.addEventListener('click', () => {
      clearTimeout(timer);
      dismissToast(el);
    });
  }

  function dismissToast(el) {
    el.classList.add('toast--dismissing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // Fallback removal if animationend doesn't fire
    setTimeout(() => { if (el.parentNode) el.remove(); }, 400);
  }

  // ── Auth helpers ──────────────────────────────────────────────────────────

  function authHeaders() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  /**
   * Attempt to refresh the Supabase JWT token.
   * @returns {boolean} true if refresh succeeded and token was updated
   */
  async function refreshToken() {
    const authClient = window.SupabaseAuthClient;
    if (!authClient) return false;
    try {
      const session = await authClient.getSession();
      if (session && session.access_token) {
        token = session.access_token;
        sessionStorage.setItem(TOKEN_KEY, token);
        return true;
      }
    } catch (e) {
      console.warn('[admin-app] Token refresh failed:', e);
    }
    return false;
  }

  /**
   * Authenticated fetch wrapper that handles 401 responses.
   * On 401: attempts token refresh, retries once with new token.
   * If refresh fails, redirects to admin login.
   *
   * @param {string} url - The URL to fetch
   * @param {object} options - Fetch options (method, body, etc.). Headers are auto-set.
   * @returns {Response} The fetch response
   * @throws {Error} If the fetch fails for non-auth reasons
   *
   * Requirements: 5.4, 5.5
   */
  // Integrity UI (admin-integrity.js) uses the same authenticated fetch.
  setTimeout(() => window.BATIntegrity?.init(authenticatedFetch, API), 0);
  // News Agent panel + Import from X (admin-agent.js); imports refresh the table.
  setTimeout(() => window.BATAgent?.init({ fetch: authenticatedFetch, api: API, toast, onChange: () => { loadData(curPage); loadStats(); } }), 0);

  async function authenticatedFetch(url, options = {}) {
    // Merge auth headers with any additional headers
    options.headers = { ...authHeaders(), ...(options.headers || {}) };

    const r = await fetch(url, options);
    // Any successful admin change (approve, reject, delete, import…) can change the stat cards.
    if (r.ok && options.method && options.method.toUpperCase() !== 'GET') scheduleStatsRefresh();

    if (r.status === 401) {
      // Attempt token refresh (Req 5.5)
      const refreshed = await refreshToken();
      if (refreshed) {
        // Retry request with refreshed token (overwrite Authorization)
        options.headers = { ...(options.headers || {}), ...authHeaders() };
        return fetch(url, options);
      } else {
        // Refresh failed — redirect to admin login (Req 5.5)
        token = '';
        sessionStorage.removeItem(TOKEN_KEY);
        showLogin();
        // Return original 401 response so callers can handle gracefully
        return r;
      }
    }

    return r;
  }

  async function checkAuth() {
    if (!token) return false;
    try {
      const r = await fetch(`${API}/api/admin/me`, { headers: authHeaders() });
      return r.ok;
    } catch { return false; }
  }

  /**
   * Check if user has admin role by inspecting app_metadata or user_metadata.
   * @param {object} user - Supabase user object
   * @returns {boolean}
   */
  function hasAdminRole(user) {
    if (!user) return false;
    // Check app_metadata.role only (set securely via Supabase admin API / service role)
    if (user.app_metadata && user.app_metadata.role === 'admin') return true;
    return false;
  }

  /**
   * Get display name for the admin user (email or display name from metadata).
   * @param {object} user - Supabase user object
   * @returns {string}
   */
  function getAdminDisplayName(user) {
    if (!user) return 'Admin';
    if (user.user_metadata && user.user_metadata.name) return user.user_metadata.name;
    return user.email || 'Admin';
  }

  // ── Inactivity Timer State ───────────────────────────────────────────────
  let inactivityTimer = null;

  function showApp(user) {
    document.getElementById('login-screen').hidden = true;
    document.getElementById('admin-app').hidden = false;
    document.getElementById('nav-user').textContent = ' ' + user;
    inactivityTimer = initInactivityTimer();
  }

  function showLogin() {
    document.getElementById('login-screen').hidden = false;
    document.getElementById('admin-app').hidden = true;
    if (inactivityTimer) {
      inactivityTimer.stop();
      inactivityTimer = null;
    }
  }

  async function loadConfig() {
    try {
      const r = await authenticatedFetch(`${API}/api/admin/config`);
      if (r.ok) {
        const data = await r.json();
        mapboxToken = data.mapboxToken;
      }
    } catch (e) {
      console.warn('Failed to load mapbox token from API:', e);
    }
  }

  // ── Login (Supabase Auth with role checking) ──────────────────────────────

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    const btn   = document.getElementById('login-btn');
    const email = document.getElementById('login-email').value.trim();
    const pass  = document.getElementById('login-pass').value;
    btn.textContent = 'Signing in…'; btn.disabled = true;
    errEl.hidden = true;

    try {
      // Wait for SupabaseAuthClient to be available (loaded via module script)
      const authClient = window.SupabaseAuthClient;
      if (!authClient) {
        throw new Error('Authentication service is not available. Please refresh the page.');
      }

      // Authenticate via Supabase Auth signInWithPassword (Req 5.1)
      const result = await authClient.signIn(email, pass);
      if (!result.success) {
        throw new Error(result.error || 'Login failed');
      }

      const user = result.user;

      // Check admin role in app_metadata or user_metadata (Req 5.2)
      if (!hasAdminRole(user)) {
        // Not an admin: display error, sign out, redirect within 3 seconds (Req 5.3)
        errEl.textContent = 'Access denied. You are not authorized as an administrator.';
        errEl.hidden = false;
        await authClient.signOut();
        setTimeout(() => {
          showLogin();
        }, 3000);
        return;
      }

      // Admin role confirmed — store Supabase JWT as token (Req 5.4)
      token = result.session.access_token;
      sessionStorage.setItem(TOKEN_KEY, token);

      // Display admin identifier (Req 5.5)
      const displayName = getAdminDisplayName(user);
      showApp(displayName);
      await loadConfig();
      loadData();
      loadStats();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      btn.textContent = 'Sign In'; btn.disabled = false;
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    // Sign out via Supabase Auth (Req 5.6)
    const authClient = window.SupabaseAuthClient;
    if (authClient) {
      await authClient.signOut();
    }
    token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    showLogin();
  });

  // ── Data loading ──────────────────────────────────────────────────────────

  async function loadData(page = 1) {
    curPage = page;
    syncPendingButton();
    const search   = document.getElementById('search-box').value.trim();
    const status   = document.getElementById('f-status').value;
    const severity = document.getElementById('f-severity').value;
    const sortVal  = document.getElementById('f-sort').value;

    let sortBy = 'accident_date';
    let sortOrder = 'desc';
    if (sortVal === 'date-asc') {
      sortBy = 'accident_date';
      sortOrder = 'asc';
    } else if (sortVal === 'id-desc') {
      sortBy = 'id';
      sortOrder = 'desc';
    } else if (sortVal === 'id-asc') {
      sortBy = 'id';
      sortOrder = 'asc';
    }

    const isIdSort = sortBy === 'id';
    const limit = isIdSort ? 10000 : PAGE_SIZE;

    const qs = new URLSearchParams({ page: isIdSort ? 1 : page, limit });
    if (search)            qs.set('search', search);
    if (status !== 'all')   qs.set('status', status);
    if (severity !== 'all') qs.set('severity', severity);
    qs.set('sortBy', sortBy);
    qs.set('sortOrder', sortOrder);

    const tbody = document.getElementById('table-body');
    tbody.innerHTML = '<tr><td colspan="10" class="t-loading">Loading…</td></tr>';

    try {
      const r = await authenticatedFetch(`${API}/api/admin/accidents?${qs}`);
      if (r.status === 401) return; // Already handled by authenticatedFetch (redirect to login)
      const data = await r.json();
      lastRows = data.rows;
      renderTable(data.rows);
      renderPagination(data.total, isIdSort ? 1 : page, limit);
      document.getElementById('record-count').textContent =
        `${data.total} record${data.total !== 1 ? 's' : ''}`;
      if (mapViewActive) {
        loadMapPins();
      }
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="10" class="t-loading" style="color:#dc2626">Error: ${e.message}</td></tr>`;
    }
  }

  // ── Stat cards: database-wide totals, whatever the filter or page ─────────

  let statsTimer = null;

  async function loadStats() {
    try {
      const r = await authenticatedFetch(`${API}/api/admin/stats`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = await r.json();
      const show = (id, n) => {
        const el = document.getElementById(id);
        if (el) el.textContent = Number.isFinite(n) ? n.toLocaleString() : '—';
      };
      show('s-total', s.total);
      show('s-active', s.active);
      show('s-pending', s.pending);
      // Rejected records are hidden from the public too, so they count here.
      show('s-hidden', (s.hidden || 0) + (s.rejected || 0));
      const hiddenBox = document.getElementById('s-hidden-box');
      if (hiddenBox) hiddenBox.title = `${s.hidden || 0} hidden, ${s.rejected || 0} rejected`;
      show('s-fatal', s.fatal);
      show('s-serious', s.serious);
      show('s-minor', s.minor);
    } catch (e) {
      console.warn('[admin-app] Record counts unavailable:', e.message);
    }
  }

  /** After approve / reject / delete / import (any admin change), refresh the cards once. */
  function scheduleStatsRefresh() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(loadStats, 400);
  }

  function updateRowInTable(id, lat, lng, location, area) {
    const rowEl = document.querySelector(`tr[data-id="${id}"]`);
    if (!rowEl) return;

    const coordCell = rowEl.querySelector('.cell-coords');
    if (coordCell) {
      if (lat && lng) {
        coordCell.innerHTML = `<span>${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)}</span>`;
      } else {
        coordCell.innerHTML = `<span class="no-coords">No coords</span>`;
      }
    }

    const locCell = rowEl.querySelector('.cell-loc');
    if (locCell) {
      locCell.textContent = location || area || '—';
    }

    const editBtn = rowEl.querySelector('[data-action="edit"]');
    if (editBtn && editBtn.dataset.row) {
      try {
        const rowData = JSON.parse(editBtn.dataset.row);
        rowData.lat = lat || '';
        rowData.lng = lng || '';
        rowData.location = location || '';
        rowData.area = area || '';
        editBtn.dataset.row = JSON.stringify(rowData);
      } catch (e) {
        console.error('Failed to update edit button row dataset', e);
      }
    }
  }

  // ── Render table ──────────────────────────────────────────────────────────

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Safely embed a JSON blob inside a single-quoted HTML attribute (data-row='...').
  function jsonAttr(obj) {
    return JSON.stringify(obj)
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderTable(rows) {
    const tbody = document.getElementById('table-body');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="t-loading">No records found.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const sevClass = `sev-${r.severity}`;
      const sevLabel = r.severity === 'fatal' ? 'Fatal' : r.severity === 'serious' ? 'Serious' : 'Minor';
      const hasLink  = r.link && r.link !== '#' && /^https?:\/\//i.test(r.link);
      const titleHtml = hasLink
        ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a>`
        : `<span class="no-link">${esc(r.title)}</span>`;
      const coordHtml = r.lat && r.lng
        ? `<span>${parseFloat(r.lat).toFixed(4)}, ${parseFloat(r.lng).toFixed(4)}</span>`
        : `<span class="no-coords">No coords</span>`;
      const stClass = r.status === 'active' ? 'status-active' : r.status === 'pending' ? 'status-pending' : 'status-hidden';
      // Plain labels: the status-badge ::before already draws the coloured dot.
      const stLabel = r.status === 'active' ? 'Active' : r.status === 'pending' ? 'Pending' : 'Hidden';
      // Checkbox cell for bulk actions
      const checkboxCell = `<td><input type="checkbox" class="row-select" data-id="${esc(r.id)}" aria-label="Select ${esc(r.id)}"></td>`;

      // Where the row came from: citizen report, News Agent or an X post.
      const kind = window.BATAgent?.sourceKind(r) || (r.reporter_id ? 'user' : null);
      const sourceBadge = window.BATAgent?.sourceBadgeHtml(r) || '';
      // Approved by the BAT Review Agent: a badge, and Undo (back to Pending).
      const reviewBadge = window.BATAgent?.reviewBadgeHtml(r) || '';
      const reviewUndo = window.BATAgent?.reviewUndoHtml(r) || '';

      // A compact snapshot of this row's fields for the Review modal / buttons.
      const reviewData = jsonAttr({
        id: r.id, title: r.title, area: r.area || '', location: r.location || '',
        severity: r.severity, date: r.date || r.date_raw || '', description: r.description || '',
        proof_url: r.proof_url || '', reporter_id: r.reporter_id || '', created_at: r.created_at || '',
        lat: r.lat || '', lng: r.lng || '', status: r.status, source: r.source || '', link: r.link || '', kind: kind || '',
      });

      // Review/Approve/Reject for every pending row; the AI integrity check is for citizen reports only.
      let pendingBtns = '';
      if (r.status === 'pending') {
        pendingBtns = `
          <button class="btn-review" data-action="review" data-row='${reviewData}'>Review</button>
          ${r.reporter_id ? `<span class="integrity-pill pending" data-integrity-id="${esc(r.id)}">AI check…</span>` : ''}
          <button class="btn-approve" data-action="approve" data-id="${esc(r.id)}">Approve</button>
          <button class="btn-reject" data-action="reject" data-id="${esc(r.id)}">Reject</button>
        `;
      }

      const rejectionNote = r.rejection_reason ? `<div style="font-size:12px;color:#b91c1c;margin-top:6px">Reason: ${esc(r.rejection_reason)}</div>` : '';
      const proofLink = r.proof_url
        ? `<div class="proof-thumb" data-action="review" data-row='${reviewData}' title="Click to review this user submission">
             <img src="${esc(r.proof_url)}" alt="Uploaded proof photo" loading="lazy">
           </div>`
        : '';

      return `<tr data-id="${esc(r.id)}">
        ${checkboxCell}
        <td class="cell-id">${esc(r.id)}</td>
        <td class="cell-title">${titleHtml}</td>
        <td class="cell-source">${esc(r.source || '—')}${sourceBadge}${reviewBadge}</td>
        <td class="cell-date">${esc(r.date || '—')}</td>
        <td class="cell-loc">${esc(r.location || r.area || '—')}${proofLink}</td>
        <td><span class="sev-badge ${sevClass}">${sevLabel}</span></td>
        <td class="cell-coords">${coordHtml}</td>
        <td>
          <button class="status-badge ${stClass}" data-action="toggle-status" data-id="${esc(r.id)}" data-status="${esc(r.status)}">
            ${stLabel}
          </button>
          ${rejectionNote}
        </td>
        <td>
          <div class="action-btns">
            <button class="btn-edit" data-action="edit" data-id="${esc(r.id)}" data-row='${jsonAttr({id:r.id,title:r.title,date:r.date||'',link:r.link||'',lat:r.lat||'',lng:r.lng||'',location:r.location||'',area:r.area||''})}'> Edit</button>
            <button class="btn-del"  data-action="delete" data-id="${esc(r.id)}" data-title="${esc(r.title)}"> Delete</button>
            ${pendingBtns}
            ${reviewUndo}
          </div>
        </td>
      </tr>`;
    }).join('');

    // Attach click handlers
    tbody.querySelectorAll('[data-action="toggle-status"]').forEach(btn => {
      btn.addEventListener('click', () => toggleStatus(btn.dataset.id, btn.dataset.status));
    });
    tbody.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', () => openEdit(JSON.parse(btn.dataset.row)));
    });
    tbody.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => openConfirmDelete(btn.dataset.id, btn.dataset.title));
    });
    // Approve / Reject single items
    tbody.querySelectorAll('[data-action="approve"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        try {
          const r = await authenticatedFetch(`${API}/api/admin/accidents/bulk`, { method: 'POST', body: JSON.stringify({ ids: [id], action: 'verify' }) });
          if (!r.ok) throw new Error((await r.json()).error || 'Failed');
          toast('Approved', 'success');
          loadData(curPage);
        } catch (e) { toast('Approve failed: ' + e.message, 'error'); }
      });
    });
    tbody.querySelectorAll('[data-action="reject"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        // open reject modal for single id
        openRejectModal([id]);
      });
    });
    // Review a user submission (photo + full details) before approving/rejecting
    tbody.querySelectorAll('[data-action="review"]').forEach(el => {
      el.addEventListener('click', () => openReview(JSON.parse(el.dataset.row)));
    });
    // Undo a Review Agent approval (asks first; the table reloads through BATAgent's onChange)
    tbody.querySelectorAll('[data-action="review-undo"]').forEach(btn => {
      btn.addEventListener('click', () => window.BATAgent?.undoReview(btn.dataset.id));
    });
    // Row selection handlers
    tbody.querySelectorAll('.row-select').forEach(cb => { cb.addEventListener('change', () => {}); });
    // Reset header select-all checkbox when table is refreshed
    const selAll = document.getElementById('select-all'); if (selAll) selAll.checked = false;
    // AI integrity verdicts for pending user reports
    window.BATIntegrity?.loadBadges(tbody);
  }

  // ── Pagination ────────────────────────────────────────────────────────────

  function renderPagination(total, page, limit) {
    const pages = Math.ceil(total / limit);
    const el = document.getElementById('pagination');
    if (pages <= 1) { el.innerHTML = ''; return; }

    const btns = [];
    btns.push(`<button class="pg-btn" ${page === 1 ? 'disabled' : ''} data-p="${page-1}">‹ Prev</button>`);
    for (let p = Math.max(1, page-2); p <= Math.min(pages, page+2); p++) {
      btns.push(`<button class="pg-btn ${p===page?'active':''}" data-p="${p}">${p}</button>`);
    }
    btns.push(`<button class="pg-btn" ${page===pages?'disabled':''} data-p="${page+1}">Next ›</button>`);
    el.innerHTML = btns.join('');
    el.querySelectorAll('.pg-btn:not(:disabled)').forEach(b => {
      b.addEventListener('click', () => loadData(parseInt(b.dataset.p)));
    });
  }

  // ── Toggle status ─────────────────────────────────────────────────────────

  async function toggleStatus(id, current) {
    const newStatus = current === 'active' ? 'hidden' : 'active';
    try {
      const r = await authenticatedFetch(`${API}/api/admin/accidents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      if (r.status === 401) return; // Handled by authenticatedFetch
      if (!r.ok) throw new Error((await r.json()).error);
      loadData(curPage);
    } catch (e) {
      toast('Failed to update status: ' + e.message, 'error');
    }
  }

  // ── Edit modal ────────────────────────────────────────────────────────────

  function openEdit(row) {
    editingId = row.id;
    const modal = document.getElementById('edit-modal');
    document.getElementById('modal-search-place').value = '';

    document.getElementById('modal-info').innerHTML =
      `<strong>${esc(row.title)}</strong><br>
       <span style="font-size:12px;color:#64748b">${esc(row.location || row.area || '—')}</span>`;

    const latVal = parseFloat(row.lat) || 12.9716;
    const lngVal = parseFloat(row.lng) || 77.5946;
    document.getElementById('edit-lat').value = row.lat || '';
    document.getElementById('edit-lng').value = row.lng || '';
    document.getElementById('edit-location').value = row.location || '';
    document.getElementById('edit-area').value = row.area || '';

    // Title and accident date: only sent on save when the admin changes them.
    editOriginal = { title: row.title || '', date: String(row.date || '').slice(0, 10) };
    document.getElementById('edit-title').value = editOriginal.title;
    const dateInput = document.getElementById('edit-date');
    dateInput.value = /^\d{4}-\d{2}-\d{2}$/.test(editOriginal.date) ? editOriginal.date : '';
    dateInput.max = todayIst();

    const linkEl = document.getElementById('modal-link');
    const linkOpen = document.getElementById('modal-link-open');
    linkEl.value = row.link || '';
    if (row.link && /^https?:\/\//i.test(row.link)) {
      linkOpen.href = row.link;
      linkOpen.style.opacity = '1';
      linkOpen.style.pointerEvents = 'auto';
    } else {
      linkOpen.href = '#';
      linkOpen.style.opacity = '0.4';
      linkOpen.style.pointerEvents = 'none';
    }

    document.getElementById('modal-error').hidden = true;
    modal.hidden = false;

    // Init or update map
    setTimeout(() => {
      if (!editMap) {
        editMap = new maplibregl.Map({
          container: 'edit-map',
          style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
          center: [lngVal, latVal],
          zoom: 13,
        });

        editMap.addControl(new maplibregl.NavigationControl(), 'top-right');

        editMarker = new maplibregl.Marker({ color: '#dc2626', draggable: true })
          .setLngLat([lngVal, latVal])
          .addTo(editMap);

        // Click map to reposition marker and update inputs
        editMap.on('click', e => {
          const { lng, lat } = e.lngLat;
          document.getElementById('edit-lat').value = lat.toFixed(6);
          document.getElementById('edit-lng').value = lng.toFixed(6);
          editMarker.setLngLat([lng, lat]);
        });

        // Drag marker to update inputs
        editMarker.on('dragend', () => {
          const { lng, lat } = editMarker.getLngLat();
          document.getElementById('edit-lat').value = lat.toFixed(6);
          document.getElementById('edit-lng').value = lng.toFixed(6);
        });
      } else {
        editMap.setCenter([lngVal, latVal]);
        editMarker.setLngLat([lngVal, latVal]);
      }

      setTimeout(() => editMap.resize(), 100);
    }, 100);

    // Sync inputs → marker
    ['edit-lat','edit-lng'].forEach(id => {
        document.getElementById(id).oninput = () => {
          const lat = parseFloat(document.getElementById('edit-lat').value);
          const lng = parseFloat(document.getElementById('edit-lng').value);
          if (!isNaN(lat) && !isNaN(lng)) {
            if (editMarker) editMarker.setLngLat([lng, lat]);
            if (editMap) editMap.setCenter([lng, lat]);
            // Debounced duplicate check when coordinates change
            scheduleDuplicateCheck(lat, lng);
          }
        };
    });
    // Initial duplicate check for this record (use record id)
    checkDuplicates(editingId);
  }

  function closeEdit() {
    document.getElementById('edit-modal').hidden = true;
    editingId = null;
  }

  /** Today's date in India; the server refuses accident dates after it. */
  function todayIst() {
    return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // ── Map View: drag pins to reposition accident coordinates ───────────────

  const PIN_COLORS = { fatal: '#dc2626', serious: '#f59e0b', minor: '#3b82f6' };

  function pinSvg(color) {
    return `<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 0C5.8 0 0 5.8 0 13c0 9.75 13 21 13 21s13-11.25 13-21C26 5.8 20.2 0 13 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      <circle cx="13" cy="13" r="5" fill="#fff"/>
    </svg>`;
  }

  function initAdminMap() {
    if (adminMap) return;
    adminMap = new maplibregl.Map({
      container: 'admin-map',
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [77.5946, 12.9716],
      zoom: 11,
      cooperativeGestures: true,
    });
    adminMap.addControl(new maplibregl.NavigationControl(), 'top-right');
  }

  function clearMapPins() {
    adminPins.forEach(marker => marker.remove());
    adminPins.clear();
  }

  function createPinPopupContent(r) {
    const latStr = r.lat != null ? parseFloat(r.lat).toFixed(5) : '—';
    const lngStr = r.lng != null ? parseFloat(r.lng).toFixed(5) : '—';
    const sev = (r.severity || 'minor').toLowerCase();
    return `
      <div class="admin-pin-popup">
        <div class="pp-title">${esc(r.title || r.id)}</div>
        <div class="pp-meta">
          <span class="sev-badge sev-${sev}">${esc(sev.toUpperCase())}</span> · <span style="text-transform:capitalize;font-weight:600">${esc(r.status || 'active')}</span><br>
          <strong>Location:</strong> ${esc(r.location || r.area || '—')}<br>
          <span style="font-family:monospace;font-size:11px;color:#64748b;display:inline-block;margin-top:4px">📍 ${latStr}, ${lngStr}</span>
        </div>
      </div>`;
  }

  function renderMapPins(rows) {
    if (!adminMap) return;
    clearMapPins();

    const withCoords = (rows || []).filter(r => {
      const lat = parseFloat(r.lat), lng = parseFloat(r.lng);
      return !isNaN(lat) && !isNaN(lng);
    });
    if (!withCoords.length) return;

    const bounds = new maplibregl.LngLatBounds();

    withCoords.forEach(r => {
      const lat = parseFloat(r.lat), lng = parseFloat(r.lng);
      const color = PIN_COLORS[r.severity] || '#64748b';

      const el = document.createElement('div');
      el.className = 'admin-pin';
      el.innerHTML = pinSvg(color);

      const popup = new maplibregl.Popup({ offset: 20, closeButton: false }).setHTML(createPinPopupContent(r));

      const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(adminMap);

      let dragStart = { lat, lng };
      marker.on('dragstart', () => {
        dragStart = marker.getLngLat();
        el.classList.add('is-dragging');
      });
      marker.on('dragend', () => {
        el.classList.remove('is-dragging');
        const { lat: newLat, lng: newLng } = marker.getLngLat();
        savePinLocation(r, { lat: dragStart.lat, lng: dragStart.lng }, { lat: newLat, lng: newLng }, marker);
      });

      adminPins.set(r.id, marker);
      bounds.extend([lng, lat]);
    });

    if (!bounds.isEmpty()) {
      adminMap.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 400 });
    }
  }

  async function savePinLocation(row, prevPos, newPos, marker) {
    try {
      const r = await authenticatedFetch(`${API}/api/admin/accidents/${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ lat: newPos.lat, lng: newPos.lng }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      const resData = await r.json();
      const updated = resData.accident || {};

      // 1. Update row object
      row.lat = newPos.lat;
      row.lng = newPos.lng;
      if (updated.location) row.location = updated.location;
      if (updated.area) row.area = updated.area;
      if (updated.zone) row.zone = updated.zone;

      // 2. Update allMapRows in-memory cache
      const cachedMap = allMapRows.find(m => String(m.id) === String(row.id));
      if (cachedMap) {
        cachedMap.lat = newPos.lat;
        cachedMap.lng = newPos.lng;
        if (updated.location) cachedMap.location = updated.location;
        if (updated.area) cachedMap.area = updated.area;
        if (updated.zone) cachedMap.zone = updated.zone;
      }

      // 3. Update lastRows in-memory cache
      const cachedTable = lastRows.find(m => String(m.id) === String(row.id));
      if (cachedTable) {
        cachedTable.lat = newPos.lat;
        cachedTable.lng = newPos.lng;
        if (updated.location) cachedTable.location = updated.location;
        if (updated.area) cachedTable.area = updated.area;
        if (updated.zone) cachedTable.zone = updated.zone;
      }

      // 4. Update the DOM table row if present
      updateRowInTable(row.id, newPos.lat, newPos.lng, row.location, row.area);

      // 5. Update marker popup content with new coords & location
      if (marker && marker.getPopup()) {
        marker.getPopup().setHTML(createPinPopupContent(row));
      }

      // 6. Update edit modal inputs if currently open for this accident
      if (editingId && String(editingId) === String(row.id)) {
        const latInput = document.getElementById('edit-lat');
        const lngInput = document.getElementById('edit-lng');
        const locInput = document.getElementById('edit-location');
        const areaInput = document.getElementById('edit-area');
        if (latInput) latInput.value = Number(newPos.lat).toFixed(6);
        if (lngInput) lngInput.value = Number(newPos.lng).toFixed(6);
        if (locInput && row.location) locInput.value = row.location;
        if (areaInput && row.area) areaInput.value = row.area;
        if (editMarker) editMarker.setLngLat([newPos.lng, newPos.lat]);
        if (editMap) editMap.setCenter([newPos.lng, newPos.lat]);
      }

      const locText = row.location ? ` to ${row.location}` : ` (${newPos.lat.toFixed(4)}, ${newPos.lng.toFixed(4)})`;
      toast(
        `Updated location for "${row.title || row.id}"${locText}`,
        'success', 6000, 'Undo',
        () => {
          marker.setLngLat([prevPos.lng, prevPos.lat]);
          savePinLocation(row, newPos, prevPos, marker);
        }
      );
    } catch (e) {
      marker.setLngLat([prevPos.lng, prevPos.lat]); // revert the pin since the save failed
      toast('Failed to update location: ' + e.message, 'error');
    }
  }

  let mapLoading = false;

  async function loadMapPins() {
    if (!adminMap && mapViewActive) initAdminMap();
    if (adminMap) adminMap.resize();

    const search   = document.getElementById('search-box').value.trim();
    const status   = document.getElementById('f-status').value;
    const severity = document.getElementById('f-severity').value;

    const qs = new URLSearchParams({ limit: 10000, page: 1 });
    if (search)            qs.set('search', search);
    if (status !== 'all')   qs.set('status', status);
    if (severity !== 'all') qs.set('severity', severity);

    const hintEl = document.querySelector('.map-view-hint');
    if (hintEl && mapViewActive && !allMapRows.length) {
      hintEl.innerHTML = `📍 Loading points of every accident…`;
    }

    try {
      mapLoading = true;
      const r = await authenticatedFetch(`${API}/api/admin/accidents?${qs}`);
      if (r.status === 401) return;
      const data = await r.json();
      allMapRows = data.rows || [];

      if (mapViewActive) {
        renderMapPins(allMapRows);
      }

      const withCoordsCount = allMapRows.filter(r => {
        const lat = parseFloat(r.lat), lng = parseFloat(r.lng);
        return !isNaN(lat) && !isNaN(lng);
      }).length;

      if (hintEl) {
        hintEl.innerHTML = `📍 Showing all <strong>${withCoordsCount}</strong> accidents on the map. Drag any pin to update coordinates. Changes save automatically.`;
      }

    } catch (e) {
      console.error('Failed to load all map pins:', e);
      if (mapViewActive) renderMapPins(lastRows);
      if (hintEl) {
        hintEl.innerHTML = `📍 Drag any pin and drop it on the correct location to update that accident's coordinates. Changes save automatically.`;
      }
    } finally {
      mapLoading = false;
    }
  }

  function toggleMapView() {
    mapViewActive = !mapViewActive;
    const mapWrap = document.getElementById('map-view-wrap');
    const tableWrap = document.getElementById('table-wrap');
    const pagination = document.getElementById('pagination');
    const btn = document.getElementById('map-view-toggle');

    if (mapWrap) mapWrap.hidden = !mapViewActive;
    if (tableWrap) tableWrap.hidden = mapViewActive;
    if (pagination) pagination.hidden = mapViewActive;
    if (btn) {
      btn.textContent = mapViewActive ? 'Table View' : 'Map View';
      btn.classList.toggle('is-active', mapViewActive);
      btn.setAttribute('aria-pressed', String(mapViewActive));
    }

    if (mapViewActive) {
      initAdminMap();
      setTimeout(() => {
        adminMap.resize();
        if (allMapRows && allMapRows.length > 0) {
          renderMapPins(allMapRows);
          const withCoordsCount = allMapRows.filter(r => !isNaN(parseFloat(r.lat)) && !isNaN(parseFloat(r.lng))).length;
          const hintEl = document.querySelector('.map-view-hint');
          if (hintEl) {
            hintEl.innerHTML = `📍 Showing all <strong>${withCoordsCount}</strong> accidents on the map. Drag any pin to update coordinates. Changes save automatically.`;
          }
        }
        loadMapPins();
      }, 50);
    }
  }

  document.getElementById('map-view-toggle')?.addEventListener('click', toggleMapView);

  // ── Duplicate detection helpers ─────────────────────────────────────────
  let dupTimer = null;
  function scheduleDuplicateCheck(lat, lng) {
    if (dupTimer) clearTimeout(dupTimer);
    dupTimer = setTimeout(() => checkDuplicates(editingId, lat, lng), 450);
  }

  async function checkDuplicates(id, lat = null, lng = null) {
    const el = document.getElementById('modal-duplicates');
    if (!el) return;
    el.textContent = 'Checking for nearby records…';
    try {
      const qs = new URLSearchParams();
      if (lat !== null && lng !== null) {
        qs.set('lat', String(lat)); qs.set('lng', String(lng));
      }
      const url = `${API}/api/admin/accidents/${encodeURIComponent(id)}/duplicates${qs.toString() ? ('?' + qs.toString()) : ''}`;
      const r = await authenticatedFetch(url);
      if (r.status === 401) return;
      const data = await r.json();
      if (!data || !data.length) {
        el.innerHTML = '<span style="color:var(--text-muted)">No nearby duplicates found.</span>';
        return;
      }
      // Render small list
      el.innerHTML = data.map(d => {
        const dist = d.distance_m ? (Number(d.distance_m).toFixed(0) + 'm') : '';
        return `<div style="padding:6px 0;border-bottom:1px solid rgba(15,23,42,0.04)"><strong>${esc(d.title || d.location || d.id)}</strong> <span style="color:#64748b;font-size:12px">${esc(d.accident_date||'')} • ${dist}</span><br><a href="#" data-id="${esc(d.id)}" class="dup-open">Open</a></div>`;
      }).join('');
      // Attach handlers to open duplicates in editor
      el.querySelectorAll('.dup-open').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const rid = a.dataset.id;
          // find row in table and trigger edit if present
          const rowBtn = document.querySelector(`#table-body [data-action="edit"][data-id="${rid}"]`);
          if (rowBtn) { rowBtn.click(); }
          else { toast('Duplicate not currently loaded in table. Refresh table to edit it.', 'warning'); }
        });
      });
    } catch (e) {
      el.innerHTML = `<span style="color:#dc2626">Duplicate check failed: ${e.message}</span>`;
    }
  }

  async function searchPlaceOnMap() {
    const searchVal = document.getElementById('modal-search-place').value.trim();
    const errEl = document.getElementById('modal-error');
    const searchBtn = document.getElementById('modal-search-btn');
    errEl.hidden = true;

    if (!searchVal) return;

    searchBtn.disabled = true;
    searchBtn.textContent = 'Searching…';

    try {
      let lat = null, lng = null, displayName = '';

      if (mapboxToken) {
        // Mapbox Places API — bbox limits results to Bangalore metropolitan area
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(searchVal)}.json?access_token=${mapboxToken}&bbox=77.35,12.7,77.85,13.25&limit=1`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Mapbox HTTP ${res.status}`);
        const data = await res.json();
        if (data && data.features && data.features.length > 0) {
          const feat = data.features[0];
          lng = feat.center[0];
          lat = feat.center[1];
          displayName = feat.place_name;
        }
      } else {
        // Nominatim (OSM) fallback query
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchVal + ', Bengaluru, Karnataka, India')}&format=json&limit=1`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
        const data = await res.json();
        if (data && data.length > 0) {
          lat = parseFloat(data[0].lat);
          lng = parseFloat(data[0].lon);
          displayName = data[0].display_name;
        } else {
          // Nominatim fallback with Karnataka
          const fallbackUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchVal + ', Karnataka, India')}&format=json&limit=1`;
          const resFallback = await fetch(fallbackUrl);
          if (!resFallback.ok) throw new Error(`Nominatim Fallback HTTP ${resFallback.status}`);
          const dataFallback = await resFallback.json();
          if (dataFallback && dataFallback.length > 0) {
            lat = parseFloat(dataFallback[0].lat);
            lng = parseFloat(dataFallback[0].lon);
            displayName = dataFallback[0].display_name;
          }
        }
      }

      if (lat !== null && lng !== null) {
        document.getElementById('edit-lat').value = lat.toFixed(6);
        document.getElementById('edit-lng').value = lng.toFixed(6);

        if (editMap) {
          if (editMarker) editMarker.setLngLat([lng, lat]);
          editMap.setCenter([lng, lat]);
          editMap.setZoom(14);
        }
        console.log(`Geocoded "${searchVal}" to: (${lat}, ${lng}) - ${displayName}`);
      } else {
        errEl.textContent = 'Location not found. Please try a different name or set coordinates manually.';
        errEl.hidden = false;
      }
    } catch (e) {
      errEl.textContent = 'Search failed: ' + e.message;
      errEl.hidden = false;
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = 'Search';
    }
  }

  document.getElementById('modal-search-btn').addEventListener('click', searchPlaceOnMap);
  document.getElementById('modal-search-place').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchPlaceOnMap();
    }
  });

  document.getElementById('modal-close').addEventListener('click', closeEdit);
  document.getElementById('modal-cancel').addEventListener('click', closeEdit);

  document.getElementById('modal-save').addEventListener('click', async () => {
    const lat = parseFloat(document.getElementById('edit-lat').value);
    const lng = parseFloat(document.getElementById('edit-lng').value);
    const location = document.getElementById('edit-location').value.trim();
    const area = document.getElementById('edit-area').value.trim();
    const title = document.getElementById('edit-title').value.replace(/\s+/g, ' ').trim();
    const date = document.getElementById('edit-date').value;
    const errEl = document.getElementById('modal-error');
    errEl.hidden = true;

    // Title and date go only when changed (the server checks them again).
    const extra = {};
    if (title !== editOriginal.title.replace(/\s+/g, ' ').trim()) {
      if (title.length < 5 || title.length > 200) {
        errEl.textContent = 'Title must be 5 to 200 characters.';
        errEl.hidden = false; return;
      }
      extra.title = title;
    }
    if (date && date !== editOriginal.date) {
      if (date > todayIst()) {
        errEl.textContent = 'Accident date cannot be in the future.';
        errEl.hidden = false; return;
      }
      extra.accident_date = date;
    }

    if (isNaN(lat) || isNaN(lng)) {
      errEl.textContent = 'Please enter valid latitude and longitude, or click on the map.';
      errEl.hidden = false; return;
    }
    if (lat < 12.5 || lat > 13.5 || lng < 77.0 || lng > 78.2) {
      errEl.textContent = `Warning: (${lat.toFixed(4)}, ${lng.toFixed(4)}) is outside the Bangalore region. Continue saving anyway?`;
      errEl.hidden = false;
      // allow save anyway on second click
    }

    try {
      const r = await authenticatedFetch(`${API}/api/admin/accidents/${encodeURIComponent(editingId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ lat, lng, location, area, ...extra }),
      });
      if (r.status === 401) return; // Handled by authenticatedFetch
      if (!r.ok) throw new Error((await r.json()).error);
      const savedId = editingId; // closeEdit() clears editingId
      closeEdit();
      if (extra.title || extra.accident_date) {
        // Title and date show in several places (row, Review data, pins): reload the page of rows.
        loadData(curPage);
        return;
      }
      updateRowInTable(savedId, lat, lng, location, area);
      const mr = allMapRows.find(m => String(m.id) === String(savedId));
      if (mr) { mr.lat = lat; mr.lng = lng; mr.location = location; mr.area = area; }
      const marker = adminPins.get(savedId);
      if (marker) {
        marker.setLngLat([lng, lat]);
        if (marker.getPopup() && mr) {
          marker.getPopup().setHTML(createPinPopupContent(mr));
        }
      }
    } catch (e) {
      errEl.textContent = 'Save failed: ' + e.message;
      errEl.hidden = false;
    }
  });

  // ── Delete modal ──────────────────────────────────────────────────────────

  function openConfirmDelete(id, title) {
    deleteId = id;
    document.getElementById('confirm-text').innerHTML =
      `This will <strong>permanently delete</strong> the following record from PostgreSQL. This cannot be undone.<br><br>
       <em style="color:#dc2626">"${esc(title)}"</em>`;
    document.getElementById('confirm-modal').hidden = false;
  }

  function closeConfirmDelete() {
    document.getElementById('confirm-modal').hidden = true;
    deleteId = null;
  }

  document.getElementById('confirm-close').addEventListener('click', closeConfirmDelete);
  document.getElementById('confirm-cancel').addEventListener('click', closeConfirmDelete);

  document.getElementById('confirm-ok').addEventListener('click', async () => {
    try {
      const r = await authenticatedFetch(`${API}/api/admin/accidents/${encodeURIComponent(deleteId)}`, {
        method: 'DELETE',
      });
      if (r.status === 401) return; // Handled by authenticatedFetch
      if (!r.ok) throw new Error((await r.json()).error);
      closeConfirmDelete();
      loadData(curPage);
    } catch (e) {
      toast('Delete failed: ' + e.message, 'error');
    }
  });

  // Close modals on backdrop click
  document.getElementById('edit-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeEdit(); });
  document.getElementById('confirm-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeConfirmDelete(); });

  // ── Add Article modal ────────────────────────────────────────────────────
  const addModal = document.getElementById('add-modal');
  const uploadBtn = document.getElementById('upload-btn');

  uploadBtn.addEventListener('click', () => {
    document.getElementById('add-title').value = '';
    document.getElementById('add-source').value = '';
    document.getElementById('add-link').value = '';
    document.getElementById('add-content').value = '';
    document.getElementById('add-modal-error').hidden = true;
    addModal.hidden = false;
  });

  function closeAddModal() {
    addModal.hidden = true;
  }

  document.getElementById('add-modal-close').addEventListener('click', closeAddModal);
  document.getElementById('add-modal-cancel').addEventListener('click', closeAddModal);

  document.getElementById('add-modal-save').addEventListener('click', async () => {
    const title = document.getElementById('add-title').value.trim();
    const source = document.getElementById('add-source').value.trim();
    const link = document.getElementById('add-link').value.trim();
    const content = document.getElementById('add-content').value.trim();
    const errEl = document.getElementById('add-modal-error');
    const saveBtn = document.getElementById('add-modal-save');
    errEl.hidden = true;

    if (!link && (!title || !content)) {
      errEl.textContent = 'Please provide either an Article Link, or Title and Content manually.';
      errEl.hidden = false;
      return;
    }

    if (link && !/^https?:\/\/\S+/i.test(link)) {
      errEl.textContent = 'Please enter a valid URL starting with http:// or https://';
      errEl.hidden = false;
      return;
    }

    // X posts are never scraped: they go through the X importer (official oEmbed) and land as pending.
    if (link && window.BATAgent?.isXHost(link)) {
      if (!window.BATAgent.isXPostUrl(link)) {
        errEl.textContent = 'Only X post links (https://x.com/<handle>/status/<id>) can be imported.';
        errEl.hidden = false;
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Importing from X…';
      try {
        const [res] = await window.BATAgent.importX([link]);
        if (res && res.status === 'imported') {
          closeAddModal();
          toast(`Imported from X as pending record #${res.id}`, 'success', 5000);
          loadData(1);
        } else {
          errEl.textContent = `X import: ${window.BATAgent.statusLabel(res?.status || 'error')} (${res?.reason || 'no result'})`;
          errEl.hidden = false;
        }
      } catch (e) {
        errEl.textContent = 'X import failed: ' + e.message;
        errEl.hidden = false;
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Verify & Upload';
      }
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = link ? 'Scraping & Verifying…' : 'Verifying with DeepSeek…';

    try {
      const r = await authenticatedFetch(`${API}/api/admin/accidents`, {
        method: 'POST',
        body: JSON.stringify({ title, source, link, content }),
      });
      if (r.status === 401) return; // Handled by authenticatedFetch
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Verification failed');
      closeAddModal();
      loadData(1);
    } catch (e) {
      errEl.textContent = 'Upload failed: ' + e.message;
      errEl.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Verify & Upload';
    }
  });

  document.getElementById('add-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeAddModal(); });

  // ── Filters ───────────────────────────────────────────────────────────────

  const PENDING_TITLE = 'Show every record awaiting review: citizen reports, News Agent finds and X imports';

  /** The Pending Reports button reads "All Records" (pressed) while the table shows pending rows. */
  function syncPendingButton() {
    const btn = document.getElementById('pending-reports-tab');
    if (!btn) return;
    const showingPending = document.getElementById('f-status').value === 'pending';
    btn.textContent = showingPending ? 'All Records' : 'Pending Reports';
    btn.title = showingPending ? 'Show every record again' : PENDING_TITLE;
    btn.setAttribute('aria-pressed', String(showingPending));
    btn.classList.toggle('is-showing-pending', showingPending);
  }

  document.getElementById('apply-btn').addEventListener('click', () => loadData(1));
  document.getElementById('search-box').addEventListener('keydown', e => { if (e.key === 'Enter') loadData(1); });
  document.getElementById('f-status').addEventListener('change', () => loadData(1));
  document.getElementById('f-severity').addEventListener('change', () => loadData(1));
  document.getElementById('f-sort').addEventListener('change', () => loadData(1));
  document.getElementById('pending-reports-tab')?.addEventListener('click', () => {
    const status = document.getElementById('f-status');
    if (status.value === 'pending') {
      status.value = 'all';
    } else {
      status.value = 'pending';
      document.getElementById('search-box').value = '';
    }
    loadData(1);
  });

  // ── Keyboard Shortcuts ──────────────────────────────────────────────────────

  /** Track the currently highlighted table row index for arrow key navigation */
  let highlightedRowIndex = -1;

  /**
   * Check if the user is currently typing in an input, textarea, or contenteditable element.
   * @param {Event} e - The keyboard event
   * @returns {boolean} true if the user is typing in a text field
   */
  function isTypingInField(e) {
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (e.target.isContentEditable) return true;
    return false;
  }

  /**
   * Get all visible table rows in the data table body.
   * @returns {NodeListOf<HTMLTableRowElement>}
   */
  function getTableRows() {
    return document.querySelectorAll('#table-body tr[data-id]');
  }

  /**
   * Highlight a table row by index, removing highlight from others.
   * @param {number} index - The row index to highlight
   */
  function highlightRow(index) {
    const rows = getTableRows();
    if (!rows.length) return;

    // Remove previous highlight
    rows.forEach(row => row.classList.remove('kb-highlighted'));

    // Clamp index to valid range
    if (index < 0) index = 0;
    if (index >= rows.length) index = rows.length - 1;

    highlightedRowIndex = index;
    const row = rows[highlightedRowIndex];
    row.classList.add('kb-highlighted');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * Check if any modal is currently visible.
   * @returns {boolean}
   */
  function isAnyModalOpen() {
    const editModal = document.getElementById('edit-modal');
    const confirmModal = document.getElementById('confirm-modal');
    const addModalEl = document.getElementById('add-modal');
    const reviewModal = document.getElementById('review-modal');
    const rejectModal = document.getElementById('reject-modal');
    const agentModal = document.getElementById('agent-modal');
    const xModal = document.getElementById('x-import-modal');
    return !editModal.hidden || !confirmModal.hidden || !addModalEl.hidden ||
      !(reviewModal?.hidden ?? true) || !(rejectModal?.hidden ?? true) ||
      !(agentModal?.hidden ?? true) || !(xModal?.hidden ?? true);
  }

  /**
   * Initialize global keyboard shortcut listener.
   * - Ctrl+S: Save in edit modal
   * - Esc: Close any open modal
   * - Arrow Up/Down: Navigate table rows (when not typing)
   * - Enter: Open edit for highlighted row (when not typing and no modal open)
   */
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+S (or Cmd+S on Mac): Save in edit modal
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        const editModal = document.getElementById('edit-modal');
        if (!editModal.hidden) {
          e.preventDefault();
          document.getElementById('modal-save').click();
          return;
        }
        // Also handle add modal save
        const addModalEl = document.getElementById('add-modal');
        if (!addModalEl.hidden) {
          e.preventDefault();
          document.getElementById('add-modal-save').click();
          return;
        }
      }

      // Escape: Close any open modal
      if (e.key === 'Escape') {
        const editModal = document.getElementById('edit-modal');
        const confirmModal = document.getElementById('confirm-modal');
        const addModalEl = document.getElementById('add-modal');

        if (!editModal.hidden) {
          closeEdit();
          return;
        }
        if (!confirmModal.hidden) {
          closeConfirmDelete();
          return;
        }
        if (!addModalEl.hidden) {
          closeAddModal();
          return;
        }
      }

      // Arrow keys: Navigate table rows (only when not typing in a field and no modal open)
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !isTypingInField(e) && !isAnyModalOpen()) {
        const rows = getTableRows();
        if (!rows.length) return;

        e.preventDefault();

        if (e.key === 'ArrowDown') {
          highlightRow(highlightedRowIndex + 1);
        } else if (e.key === 'ArrowUp') {
          highlightRow(highlightedRowIndex - 1);
        }
      }

      // Enter: Open edit for highlighted row (when not typing and no modal open)
      if (e.key === 'Enter' && !isTypingInField(e) && !isAnyModalOpen()) {
        const rows = getTableRows();
        if (highlightedRowIndex >= 0 && highlightedRowIndex < rows.length) {
          const row = rows[highlightedRowIndex];
          const editBtn = row.querySelector('[data-action="edit"]');
          if (editBtn) {
            e.preventDefault();
            editBtn.click();
          }
        }
      }
    });
  }

  /**
   * Add keyboard shortcut hint tooltips to relevant buttons.
   */
  function addShortcutHints() {
    // Save button in edit modal
    const modalSave = document.getElementById('modal-save');
    if (modalSave) {
      modalSave.title = 'Save Changes (Ctrl+S)';
    }

    // Cancel/Close buttons in edit modal
    const modalClose = document.getElementById('modal-close');
    if (modalClose) {
      modalClose.title = 'Close (Esc)';
    }
    const modalCancel = document.getElementById('modal-cancel');
    if (modalCancel) {
      modalCancel.title = 'Cancel (Esc)';
    }

    // Confirm modal close/cancel
    const confirmClose = document.getElementById('confirm-close');
    if (confirmClose) {
      confirmClose.title = 'Close (Esc)';
    }
    const confirmCancel = document.getElementById('confirm-cancel');
    if (confirmCancel) {
      confirmCancel.title = 'Cancel (Esc)';
    }

    // Add modal save
    const addModalSave = document.getElementById('add-modal-save');
    if (addModalSave) {
      addModalSave.title = 'Verify & Upload (Ctrl+S)';
    }
    const addModalClose = document.getElementById('add-modal-close');
    if (addModalClose) {
      addModalClose.title = 'Close (Esc)';
    }
    const addModalCancel = document.getElementById('add-modal-cancel');
    if (addModalCancel) {
      addModalCancel.title = 'Cancel (Esc)';
    }
  }

  // Initialize keyboard shortcuts and hints
  initKeyboardShortcuts();
  addShortcutHints();

  // ── Bulk selection & actions ──────────────────────────────────────────
  function getSelectedIds() {
    return Array.from(document.querySelectorAll('.row-select:checked')).map(cb => cb.dataset.id);
  }

  function openRejectModal(ids) {
    if (!ids || !ids.length) return toast('No records selected', 'warning');
    // store ids on modal element
    const modal = document.getElementById('reject-modal');
    modal.dataset.ids = JSON.stringify(ids);
    document.getElementById('bulk-reject-reason').value = '';
    modal.hidden = false;
  }

  function closeRejectModal() {
    const modal = document.getElementById('reject-modal');
    modal.hidden = true;
    delete modal.dataset.ids;
  }

  // ── Review User Submission modal ────────────────────────────────────────

  function openReview(row) {
    const modal = document.getElementById('review-modal');
    modal.dataset.id = row.id;
    const kind = row.kind || (row.reporter_id ? 'user' : '');
    const isUser = kind === 'user';
    const titles = { user: 'Review User Submission', agent: 'Review News Agent Find', x: 'Review X Post Import' };
    const titleEl = document.getElementById('review-title');
    if (titleEl) titleEl.textContent = titles[kind] || 'Review Pending Record';

    const photoWrap = document.getElementById('review-photo-wrap');
    photoWrap.innerHTML = !isUser ? ''
      : row.proof_url
        ? `<img class="review-photo" src="${esc(row.proof_url)}" alt="Uploaded proof photo">`
        : `<div class="review-photo-empty">No photo was attached to this report.</div>`;

    const coords = (row.lat && row.lng) ? `${parseFloat(row.lat).toFixed(5)}, ${parseFloat(row.lng).toFixed(5)}` : 'No coordinates (use Edit to set the pin)';
    const submittedAt = row.created_at ? new Date(row.created_at).toLocaleString() : '—';
    const reporter = row.reporter_id ? row.reporter_id.slice(0, 8) + '…' : '—';
    const sourceHref = /^https?:\/\//i.test(row.link || '') ? row.link : '';
    const sourceValue = sourceHref
      ? `<a href="${esc(sourceHref)}" target="_blank" rel="noopener noreferrer">${esc(row.source || 'Open source')} ↗</a>`
      : esc(row.source || '—');
    const lastItem = isUser
      ? `<div class="review-info-item"><div class="ri-label">Reporter ID</div><div class="ri-value">${esc(reporter)}</div></div>`
      : `<div class="review-info-item"><div class="ri-label">Source</div><div class="ri-value">${sourceValue}</div></div>`;

    document.getElementById('review-info').innerHTML = `
      <div class="review-info-grid">
        <div class="review-info-item"><div class="ri-label">Title</div><div class="ri-value">${esc(row.title || '—')}</div></div>
        <div class="review-info-item"><div class="ri-label">Severity</div><div class="ri-value">${esc((row.severity||'').toUpperCase() || '—')}</div></div>
        <div class="review-info-item"><div class="ri-label">Location</div><div class="ri-value">${esc(row.location || '—')}</div></div>
        <div class="review-info-item"><div class="ri-label">Area</div><div class="ri-value">${esc(row.area || '—')}</div></div>
        <div class="review-info-item"><div class="ri-label">Accident Date</div><div class="ri-value">${esc(row.date || '—')}</div></div>
        <div class="review-info-item"><div class="ri-label">Coordinates</div><div class="ri-value">${esc(coords)}</div></div>
        <div class="review-info-item"><div class="ri-label">${isUser ? 'Submitted' : 'Added'}</div><div class="ri-value">${esc(submittedAt)}</div></div>
        ${lastItem}
      </div>`;

    const descLabel = document.getElementById('review-desc-label');
    if (descLabel) descLabel.textContent = isUser ? 'Description (from reporter)' : 'Summary (written by the AI: check the source before approving)';
    document.getElementById('review-description').textContent = row.description || 'No description provided.';
    const integrityBox = document.getElementById('review-integrity');
    if (isUser) window.BATIntegrity?.renderPanel(integrityBox, row.id);
    else integrityBox.innerHTML = '';
    // News Agent finds: the BAT Review Agent's verdict and any fix suggestion ("Apply suggestions" uses the Edit PATCH).
    const verdictBox = document.getElementById('review-agent-verdict');
    if (verdictBox) {
      if (kind === 'agent' && window.BATAgent?.renderReviewVerdict) window.BATAgent.renderReviewVerdict(verdictBox, row, { onApplied: () => { closeReview(); loadData(curPage); } });
      else verdictBox.innerHTML = '';
    }
    document.getElementById('review-reject-reason').value = '';
    document.getElementById('review-error').hidden = true;

    const isPending = row.status === 'pending';
    document.getElementById('review-approve-btn').style.display = isPending ? '' : 'none';
    document.getElementById('review-reject-btn').style.display = isPending ? '' : 'none';

    modal.hidden = false;
  }

  function closeReview() {
    const modal = document.getElementById('review-modal');
    modal.hidden = true;
    delete modal.dataset.id;
  }

  async function reviewAction(action) {
    const modal = document.getElementById('review-modal');
    const id = modal.dataset.id;
    if (!id) return;
    const errorEl = document.getElementById('review-error');
    errorEl.hidden = true;
    try {
      const body = { ids: [id], action };
      if (action === 'hide') body.rejection_reason = document.getElementById('review-reject-reason').value.trim();
      const r = await authenticatedFetch(`${API}/api/admin/accidents/bulk`, { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      toast(action === 'verify' ? 'Report approved and published' : 'Report rejected', 'success');
      closeReview();
      loadData(curPage);
    } catch (e) {
      errorEl.textContent = 'Action failed: ' + e.message;
      errorEl.hidden = false;
    }
  }

  // select-all checkbox handler
  const selectAllEl = document.getElementById('select-all');
  if (selectAllEl) {
    selectAllEl.addEventListener('change', () => {
      const checked = selectAllEl.checked;
      document.querySelectorAll('.row-select').forEach(cb => { cb.checked = checked; });
    });
  }

  // Bulk action buttons
  document.getElementById('approve-selected')?.addEventListener('click', async () => {
    const ids = getSelectedIds(); if (!ids.length) return toast('No records selected', 'warning');
    try {
      const r = await authenticatedFetch(`${API}/api/admin/accidents/bulk`, { method: 'POST', body: JSON.stringify({ ids, action: 'verify' }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      toast('Approved selected', 'success'); loadData(curPage);
    } catch (e) { toast('Bulk approve failed: ' + e.message, 'error'); }
  });

  document.getElementById('reject-selected')?.addEventListener('click', () => {
    const ids = getSelectedIds(); if (!ids.length) return toast('No records selected', 'warning');
    openRejectModal(ids);
  });

  document.getElementById('delete-selected')?.addEventListener('click', async () => {
    const ids = getSelectedIds(); if (!ids.length) return toast('No records selected', 'warning');
    if (!confirm(`Delete ${ids.length} records permanently? This cannot be undone.`)) return;
    try {
      const r = await authenticatedFetch(`${API}/api/admin/accidents/bulk`, { method: 'POST', body: JSON.stringify({ ids, action: 'delete' }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      toast('Deleted selected', 'success'); loadData(curPage);
    } catch (e) { toast('Bulk delete failed: ' + e.message, 'error'); }
  });

  // Reject modal buttons
  document.getElementById('reject-close')?.addEventListener('click', closeRejectModal);
  document.getElementById('reject-cancel')?.addEventListener('click', closeRejectModal);
  document.getElementById('reject-confirm')?.addEventListener('click', async () => {
    const modal = document.getElementById('reject-modal');
    const ids = JSON.parse(modal.dataset.ids || '[]');
    const reason = document.getElementById('bulk-reject-reason').value.trim();
    if (!ids.length) { closeRejectModal(); return; }
    try {
      const r = await authenticatedFetch(`${API}/api/admin/accidents/bulk`, { method: 'POST', body: JSON.stringify({ ids, action: 'hide', rejection_reason: reason }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      toast('Rejected selected', 'success');
      closeRejectModal();
      loadData(curPage);
    } catch (e) { toast('Bulk reject failed: ' + e.message, 'error'); }
  });

  // Review submission modal buttons
  document.getElementById('review-close')?.addEventListener('click', closeReview);
  document.getElementById('review-close-btn')?.addEventListener('click', closeReview);
  document.getElementById('review-approve-btn')?.addEventListener('click', () => reviewAction('verify'));
  document.getElementById('review-reject-btn')?.addEventListener('click', () => reviewAction('hide'));

  // ── Toast Notification System ────────────────────────────────────────────

  function showToast(message, type = 'success', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast--removing');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ── Auto-Save Draft to SessionStorage ──────────────────────────────────────

  function hasUnsavedChanges() {
    // Check if edit modal is open with potentially modified values
    if (editingId && !document.getElementById('edit-modal').hidden) {
      return true;
    }
    // Check if add modal is open with content
    const addModal = document.getElementById('add-modal');
    if (addModal && !addModal.hidden) {
      const title = document.getElementById('add-title').value.trim();
      const link = document.getElementById('add-link').value.trim();
      const content = document.getElementById('add-content').value.trim();
      if (title || link || content) return true;
    }
    return false;
  }

  function saveDraftToSession() {
    const draft = {};
    // Save edit modal state
    if (editingId && !document.getElementById('edit-modal').hidden) {
      draft.editModal = {
        id: editingId,
        lat: document.getElementById('edit-lat').value,
        lng: document.getElementById('edit-lng').value,
        location: document.getElementById('edit-location').value,
        area: document.getElementById('edit-area').value,
        title: document.getElementById('edit-title').value,
        date: document.getElementById('edit-date').value,
      };
    }
    // Save add modal state
    const addModal = document.getElementById('add-modal');
    if (addModal && !addModal.hidden) {
      draft.addModal = {
        title: document.getElementById('add-title').value,
        source: document.getElementById('add-source').value,
        link: document.getElementById('add-link').value,
        content: document.getElementById('add-content').value,
      };
    }
    if (Object.keys(draft).length > 0) {
      sessionStorage.setItem('bat_admin_draft', JSON.stringify(draft));
    }
  }

  // ── Inactivity Timer ───────────────────────────────────────────────────────

  function initInactivityTimer(timeoutMs = 30 * 60 * 1000) {
    const WARNING_BEFORE = 5 * 60 * 1000; // 5 minutes before timeout
    let logoutTimer = null;
    let warningTimer = null;
    let countdownInterval = null;
    let warningShown = false;
    let stopped = false;

    const warningModal = document.getElementById('inactivity-modal');
    const countdownEl = document.getElementById('inactivity-countdown');
    const stayBtn = document.getElementById('inactivity-stay-btn');

    function hideWarning() {
      if (warningModal) warningModal.hidden = true;
      warningShown = false;
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
    }

    function showWarning() {
      warningShown = true;
      if (warningModal) warningModal.hidden = false;
      // Start countdown display
      let remaining = WARNING_BEFORE;
      updateCountdown(remaining);
      countdownInterval = setInterval(() => {
        remaining -= 1000;
        if (remaining <= 0) {
          clearInterval(countdownInterval);
          countdownInterval = null;
        } else {
          updateCountdown(remaining);
        }
      }, 1000);
    }

    function updateCountdown(ms) {
      if (!countdownEl) return;
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.floor((ms % 60000) / 1000);
      countdownEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    function performTimeout() {
      if (stopped) return;
      // Auto-save draft if unsaved changes exist
      if (hasUnsavedChanges()) {
        saveDraftToSession();
      }
      // Clear session
      token = '';
      sessionStorage.removeItem(TOKEN_KEY);
      const authClient = window.SupabaseAuthClient;
      if (authClient) {
        authClient.signOut().catch(() => {});
      }
      hideWarning();
      showLogin();
      showToast('Session expired due to inactivity', 'warning', 5000);
    }

    function resetTimer() {
      if (stopped) return;
      clearTimeout(logoutTimer);
      clearTimeout(warningTimer);
      hideWarning();

      sessionStorage.setItem('bat_admin_last_activity', Date.now().toString());

      // Set warning timer (fires at timeoutMs - WARNING_BEFORE)
      warningTimer = setTimeout(() => {
        if (!stopped) showWarning();
      }, timeoutMs - WARNING_BEFORE);

      // Set logout timer (fires at timeoutMs)
      logoutTimer = setTimeout(() => {
        if (!stopped) performTimeout();
      }, timeoutMs);
    }

    function stop() {
      stopped = true;
      clearTimeout(logoutTimer);
      clearTimeout(warningTimer);
      hideWarning();
      events.forEach(evt => document.removeEventListener(evt, resetTimer));
    }

    // Track user activity with passive listeners
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach(evt => document.addEventListener(evt, resetTimer, { passive: true }));

    // "Stay Logged In" button in warning modal
    if (stayBtn) {
      stayBtn.addEventListener('click', () => {
        resetTimer();
      });
    }

    // Initial start
    resetTimer();

    return { reset: resetTimer, stop };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function boot() {
    // Wait briefly for SupabaseAuthClient to be available (loaded as ES module)
    let retries = 0;
    while (!window.SupabaseAuthClient && retries < 20) {
      await new Promise(r => setTimeout(r, 50));
      retries++;
    }

    if (token && await checkAuth()) {
      // Token still valid on server — try to get display name from Supabase session
      const authClient = window.SupabaseAuthClient;
      let displayName = 'Admin';
      if (authClient) {
        const session = await authClient.getSession();
        if (session && session.user) {
          displayName = getAdminDisplayName(session.user);
          // Refresh the token from current Supabase session
          token = session.access_token;
          sessionStorage.setItem(TOKEN_KEY, token);
        }
      }
      showApp(displayName);
      await loadConfig();
      loadData();
      loadStats();
      loadMapPins();
    } else {
      token = '';
      sessionStorage.removeItem(TOKEN_KEY);
      showLogin();
    }
  }

  boot();
})();
