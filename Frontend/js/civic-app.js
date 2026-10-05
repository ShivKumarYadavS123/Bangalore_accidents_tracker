(function () {
  const api = (window.BAT_CONFIG?.apiBase || '').replace(/\/$/, '');
  let point = null;

  const loc = document.getElementById('loc');
  const submit = document.getElementById('submit');
  const issues = document.getElementById('issues');

  function esc(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function getSupabaseClient() {
    if (window.SupabaseAuthClient?.getClient) {
      const c = window.SupabaseAuthClient.getClient();
      if (c) return c;
    }
    if (window.supabase) return window.supabase;
    return null;
  }

  function renderList(list) {
    if (!list || !list.length) {
      issues.innerHTML = '<p style="color:#64748b; padding:12px 0;">No civic issues have been reported yet. Be the first to report a safety hazard above.</p>';
      return;
    }

    issues.innerHTML = list.map(x => `
      <article class="issue ${esc(x.status)}">
        <div>
          <span class="pill">${esc(String(x.type || '').replace('_', ' '))}</span>
          <span class="pill" style="margin-left:6px; background:${x.status === 'resolved' ? '#dcfce7' : x.status === 'in_progress' ? '#e0e7ff' : '#fef3c7'}; color:${x.status === 'resolved' ? '#166534' : x.status === 'in_progress' ? '#3730a3' : '#92400e'}">
            ${esc(String(x.status || 'open').replace('_', ' '))}
          </span>
        </div>
        <h3>${esc(x.title)}</h3>
        <p>${esc(x.description)}</p>
        <p class="note">${esc(x.area || 'Bangalore')} · ${new Date(x.created_at || Date.now()).toLocaleDateString()}</p>
        ${x.action_note ? `<p style="color:#0369a1;"><strong>Action update:</strong> ${esc(x.action_note)}</p>` : ''}
      </article>
    `).join('');
  }

  async function load() {
    issues.textContent = 'Loading issues…';

    // 1. Try backend API first if api base is configured
    if (api) {
      try {
        const res = await fetch(`${api}/api/civic/issues`);
        const contentType = res.headers.get('content-type') || '';
        if (res.ok && contentType.includes('application/json')) {
          const list = await res.json();
          if (Array.isArray(list)) {
            renderList(list);
            return;
          }
        }
      } catch (e) {
        // Fall back to Supabase
      }
    }

    // 2. Direct Supabase fallback (for static hosting like Cloudflare Workers/Pages)
    try {
      const sb = getSupabaseClient();
      if (sb) {
        // Explicit columns: the anon key may only read public ones (reporter_id is private).
        const { data, error } = await sb
          .from('civic_issues')
          .select('id, type, title, description, area, lat, lng, status, action_note, created_at, updated_at')
          .order('created_at', { ascending: false });

        if (!error && Array.isArray(data)) {
          renderList(data);
          return;
        }
      }
    } catch (sbErr) {
      console.warn('Supabase civic_issues fallback error:', sbErr);
    }

    // If both return nothing or empty
    renderList([]);
  }

  // Geolocation
  const locateBtn = document.getElementById('locate');
  if (locateBtn) {
    locateBtn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        loc.textContent = 'Geolocation is not supported by your browser.';
        return;
      }
      loc.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(
        p => {
          point = { lat: p.coords.latitude, lng: p.coords.longitude };
          loc.textContent = `Location ready (±${Math.round(p.coords.accuracy)}m)`;
          loc.style.color = '#166534';
          submit.disabled = false;
        },
        () => {
          loc.textContent = 'Location permission is required to pin this issue.';
          loc.style.color = '#b91c1c';
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }

  // Submission
  const form = document.getElementById('issue-form');
  if (form) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!point) return;

      submit.disabled = true;
      submit.textContent = 'Submitting…';

      try {
        const session = await window.SupabaseAuthClient?.getSession?.();
        if (!session?.access_token) {
          location.href = 'login.html?returnTo=civic.html';
          return;
        }

        const body = {
          type: document.getElementById('type').value,
          title: document.getElementById('title').value,
          description: document.getElementById('description').value,
          area: document.getElementById('area').value,
          ...point
        };

        let submitted = false;

        // Try API first if configured
        if (api) {
          try {
            const res = await fetch(`${api}/api/civic/issues`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`
              },
              body: JSON.stringify(body)
            });
            const contentType = res.headers.get('content-type') || '';
            if (res.ok && contentType.includes('application/json')) {
              submitted = true;
            }
          } catch (_) {}
        }

        // Direct Supabase fallback
        if (!submitted) {
          const sb = getSupabaseClient();
          if (!sb) throw new Error('Database connection unavailable.');

          const recordId = `civic_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const { error: insertErr } = await sb.from('civic_issues').insert({
            id: recordId,
            type: body.type,
            title: body.title,
            description: body.description,
            area: body.area || null,
            lat: body.lat,
            lng: body.lng,
            reporter_id: session.user.id,
            status: 'open'
          });

          if (insertErr) throw new Error(insertErr.message || 'Submission failed');
          submitted = true;
        }

        form.reset();
        point = null;
        loc.textContent = 'Thank you — your safety report was submitted.';
        loc.style.color = '#166534';
        await load();
      } catch (e) {
        loc.textContent = e.message || 'Failed to submit report.';
        loc.style.color = '#b91c1c';
      } finally {
        submit.disabled = !point;
        submit.textContent = 'Submit safety signal';
      }
    });
  }

  const refreshBtn = document.getElementById('refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', load);

  load();
})();
