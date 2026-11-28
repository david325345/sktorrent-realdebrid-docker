// Opravy z nočního reportu 2026-11-27 (v3.10.3): u seriálu s víc názvy nejdřív 1. kolo všech názvů, stránkuje se až
// potom (Čas / Time — „cas“ ⊂ Casino, Castle Rock, Kolo času…); jen limit rychlosti addonu → sktDown:"limit"
process.env.SKT_SEARCH_BUDGET_MS = "8000";
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const h = (i) => i.toString(16).padStart(40, "0");

// ---------- simulované SKT (jako skutečné: hledá jen v názvu, slova jako podřetězce, 24 na stránku) ----------
let DB = [];
let sktCalls = [];
const PER = 24;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host !== "sktorrent.eu") throw new Error("Nemockovaná URL: " + cfg.url);
  sktCalls.push(params.search + (+params.page ? ` p${params.page}` : ""));
  const words = norm(String(params.search)).split(" ").filter(w => w.length >= 2);
  const hits = DB.filter(([, n]) => words.every(w => norm(n).includes(w)));
  const page = +(params.page || 0);
  const slice = hits.slice(page * PER, page * PER + PER);
  const pag = Array.from({ length: Math.ceil(hits.length / PER) }, (_, i) => `<a href="torrents_v2.php?search=x&page=${i}">${i + 1}</a>`).join("");
  return ok(`<table>${slice.map(([hh, n, c]) => `<tr><td><b>${c}</b><a href="details.php?id=${hh}" title="Stiahni si ${c} ${n} = CSFD 75%"><img src="p.jpg"></a> Velkost 1 GB | Odosielaju : 3</td></tr>`).join("")}</table>${pag}`);
};

const skt = require(P + "/lib/skt");
const { findTorrents } = require(P + "/lib/search");
const reset = () => { skt._resetBreaker(); sktCalls = []; };
const isPage = (q) => / p\d$/.test(q);

// Cizí tituly: „cas“ ⊂ Casino / Castle / Kolo času, „time“ ⊂ Timeless — holé názvy i varianty mají plné stránky
const noise = [
  ...Array.from({ length: 30 }, (_, i) => [h(100 + i), `Casino Royale ${i} (2006)(CZ)[1080p]`, "Filmy CZ/SK dabing"]),
  ...Array.from({ length: 30 }, (_, i) => [h(200 + i), `Castle Rock ${i} S01E0${(i % 9) + 2} (CZ)`, "Seriál"]),
  ...Array.from({ length: 30 }, (_, i) => [h(300 + i), `Kolo času ${i} - ${(i % 3) + 1}. serie (CZ)`, "Seriál"]),
  ...Array.from({ length: 30 }, (_, i) => [h(400 + i), `Timeless ${i} S01E0${(i % 9) + 2} (CZ)`, "Seriál"]),
  ...Array.from({ length: 30 }, (_, i) => [h(500 + i), `Timeless ${i} - ${(i % 2) + 1}. serie (CZ)`, "Seriál"])];
const TIME = { en: "Time", cz: "Čas", sk: "Time", year: "2021", seasonYears: { 1: "2021", 2: "2023" } };

(async () => {
  // ================= 1: titul na SKT není — 1. kolo „Time“ dřív než stránky „Čas“ =================
  DB = noise;
  reset();
  let f = await findTorrents({ type: "series", season: 1, episode: 1, titles: TIME });
  const firstPage = sktCalls.findIndex(isPage);
  const lastTimeR1 = Math.max(...["Time", "Time S01E01", "Time S01", "Time seri"].map(q => sktCalls.indexOf(q)));
  eq("1. kolo „Čas“ i „Time“ před první další stránkou", [firstPage > 0, lastTimeR1 >= 0, lastTimeR1 < firstPage], [true, true, true]);
  eq("bez titulu: stránkují se oba názvy jako dřív, nic nenalezeno, bez chyby", [sktCalls.some(q => q.startsWith("Čas") && isPage(q)), sktCalls.some(q => q.startsWith("Time") && isPage(q)), f.torrents.length + f.batchTorrents.length, !!f.sktDown], [true, true, 0, false]);

  // ================= 2: náš titul v 1. kole „Time“ → stránky „Čas“ se nečtou =================
  DB = [[h(1), "Time - 1. serie (2021)(EN)[1080p]", "Seriál"], ...noise];     // jen anglický název, „Čas“ v něm není
  reset();
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: TIME });
  eq("titul pod 2. názvem v 1. kole: balík nalezen, stránky obecného „Čas“ se nečtou",
    [f.batchTorrents.map(t => t.hash), sktCalls.some(q => q.startsWith("Čas") && isPage(q))], [[h(1)], false]);

  // ================= 3: titul v 1. kole „Time“ (jiná sezóna), náš balík až na 2. stránce „Čas seri“ → najde se =================
  DB = [[h(2), "Time S02E01 (2023)(EN)[1080p]", "Seriál"], ...noise, [h(3), "Čas / Time - 1. serie (2021)(CZ)[TvRip]", "Seriál"]];
  reset();
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: TIME });
  eq("titul pod 2. názvem bez našeho dílu: dočtou se i stránky odloženého 1. názvu a balík se najde", f.batchTorrents.map(t => t.hash), [h(3)]);

  // ================= 4: jen limit rychlosti addonu → sktDown:"limit" =================
  DB = noise;
  reset();
  const RL = skt._rate(); for (let i = 0; i < RL.perMin; i++) RL.log.push(Date.now());
  f = await findTorrents({ type: "series", season: 1, episode: 2, titles: TIME });
  eq("plné okno limitu: sktDown „limit“ (ne výpadek SKT), bez dotazu na SKT", [f.sktDown, sktCalls.length, f.audit.queries.every(q => q.err === "limit addonu")], ["limit", 0, true]);
  reset();
  skt._breaker().openUntil = Date.now() + 30000;
  f = await findTorrents({ type: "series", season: 1, episode: 3, titles: TIME });
  eq("jistič (výpadek SKT): sktDown true jako dřív", f.sktDown, true);
  reset();

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
