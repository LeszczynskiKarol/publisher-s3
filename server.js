require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const {
  S3Client, GetBucketLocationCommand, ListObjectsV2Command,
  GetObjectCommand, PutObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  CloudFrontClient, ListDistributionsCommand, CreateInvalidationCommand,
} = require('@aws-sdk/client-cloudfront');

const PORT = parseInt(process.env.PORT || '4900', 10);
const PASSWORD = process.env.PUB_PASSWORD;
const SECRET = process.env.PUB_SECRET;
const API_KEY = process.env.PUB_API_KEY;
if (!PASSWORD || !SECRET || !process.env.PG_URL) {
  console.error('Brak PUB_PASSWORD / PUB_SECRET / PG_URL w .env — przerwano start.');
  process.exit(1);
}

const db = new Pool({ connectionString: process.env.PG_URL, max: 5 });
const cf = new CloudFrontClient({ region: 'us-east-1' });

// ── S3 multi-region (jak w s3-manager) ──────────────────────────────────────
const s3Clients = new Map();
const clientFor = (r) => {
  const region = r || 'us-east-1';
  if (!s3Clients.has(region)) s3Clients.set(region, new S3Client({ region }));
  return s3Clients.get(region);
};
const bucketRegions = new Map();
async function s3For(bucket) {
  if (!bucketRegions.has(bucket)) {
    const out = await clientFor('us-east-1').send(new GetBucketLocationCommand({ Bucket: bucket }));
    bucketRegions.set(bucket, out.LocationConstraint || 'us-east-1');
  }
  return clientFor(bucketRegions.get(bucket));
}

async function s3GetText(bucket, key) {
  const s3 = await s3For(bucket);
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return await out.Body.transformToString('utf8');
}

async function s3Put(bucket, key, body, contentType) {
  const s3 = await s3For(bucket);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

// ── schemat ─────────────────────────────────────────────────────────────────
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id serial PRIMARY KEY,
      domain text UNIQUE NOT NULL,       -- np. www.zostancopywriterem.pl
      bucket text NOT NULL,
      blog_prefix text NOT NULL DEFAULT 'blog/',
      sitemap_key text NOT NULL DEFAULT 'sitemap-0.xml',
      template text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS published (
      id serial PRIMARY KEY,
      domain text NOT NULL,
      slug text NOT NULL,
      title text NOT NULL,
      url text NOT NULL,
      steps jsonb NOT NULL DEFAULT '[]',
      ts timestamptz NOT NULL DEFAULT now()
    );
  `);
}

// ── auth: cookie (GUI) albo x-api-key (automatyzacja/Claude) ────────────────
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

// ── Google Indexing API (SA JWT bez zewnętrznych bibliotek) ─────────────────
let saCache = null;
function loadSa() {
  if (!saCache) saCache = JSON.parse(fs.readFileSync(process.env.GOOGLE_SA_KEY, 'utf8'));
  return saCache;
}

async function googleIndexingPing(url) {
  const sa = loadSa();
  const now = Math.floor(Date.now() / 1000);
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/indexing',
    aud: sa.token_uri,
    iat: now, exp: now + 3600,
  })}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(sa.private_key, 'base64url')}`;
  const tokenRes = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const token = (await tokenRes.json()).access_token;
  if (!token) throw new Error('Indexing API: brak tokenu');
  const res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, type: 'URL_UPDATED' }),
  });
  if (!res.ok) throw new Error(`Indexing API: HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
}

// ── CloudFront ──────────────────────────────────────────────────────────────
let cfList = null;
async function cfDistributionsFor(domain) {
  if (!cfList) {
    const out = await cf.send(new ListDistributionsCommand({}));
    cfList = (out.DistributionList?.Items || []).map((d) => ({
      id: d.Id, aliases: d.Aliases?.Items || [],
    }));
  }
  const apex = domain.replace(/^www\./, '');
  return cfList.filter((d) => d.aliases.some((a) => a === domain || a === apex || a === `www.${apex}`));
}

// ── mini markdown → HTML ────────────────────────────────────────────────────
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function mdToHtml(md) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const blocks = md.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map((b) => {
    const t = b.trim();
    if (!t) return '';
    const h = t.match(/^(#{1,4})\s+(.*)$/s);
    if (h) return `<h${h[1].length}>${inline(h[2].trim())}</h${h[1].length}>`;
    if (/^[-*]\s+/m.test(t) && t.split('\n').every((l) => /^[-*]\s+/.test(l.trim()))) {
      return `<ul>${t.split('\n').map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (/^\d+\.\s+/m.test(t) && t.split('\n').every((l) => /^\d+\.\s+/.test(l.trim()))) {
      return `<ol>${t.split('\n').map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
    }
    return `<p>${inline(t).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

const slugify = (s) => s.toLowerCase()
  .replace(/[ąćęłńóśźż]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c]))
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// ── API: konfiguracja stron ─────────────────────────────────────────────────
app.get('/api/sites', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT id, domain, bucket, blog_prefix, sitemap_key, (template IS NOT NULL) AS has_template FROM sites ORDER BY domain');
  res.json({ sites: rows });
}));

app.get('/api/buckets', wrap(async (req, res) => {
  const { ListBucketsCommand } = require('@aws-sdk/client-s3');
  const out = await clientFor('us-east-1').send(new ListBucketsCommand({}));
  res.json({ buckets: (out.Buckets || []).map((b) => b.Name) });
}));

app.post('/api/sites', wrap(async (req, res) => {
  const { domain, bucket, blog_prefix = 'blog/', sitemap_key = 'sitemap-0.xml' } = req.body;
  if (!domain || !bucket) return res.status(400).json({ error: 'brak domain/bucket' });
  await db.query(
    `INSERT INTO sites (domain, bucket, blog_prefix, sitemap_key) VALUES ($1,$2,$3,$4)
     ON CONFLICT (domain) DO UPDATE SET bucket=$2, blog_prefix=$3, sitemap_key=$4`,
    [domain, bucket, blog_prefix, sitemap_key]);
  res.json({ ok: true });
}));

app.delete('/api/sites/:id', wrap(async (req, res) => {
  await db.query('DELETE FROM sites WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

async function siteOf(domain) {
  const { rows } = await db.query('SELECT * FROM sites WHERE domain=$1', [domain]);
  if (!rows[0]) throw Object.assign(new Error('Nieznana strona — dodaj ją najpierw w konfiguracji'), { status: 400 });
  return rows[0];
}

// szablon: istniejący albo propozycja z najnowszego artykułu na blogu
app.get('/api/template', wrap(async (req, res) => {
  const site = await siteOf(req.query.domain);
  if (site.template) return res.json({ template: site.template, source: 'saved' });
  const s3 = await s3For(site.bucket);
  const out = await s3.send(new ListObjectsV2Command({ Bucket: site.bucket, Prefix: site.blog_prefix, MaxKeys: 1000 }));
  const article = (out.Contents || [])
    .filter((o) => o.Key.endsWith('/index.html'))
    .sort((a, b) => b.LastModified - a.LastModified)[0];
  if (!article) return res.json({ template: null, source: 'none' });
  const html = await s3GetText(site.bucket, article.Key);
  res.json({ template: html, source: article.Key });
}));

app.post('/api/template', wrap(async (req, res) => {
  const { domain, template } = req.body;
  await siteOf(domain);
  for (const ph of ['{{TITLE}}', '{{CONTENT}}']) {
    if (!template.includes(ph)) return res.status(400).json({ error: `szablon nie zawiera ${ph}` });
  }
  await db.query('UPDATE sites SET template=$1 WHERE domain=$2', [template, domain]);
  res.json({ ok: true });
}));

// lista opublikowanych artykułów (z bucketa)
app.get('/api/articles', wrap(async (req, res) => {
  const site = await siteOf(req.query.domain);
  const s3 = await s3For(site.bucket);
  const out = await s3.send(new ListObjectsV2Command({ Bucket: site.bucket, Prefix: site.blog_prefix, MaxKeys: 1000 }));
  const articles = (out.Contents || [])
    .filter((o) => o.Key.endsWith('/index.html'))
    .map((o) => ({
      slug: o.Key.slice(site.blog_prefix.length, -('/index.html'.length)),
      modified: o.LastModified,
      sizeKb: Math.round(o.Size / 1024),
      url: `https://${site.domain}/${o.Key.replace(/index\.html$/, '')}`,
    }))
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
  res.json({ articles });
}));

// ── publikacja ──────────────────────────────────────────────────────────────
app.post('/api/publish', wrap(async (req, res) => {
  const { domain, title, description = '', content, format = 'markdown' } = req.body;
  let { slug } = req.body;
  if (!domain || !title || !content) return res.status(400).json({ error: 'brak domain/title/content' });
  const site = await siteOf(domain);
  if (!site.template) return res.status(400).json({ error: 'strona nie ma zapisanego szablonu' });
  slug = slugify(slug || title);
  if (!slug) return res.status(400).json({ error: 'pusty slug' });

  const contentHtml = format === 'html' ? content : mdToHtml(content);
  const url = `https://${site.domain}/${site.blog_prefix}${slug}/`;
  const dateIso = new Date().toISOString().slice(0, 10);
  const html = site.template
    .replaceAll('{{TITLE}}', esc(title))
    .replaceAll('{{DESCRIPTION}}', esc(description))
    .replaceAll('{{CONTENT}}', contentHtml)
    .replaceAll('{{DATE}}', dateIso)
    .replaceAll('{{CANONICAL}}', url)
    .replaceAll('{{SLUG}}', slug);

  const steps = [];
  const step = async (name, fn) => {
    try { const info = await fn(); steps.push({ name, ok: true, info: info || null }); }
    catch (e) { steps.push({ name, ok: false, info: e.message }); }
  };

  await step('upload artykułu', async () => {
    await s3Put(site.bucket, `${site.blog_prefix}${slug}/index.html`, html, 'text/html; charset=utf-8');
    return `${site.bucket}/${site.blog_prefix}${slug}/index.html`;
  });

  await step('aktualizacja sitemap', async () => {
    let xml;
    try { xml = await s3GetText(site.bucket, site.sitemap_key); }
    catch { throw new Error(`brak ${site.sitemap_key} w buckecie`); }
    if (xml.includes(`<loc>${url}</loc>`)) return 'URL już był w sitemap';
    const entry = `<url><loc>${url}</loc><lastmod>${dateIso}</lastmod></url>`;
    if (!xml.includes('</urlset>')) throw new Error('sitemap bez </urlset>');
    xml = xml.replace('</urlset>', `${entry}</urlset>`);
    await s3Put(site.bucket, site.sitemap_key, xml, 'application/xml');
    return 'dodano wpis';
  });

  await step('invalidacja CloudFront', async () => {
    const dists = await cfDistributionsFor(site.domain);
    if (!dists.length) return 'brak dystrybucji (pomijam)';
    for (const d of dists) {
      await cf.send(new CreateInvalidationCommand({
        DistributionId: d.id,
        InvalidationBatch: {
          CallerReference: `pub-${Date.now()}-${d.id}`,
          Paths: { Quantity: 2, Items: [`/${site.blog_prefix}${slug}/*`, `/${site.sitemap_key}`] },
        },
      }));
    }
    return `${dists.length} dystrybucji`;
  });

  await step('Google Indexing API', () => googleIndexingPing(url));

  await db.query('INSERT INTO published (domain, slug, title, url, steps) VALUES ($1,$2,$3,$4,$5)',
    [domain, slug, title, url, JSON.stringify(steps)]);

  res.json({ ok: steps.every((s) => s.ok), url, slug, steps });
}));

app.get('/api/history', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT domain, slug, title, url, steps, ts FROM published ORDER BY ts DESC LIMIT 50');
  res.json({ history: rows });
}));

app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  await initDb();
  app.listen(PORT, '127.0.0.1', () => console.log(`publisher na http://127.0.0.1:${PORT}`));
})();
