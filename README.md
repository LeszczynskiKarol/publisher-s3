# Publisher

Publikator artykułów na statyczne satelity S3 — jeden formularz zamiast ręcznej
roboty. Publicznie (za hasłem) pod **https://publish.torweb.pl**, lokalnie
`http://localhost:4900`.

## Co robi jedna publikacja

1. renderuje artykuł (markdown → HTML albo gotowy HTML) w szablonie strony
2. wgrywa `blog/<slug>/index.html` do bucketa S3 domeny
3. dopisuje URL do sitemap (`sitemap-0.xml` / konfigurowalny klucz)
4. invaliduje dystrybucje CloudFront domeny (www + apex)
5. pinguje Google Indexing API (`URL_UPDATED`) — JWT service account
   podpisywany czystym node `crypto`, bez zewnętrznych bibliotek

Każdy krok raportowany osobno (✓/✗) i zapisywany w historii (Postgres).

## Szablony per domena

Szablon = pełny HTML strony artykułu z placeholderami `{{TITLE}}`,
`{{DESCRIPTION}}`, `{{CONTENT}}`, `{{DATE}}`, `{{CANONICAL}}`, `{{SLUG}}`.
Przy pierwszej konfiguracji GUI podpowiada HTML najnowszego artykułu z bucketa —
wystarczy podmienić treść na placeholdery. Dzięki temu nowe wpisy wyglądają
identycznie jak reszta strony (satelity budowane w Astro).

## API pod automatyzację (autoblogging)

Wszystkie endpointy przyjmują nagłówek `x-api-key` zamiast sesji cookie:

```
POST /api/publish
{ "domain": "www.przyklad.pl", "title": "…", "description": "…",
  "content": "## markdown…", "format": "markdown", "slug": "opcjonalny" }
```

Zaprojektowane pod podpięcie Claude'a jako autobloggera (cron → generacja
treści → POST /api/publish).

## Uruchomienie

```
npm install
cp .env.example .env     # hasła + ścieżka do klucza SA Google
node server.js
```
