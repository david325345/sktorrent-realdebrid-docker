// Opravy z nočního reportu 2026-11-25 (v3.10.2): další stránky holého názvu a „seri“ se nečtou, když 1. kolo nemá
// nic z našeho titulu a varianty S01E07 / S01 / seri jsou úplné (Crusade). Platí pro všechny sezóny a nahrazuje
// pravidlo „nová sezóna = jen 1. stránka“, které ztratilo balík z 2. stránky „Lov seri“ (Lov / The Hunt, 2026).
process.env.SKT_SEARCH_BUDGET_MS = "8000";
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const h = (i) => i.toString(16).padStart(40, "0");

// ---------- simulované SKT (jako skutečné: „Stiahni si <kategorie> … = CSFD NN%“, hledá jen v názvu, 24 na stránku) ----------
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
const pages = () => sktCalls.filter(q => / p\d$/.test(q));

(async () => {
  // ================= Crusade (2022): cizí tituly na všech stránkách, varianty úplné =================
  const films = ["Indiana Jones a Poslední křížová výprava / Indiana Jones and the Last Crusade (1989)", "Draci templari / Dragon Crusaders (2011)(CZ)", "Crusade in Jeans (2006)", "The Crusades (2005) dokument"];
  DB = [...Array.from({ length: 52 }, (_, i) => [h(100 + i), `${films[i % 4]} verze ${i} [${720 + i}p]`, i % 4 === 3 ? "Dokument" : "Filmy CZ/SK dabing"]),
        [h(1), "Batman: Rytíř v plášti / Batman: Caped Crusader S01 (EN)[WEB-DL][1080p]", "Seriál"],
        [h(2), "JoJo's Bizarre Adventure - Stardust Crusaders (S01+02)(2015)(JP+CZtit)", "Seriál"]];
  const CR = { en: "Crusade", cz: "Krucjata", sk: "", year: "2022", seasonYears: { 1: "2022" } };
  reset();
  let f = await findTorrents({ type: "series", season: 1, episode: 7, titles: CR });
  eq("Crusade S01E07: 5 dotazů (Krucjata, Crusade + 3 varianty), další stránky holého názvu ne",
    [sktCalls.length, pages(), f.torrents.length + f.batchTorrents.length], [5, [], 0]);

  // ================= Lov / The Hunt (2026): balík až na 2. stránce „Lov seri“, varianty plné =================
  DB = [...Array.from({ length: 30 }, (_, i) => [h(300 + i), `Love Island ${i} - ${(i % 9) + 1}. serie (CZ)`, "Seriál"]),
        ...Array.from({ length: 30 }, (_, i) => [h(400 + i), `Lovecraft Country ${i} S01E01 (CZ)`, "Seriál"]),
        // „The Hunt“ je stejně obecné (The Hunter, The Hunters) — balík zapadne i pod druhým názvem
        ...Array.from({ length: 30 }, (_, i) => [h(600 + i), `The Hunter ${i} - ${(i % 9) + 1}. serie (CZ)`, "Seriál"]),
        ...Array.from({ length: 30 }, (_, i) => [h(700 + i), `The Hunters ${i} S01E01 (CZ)`, "Seriál"]),
        [h(3), "Lov / The Hunt / Traqués 1. serie (EN/FR)[1080p][WEB-DL][HEVC]", "Seriál"]];
  const LOV = { en: "The Hunt", cz: "Lov", sk: "", year: "2026", seasonYears: { 1: "2026" } };
  reset();
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: LOV });
  eq("Lov S01E01 (nová sezóna): varianty plné → čte se dál a balík 1. série se najde",
    [f.batchTorrents.map(t => t.hash), pages().length > 0], [[h(3)], true]);

  // ================= náš titul v 1. kole → stránkuje se jako dřív =================
  DB = [...Array.from({ length: 30 }, (_, i) => [h(500 + i), `Crusade S01E0${(i % 9) + 1} verze ${i} (CZ)`, "Seriál"]), ...DB.slice(0, 10)];
  reset();
  f = await findTorrents({ type: "series", season: 1, episode: 7, titles: { ...CR, cz: "" } });
  eq("náš titul na 1. stránce: díly nalezené, další stránky se čtou", [f.torrents.length > 0, pages().length > 0], [true, true]);

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
