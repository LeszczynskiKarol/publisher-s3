#!/usr/bin/env node
// Źródła do artykułu z cytado — ZAMIAST lokalnej biblioteki `copy-library`.
//
// PO CO OSOBNY SKRYPT, skoro to jedno wywołanie HTTP. Bo pisarzem jest lokalny
// Claude uruchamiany z promptem zapisanym do pliku w JOBS_DIR. Gdyby klucz API
// stał w treści promptu, leżałby jawnym tekstem na dysku przy każdym zadaniu
// i w każdej kopii zapasowej. Tak klucz zostaje w `.env`, a prompt zawiera
// tylko polecenie „uruchom ten skrypt".
//
// DLACZEGO CYTADO ZAMIAST library.py: lokalna biblioteka była pierwowzorem,
// z którego cytado wyrosło. Utrzymywanie obu znaczy dwa korpusy, dwa zestawy
// reguł licencyjnych i dwa miejsca, w których trzeba naprawiać ten sam błąd.
// Cytado dokłada do tego numery DRUKOWANYCH stron i sprawdzalne pochodzenie,
// więc artykuł może powołać się na „s. N", a nie na „gdzieś w tym pliku".
//
// Użycie:
//   node cytado.mjs pokrycie "temat"     → ile korpus ma na ten temat (JSON)
//   node cytado.mjs zrodla   "temat"     → materiał do pisania (JSON)
//
// Kody wyjścia: 0 = OK, 2 = brak konfiguracji, 3 = błąd API.
// Pusty wynik NIE jest błędem — brak źródeł to legalna odpowiedź i pisarz ma
// się o niej dowiedzieć wprost, zamiast dostać ciszę.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KATALOG = path.dirname(fileURLToPath(import.meta.url));

function konfiguracja() {
  const plik = path.join(KATALOG, ".env");
  if (!fs.existsSync(plik)) return {};
  const wynik = {};
  for (const linia of fs.readFileSync(plik, "utf8").split(/\r?\n/)) {
    const m = linia.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) wynik[m[1]] = m[2].trim();
  }
  return wynik;
}

const cfg = konfiguracja();
const KLUCZ = cfg.CYTADO_KEY || process.env.CYTADO_KEY;
const BAZA = cfg.CYTADO_URL || process.env.CYTADO_URL || "https://cytado.com/api/ext";

if (!KLUCZ) {
  console.error("Brak CYTADO_KEY w D:/publisher/.env — bez niego nie ma źródeł.");
  process.exit(2);
}

async function wolaj(sciezka, cialo, timeoutMs = 600000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BAZA}${sciezka}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KLUCZ}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cialo),
      signal: ctrl.signal,
    });
    const tekst = await r.text();
    if (!r.ok) {
      // TREŚĆ BŁĘDU, NIE SAM KOD. „402" nie mówi pisarzowi nic; „przekroczony
      // limit pakietu" mówi wszystko i pozwala mu napisać artykuł bez źródeł,
      // zamiast wywalić całe zadanie.
      throw new Error(`${r.status}: ${tekst.slice(0, 300)}`);
    }
    return JSON.parse(tekst);
  } finally {
    clearTimeout(t);
  }
}

const [tryb, ...reszta] = process.argv.slice(2);
const temat = reszta.join(" ").trim();

if (!tryb || !temat) {
  console.error('Użycie: node cytado.mjs <pokrycie|zrodla> "temat artykułu"');
  process.exit(2);
}

try {
  if (tryb === "pokrycie") {
    // Do etapu PROPONOWANIA tematów. `coverageWprost` to liczba dokumentów
    // faktycznie O TYM temacie — `coverage` obejmuje też materiał pokrewny,
    // więc sam w sobie potrafi wyglądać na pokrycie tam, gdzie go nie ma.
    const r = await wolaj("/chapter-sources", {
      topic: temat,
      chapter: "Artykuł blogowy",
      langs: ["pl", "en"],
      limit: 12,
    });
    const zrodla = Array.isArray(r.sources) ? r.sources : [];
    console.log(
      JSON.stringify(
        {
          temat,
          pokrycie: r.coverage ?? 0,
          pokrycie_wprost: r.coverageWprost ?? 0,
          dostepnych_zrodel: zrodla.length,
          z_paginacja: zrodla.filter((s) => s.paginated).length,
          werdykt:
            (r.coverageWprost ?? 0) >= 3
              ? "dobre-pokrycie"
              : (r.coverageWprost ?? 0) >= 1
                ? "slabe-pokrycie"
                : "brak-pokrycia",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (tryb === "zrodla") {
    const r = await wolaj("/chapter-sources", {
      topic: temat,
      chapter: "Artykuł blogowy",
      langs: ["pl", "en"],
      limit: 10,
    });
    const zrodla = (Array.isArray(r.sources) ? r.sources : []).map((s) => ({
      tytul: s.title,
      autorzy: s.authors,
      rok: s.year,
      url: s.url,
      // `paginated` mówi, czy w tekście są kotwice stron. Bez tego pisarz
      // wieszałby „s. N" na źródle, które numerów stron nie ma wcale.
      ma_numery_stron: Boolean(s.paginated),
      // „wprost" vs „tlo" — czy praca jest O TYM temacie, czy tylko pokrewna.
      trafnosc: s.tier,
      tekst: s.text,
    }));
    console.log(
      JSON.stringify(
        {
          temat,
          pokrycie: r.coverage ?? 0,
          pokrycie_wprost: r.coverageWprost ?? 0,
          rozliczenie: r.billing ?? null,   // cytado zangielszczylo pole 05.08.2026
          zrodel: zrodla.length,
          zrodla,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  console.error(`Nieznany tryb: ${tryb}`);
  process.exit(2);
} catch (e) {
  console.error(`cytado: ${e.message}`);
  process.exit(3);
}
