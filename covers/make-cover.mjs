// Generator okładek blogowych: FLUX (Replicate) → szablon HTML per strona →
// headless Chrome → JPG. Użycie:
//   node make-cover.mjs --template <plik.html> --title "..." --subtitle "..."
//     --photo-prompt "..." --out <plik.jpg> [--no-photo]
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// prosty parser argumentów
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) args[key] = process.argv[++i];
    else args[key] = true;
  }
}
for (const req of ["template", "title", "out"]) {
  if (!args[req]) { console.error(`brak --${req}`); process.exit(1); }
}

// .env publishera (REPLICATE_API_TOKEN)
const envPath = path.join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function fluxPhoto(prompt) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("brak REPLICATE_API_TOKEN");
  const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
    body: JSON.stringify({
      input: { prompt, aspect_ratio: "3:4", output_format: "webp", output_quality: 90, safety_tolerance: 5 },
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`replicate ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let pred = await res.json();
  const headers = { Authorization: `Bearer ${token}` };
  for (let i = 0; i < 18 && ["starting", "processing"].includes(pred.status); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    pred = await (await fetch(pred.urls.get, { headers })).json();
  }
  if (pred.status !== "succeeded") throw new Error(`flux: ${pred.status} ${pred.error || ""}`);
  const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  return `data:image/webp;base64,${buf.toString("base64")}`;
}

const main = async () => {
  let photo = "";
  const cacheFile = path.join(__dirname, ".last-photo.b64");
  if (args["reuse-photo"] && existsSync(cacheFile)) {
    photo = readFileSync(cacheFile, "utf8");
  } else if (args["photo-prompt"] && !args["no-photo"]) {
    console.log("FLUX: generuję zdjęcie…");
    photo = await fluxPhoto(args["photo-prompt"]);
    writeFileSync(cacheFile, photo, "utf8");
  }
  let html = readFileSync(args.template, "utf8")
    .replaceAll("{{TITLE}}", esc(args.title))
    .replaceAll("{{SUBTITLE}}", esc(args.subtitle || ""))
    .replaceAll("{{PHOTO}}", photo);

  const tmpHtml = path.join(__dirname, `.cover-${Date.now()}.html`);
  const tmpPng = tmpHtml.replace(".html", ".png");
  writeFileSync(tmpHtml, html, "utf8");
  console.log("Chrome: renderuję…");
  execFileSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--window-size=1640,924", `--screenshot=${tmpPng}`,
    "--virtual-time-budget=8000", // czekaj na font + obraz
    `file:///${tmpHtml.replace(/\\/g, "/")}`,
  ], { stdio: "pipe", timeout: 60000 });

  const sharp = (await import("sharp")).default;
  await sharp(tmpPng).jpeg({ quality: 88 }).toFile(args.out);
  unlinkSync(tmpHtml); unlinkSync(tmpPng);
  console.log(`COVER: ${args.out}`);
};

main().catch((e) => { console.error("BŁĄD:", e.message); process.exit(1); });
