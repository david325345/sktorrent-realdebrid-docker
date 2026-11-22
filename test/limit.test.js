// Limit rychlosti požadavků na SKT (v3.9.4, report 2026-11-21): klouzavé okno, rezerva pro hlavní dotazy,
// poloviční limit po pauze 429, přeskočený dotaz se nepočítá jako chyba SKT
process.env.SKT_RATE_PER_MIN = "6";          // v testu malé okno (výchozí 15)
process.env.SKT_RATE_WAIT_MS = "300";        // a krátké čekání (výchozí 3 s)
process.env.SKT_SEARCH_BUDGET_MS = "8000";
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const h = (i) => i.toString(16).padStart(40, "0");

let mode = "ok", calls = 0;
const httpErr = (status, headers = {}) => { const e = new Error(`Request failed with status code ${status}`); e.response = { status, headers, data: "" }; return e; };
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x");
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host !== "sktorrent.eu") throw new Error("Nemockovaná URL: " + cfg.url);
  calls++;
  if (mode === "429") throw httpErr(429, { "retry-after": "1" });
  if (url.pathname.endsWith("/details.php")) return ok(`<html>${(cfg.params || {}).id}</html>`);
  return ok("<table></table>");
};

const skt = require(P + "/lib/skt");
const { findTorrents } = require(P + "/lib/search");
const q = (s, low) => skt.searchSKTPage(s, "", "", 0, { low });

(async () => {
  eq("limit z SKT_RATE_PER_MIN", skt._rate().perMin, 6);

  // ================= okno: 6 projde, 7. počká a přeskočí se =================
  skt._resetBreaker(); calls = 0;
  for (let i = 1; i <= 6; i++) await q(`A${i}`);
  const t0 = Date.now();
  let r = await q("A7");
  eq("7. požadavek v okně: „limit addonu“, bez dotazu na SKT; místo se do 300 ms neuvolní → bez čekání", [r.err, r.skipped, calls, Date.now() - t0 < 100], ["limit addonu", true, 6, true]);
  // Místo se uvolní do čekací doby → počká a projde (nejstarší záznam okna posunutý o 60 s − 150 ms)
  skt._rate().log[0] = Date.now() - 60000 + 150;
  const t1 = Date.now(); r = await q("A8");
  eq("místo do 300 ms → počká (~150 ms) a projde", [r.err, calls, r.rl >= 100 && Date.now() - t1 < 400], [undefined, 7, true]);
  eq("z paměti dál odpovídá i při plném okně", (await q("A1")).cached, true);

  // ================= rezerva: méně důležité požadavky nechávají 3 místa hlavním =================
  skt._resetBreaker(); calls = 0;
  for (let i = 1; i <= 3; i++) await q(`B${i}`);
  r = await q("B4", true);
  const d = await skt.getTorrentCsfd(h(1), "", "");
  eq("při 3/6 v okně: méně důležitý dotaz i detail přeskočen", [r.err, d, calls], ["limit addonu", undefined, 3]);
  r = await q("B5");
  eq("hlavní dotaz rezervu použije", [r.err, calls], [undefined, 4]);

  // ================= po pauze 429 prvních 60 s poloviční limit =================
  skt._resetBreaker(); calls = 0; mode = "429";
  r = await q("C1");
  eq("429: pauza 1 s", [r.err, r.pause], ["http 429", 1]);
  await sleep(1100); mode = "ok";
  eq("po pauze poloviční limit (3)", skt._rate().cap, 3);
  const rs = [];
  for (const s of ["C2", "C3", "C4"]) rs.push((await q(s)).err || "ok");
  eq("po pauze: 2 projdou (okno 3 včetně dotazu s 429), třetí ne", rs, ["ok", "ok", "limit addonu"]);

  // ================= hledání: přeskočené dotazy nejsou chyba SKT =================
  skt._resetBreaker(); calls = 0;
  for (let i = 1; i <= 6; i++) await q(`D${i}`);
  const f = await findTorrents({ type: "series", season: 1, episode: 1, titles: { en: "Alpha Show", cz: "Alfa seriál", sk: "Alfa šou", year: "2024" } });
  eq("plné okno: všechny názvy se zkusí (přeskok se do 2 chyb nepočítá), archiv „limit addonu“ + skip, bez dotazu",
    [f.audit.queries.map(x => [x.err, !!x.skip]), calls, !!f.sktDown], [[["limit addonu", true], ["limit addonu", true], ["limit addonu", true]], 6, true]);

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
