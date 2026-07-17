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
  return { title: get('title'), description: get('description'), pubDate: get('pubDate') || get('date'), draft: get('draft') };
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
        files.push({
          rel: `${base}/${rel ? rel + '/' : ''}${e.name}`.replace(/\\/g, '/'),
          name: e.name,
          title: fm.title,
          pubDate: fm.pubDate,
          draft: fm.draft === 'true',
          sizeKb: Math.round(st.size / 1024),
          mtime: st.mtime,
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
          .replace(/^(pubDate|date):.*$/gm, `$1: ${new Date().toISOString().slice(0, 10)}`)
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

Wykonaj analizę (wszystkie trzy źródła):
1. Przeczytaj tytuły i tematykę istniejących artykułów w ${base} — nowe tematy nie mogą ich dublować, mają uzupełniać luki.
2. Pobierz dane Google Search Console i GA4 dla domeny ${apexOf(site.site_url)} zgodnie z procedurą z Twojego globalnego CLAUDE.md (sekcja "Google Analytics (GA4) & Search Console"). Szukaj zapytań z wyświetleniami, na które strona nie ma dedykowanego artykułu, oraz artykułów z potencjałem na temat pokrewny.
3. Zrób research w sieci (WebSearch): czego aktualnie szukają ludzie w tej tematyce, jakie tematy pokrywa konkurencja, czego brakuje.

WYNIK: wypisz WYŁĄCZNIE czysty JSON (bez markdown, bez komentarzy):
[{"temat":"...","uzasadnienie":"1-2 zdania dlaczego ten temat","zrodlo":"gsc|ga|web|content-gap"}]
Dokładnie 5 pozycji, tematy po polsku.`;
  const job = await launchClaudeJob(site, prompt, {
    label: 'Propozycje tematów',
    onDone: (j, code) => {
      if (code !== 0) return;
      try {
        const m = (j.claudeResult || '').match(/\[[\s\S]*\]/);
        j.result = { proposals: JSON.parse(m[0]) };
      } catch { j.result = { error: 'nie udało się sparsować propozycji', raw: (j.claudeResult || '').slice(0, 2000) }; }
    },
  });
  res.json({ ok: true, job: job.id });
}));

// tryb "napisz artykuł": temat z góry ALBO wolna ręka; opcjonalny auto-deploy
app.post('/api/ai/write', wrap(async (req, res) => {
  const site = await siteById(req.body.site);
  const { base, mode = 'topic', topic, autodeploy = true } = req.body;
  if (!base) return res.status(400).json({ error: 'brak base' });
  if (mode === 'topic' && !topic) return res.status(400).json({ error: 'brak tematu' });

  const topicPart = mode === 'free'
    ? `TEMAT: dobierz SAM — masz pełną wolną rękę. Przeanalizuj istniejące artykuły w ${base}, dane GSC/GA4 domeny ${apexOf(site.site_url)} (procedura w globalnym CLAUDE.md) oraz zrób web research (WebSearch), i wybierz temat o największym potencjale, który uzupełnia luki strony. W logu uzasadnij wybór jednym akapitem.`
    : `TEMAT artykułu (podany z góry): "${topic}"`;

  const prompt = `${aiContext(site, base)}

ZADANIE: napisz JEDEN nowy, długi artykuł blogowy i zapisz go w kolekcji.

ETAP 1 — ANALIZA (obowiązkowa, zanim napiszesz choć zdanie):
- przeczytaj 2-3 istniejące artykuły z ${base}: DOKŁADNY schemat frontmattera (wszystkie pola, format dat, kategorie/tagi w użyciu), styl, typową długość i strukturę nagłówków;
- ${topicPart}
- zrób rzetelny research (WebSearch): aktualne dane, liczby, fakty — artykuł ma być merytoryczny, nie lany.

ETAP 2 — PISANIE:
- załaduj skill "tekst-merytoryczny-pl" (narzędzie Skill) i pisz zgodnie z jego regułami — to nadrzędne wytyczne stylu;
- minimum 1500 słów, po polsku, konkretnie, z przykładami i danymi z researchu;
- frontmatter IDENTYCZNY ze schematem kolekcji (te same pola co istniejące pliki; kategorie/tagi wybierz z już używanych);
- zapisz plik jako ${base}/<slug-z-tytulu>.md (slug: małe litery, bez polskich znaków, myślniki).

NIE uruchamiaj deployu ani gita — deploy zrobi system po Tobie.
Na końcu wypisz dokładnie jedną linię: CREATED: <względna ścieżka pliku>.`;

  const job = await launchClaudeJob(site, prompt, {
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
