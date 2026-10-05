const API = (window.BAT_CONFIG?.apiBase || '').replace(/\/$/, '');

let chartTrendsInstance = null;
let chartSeverityInstance = null;
let chartAreasInstance = null;
let chartByHourInstance = null;
let chartByDayInstance = null;

async function fetchJson(path) {
  if (!API) throw new Error('No API base configured');
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('Non-JSON response');
  return await res.json();
}

function hexToRGBA(hex, alpha = 1) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

async function computeFallbackStats() {
  let rows = [];

  // 1. Try Supabase
  try {
    const sb = window.supabase || (window.SupabaseAuthClient?.getClient ? window.SupabaseAuthClient.getClient() : null);
    if (sb) {
      const { data, error } = await sb
        .from('accidents')
        .select('accident_date, date_raw, severity, area, zone')
        .eq('status', 'active');
      if (!error && Array.isArray(data) && data.length > 0) {
        rows = data;
      }
    }
  } catch (_) {}

  // 2. Fall back to local accident_data.json
  if (!rows.length) {
    try {
      const res = await fetch('accident_data.json', { cache: 'no-store' });
      if (res.ok) {
        rows = (await res.json()).filter(r => r && r.status === 'active');
      }
    } catch (_) {}
  }

  // Aggregate monthly
  const monthlyMap = {};
  const byHour = new Array(24).fill(0);
  const byDay = new Array(7).fill(0);
  const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const areaMap = {};

  for (const d of rows) {
    const sev = d.severity || 'minor';

    // Monthly
    const dtStr = d.accident_date || d.date || d.date_raw;
    if (dtStr && typeof dtStr === 'string') {
      const m = dtStr.slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(m)) {
        if (!monthlyMap[m]) monthlyMap[m] = { month: m, total: 0, fatal: 0, serious: 0, minor: 0 };
        monthlyMap[m].total++;
        if (sev === 'fatal') monthlyMap[m].fatal++;
        else if (sev === 'serious') monthlyMap[m].serious++;
        else monthlyMap[m].minor++;
      }
    }

    // Time of day & day of week
    let dow = null;
    if (dtStr) {
      const dt = new Date(dtStr);
      if (!isNaN(dt.getTime())) {
        dow = dt.getDay();
        byDay[dow]++;
      }
    }

    const rawTime = String(d.date_raw || d.time || '');
    const timeMatch = rawTime.match(/([0-2]?[0-9]):([0-5][0-9])/);
    let hour = null;
    if (timeMatch) {
      hour = parseInt(timeMatch[1], 10);
      if (hour >= 0 && hour < 24) byHour[hour]++;
      else hour = null;
    }
    if (dow !== null && hour !== null) matrix[dow][hour]++;

    // By area
    const area = d.area || 'Unknown';
    const zone = d.zone || 'Unknown';
    const k = `${area}||${zone}`;
    if (!areaMap[k]) areaMap[k] = { area, zone, total: 0, fatal: 0, serious: 0, minor: 0 };
    areaMap[k].total++;
    if (sev === 'fatal') areaMap[k].fatal++;
    else if (sev === 'serious') areaMap[k].serious++;
    else areaMap[k].minor++;
  }

  const monthly = Object.values(monthlyMap).sort((a, b) => a.month.localeCompare(b.month));
  const byArea = Object.values(areaMap).sort((a, b) => b.total - a.total);
  const byTime = { byHour, byDay, matrix };

  return { monthly, byTime, byArea };
}

async function renderAll() {
  let monthly = [];
  let byTime = { byHour: [], byDay: [], matrix: [] };
  let byArea = [];

  try {
    const results = await Promise.all([
      fetchJson('/api/stats/trends'),
      fetchJson('/api/stats/by-time'),
      fetchJson('/api/stats/by-area')
    ]);
    monthly = results[0] || [];
    byTime = results[1] || byTime;
    byArea = results[2] || [];
  } catch (e) {
    console.warn('API stats unavailable, calculating statistics client-side from dataset:', e.message);
    const fallback = await computeFallbackStats();
    monthly = fallback.monthly;
    byTime = fallback.byTime;
    byArea = fallback.byArea;
  }

  renderTrendsChart(monthly);
  renderSeverityChart(monthly);
  renderAreasChart(byArea);
  renderByHourChart(byTime?.byHour || []);
  renderByDayChart(byTime?.byDay || []);
  renderHeatmap(byTime?.matrix || []);
}

function renderTrendsChart(data) {
  const el = document.getElementById('chart-trends');
  if (!el) return;
  const ctx = el.getContext('2d');
  if (chartTrendsInstance) chartTrendsInstance.destroy();

  const labels = (data || []).map(d => d.month);
  const totals = (data || []).map(d => Number(d.total || 0));
  const fatal = (data || []).map(d => Number(d.fatal || 0));
  const serious = (data || []).map(d => Number(d.serious || 0));
  const minor = (data || []).map(d => Number(d.minor || 0));

  chartTrendsInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Total', data: totals, borderColor: '#0ea5a4', backgroundColor: hexToRGBA('#0ea5a4', 0.08), tension: 0.25, fill: true },
        { label: 'Fatal', data: fatal, borderColor: '#dc2626', backgroundColor: hexToRGBA('#dc2626', 0.06), tension: 0.25 },
        { label: 'Serious', data: serious, borderColor: '#f59e0b', backgroundColor: hexToRGBA('#f59e0b', 0.06), tension: 0.25 },
        { label: 'Minor', data: minor, borderColor: '#3b82f6', backgroundColor: hexToRGBA('#3b82f6', 0.06), tension: 0.25 }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top' } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true } }
    }
  });
}

function renderSeverityChart(monthly) {
  const el = document.getElementById('chart-severity');
  if (!el) return;
  const ctx = el.getContext('2d');
  if (chartSeverityInstance) chartSeverityInstance.destroy();

  const sum = { fatal: 0, serious: 0, minor: 0 };
  (monthly || []).forEach(m => {
    sum.fatal += Number(m.fatal || 0);
    sum.serious += Number(m.serious || 0);
    sum.minor += Number(m.minor || 0);
  });

  chartSeverityInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Fatal', 'Serious', 'Minor'],
      datasets: [{ data: [sum.fatal, sum.serious, sum.minor], backgroundColor: ['#dc2626', '#f59e0b', '#3b82f6'] }]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
  });
}

function renderAreasChart(areaData) {
  const el = document.getElementById('chart-areas');
  if (!el) return;
  const ctx = el.getContext('2d');
  if (chartAreasInstance) chartAreasInstance.destroy();

  const sorted = (areaData || []).sort((a, b) => b.total - a.total).slice(0, 10);
  const labels = sorted.map(r => r.area + (r.zone ? (' — ' + r.zone) : ''));
  const vals = sorted.map(r => Number(r.total || 0));

  chartAreasInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Incidents', data: vals, backgroundColor: '#0284c7' }] },
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }
  });
}

function renderByHourChart(hours) {
  const el = document.getElementById('chart-byhour');
  if (!el) return;
  const ctx = el.getContext('2d');
  if (chartByHourInstance) chartByHourInstance.destroy();

  const labels = Array.from({ length: 24 }, (_, i) => String(i));
  const data = (hours && hours.length === 24) ? hours.map(n => Number(n || 0)) : labels.map(() => 0);

  chartByHourInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Incidents', data, backgroundColor: '#3b82f6' }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true } } }
  });
}

function renderByDayChart(days) {
  const el = document.getElementById('chart-byday');
  if (!el) return;
  const ctx = el.getContext('2d');
  if (chartByDayInstance) chartByDayInstance.destroy();

  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const data = (days && days.length === 7) ? days.map(n => Number(n || 0)) : labels.map(() => 0);

  chartByDayInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Incidents', data, backgroundColor: '#f59e0b' }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}

function renderHeatmap(matrix) {
  const container = document.getElementById('heatmap');
  if (!container) return;
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const rows = (matrix && matrix.length === 7) ? matrix : dayLabels.map(() => new Array(24).fill(0));

  let max = 0;
  rows.forEach(row => row.forEach(v => { if (Number(v) > max) max = Number(v); }));

  container.innerHTML = '';

  const corner = document.createElement('div');
  container.appendChild(corner);
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'heatmap-hour-label';
    label.textContent = (h % 3 === 0) ? String(h) : '';
    container.appendChild(label);
  }

  rows.forEach((row, dayIdx) => {
    const dayLabel = document.createElement('div');
    dayLabel.className = 'heatmap-label';
    dayLabel.textContent = dayLabels[dayIdx];
    container.appendChild(dayLabel);

    row.forEach((count, hourIdx) => {
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      const intensity = max > 0 ? Number(count) / max : 0;
      cell.style.background = hexToRGBA('#dc2626', 0.06 + intensity * 0.9);
      cell.title = `${dayLabels[dayIdx]} ${String(hourIdx).padStart(2, '0')}:00 — ${count} incident${count === 1 ? '' : 's'}`;
      container.appendChild(cell);
    });
  });
}

document.getElementById('refresh-btn')?.addEventListener('click', () => { renderAll(); });
document.getElementById('download-csv')?.addEventListener('click', (e) => {
  e.preventDefault();
  const url = (API || '') + '/api/accidents?format=csv';
  window.open(url, '_blank');
});
document.getElementById('download-geojson')?.addEventListener('click', (e) => {
  e.preventDefault();
  const url = (API || '') + '/api/export/geojson';
  window.open(url, '_blank');
});

// Init
renderAll();

export {};
