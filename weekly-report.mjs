// Tygodniowy raport AI portfela — warstwa INTERPRETACJI nad silnikiem
// rekomendacji seo-panelu (detekcja=heurystyka tam, synteza=AI tutaj).
// Dane: GET /api/ext/report-data (2 okna 7 dni z lagiem GSC). Syntezę pisze
// LOKALNY Claude Code (subskrypcja — 0 zł per raport, wzorzec autobloga).
// Wysyłka: SES (te same env co digest publishera). Archiwum: .reports/.
// Harmonogram: Task Scheduler "seo-weekly-report", poniedziałki 09:00
// (po measureOutcomes 05:00 i gsc_pull 06:00 na VPS panel).
// Ręcznie: node weekly-report.mjs [--dry]  (--dry: bez maila, tylko archiwum)
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, ".env") });

const { SEO_PANEL_URL, SEO_PANEL_KEY, SES_REGION, SES_FROM, ALERT_EMAIL } = process.env;
const DRY = process.argv.includes("--dry");
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

if (!SEO_PANEL_URL || !SEO_PANEL_KEY) {
  console.error("brak SEO_PANEL_URL/SEO_PANEL_KEY w .env");
  process.exit(1);
}

const res = await fetch(`${SEO_PANEL_URL}/api/ext/report-data`, {
  headers: { "x-api-key": SEO_PANEL_KEY },
});
if (!res.ok) {
  console.error(`report-data: HTTP ${res.status}`);
  process.exit(1);
}
const data = await res.json();
console.log(`dane: ${data.domains.length} domen, okno ${data.windows.current}`);

const prompt = `Jesteś analitykiem SEO całego portfela domen Karola. Poniżej JSON z danymi
tygodnia (okno ${data.windows.current}) w porównaniu z poprzednim (${data.windows.previous}):
per domena masz kliknięcia/wyświetlenia GSC, sesje/konwersje GA4, strony
zyskujące i tracące (winners/losers), alerty, eventy (w tym CONTENT_PUBLISHED
z pętli autobloga), nowe rekomendacje silnika (REFRESH/NEW_TOPIC/PRUNE ze
score) i zmierzone werdykty wcześniejszych działań (outcomesMeasured:
IMPROVED/FLAT/WORSE).

Napisz TYGODNIOWY RAPORT po polsku, jako zwykły tekst maila (bez markdown).
Struktura:

TL;DR — 3-5 zdań o całym portfelu (suma zmian, najważniejsze wydarzenie).

CO SIĘ ZMIENIŁO — tylko domeny z istotnym ruchem (zmiana >20% I >20 kliknięć
tygodniowo). Dla każdej: liczby, które strony odpowiadają za zmianę i Twoja
HIPOTEZA dlaczego (wiąż z eventami, alertami, publikacjami). Domeny bez zmian
pomiń całkowicie.

SKUTECZNOŚĆ DZIAŁAŃ — werdykty z outcomesMeasured i świeże publikacje.
Jeśli widzisz wzorzec (np. refreshe działają, a tematy z fraz typu X nie),
nazwij go wprost — to najcenniejsza część raportu.

DO ZROBIENIA W TYM TYGODNIU — max 5 pozycji z recommendationsNew o najwyższym
score, każda w jednym zdaniu z uzasadnieniem liczbowym. Wskaż, które
zaakceptować w Publisherze.

CZERWONE FLAGI — alerty i spadki wymagające reakcji, jeśli są.

Zasady: konkrety i liczby zamiast ogólników; hipotezy oznaczaj jako hipotezy;
maksymalnie ~600 słów; zwróć SAM raport, bez wstępów i komentarzy od siebie.

DANE:
${JSON.stringify(data, null, 1)}`;

const jobsDir = path.join(__dirname, ".jobs");
fs.mkdirSync(jobsDir, { recursive: true });
const promptFile = path.join(jobsDir, "weekly-report-prompt.txt");
fs.writeFileSync(promptFile, prompt, "utf8");
const bashPrompt = "/" + promptFile.replace(/\\/g, "/").replace(":", "");

console.log("Claude pisze raport…");
const t0 = Date.now();
const run = spawnSync(GIT_BASH, ["-lc", `cat "${bashPrompt}" | claude -p`], {
  cwd: __dirname,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  timeout: 15 * 60 * 1000,
});
fs.rmSync(promptFile, { force: true });
if (run.status !== 0 || !run.stdout?.trim()) {
  console.error(`claude padł (exit ${run.status}):`, (run.stderr || "").slice(-2000));
  process.exit(1);
}
const report = run.stdout.trim();
console.log(`raport gotowy w ${Math.round((Date.now() - t0) / 1000)}s (${report.length} znaków)`);

const stamp = new Date().toISOString().slice(0, 10);
const archiveDir = path.join(__dirname, ".reports");
fs.mkdirSync(archiveDir, { recursive: true });
fs.writeFileSync(path.join(archiveDir, `${stamp}.md`), report, "utf8");

if (DRY) {
  console.log("--dry: bez maila. Raport w .reports/" + stamp + ".md");
  process.exit(0);
}

if (!ALERT_EMAIL || !SES_FROM) {
  console.error("brak ALERT_EMAIL/SES_FROM — raport tylko w archiwum");
  process.exit(1);
}
const ses = new SESClient({ region: SES_REGION || "eu-central-1" });
await ses.send(
  new SendEmailCommand({
    Source: SES_FROM,
    Destination: { ToAddresses: [ALERT_EMAIL] },
    Message: {
      Subject: { Data: `[seo] Raport tygodniowy ${stamp}`, Charset: "UTF-8" },
      Body: { Text: { Data: report, Charset: "UTF-8" } },
    },
  }),
);
console.log(`wysłano na ${ALERT_EMAIL}`);
