/**
 * Admin: BAT News Agent panel and the "Import from X" paste box.
 * Hooks used by admin-app.js:
 *   BATAgent.init({ fetch, api, toast, onChange })   wire the buttons and modals
 *   BATAgent.sourceKind(row)       'x' | 'agent' | 'user' | null
 *   BATAgent.sourceBadgeHtml(row)  "Agent" / "X" badge markup (fixed strings only)
 *   BATAgent.isXPostUrl(url), BATAgent.isXHost(url)
 *   BATAgent.importX(urls)         POST /api/admin/x-import → one result per link
 * Headlines, reasons and links come from outside sources, so they are always
 * inserted with textContent and links must be http(s).
 */
(function () {
  'use strict';

  const AGENT_MARKER = '(Found by BAT News Agent)';
  const X_POST = /^https:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]{1,15}\/status\/\d{1,20}\/?(?:\?[^#\s]*)?$/i;
  const MAX_X_LINKS = 20;
  const POLL_MS = 5000;
  const STATUS_LABEL = {
    imported: 'Imported',
    duplicate: 'Duplicate',
    not_accident: 'Not an accident',
    outside_bangalore: 'Not in Bangalore',
    invalid_link: 'Invalid link',
    error: 'Error',
    deferred: 'Deferred',
  };
  const RUN_LABEL = { running: 'Running', completed: 'Completed', budget_reached: 'Budget reached', rate_limited: 'Rate limited', failed: 'Failed' };
  const TRIGGER_LABEL = { schedule: 'Scheduled', manual: 'Run now', backfill: 'Backfill' };

  let doFetch = null;
  let API = '';
  let toast = () => {};
  let onChange = () => {};
  let lastStatus = null;
  let pollTimer = null;
  let pollUntil = 0;
  let watchingRunId = null;
  let openRunId = null; // run shown in the detail view
  let openRunRunning = false; // whether that run was still running when last fetched
  let wired = false;

  // ── Pure helpers (also used by admin-app.js and the tests) ─────────────────

  function isXPostUrl(u) { return X_POST.test(String(u || '').trim()); }

  function isXHost(u) {
    try { return /(^|\.)(x\.com|twitter\.com)$/i.test(new URL(String(u || '').trim()).hostname); } catch (_) { return false; }
  }

  function safeHref(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : null; }

  function sourceKind(row) {
    if (!row) return null;
    if (isXPostUrl(row.link)) return 'x';
    if (String(row.description || '').includes(AGENT_MARKER)) return 'agent';
    if (row.reporter_id) return 'user';
    return null;
  }

  function sourceBadgeHtml(row) {
    const kind = sourceKind(row);
    if (kind === 'agent') return '<span class="src-badge src-badge--agent" title="Found by the BAT News Agent">Agent</span>';
    if (kind === 'x') return '<span class="src-badge src-badge--x" title="Imported from a post on X">X</span>';
    return '';
  }

  function statusLabel(status) { return STATUS_LABEL[status] || status; }

  function parseLines(text) {
    return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  function el(tag, attrs = {}, kids = []) {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    [].concat(kids).filter(Boolean).forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }

  const $ = (id) => document.getElementById(id);

  async function getJson(url, opts) {
    const r = await doFetch(url, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function fmtIn(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 60000)) return 'in a minute';
    const m = Math.round(ms / 60000);
    return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
  }

  /** One result row: coloured status, title (link), publisher and reason. */
  function itemRow({ status, deferred, title, href, detail }) {
    const key = deferred ? 'deferred' : status;
    const link = safeHref(href);
    return el('li', { class: 'agent-item' }, [
      el('span', { class: `st-pill st-${key}`, text: statusLabel(key) }),
      el('div', { class: 'agent-item-body' }, [
        el('div', { class: 'agent-item-title' }, [link ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: title || link }) : el('span', { text: title || '' })]),
        detail ? el('div', { class: 'agent-item-reason', text: detail }) : null,
      ]),
    ]);
  }

  // ── News Agent panel ──────────────────────────────────────────────────────

  function setRunButtons(s) {
    const blocked = !s || !s.enabled || !s.ready || s.running;
    ['agent-run-btn', 'agent-backfill-btn'].forEach(id => { const b = $(id); if (b) b.disabled = blocked; });
    const hint = $('agent-run-hint');
    if (hint) {
      hint.textContent = !s ? '' : !s.enabled ? 'The agent is turned off (AGENT_ENABLED=false in server/.env).'
        : !s.ready ? `The agent can't run: ${s.notReadyReason}.` : s.running ? 'A run is in progress. This panel updates by itself.' : '';
      hint.hidden = !hint.textContent;
    }
  }

  function renderStatus(s) {
    const box = $('agent-status');
    if (!box) return;
    const state = !s.enabled ? ['off', 'Off'] : !s.ready ? ['warn', "On, can't run"] : s.running ? ['busy', 'Running now'] : ['on', 'On'];
    const rows = [
      ['Status', el('span', { class: `agent-state agent-state--${state[0]}`, text: state[1] })],
      ['Next run', !s.enabled ? 'none (turned off)' : s.running ? 'after this run finishes' : s.nextRunAt ? `${fmtTime(s.nextRunAt)} (${fmtIn(s.nextRunAt)})` : '—'],
      ['Last run', fmtTime(s.lastRunAt)],
      ['AI calls today', `${s.aiCallsToday} of ${s.dailyAiBudget} (max ${s.maxAiCallsPerRun} per run)`],
      ['Free AI calls left', s.siteAi ? `${s.siteAi.remaining} of ${s.siteAi.limit} site-wide (agent pauses below ${s.siteAi.reserve})` : '—'],
    ];
    if (s.queueLength) rows.push(['Waiting', `${s.queueLength} article${s.queueLength === 1 ? '' : 's'} queued for the next run`]);
    box.replaceChildren(el('dl', { class: 'agent-status-grid' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, [v])])));
    setRunButtons(s);
  }

  function runSummary(c = {}) {
    const skipped = (c.not_accident || 0) + (c.outside_bangalore || 0);
    return [
      `${c.imported || 0} imported`,
      c.duplicate ? `${c.duplicate} duplicate` : null,
      skipped ? `${skipped} skipped` : null,
      c.error ? `${c.error} error${c.error === 1 ? '' : 's'}` : null,
      c.deferred ? `${c.deferred} deferred` : null,
    ].filter(Boolean).join(' · ');
  }

  function renderRuns(s) {
    const ul = $('agent-runs');
    if (!ul) return;
    const runs = [...(s.currentRun ? [{ ...s.currentRun, status: 'running' }] : []), ...(s.lastRuns || [])];
    if (!runs.length) {
      ul.replaceChildren(el('li', { class: 'agent-empty', text: 'No runs yet. The first run starts 2 minutes after the server starts, or press Run now.' }));
      return;
    }
    ul.replaceChildren(...runs.map(r => el('li', {}, [
      el('button', { type: 'button', class: 'agent-run', onclick: () => openRun(r.id) }, [
        el('span', { class: 'agent-run-top' }, [
          el('span', { class: 'agent-run-when', text: fmtTime(r.startedAt) }),
          el('span', { class: `run-chip run-chip--${r.status}`, text: RUN_LABEL[r.status] || r.status }),
        ]),
        el('span', { class: 'agent-run-meta', text: `${TRIGGER_LABEL[r.trigger] || r.trigger}${r.trigger === 'backfill' ? ` (${r.days} days)` : ''} · ${runSummary(r.counts)} · ${r.aiCalls} AI call${r.aiCalls === 1 ? '' : 's'}` }),
      ]),
    ])));
  }

  async function refresh() {
    try {
      const s = await getJson(`${API}/api/admin/agent/status`);
      lastStatus = s;
      renderStatus(s);
      renderRuns(s);
      return s;
    } catch (e) {
      const box = $('agent-status');
      if (box) box.replaceChildren(el('p', { class: 'agent-error', text: `Could not load the News Agent status: ${e.message}` }));
      setRunButtons(null);
      return null;
    }
  }

  function showRunList() {
    openRunId = null;
    openRunRunning = false;
    $('agent-runs-view').hidden = false;
    $('agent-run-detail').hidden = true;
  }

  function sourceLine(name, s) {
    if (s.ok) return el('li', { text: `${name}: ${s.count} results` });
    if (s.skipped) return el('li', { class: 'skipped', text: `${name}: ${s.error || 'rate-limited'}, skipped` });
    return el('li', { class: 'failed', text: `${name}: failed (${s.error || 'error'}), skipped` });
  }

  function logLines(lines) {
    return lines.map(l => el('span', {
      class: /rate-limited|budget reached|deferred|will retry/i.test(l) ? 'log-warn' : /failed|error/i.test(l) ? 'log-fail' : null,
      text: `${l}\n`,
    }));
  }

  /** Show one run. `quiet` re-renders in place (used when a run finishes) without the loading placeholder. */
  async function openRun(id, { quiet = false } = {}) {
    openRunId = id;
    $('agent-runs-view').hidden = true;
    $('agent-run-detail').hidden = false;
    const body = $('agent-run-detail-body');
    if (!quiet) body.replaceChildren(el('p', { class: 'agent-note', text: 'Loading run…' }));
    try {
      const run = await getJson(`${API}/api/admin/agent/runs/${encodeURIComponent(id)}`);
      if (openRunId !== id) return; // the admin moved on while this was loading
      openRunRunning = Boolean(run.running);
      if (openRunRunning && !pollTimer) startPolling();
      const sources = Object.entries(run.sources || {}).map(([name, s]) => sourceLine(name, s));
      const items = (run.items || []).map(it => itemRow({
        status: it.status,
        deferred: it.deferred,
        title: it.title || it.url,
        href: it.link || it.url,
        detail: [it.publisher, it.reason].filter(Boolean).join(' · '),
      }));
      const status = run.running ? 'running' : run.status;
      body.replaceChildren(
        el('div', { class: 'agent-run-head' }, [
          el('strong', { text: `${TRIGGER_LABEL[run.trigger] || run.trigger} run · ${fmtTime(run.startedAt)}` }),
          el('span', { class: `run-chip run-chip--${status}`, text: RUN_LABEL[status] || status }),
        ]),
        el('p', { class: 'agent-note', text: `${runSummary(run.counts)} · ${run.aiCalls} AI call${run.aiCalls === 1 ? '' : 's'}${run.stopReason ? ` · stopped: ${run.stopReason}` : ''}${run.counts?.itemsNotLogged ? ` · ${run.counts.itemsNotLogged} more not listed` : ''}` }),
        el('div', { class: 'modal-section-label', text: 'Sources' }),
        el('ul', { class: 'agent-sources' }, sources),
        el('div', { class: 'modal-section-label', text: `Articles (${items.length})` }),
        items.length ? el('ul', { class: 'agent-items' }, items) : el('p', { class: 'agent-note', text: 'No new articles in this run.' }),
        el('details', { class: 'agent-log-wrap' }, [el('summary', { text: 'Step-by-step log' }), el('pre', { class: 'agent-log' }, logLines(run.log || []))]),
      );
    } catch (e) {
      if (openRunId === id) body.replaceChildren(el('p', { class: 'agent-error', text: `Could not load this run: ${e.message}` }));
    }
  }

  /** The open run was running and the status poll says it is no longer the current run: show its final state. */
  function openRunFinished(s) {
    return Boolean(openRunId && openRunRunning && !$('agent-run-detail').hidden && s.currentRun?.id !== openRunId);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling() {
    stopPolling();
    pollUntil = Date.now() + 20 * 60 * 1000;
    pollTimer = setInterval(async () => {
      if (Date.now() > pollUntil) { stopPolling(); return; }
      const s = await refresh();
      if (s && openRunFinished(s)) await openRun(openRunId, { quiet: true });
      if (s && !s.running) {
        stopPolling();
        const run = (s.lastRuns || []).find(r => r.id === watchingRunId) || (watchingRunId ? s.lastRuns?.[0] : null);
        if (run) {
          toast(`News Agent run finished: ${runSummary(run.counts)}`, run.status === 'failed' ? 'error' : 'success', 6000);
          if (run.counts?.imported) onChange();
        }
        watchingRunId = null;
      }
    }, POLL_MS);
  }

  async function startRun(backfillDays) {
    if (backfillDays) {
      const perRun = lastStatus?.maxAiCallsPerRun ?? 8;
      const perDay = lastStatus?.dailyAiBudget ?? 20;
      const ok = window.confirm(`Search the last ${backfillDays} days of news now?\n\nThe same AI limits apply (${perRun} calls per run, ${perDay} per day), so articles it can't reach today wait for the next runs. Everything found is added as Pending.`);
      if (!ok) return;
    }
    setRunButtons({ ...(lastStatus || {}), running: true });
    try {
      const body = await getJson(`${API}/api/admin/agent/run`, { method: 'POST', body: JSON.stringify(backfillDays ? { backfillDays } : {}) });
      watchingRunId = body.runId;
      toast(backfillDays ? `Backfill of the last ${backfillDays} days started` : 'News Agent run started', 'success');
      await refresh();
      startPolling();
    } catch (e) {
      toast(`Could not start the run: ${e.message}`, 'error', 5000);
      await refresh();
    }
  }

  function openAgent() {
    const modal = $('agent-modal');
    if (!modal) return;
    showRunList();
    modal.hidden = false;
    refresh().then(s => { if (s?.running && !pollTimer) startPolling(); });
  }

  function closeAgent() {
    const modal = $('agent-modal');
    if (modal) modal.hidden = true;
    openRunId = null;
    openRunRunning = false;
    // Keep polling only while a run started here is still going, so its toast still appears.
    if (!watchingRunId) stopPolling();
  }

  // ── Import from X ─────────────────────────────────────────────────────────

  async function importX(urls) {
    const body = await getJson(`${API}/api/admin/x-import`, { method: 'POST', body: JSON.stringify({ urls }) });
    return body.results || [];
  }

  function updateXCount() {
    const n = parseLines($('x-import-urls').value).length;
    const hint = $('x-import-count');
    hint.textContent = `${n} of ${MAX_X_LINKS} links`;
    hint.classList.toggle('over', n > MAX_X_LINKS);
  }

  function setXBusy(busy) {
    const btn = $('x-import-run');
    btn.disabled = busy;
    btn.textContent = busy ? 'Importing…' : 'Import';
    $('x-import-urls').disabled = busy;
  }

  async function runXImport() {
    const err = $('x-import-error');
    const list = $('x-import-results');
    err.hidden = true;
    const lines = parseLines($('x-import-urls').value);
    if (!lines.length) { err.textContent = 'Paste at least one X post link.'; err.hidden = false; return; }
    if (lines.length > MAX_X_LINKS) { err.textContent = `At most ${MAX_X_LINKS} links at a time (you pasted ${lines.length}).`; err.hidden = false; return; }
    setXBusy(true);
    list.replaceChildren(el('li', { class: 'agent-empty', text: `Checking ${lines.length} post${lines.length === 1 ? '' : 's'}… each one is read through X's embed service and checked by the AI, so this can take a little while.` }));
    try {
      const results = await importX(lines);
      list.replaceChildren(...results.map(r => itemRow({ status: r.status, title: r.canonicalUrl || r.input, href: r.canonicalUrl, detail: r.reason })));
      const imported = results.filter(r => r.status === 'imported').length;
      toast(`X import: ${imported} imported as pending, ${results.length - imported} not imported`, imported ? 'success' : 'warning', 5000);
      if (imported) onChange();
    } catch (e) {
      list.replaceChildren();
      err.textContent = `Import failed: ${e.message}`;
      err.hidden = false;
    } finally {
      setXBusy(false);
    }
  }

  function openX() {
    const modal = $('x-import-modal');
    if (!modal) return;
    $('x-import-error').hidden = true;
    updateXCount();
    modal.hidden = false;
    setTimeout(() => $('x-import-urls')?.focus(), 50);
  }

  function closeX() { const m = $('x-import-modal'); if (m) m.hidden = true; }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function wire() {
    if (wired) return;
    wired = true;
    $('agent-btn')?.addEventListener('click', openAgent);
    $('agent-close')?.addEventListener('click', closeAgent);
    $('agent-close-btn')?.addEventListener('click', closeAgent);
    $('agent-back')?.addEventListener('click', showRunList);
    $('agent-run-btn')?.addEventListener('click', () => startRun(0));
    $('agent-backfill-btn')?.addEventListener('click', () => startRun(30));
    $('agent-modal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeAgent(); });

    $('x-import-btn')?.addEventListener('click', openX);
    $('x-import-close')?.addEventListener('click', closeX);
    $('x-import-cancel')?.addEventListener('click', closeX);
    $('x-import-run')?.addEventListener('click', runXImport);
    $('x-import-urls')?.addEventListener('input', updateXCount);
    $('x-import-modal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeX(); });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if ($('x-import-modal') && !$('x-import-modal').hidden) closeX();
      else if ($('agent-modal') && !$('agent-modal').hidden) closeAgent();
    });
  }

  function init({ fetch, api, toast: toastFn, onChange: changed } = {}) {
    doFetch = fetch;
    API = api || '';
    if (typeof toastFn === 'function') toast = toastFn;
    if (typeof changed === 'function') onChange = changed;
    wire();
  }

  window.BATAgent = { init, sourceKind, sourceBadgeHtml, isXPostUrl, isXHost, importX, statusLabel, parseLines, openRun };
})();
