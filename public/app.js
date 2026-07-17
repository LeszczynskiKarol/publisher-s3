'use strict';

const $ = (s) => document.querySelector(s);
const state = { sites: [], site: null };

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

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

const fmtDT = (iso) => new Date(iso).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';

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

// ── strony ──────────────────────────────────────────────────────────────────
async function loadSites() {
  const { sites } = await api('/api/sites');
  state.sites = sites;
  $('#site-list').innerHTML = sites.map((s) => `
    <button class="site-item ${state.site?.domain === s.domain ? 'active' : ''}" data-domain="${esc(s.domain)}">
      ${GLOBE}<span>${esc(s.domain)}</span>
      ${s.has_template ? '' : '<span class="no-tpl">brak szablonu</span>'}
    </button>`).join('');
}

$('#site-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.site-item');
  if (!btn) return;
  state.site = state.sites.find((s) => s.domain === btn.dataset.domain);
  $('#empty-state').classList.add('hidden');
  $('#history-view').classList.add('hidden');
  $('#browser').classList.remove('hidden');
  $('#site-label').textContent = state.site.domain;
  loadSites();
  switchTab(state.site.has_template ? 'new' : 'template');
  if (!state.site.has_template) toast('Ta strona nie ma jeszcze szablonu — ustaw go w zakładce Szablon.', 'error');
});

// ── zakładki ────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#view-new').classList.toggle('hidden', tab !== 'new');
  $('#view-articles').classList.toggle('hidden', tab !== 'articles');
  $('#view-template').classList.toggle('hidden', tab !== 'template');
  if (tab === 'articles') loadArticles();
  if (tab === 'template') loadTemplate();
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) switchTab(t.dataset.tab);
});

// ── nowy artykuł ────────────────────────────────────────────────────────────
$('#art-title').addEventListener('input', () => {
  $('#art-slug').placeholder = $('#art-title').value
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c]))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || '(auto z tytułu)';
});

$('#publish-btn').addEventListener('click', async () => {
  const title = $('#art-title').value.trim();
  const content = $('#art-content').value.trim();
  if (!title || !content) { toast('Uzupełnij tytuł i treść.', 'error'); return; }
  const btn = $('#publish-btn');
  btn.disabled = true;
  $('#publish-status').innerHTML = '<span class="spinner"></span>publikowanie…';
  $('#publish-result').classList.add('hidden');
  try {
    const out = await api('/api/publish', {
      method: 'POST',
      body: {
        domain: state.site.domain,
        title,
        slug: $('#art-slug').value.trim() || undefined,
        description: $('#art-desc').value.trim(),
        content,
        format: document.querySelector('input[name="format"]:checked').value,
      },
    });
    $('#publish-status').textContent = '';
    $('#publish-result').classList.remove('hidden');
    $('#publish-result').innerHTML = out.steps.map((s) => `
      <div class="step-row">
        <span class="${s.ok ? 's-ok' : 's-fail'}">${s.ok ? '✓' : '✗'}</span>
        <span>${esc(s.name)}</span>
        ${s.info ? `<span class="s-info" title="${esc(s.info)}">${esc(s.info)}</span>` : ''}
      </div>`).join('') +
      `<div class="step-url">→ <a href="${esc(out.url)}" target="_blank" rel="noopener">${esc(out.url)}</a></div>`;
    toast(out.ok ? 'Opublikowano! 🎉' : 'Opublikowano z błędami — sprawdź kroki.', out.ok ? 'success' : 'error');
    if (out.ok) { $('#art-title').value = ''; $('#art-slug').value = ''; $('#art-desc').value = ''; $('#art-content').value = ''; }
  } catch (err) {
    $('#publish-status').textContent = '';
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── artykuły ────────────────────────────────────────────────────────────────
async function loadArticles() {
  $('#articles-tbody').innerHTML = '<tr><td colspan="4"><span class="spinner"></span>Ładowanie…</td></tr>';
  try {
    const { articles } = await api(`/api/articles?domain=${encodeURIComponent(state.site.domain)}`);
    $('#articles-tbody').innerHTML = articles.map((a) => `
      <tr>
        <td class="mono-cell">${esc(a.slug)}</td>
        <td class="mono-cell">${fmtDT(a.modified)}</td>
        <td class="num">${a.sizeKb} KB</td>
        <td><a href="${esc(a.url)}" target="_blank" rel="noopener">otwórz ↗</a></td>
      </tr>`).join('') || '<tr><td colspan="4">Brak artykułów pod tym prefiksem.</td></tr>';
  } catch (err) {
    $('#articles-tbody').innerHTML = `<tr><td colspan="4">${esc(err.message)}</td></tr>`;
  }
}

// ── szablon ─────────────────────────────────────────────────────────────────
async function loadTemplate() {
  $('#template-status').innerHTML = '<span class="spinner"></span>ładowanie…';
  $('#template-editor').value = '';
  try {
    const out = await api(`/api/template?domain=${encodeURIComponent(state.site.domain)}`);
    $('#template-editor').value = out.template || '';
    $('#template-status').textContent = out.source === 'saved'
      ? 'zapisany szablon'
      : out.source === 'none' ? 'brak artykułów do podpowiedzi — wklej szablon ręcznie'
      : `propozycja z: ${out.source} — zamień treść na placeholdery i zapisz`;
  } catch (err) {
    $('#template-status').textContent = err.message;
  }
}

$('#template-save').addEventListener('click', async () => {
  try {
    await api('/api/template', {
      method: 'POST',
      body: { domain: state.site.domain, template: $('#template-editor').value },
    });
    toast('Zapisano szablon.', 'success');
    state.site.has_template = true;
    loadSites();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── historia ────────────────────────────────────────────────────────────────
$('#history-btn').addEventListener('click', async () => {
  $('#empty-state').classList.add('hidden');
  $('#browser').classList.add('hidden');
  $('#history-view').classList.remove('hidden');
  const { history } = await api('/api/history');
  $('#history-tbody').innerHTML = history.map((h) => `
    <tr>
      <td class="mono-cell">${fmtDT(h.ts)}</td>
      <td class="mono-cell">${esc(h.domain)}</td>
      <td><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a></td>
      <td class="mono-cell">${h.steps.map((s) => s.ok ? '✓' : '✗').join(' ')}</td>
    </tr>`).join('') || '<tr><td colspan="4">Jeszcze nic nie opublikowano.</td></tr>';
});

// ── dodawanie strony ────────────────────────────────────────────────────────
$('#add-site-btn').addEventListener('click', async () => {
  $('#modal-backdrop').classList.remove('hidden');
  const { buckets } = await api('/api/buckets');
  $('#new-bucket').innerHTML = buckets.map((b) => `<option>${esc(b)}</option>`).join('');
});

$('#new-domain').addEventListener('input', () => {
  const v = $('#new-domain').value.trim();
  const opt = [...$('#new-bucket').options].find((o) => o.value === v);
  if (opt) $('#new-bucket').value = v;
});

$('#modal-cancel').addEventListener('click', () => $('#modal-backdrop').classList.add('hidden'));
$('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#modal-backdrop').classList.add('hidden');
});

$('#modal-save').addEventListener('click', async () => {
  try {
    await api('/api/sites', {
      method: 'POST',
      body: {
        domain: $('#new-domain').value.trim(),
        bucket: $('#new-bucket').value,
        blog_prefix: $('#new-prefix').value.trim() || 'blog/',
        sitemap_key: $('#new-sitemap').value.trim() || 'sitemap-0.xml',
      },
    });
    $('#modal-backdrop').classList.add('hidden');
    toast('Dodano stronę.', 'success');
    loadSites();
  } catch (err) {
    toast(err.message, 'error');
  }
});

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
