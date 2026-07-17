'use strict';

const $ = (s) => document.querySelector(s);
const state = { sites: [], site: null, base: null, files: [], file: null, job: null };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function showLogin() { $('#login-view').classList.remove('hidden'); $('#app-view').classList.add('hidden'); $('#password').focus(); }
function showApp() { $('#login-view').classList.add('hidden'); $('#app-view').classList.remove('hidden'); }

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').classList.add('hidden');
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    showApp();
    loadSites();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ── lista projektów ─────────────────────────────────────────────────────────
async function loadSites() {
  const { sites } = await api('/api/sites');
  state.sites = sites.filter((s) => !s.hidden);
  renderSites();
}

function renderSites() {
  const q = ($('#site-filter').value || '').toLowerCase();
  const list = state.sites.filter((s) => s.name.toLowerCase().includes(q) || (s.site_url || '').includes(q));
  $('#site-list').innerHTML = list.map((s) => {
    const total = (s.collections || []).reduce((n, c) => n + c.count, 0);
    return `
    <button class="site-item ${state.site?.id === s.id ? 'active' : ''}" data-id="${s.id}" title="${esc(s.dir)}">
      <span class="s-name">${esc(s.name)}</span>
      <span class="s-meta">
        ${total ? `<span class="s-count">${total} md</span>` : '<span class="s-count dim">bez md</span>'}
        ${s.has_deploy ? '<span class="s-deploy" title="ma deploy.sh">🚀</span>' : ''}
      </span>
    </button>`;
  }).join('');
  $('#site-count').textContent = `${list.length} projektów`;
}

$('#site-filter').addEventListener('input', renderSites);

$('#scan-btn').addEventListener('click', async () => {
  $('#scan-btn').disabled = true;
  try {
    const out = await api('/api/scan', { method: 'POST' });
    toast(`Przeskanowano — ${out.found} projektów Astro.`, 'success');
    loadSites();
  } catch (err) { toast(err.message, 'error'); }
  finally { $('#scan-btn').disabled = false; }
});

$('#site-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.site-item');
  if (!btn) return;
  openSite(state.sites.find((s) => s.id === +btn.dataset.id));
});

function openSite(site) {
  state.site = site;
  state.base = (site.collections || [])[0]?.base || null;
  renderSites();
  $('#empty-state').classList.add('hidden');
  $('#browser').classList.remove('hidden');
  $('#site-label').textContent = site.name;
  const link = $('#site-link');
  if (site.site_url) { link.textContent = site.site_url.replace('https://', ''); link.href = site.site_url; link.classList.remove('hidden'); }
  else link.classList.add('hidden');
  $('#deploy-btn').title = site.has_deploy ? 'Uruchom deploy.sh' : 'Brak deploy.sh — odpali tylko npm run build';
  renderCollectionTabs();
  showFiles();
}

function renderCollectionTabs() {
  const cols = state.site.collections || [];
  $('#collection-tabs').innerHTML = cols.map((c) => `
    <button class="tab ${c.base === state.base ? 'active' : ''}" data-base="${esc(c.base)}">${esc(c.name)} (${c.count})</button>`,
  ).join('') || '<span class="count-label">brak kolekcji markdown</span>';
}

$('#collection-tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  state.base = t.dataset.base;
  renderCollectionTabs();
  showFiles();
});

// ── pliki ───────────────────────────────────────────────────────────────────
async function showFiles() {
  $('#view-editor').classList.add('hidden');
  $('#view-files').classList.remove('hidden');
  if (!state.base) { $('#files-tbody').innerHTML = '<tr><td colspan="5">Ten projekt nie ma plików markdown.</td></tr>'; $('#files-count').textContent = ''; return; }
  $('#files-tbody').innerHTML = '<tr><td colspan="5"><span class="spinner"></span>Ładowanie…</td></tr>';
  try {
    const { files } = await api(`/api/content?site=${state.site.id}&base=${encodeURIComponent(state.base)}`);
    state.files = files;
    $('#files-count').textContent = `${files.length} plików w ${state.base}`;
    $('#files-tbody').innerHTML = files.map((f) => `
      <tr class="row-clickable" data-rel="${esc(f.rel)}">
        <td>${esc(f.title || '—')}${f.draft ? ' <span class="draft-badge">draft</span>' : ''}</td>
        <td class="mono-cell">${esc(f.name)}</td>
        <td class="mono-cell">${esc(f.pubDate || '')}</td>
        <td class="num">${f.sizeKb}</td>
        <td class="mono-cell">edytuj →</td>
      </tr>`).join('') || '<tr><td colspan="5">Pusto.</td></tr>';
  } catch (err) {
    $('#files-tbody').innerHTML = `<tr><td colspan="5">${esc(err.message)}</td></tr>`;
  }
}

$('#files-tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-rel]');
  if (tr) openEditor(tr.dataset.rel);
});

// ── edytor ──────────────────────────────────────────────────────────────────
async function openEditor(rel) {
  state.file = rel;
  $('#view-files').classList.add('hidden');
  $('#view-editor').classList.remove('hidden');
  $('#file-label').textContent = rel;
  $('#editor').value = 'Ładowanie…';
  try {
    const { content } = await api(`/api/file?site=${state.site.id}&rel=${encodeURIComponent(rel)}`);
    $('#editor').value = content;
  } catch (err) {
    $('#editor').value = '';
    toast(err.message, 'error');
  }
}

$('#back-btn').addEventListener('click', showFiles);

async function saveFile() {
  try {
    await api('/api/file', { method: 'POST', body: { site: state.site.id, rel: state.file, content: $('#editor').value } });
    toast('Zapisano (poprzednia wersja w kopii).', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

$('#save-btn').addEventListener('click', saveFile);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && !$('#view-editor').classList.contains('hidden')) {
    e.preventDefault();
    saveFile();
  }
});

$('#delete-btn').addEventListener('click', async () => {
  if (!confirm(`Usunąć ${state.file}?\nKopia zostanie w .backups; jeśli projekt jest w git, plik da się też odzyskać z historii.`)) return;
  try {
    await api('/api/file', { method: 'DELETE', body: { site: state.site.id, rel: state.file } });
    toast('Usunięto (kopia w .backups).', 'success');
    openSiteRefresh();
  } catch (err) { toast(err.message, 'error'); }
});

async function openSiteRefresh() {
  await api('/api/scan', { method: 'POST' }).catch(() => {});
  const { sites } = await api('/api/sites');
  state.sites = sites.filter((s) => !s.hidden);
  state.site = state.sites.find((s) => s.id === state.site.id);
  renderSites();
  renderCollectionTabs();
  showFiles();
}

// ── nowy artykuł ────────────────────────────────────────────────────────────
$('#new-file-btn').addEventListener('click', () => {
  if (!state.base) { toast('Ten projekt nie ma kolekcji markdown.', 'error'); return; }
  $('#modal-backdrop').classList.remove('hidden');
  $('#new-title').focus();
});

$('#modal-cancel').addEventListener('click', () => $('#modal-backdrop').classList.add('hidden'));
$('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#modal-backdrop').classList.add('hidden');
});

$('#modal-create').addEventListener('click', async () => {
  const title = $('#new-title').value.trim();
  if (!title) return;
  try {
    const out = await api('/api/new', {
      method: 'POST',
      body: {
        site: state.site.id, base: state.base, title,
        slug: $('#new-slug').value.trim() || undefined,
        description: $('#new-desc').value.trim(),
      },
    });
    $('#modal-backdrop').classList.add('hidden');
    $('#new-title').value = ''; $('#new-slug').value = ''; $('#new-desc').value = '';
    toast(`Utworzono ${out.rel}`, 'success');
    openEditor(out.rel);
  } catch (err) { toast(err.message, 'error'); }
});

// ── deploy ──────────────────────────────────────────────────────────────────
$('#deploy-btn').addEventListener('click', async () => {
  if (!confirm(`Deploy ${state.site.name}?\n${state.site.has_deploy ? 'Uruchomi ./deploy.sh (build + S3 + CloudFront).' : 'UWAGA: brak deploy.sh — poleci tylko npm run build.'}`)) return;
  try {
    const out = await api('/api/deploy', { method: 'POST', body: { site: state.site.id } });
    state.job = out.job;
    $('#deploy-panel').classList.remove('hidden');
    $('#deploy-title').innerHTML = `<span class="spinner"></span>Deploy: ${esc(state.site.name)}`;
    pollJob();
  } catch (err) { toast(err.message, 'error'); }
});

async function pollJob() {
  if (!state.job) return;
  try {
    const j = await api(`/api/job/${state.job}`);
    $('#deploy-log').textContent = j.log.join('\n');
    $('#deploy-log').scrollTop = $('#deploy-log').scrollHeight;
    if (j.status === 'running') setTimeout(pollJob, 1500);
    else {
      $('#deploy-title').textContent = j.status === 'done' ? `✓ Deploy OK: ${j.name}` : `✗ Deploy padł: ${j.name}`;
      toast(j.status === 'done' ? 'Deploy zakończony.' : 'Deploy nieudany — sprawdź log.', j.status === 'done' ? 'success' : 'error');
    }
  } catch { setTimeout(pollJob, 3000); }
}

$('#deploy-close').addEventListener('click', () => $('#deploy-panel').classList.add('hidden'));

// ── init ────────────────────────────────────────────────────────────────────
(async function init() {
  try {
    await api('/api/sites');
    showApp();
    loadSites();
  } catch {
    showLogin();
  }
})();
