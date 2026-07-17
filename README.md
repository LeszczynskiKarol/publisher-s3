# Publisher — content manager frontów Astro

CMS nad źródłami wszystkich stron Astro (satelity + fronty aplikacji) — zamiast
edycji plików ręcznie w edytorze i deployów z terminala. Publicznie (za hasłem)
pod **https://publish.torweb.pl**, lokalnie `http://localhost:4900`.

## Jak działa

**Auto-discovery**: skan dysku (`D:\*/astro.config.*` i `D:\*/frontend/astro.config.*`)
znajduje wszystkie projekty Astro; z każdego czyta `site:` (domena), remote origin
(GitHub), obecność `deploy.sh` i kolekcje treści (`src/content/*` + markdown
w `src/pages`). Przycisk „Skanuj" wykrywa nowe projekty automatycznie —
dodanie kolejnej strony do CMS-a = po prostu położenie jej na dysku.

**Content**: lista plików `.md/.mdx` per kolekcja (tytuł/data/draft z frontmattera),
edycja surowego pliku (frontmatter + treść) z Ctrl+S, usuwanie, tworzenie nowych —
frontmatter nowego artykułu jest **dziedziczony z najnowszego pliku kolekcji**
(każda strona ma swój schemat: description vs excerpt/metaTitle itd.), więc wpis
od razu pasuje do danej strony. Przed każdym zapisem/usunięciem poprzednia wersja
ląduje w `.backups/` (plus historia git projektu).

**Deploy**: przycisk uruchamia `./deploy.sh` projektu (build → `aws s3 sync` →
invalidacja CloudFront) przez git-basha, z logiem na żywo w GUI. Projekty bez
`deploy.sh` dostają fallback `npm run build` (z ostrzeżeniem).

## API pod automatyzację (autoblogging)

Nagłówek `x-api-key` zamiast sesji. Przyszły autoblogger (cron + Claude):

```
POST /api/new    { site, base, title, description, slug?, content? }
POST /api/file   { site, rel, content }          # pełna treść artykułu
POST /api/deploy { site }                        # → job id
GET  /api/job/:id                                # status + log
```

## Uruchomienie

```
npm install
cp .env.example .env
node server.js       # przy starcie robi pełny skan dysku
```

Stan (lista projektów) w Postgres `publisher`.
