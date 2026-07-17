require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '4900', 10);
const PASSWORD = process.env.PUB_PASSWORD;
const SECRET = process.env.PUB_SECRET;
const API_KEY = process.env.PUB_API_KEY;
if (!PASSWORD || !SECRET || !process.env.PG_URL) {
  console.error('Brak PUB_PASSWORD / PUB_SECRET / PG_URL w .env — przerwano start.');
  process.exit(1);
}

const db = new Pool({ connectionString: process.env.PG_URL, max: 5 });
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const SCAN_ROOT = 'D:\\';
const BACKUP_DIR = path.join(__dirname, '.backups');

// ── schemat ─────────────────────────────────────────────────────────────────
async function initDb() {
  await db.query(`
    DROP TABLE IF EXISTS sites;      -- stary model (publikacja HTML do S3) — zastąpiony
    DROP TABLE IF EXISTS published;
    CREATE TABLE IF NOT EXISTS astro_sites (
      id serial PRIMARY KEY,
      dir text UNIQUE NOT NULL,          -- katalog projektu (absolutny)
      name text NOT NULL,
      site_url text,                     -- z astro.config "site:"
      repo text,                         -- remote origin z .git/config
      has_deploy boolean NOT NULL DEFAULT false,
      collections jsonb NOT NULL DEFAULT '[]',
      hidden boolean NOT NULL DEFAULT false,
      scanned_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS topic_queue (
      id serial PRIMARY KEY,
      site_id int NOT NULL,
      topic text NOT NULL,
      why text,
      zrodlo text,
      biblioteka text,
      status text NOT NULL DEFAULT 'proposed',  -- proposed|accepted|writing|published|rejected|failed
      file_rel text,
      url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS autoblog (
      site_id int PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT false,
      cadence real NOT NULL DEFAULT 1,          -- artykułów na tydzień
      tier text NOT NULL DEFAULT 'B',           -- B = auto-deploy, A = bez deployu (czeka na Ciebie)
      fallback_free boolean NOT NULL DEFAULT true,
      next_run timestamptz,
      last_run timestamptz
    );
    CREATE TABLE IF NOT EXISTS settings (k text PRIMARY KEY, v text NOT NULL);
    INSERT INTO settings (k, v) VALUES ('autoblog_paused', 'false'), ('autoblog_daily_max', '2')
      ON CONFLICT DO NOTHING;
  `);
}

// ── auth (cookie GUI / x-api-key automatyzacja) ─────────────────────────────
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const sign = () => {
  const p = String(Date.now() + SESSION_TTL_MS);
  return `${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('hex')}`;
};
const verify = (t) => {
  if (!t) return false;
  const [p, s] = t.split('.');
  if (!p || !s) return false;
  const e = crypto.createHmac('sha256', SECRET).update(p).digest('hex');
  const a = Buffer.from(s), b = Buffer.from(e);
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Date.now() < +p;
};
const cookieVal = (req, n) => {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === n) return decodeURIComponent(v.join('='));
  }
  return null;
};

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  const rec = (attempts.get(ip) || []).filter((t) => Date.now() - t < 900000);
  if (rec.length >= 5) return res.status(429).json({ error: 'Za dużo prób.' });
  const a = crypto.createHash('sha256').update(String(req.body.password || '')).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    attempts.set(ip, [...rec, Date.now()]);
    return res.status(401).json({ error: 'Błędne hasło.' });
  }
  res.setHeader('Set-Cookie', `pub=${encodeURIComponent(sign())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'pub=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  if (API_KEY && req.headers['x-api-key'] === API_KEY) return next();
  if (!verify(cookieVal(req, 'pub'))) return res.status(401).json({ error: 'unauthorized' });
  next();
});

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(`[${new Date().toISOString()}]`, req.method, req.originalUrl, err.message);
  res.status(err.status || 500).json({ error: err.message });
});

// ── discovery: skan dysku w poszukiwaniu projektów Astro ────────────────────
async function findAstroDirs() {
  const dirs = [];
  const top = await fsp.readdir(SCAN_ROOT, { withFileTypes: true }).catch(() => []);
  for (const d of top) {
    if (!d.isDirectory() || d.name.startsWith('$') || d.name === 'node_modules') continue;
    const base = path.join(SCAN_ROOT, d.name);
    for (const cand of [base, path.join(base, 'frontend')]) {
      const hasConfig = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']
        .some((f) => fs.existsSync(path.join(cand, f)));
      if (hasConfig) dirs.push(cand);
    }
  }
  return dirs;
}

function readSiteUrl(dir) {
  for (const f of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']) {
    try {
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = txt.match(/site:\s*['"]([^'"]+)['"]/);
      if (m) return m[1].replace(/\/$/, '');
    } catch {}
  }
  return null;
}

function readRepo(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const m = txt.match(/url\s*=\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

async function scanCollections(dir) {
  const collections = [];
  const contentDir = path.join(dir, 'src', 'content');
  try {
    for (const c of await fsp.readdir(contentDir, { withFileTypes: true })) {
      if (!c.isDirectory()) continue;
      const files = (await fsp.readdir(path.join(contentDir, c.name)))
        .filter((f) => /\.(md|mdx)$/.test(f));
      if (files.length) collections.push({ name: c.name, base: `src/content/${c.name}`, count: files.length });
    }
  } catch {}
  // markdown bezpośrednio w src/pages/** (starszy wzorzec)
  const pagesDir = path.join(dir, 'src', 'pages');
  const pageMd = [];
  async function walk(d, rel) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(d, e.name), `${rel}/${e.name}`);
      else if (/\.(md|mdx)$/.test(e.name)) pageMd.push(`${rel}/${e.name}`);
    }
  }
  await walk(pagesDir, '');
  if (pageMd.length) collections.push({ name: 'pages (md)', base: 'src/pages', count: pageMd.length });
  return collections;
}

async function runScan() {
  const dirs = await findAstroDirs();
  for (const dir of dirs) {
    const name = path.basename(dir) === 'frontend'
      ? `${path.basename(path.dirname(dir))}/frontend` : path.basename(dir);
    const row = {
      dir,
      name,
      site_url: readSiteUrl(dir),
      repo: readRepo(dir),
      has_deploy: fs.existsSync(path.join(dir, 'deploy.sh')),
      collections: JSON.stringify(await scanCollections(dir)),
    };
    await db.query(`
      INSERT INTO astro_sites (dir, name, site_url, repo, has_deploy, collections, scanned_at)
      VALUES ($1,$2,$3,$4,$5,$6, now())
      ON CONFLICT (dir) DO UPDATE SET name=$2, site_url=$3, repo=$4, has_deploy=$5, collections=$6, scanned_at=now()`,
      [row.dir, row.name, row.site_url, row.repo, row.has_deploy, row.collections]);
  }
  return dirs.length;
}

app.post('/api/scan', wrap(async (req, res) => {
  const n = await runScan();
  res.json({ ok: true, found: n });
}));

app.get('/api/sites', wrap(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, dir, name, site_url, repo, has_deploy, collections, hidden FROM astro_sites ORDER BY name');
  res.json({ sites: rows });
}));

app.post('/api/sites/:id/hide', wrap(async (req, res) => {
  await db.query('UPDATE astro_sites SET hidden=$1 WHERE id=$2', [!!req.body.hidden, req.params.id]);
  res.json({ ok: true });
}));

// ── pliki content ───────────────────────────────────────────────────────────
async function siteById(id) {
  const { rows } = await db.query('SELECT * FROM astro_sites WHERE id=$1', [id]);
  if (!rows[0]) throw Object.assign(new Error('nieznana strona'), { status: 404 });
  return rows[0];
}

function safeAbs(site, rel) {
  if (!/\.(md|mdx)$/.test(rel)) throw Object.assign(new Error('dozwolone tylko .md/.mdx'), { status: 400 });
  const abs = path.resolve(site.dir, rel);
  if (!abs.startsWith(path.resolve(site.dir) + path.sep)) {
    throw Object.assign(new Error('ścieżka poza projektem'), { status: 400 });
  }
  return abs;
}

function parseFrontmatter(txt) {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const get = (k) => {
    const mm = m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm'));
    return mm ? mm[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  return {
    title: get('title'),
    description: get('description'),
    pubDate: get('pubDate') || get('publishDate') || get('pubDatetime') || get('date'),
    draft: get('draft'),
  };
}

// zgadnij publiczny URL artykułu: src/content/<kolekcja>/<slug>.md →
// /<kolekcja>/<slug>/ jeśli istnieje src/pages/<kolekcja>/, inaczej /<slug>/
function urlFor(site, base, rel) {
  if (!site.site_url) return null;
  const colName = base.replace(/^src\/content\/?/, '').split('/')[0];
  const slugPath = rel.replace(/^src\/(content|pages)\//, '').replace(/^[^/]+\//, '').replace(/\.(md|mdx)$/, '');
  const hasRoute = colName && fs.existsSync(path.join(site.dir, 'src', 'pages', colName));
  return `${site.site_url}/${hasRoute ? colName + '/' : ''}${slugPath}/`;
}

app.get('/api/content', wrap(async (req, res) => {
  const site = await siteById(req.query.site);
  const base = String(req.query.base || '');
  const absBase = path.resolve(site.dir, base);
  if (!absBase.startsWith(path.resolve(site.dir))) throw Object.assign(new Error('zła ścieżka'), { status: 400 });
  const files = [];
  async function walk(d, rel) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name);
      else if (/\.(md|mdx)$/.test(e.name)) {
        const abs = path.join(d, e.name);
        const st = await fsp.stat(abs);
        const head = (await fsp.readFile(abs, 'utf8')).slice(0, 3000);
        const fm = parseFrontmatter(head);
        const fileRel = `${base}/${rel ? rel + '/' : ''}${e.name}`.replace(/\\/g, '/');
        files.push({
          rel: fileRel,
          name: e.name,
          title: fm.title,
          pubDate: fm.pubDate,
          draft: fm.draft === 'true',
          sizeKb: Math.round(st.size / 1024),
          mtime: st.mtime,
          url: urlFor(site, base, fileRel),
        });
      }
    }
  }
  await walk(absBase, '');
  files.sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || '') || b.mtime - a.mtime);
  res.json({ files });
}));

app.get('/api/file', wrap(async (req, res) => {
  const site = await siteById(req.query.site);
  const abs = safeAbs(site, String(req.query.rel));
  res.json({ content: await fsp.readFile(abs, 'utf8') });
}));

async function backupFile(site, rel, abs) {
  try {
    const dst = path.join(BACKUP_DIR, site.name.replace(/[\\/]/g, '_'),
      `${rel.replace(/[\\/]/g, '_')}.${Date.now()}`);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(abs, dst);
  } catch {}
}

app.post('/api/file', wrap(async (req, res) => {
  const { site: siteId, rel, content } = req.body;
  const site = await siteById(siteId);
  const abs = safeAbs(site, rel);
  if (fs.existsSync(abs)) await backupFile(site, rel, abs);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  res.json({ ok: true });
}));

app.delete('/api/file', wrap(async (req, res) => {
  const { site: siteId, rel } = req.body;
  const site = await siteById(siteId);
  const abs = safeAbs(site, rel);
  await backupFile(site, rel, abs);
  await fsp.unlink(abs);
  res.json({ ok: true });
}));

// nowy artykuł: frontmatter dziedziczony z najnowszego pliku kolekcji
const slugify = (s) => s.toLowerCase()
  .replace(/[ąćęłńóśźż]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c]))
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

app.post('/api/new', wrap(async (req, res) => {
  const { site: siteId, base, title, description = '', content = '' } = req.body;
  if (!title || !base) return res.status(400).json({ error: 'brak base/title' });
  const site = await siteById(siteId);
  const slug = slugify(req.body.slug || title);
  const rel = `${base}/${slug}.md`;
  const abs = safeAbs(site, rel);
  if (fs.existsSync(abs)) return res.status(409).json({ error: 'plik już istnieje', rel });

  // szablon frontmattera: najnowszy plik w kolekcji
  const absBase = path.resolve(site.dir, base);
  let fmBlock = `---\ntitle: "${title}"\ndescription: "${description}"\npubDate: ${new Date().toISOString().slice(0, 10)}\n---`;
  try {
    const newest = (await fsp.readdir(absBase))
      .filter((f) => /\.(md|mdx)$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(absBase, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (newest) {
      const src = await fsp.readFile(path.join(absBase, newest.f), 'utf8');
      const m = src.match(/^---\r?\n[\s\S]*?\r?\n---/);
      if (m) {
        const t = title.replace(/"/g, '\\"');
        const d = description.replace(/"/g, '\\"');
        fmBlock = m[0]
          .replace(/^title:.*$/m, `title: "${t}"`)
          .replace(/^metaTitle:.*$/m, `metaTitle: "${t}"`)
          .replace(/^(description|excerpt|metaDescription):.*$/gm, `$1: "${d}"`)
          .replace(/^(pubDate|publishDate|pubDatetime|date):.*$/gm, `$1: ${new Date().toISOString().slice(0, 10)}`)
          .replace(/^draft:.*$/m, 'draft: false');
      }
    }
  } catch {}
  await fsp.writeFile(abs, `${fmBlock}\n\n${content}\n`, 'utf8');
  res.json({ ok: true, rel, slug });
}));

// ── deploy (deploy.sh przez git-bash / npm run build) ───────────────────────
const jobs = new Map();
let jobSeq = 0;

app.post('/api/deploy', wrap(async (req, res) => {
  const site = await siteById(req.body.site);
  const running = [...jobs.values()].find((j) => j.dir === site.dir && j.status === 'running');
  if (running) return res.status(409).json({ error: 'deploy tej strony już trwa', job: running.id });

  const id = ++jobSeq;
  const job = { id, dir: site.dir, name: site.name, status: 'running', log: [], started: Date.now() };
  jobs.set(id, job);
  const push = (line) => { job.log.push(line); if (job.log.length > 500) job.log.shift(); };

  const cmd = site.has_deploy ? './deploy.sh' : 'npm run build';
  push(`$ ${cmd}  (w ${site.dir})`);
  const child = spawn(GIT_BASH, ['-lc', cmd], { cwd: site.dir, windowsHide: true });
  child.stdout.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(push));
  child.stderr.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(push));
  child.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'failed';
    job.ms = Date.now() - job.started;
    push(code === 0 ? `✓ zakończono w ${Math.round(job.ms / 1000)}s` : `✗ exit code ${code}`);
  });
  child.on('error', (e) => { job.status = 'failed'; push(`✗ ${e.message}`); });

  res.json({ ok: true, job: id, mode: site.has_deploy ? 'deploy.sh' : 'npm run build (brak deploy.sh!)' });
}));

app.get('/api/jobs', wrap(async (req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => b.started - a.started)
    .slice(0, 20)
    .map((j) => ({ id: j.id, name: j.name, status: j.status, started: j.started, min: Math.round((Date.now() - j.started) / 60000) }));
  res.json({ jobs: list });
}));

app.get('/api/job/:id', wrap(async (req, res) => {
  const job = jobs.get(parseInt(req.params.id, 10));
  if (!job) return res.status(404).json({ error: 'nie ma takiego joba' });
  res.json({ status: job.status, log: job.log.slice(-120), name: job.name, result: job.result || null });
}));

// ── AI: lokalny Claude (Opus 4.8, kontekst 1M) analizuje i pisze ────────────
const JOBS_DIR = path.join(__dirname, '.jobs');
const CLAUDE_CMD = `claude -p --model 'claude-opus-4-8[1m]' --dangerously-skip-permissions --output-format stream-json --verbose`;

function apexOf(siteUrl) {
  try { return new URL(siteUrl).hostname; } catch { return siteUrl || ''; }
}

// stream-json → czytelny log postępu (nazwy narzędzi + fragmenty tekstu)
function pushStreamLine(job, line) {
  try {
    const j = JSON.parse(line);
    if (j.type === 'assistant') {
      for (const c of j.message?.content || []) {
        if (c.type === 'tool_use') job.log.push(`→ ${c.name}${c.input?.file_path ? ' ' + c.input.file_path : ''}${c.input?.query ? ' „' + c.input.query + '"' : ''}`);
        else if (c.type === 'text' && c.text.trim()) job.log.push(...c.text.trim().split('\n').slice(0, 4));
      }
    } else if (j.type === 'result') {
      job.claudeResult = j.result || '';
      job.log.push(`— Claude skończył (${Math.round((j.duration_ms || 0) / 1000)}s, ${j.num_turns || '?'} tur)`);
    }
  } catch {
    if (line.trim()) job.log.push(line);
  }
  if (job.log.length > 800) job.log.splice(0, job.log.length - 800);
}

async function launchClaudeJob(site, prompt, { label, andDeploy = false, onDone } = {}) {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  const id = ++jobSeq;
  const promptFile = path.join(JOBS_DIR, `prompt-${id}.txt`);
  await fsp.writeFile(promptFile, prompt, 'utf8');
  const job = { id, dir: site.dir, name: `${label}: ${site.name}`, status: 'running', log: [], started: Date.now() };
  jobs.set(id, job);
  job.log.push(`⏳ ${label} — Claude (Opus 4.8, 1M) pracuje w ${site.dir}…`);

  const bashPrompt = '/' + promptFile.replace(/\\/g, '/').replace(':', '');
  const cmd = `cd . && cat "${bashPrompt}" | ${CLAUDE_CMD}${andDeploy ? ' && ./deploy.sh' : ''}`;
  const child = spawn(GIT_BASH, ['-lc', cmd], { cwd: site.dir, windowsHide: true });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach((l) => pushStreamLine(job, l));
  });
  child.stderr.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => job.log.push(l)));
  child.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'failed';
    job.ms = Date.now() - job.started;
    job.log.push(code === 0 ? `✓ zakończono w ${Math.round(job.ms / 60000)} min` : `✗ exit code ${code}`);
    fsp.unlink(promptFile).catch(() => {});
    if (onDone) onDone(job, code);
  });
  child.on('error', (e) => { job.status = 'failed'; job.log.push(`✗ ${e.message}`); });
  return job;
}

function aiContext(site, base) {
  return `Jesteś w katalogu projektu Astro strony ${site.site_url || site.name} (katalog: ${site.dir}).
Kolekcja artykułów blogowych: ${base}. Domena: ${apexOf(site.site_url)}.`;
}

// tryb "zaproponuj tematy": analiza treści + GSC/GA + web research → JSON propozycji
app.post('/api/ai/propose', wrap(async (req, res) => {
  const site = await siteById(req.body.site);
  const base = req.body.base;
  if (!base) return res.status(400).json({ error: 'brak base' });
  const prompt = `${aiContext(site, base)}

ZADANIE: zaproponuj 5 tematów na NOWY artykuł blogowy dla tej strony. NICZEGO nie zapisuj na dysku.

Wykonaj analizę (wszystkie cztery źródła — są komplementarne, żadne nie zastępuje innego):
1. Przeczytaj tytuły i tematykę istniejących artykułów w ${base} — nowe tematy nie mogą ich dublować, mają uzupełniać luki.
2. Pobierz dane Google Search Console i GA4 dla domeny ${apexOf(site.site_url)} zgodnie z procedurą z Twojego globalnego CLAUDE.md (sekcja "Google Analytics (GA4) & Search Console"). Szukaj zapytań z wyświetleniami, na które strona nie ma dedykowanego artykułu, oraz artykułów z potencjałem na temat pokrewny.
3. BIBLIOTEKA ŹRÓDEŁ: załaduj skill "biblioteka" (narzędzie Skill). Sprawdź \`python library.py stats\` (z D:\\copy-library\\pipeline), czy któraś kolekcja pasuje tematycznie do tej strony. Jeśli tak — przejrzyj \`python library.py clusters <kolekcja>\` i wygeneruj część propozycji z tego, co biblioteka FAKTYCZNIE głęboko pokrywa (motywy, spory, liczby z wielu źródeł) — takie tematy dostaną najlepsze, źródłowe artykuły. NIE rób żniw (harvest) — tylko odczyt.
4. Zrób research w sieci (WebSearch): czego aktualnie szukają ludzie w tej tematyce, jakie tematy pokrywa konkurencja, czego brakuje.

WYNIK: wypisz WYŁĄCZNIE czysty JSON (bez markdown, bez komentarzy):
[{"temat":"...","uzasadnienie":"1-2 zdania dlaczego ten temat","zrodlo":"gsc|ga|web|content-gap|biblioteka","biblioteka":"<nazwa-kolekcji albo brak>"}]
Pole "biblioteka" ustaw na nazwę kolekcji, jeśli biblioteka ma źródła przydatne DO TEGO tematu (nawet gdy pomysł przyszedł z GSC/web) — to sygnał, że artykuł będzie miał głębokie pokrycie źródłowe. Dokładnie 5 pozycji, tematy po polsku.`;
  const job = await launchClaudeJob(site, prompt, {
    label: 'Propozycje tematów',
    onDone: async (j, code) => {
      if (code !== 0) return;
      try {
        const m = (j.claudeResult || '').match(/\[[\s\S]*\]/);
        j.result = { proposals: JSON.parse(m[0]) };
        for (const p of j.result.proposals) {
          await db.query(
            `INSERT INTO topic_queue (site_id, topic, why, zrodlo, biblioteka) VALUES ($1,$2,$3,$4,$5)`,
            [site.id, p.temat, p.uzasadnienie || null, p.zrodlo || null, p.biblioteka || null]);
        }
      } catch { j.result = { error: 'nie udało się sparsować propozycji', raw: (j.claudeResult || '').slice(0, 2000) }; }
    },
  });
  res.json({ ok: true, job: job.id });
}));

// ── kolejka tematów ─────────────────────────────────────────────────────────
app.get('/api/queue', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM topic_queue WHERE site_id=$1 AND status NOT IN ('rejected') ORDER BY
     CASE status WHEN 'writing' THEN 0 WHEN 'accepted' THEN 1 WHEN 'proposed' THEN 2 ELSE 3 END, created_at DESC LIMIT 60`,
    [req.query.site]);
  res.json({ queue: rows });
}));

app.post('/api/queue', wrap(async (req, res) => {
  const { site: siteId, topic, status = 'accepted' } = req.body;
  if (!topic) return res.status(400).json({ error: 'brak tematu' });
  await siteById(siteId);
  await db.query('INSERT INTO topic_queue (site_id, topic, zrodlo, status) VALUES ($1,$2,$3,$4)',
    [siteId, topic.trim(), 'manual', status]);
  res.json({ ok: true });
}));

app.post('/api/queue/:id', wrap(async (req, res) => {
  const { status } = req.body;
  if (!['accepted', 'rejected', 'proposed'].includes(status)) return res.status(400).json({ error: 'zły status' });
  await db.query('UPDATE topic_queue SET status=$1 WHERE id=$2', [status, req.params.id]);
  res.json({ ok: true });
}));

// ── autoblog: konfiguracja + scheduler ──────────────────────────────────────
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const ses = new SESClient({ region: process.env.SES_REGION || 'eu-central-1' });

async function sendDigest(subject, body) {
  if (!process.env.ALERT_EMAIL) return;
  try {
    await ses.send(new SendEmailCommand({
      Source: process.env.SES_FROM,
      Destination: { ToAddresses: [process.env.ALERT_EMAIL] },
      Message: {
        Subject: { Data: `[publisher] ${subject}`, Charset: 'UTF-8' },
        Body: { Text: { Data: body, Charset: 'UTF-8' } },
      },
    }));
  } catch (e) { console.error('SES:', e.message); }
}

const getSetting = async (k) => (await db.query('SELECT v FROM settings WHERE k=$1', [k])).rows[0]?.v;
const setSetting = (k, v) => db.query(
  'INSERT INTO settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2', [k, String(v)]);

// losowy termin: za `days` dni (±20%), o losowej godzinie 8-20
function nextRunAfter(days) {
  const jitter = 0.8 + Math.random() * 0.4;
  const d = new Date(Date.now() + days * jitter * 86400000);
  d.setHours(8 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60), 0, 0);
  return d;
}

app.get('/api/autoblog', wrap(async (req, res) => {
  const { rows } = await db.query(`
    SELECT a.*, s.name, s.site_url,
      (SELECT count(*)::int FROM topic_queue q WHERE q.site_id=a.site_id AND q.status='accepted') AS queued,
      (SELECT count(*)::int FROM topic_queue q WHERE q.site_id=a.site_id AND q.status='proposed') AS proposed
    FROM autoblog a JOIN astro_sites s ON s.id=a.site_id ORDER BY s.name`);
  res.json({
    paused: (await getSetting('autoblog_paused')) === 'true',
    dailyMax: parseInt(await getSetting('autoblog_daily_max'), 10) || 2,
    sites: rows,
  });
}));

app.post('/api/autoblog', wrap(async (req, res) => {
  const { site: siteId, enabled, cadence = 1, tier = 'B', fallback_free = true } = req.body;
  await siteById(siteId);
  await db.query(`
    INSERT INTO autoblog (site_id, enabled, cadence, tier, fallback_free, next_run)
    VALUES ($1,$2,$3,$4,$5, CASE WHEN $2 THEN now() + interval '1 hour' ELSE NULL END)
    ON CONFLICT (site_id) DO UPDATE SET enabled=$2, cadence=$3, tier=$4, fallback_free=$5,
      next_run = CASE WHEN $2 AND autoblog.next_run IS NULL THEN now() + interval '1 hour' ELSE autoblog.next_run END`,
    [siteId, !!enabled, cadence, tier, !!fallback_free]);
  res.json({ ok: true });
}));

app.post('/api/autoblog/pause', wrap(async (req, res) => {
  await setSetting('autoblog_paused', !!req.body.paused);
  res.json({ ok: true });
}));

function firstBlogBase(site) {
  const cols = typeof site.collections === 'string' ? JSON.parse(site.collections) : (site.collections || []);
  const blog = cols.find((c) => /blog/i.test(c.name)) || cols[0];
  return blog?.base || null;
}

async function autoblogTick() {
  try {
    if ((await getSetting('autoblog_paused')) === 'true') return;
    const h = new Date().getHours();
    if (h < 8 || h >= 21) return;
    const dailyMax = parseInt(await getSetting('autoblog_daily_max'), 10) || 2;
    const { rows: [today] } = await db.query(
      `SELECT count(*)::int n FROM topic_queue WHERE published_at::date = now()::date`);
    if (today.n >= dailyMax) return;
    if ([...jobs.values()].some((j) => j.autoblog && j.status === 'running')) return;

    const { rows } = await db.query(`
      SELECT a.*, s.* , s.id AS sid FROM autoblog a JOIN astro_sites s ON s.id=a.site_id
      WHERE a.enabled AND a.next_run <= now() ORDER BY a.next_run LIMIT 1`);
    const row = rows[0];
    if (!row) return;
    const site = { id: row.sid, dir: row.dir, name: row.name, site_url: row.site_url, has_deploy: row.has_deploy, collections: row.collections };
    const base = firstBlogBase(site);
    if (!base) {
      await db.query('UPDATE autoblog SET next_run=$1 WHERE site_id=$2', [nextRunAfter(7), site.id]);
      return;
    }
    const { rows: topics } = await db.query(
      `SELECT * FROM topic_queue WHERE site_id=$1 AND status='accepted' ORDER BY created_at LIMIT 1`, [site.id]);
    const topicRow = topics[0];
    if (!topicRow && !row.fallback_free) {
      await sendDigest(`⚠ ${site.name}: pusta kolejka`,
        `Autoblog dla ${site.name} nie ma zaakceptowanych tematów, a wolna ręka jest wyłączona.\nZaakceptuj tematy w https://publish.torweb.pl albo włącz fallback.\nNastępna próba jutro.`);
      await db.query('UPDATE autoblog SET next_run=now() + interval \'1 day\' WHERE site_id=$1', [site.id]);
      return;
    }
    const mode = topicRow ? 'topic' : 'free';
    if (topicRow) await db.query(`UPDATE topic_queue SET status='writing' WHERE id=$1`, [topicRow.id]);
    console.log(`[autoblog] start: ${site.name} (${mode}${topicRow ? ': ' + topicRow.topic : ''})`);

    const job = await launchClaudeJob(site, buildWritePrompt(site, base, mode, topicRow?.topic), {
      label: `Autoblog${mode === 'free' ? ' (wolna ręka)' : ''}`,
      andDeploy: row.tier === 'B' && site.has_deploy,
      onDone: async (j, code) => {
        const created = (j.claudeResult || '').match(/CREATED:\s*(\S+)/)?.[1] || null;
        const slugPath = created ? created.replace(/^src\/content\//, '').replace(/\.(md|mdx)$/, '') : null;
        const url = slugPath && site.site_url ? `${site.site_url}/${slugPath}/` : null;
        if (code === 0) {
          if (topicRow) await db.query(
            `UPDATE topic_queue SET status='published', published_at=now(), file_rel=$1, url=$2 WHERE id=$3`,
            [created, url, topicRow.id]);
          else await db.query(
            `INSERT INTO topic_queue (site_id, topic, zrodlo, status, file_rel, url, published_at)
             VALUES ($1,$2,'wolna-reka','published',$3,$4,now())`,
            [site.id, `(wolna ręka) ${created || '?'}`, created, url]);
          await db.query('UPDATE autoblog SET last_run=now(), next_run=$1 WHERE site_id=$2',
            [nextRunAfter(7 / row.cadence), site.id]);
          await sendDigest(`✍ ${site.name}: nowy artykuł`,
            `Strona: ${site.name}\nTemat: ${topicRow ? topicRow.topic : 'wolna ręka'}\nPlik: ${created || '?'}\nURL: ${url || '?'}\n` +
            `Deploy: ${row.tier === 'B' && site.has_deploy ? 'wykonany automatycznie' : 'NIE (tier A) — zdeployuj z publishera'}\n\nhttps://publish.torweb.pl`);
        } else {
          if (topicRow) await db.query(`UPDATE topic_queue SET status='accepted' WHERE id=$1`, [topicRow.id]);
          await db.query('UPDATE autoblog SET next_run=now() + interval \'1 day\' WHERE site_id=$1', [site.id]);
          await sendDigest(`✗ ${site.name}: autoblog nieudany`,
            `Job padł (exit != 0). Temat wrócił do kolejki, następna próba jutro.\nOstatnie linie logu:\n${j.log.slice(-12).join('\n')}`);
        }
      },
    });
    job.autoblog = true;
  } catch (e) { console.error('autoblogTick:', e.message); }
}
setInterval(autoblogTick, 10 * 60 * 1000);

// tryb "napisz artykuł": temat z góry ALBO wolna ręka; opcjonalny auto-deploy
function buildWritePrompt(site, base, mode, topic) {
  const topicPart = mode === 'free'
    ? `TEMAT: dobierz SAM — masz pełną wolną rękę. Przeanalizuj istniejące artykuły w ${base}, dane GSC/GA4 domeny ${apexOf(site.site_url)} (procedura w globalnym CLAUDE.md), pokrycie biblioteki źródeł (patrz ETAP 1b — tematy głęboko pokryte biblioteką preferuj przy porównywalnym potencjale) oraz zrób web research (WebSearch), i wybierz temat o największym potencjale, który uzupełnia luki strony. W logu uzasadnij wybór jednym akapitem.`
    : `TEMAT artykułu (podany z góry): "${topic}"`;

  return `${aiContext(site, base)}

ZADANIE: napisz JEDEN nowy, długi artykuł blogowy i zapisz go w kolekcji.

ETAP 1 — ANALIZA (obowiązkowa, zanim napiszesz choć zdanie):
- przeczytaj 2-3 istniejące artykuły z ${base}: DOKŁADNY schemat frontmattera (wszystkie pola, format dat, kategorie/tagi w użyciu), styl, typową długość i strukturę nagłówków;
- ${topicPart}

ETAP 1b — RESEARCH DWURAMIENNY (oba ramiona, równolegle — nie wybieraj jednego):
a) BIBLIOTEKA ŹRÓDEŁ (głębia i wiarygodność): załaduj skill "biblioteka" (narzędzie Skill) i sprawdź \`python library.py stats\`, czy istnieje kolekcja pasująca do tematu. Jeśli TAK: wybierz źródła wg workflow skilla (\`library.py clusters\`, \`library.py top --cluster\`, \`search.py "fraza" --collection\` — po polsku z wariantami fleksyjnymi przez "or" i --lang pl, po angielsku osobno), przeczytaj pełne teksty 2-4 najtrafniejszych dokumentów (kolumna text_path) i wyciągnij z nich konkrety: liczby, badania, definicje, spory, cytaty (parafrazuj, cytuj źródło; strony PDF wg document_pages → "s. N"). NIE uruchamiaj żniw (harvest_*) — tylko odczyt istniejącej biblioteki. Jeśli kolekcji pasującej NIE ma — odnotuj to i pomiń to ramię (nie twórz nowej biblioteki).
b) WEB (aktualność): WebSearch — bieżące dane, ceny, daty, zmiany przepisów, trendy. To ramię uzupełnia bibliotekę o świeżość, której statyczne źródła nie mają.
Artykuł ma łączyć oba ramiona: merytoryczny rdzeń ze źródeł bibliotecznych (jeśli są) + aktualia z sieci.

ETAP 2 — PISANIE:
- załaduj skill "tekst-merytoryczny-pl" (narzędzie Skill) i pisz zgodnie z jego regułami — to nadrzędne wytyczne stylu;
- minimum 1500 słów, po polsku, konkretnie, z przykładami i danymi z researchu;
- wpleć naturalnie 2-3 linki wewnętrzne do istniejących artykułów tej strony (ścieżki wg konwencji routingu strony, sprawdź w istniejących plikach jak linkują między sobą);
- frontmatter IDENTYCZNY ze schematem kolekcji (te same pola co istniejące pliki; kategorie/tagi wybierz z już używanych);
- zapisz plik jako ${base}/<slug-z-tytulu>.md (slug: małe litery, bez polskich znaków, myślniki).

${coverStep(site)}NIE uruchamiaj deployu ani gita — deploy zrobi system po Tobie.
Na końcu wypisz dokładnie jedną linię: CREATED: <względna ścieżka pliku>.`;
}

// jeśli strona ma szablon okładek — Claude generuje okładkę po napisaniu tekstu
function coverStep(site) {
  const tplName = site.name.replace(/[\\/]/g, '_') + '.html';
  const tpl = path.join(__dirname, 'covers', tplName);
  if (!fs.existsSync(tpl)) return '';
  return `
ETAP 3 — OKŁADKA (ta strona ma szablon okładek — wygeneruj ją PO zapisaniu artykułu):
- ułóż krótki, chwytliwy tytuł okładkowy (3-7 słów; pełny tytuł artykułu bywa za długi) i podtytuł (1 zdanie);
- ułóż po angielsku prompt na TEMATYCZNE zdjęcie stockowe (professional editorial stock photo, bez tekstu/logo/watermarków) pasujące do artykułu;
- uruchom (Bash): node "${path.join(__dirname, 'covers', 'make-cover.mjs').replace(/\\/g, '/')}" --template "${tpl.replace(/\\/g, '/')}" --title "<tytuł okładkowy>" --subtitle "<podtytuł>" --photo-prompt "<prompt en>" --out "<katalog-projektu>/public/blog/<slug>.jpg"
- dopisz do frontmattera artykułu pola obrazka DOKŁADNIE wg schematu innych plików kolekcji (np. image: "/blog/<slug>.jpg" + imageAlt: "..."; jeśli kolekcja używa innych nazw pól — użyj ich).
`;
}

app.post('/api/ai/write', wrap(async (req, res) => {
  const site = await siteById(req.body.site);
  const { base, mode = 'topic', topic, autodeploy = true } = req.body;
  if (!base) return res.status(400).json({ error: 'brak base' });
  if (mode === 'topic' && !topic) return res.status(400).json({ error: 'brak tematu' });
  const job = await launchClaudeJob(site, buildWritePrompt(site, base, mode, topic), {
    label: mode === 'free' ? 'Artykuł (wolna ręka)' : 'Artykuł (AI)',
    andDeploy: autodeploy && site.has_deploy,
  });
  res.json({ ok: true, job: job.id, autodeploy: autodeploy && site.has_deploy });
}));

app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  await initDb();
  app.listen(PORT, '127.0.0.1', () => console.log(`publisher (astro CMS) na http://127.0.0.1:${PORT}`));
  const n = await runScan();
  console.log(`Skan: ${n} projektów Astro.`);
})();
