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

## AI: lokalny Claude pisze artykuły (Opus 4.8, kontekst 1M)

Pasek AI nad listą artykułów uruchamia **lokalnego Claude'a CLI** w katalogu
projektu (`claude -p --model 'claude-opus-4-8[1m]' --dangerously-skip-permissions`),
z logiem postępu na żywo w GUI. Trzy tryby tematu:

1. **Temat z góry** — wpisujesz temat → „Napisz (AI)".
2. **„Zaproponuj tematy"** — Claude analizuje istniejące artykuły, dane GSC/GA4
   domeny (procedura z globalnego CLAUDE.md) i robi web research → zwraca 5
   propozycji z uzasadnieniem i źródłem (gsc/ga/web/content-gap); klik „Pisz"
   przy wybranej.
3. **„Wolna ręka"** — Claude sam dobiera temat (analiza + GSC/GA + research)
   i pisze bez dalszych pytań.

Każdy artykuł poprzedza obowiązkowa analiza (schemat frontmattera kolekcji,
styl strony, research faktów w sieci), a styl pilnowany jest skillem
`tekst-merytoryczny-pl`. Checkbox **auto-deploy** dokleja `./deploy.sh` po
udanym pisaniu — całość od tematu do publikacji na jeden klik.

## Autoblog (scheduler wbudowany w publishera)

Per strona: włącz/wyłącz, kadencja (2×/tydz → co 2 tyg.), tier
(**B** = auto-deploy po napisaniu, **A** = artykuł czeka na ręczny deploy),
fallback „wolna ręka" przy pustej kolejce. Do tego **kolejka tematów**:
propozycje AI trafiają jako `proposed` → akceptujesz/odrzucasz w GUI
(albo dodajesz własne „➕ Do kolejki") → scheduler pisze po jednym.

Bezpieczniki: globalna pauza, limit dzienny (domyślnie 2 artykuły/dobę
łącznie), okno publikacji 8-21 z losową godziną i jitterem terminu (bez
footprintu „wszystko o północy"), jeden job naraz, nieudany temat wraca
do kolejki z ponowieniem za dobę. Po każdej publikacji **digest mailem
(SES)**: strona, temat, plik, URL, status deployu.

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
