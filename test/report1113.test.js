// Opravy z nočních reportů 2026-11-09 až 2026-11-13 (v3.9.0): jistič po pauze (čekání na zkušební dotaz,
// pokračování dalšími názvy), nový seriál bez zbytečného stránkování, ČSFD název a záchrana přes ČSFD odkaz
// v detailu i pro IMDb tituly (Melania Rea)
process.env.SKT_SEARCH_BUDGET_MS = "8000";
process.env.SKT_HARD_LIMIT_MS = "1500";
process.env.CSFD_URL = "http://csfd:7020";
process.env.CSFD_PUBLIC_URL = "";
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const h = (i) => i.toString(16).padStart(40, "0");
const YEAR = new Date().getFullYear();

// ---------- simulované API ----------
const calls = [];
let sktMode = "ok";           // ok | timeout
let LAT = 0;
let DB = [];                  // [hash, název, kategorie, ČSFD z detailu]
let csfdDelay = 0;
const RATING = { tt45114341: { found: true, csfdId: 1500000, title: "Melania Rea: Případ, který otřásl Itálií", year: 2026, type: "series" },
                 tt0203259: { found: true, csfdId: 70000, title: "Zákon a pořádek: Útvar pro zvláštní oběti", year: 1999, type: "series" } };
const PER = 24;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const p = url.pathname; const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  calls.push(`${url.host}${p}${params.search ? " " + params.search + (params.page ? " p" + params.page : "") : ""}${params.id ? " " + params.id : ""}`);
  const ok = (data, status = 200) => ({ data, status, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host === "csfd:7020") {
    if (csfdDelay) await sleep(csfdDelay);
    const m = p.match(/^\/rating\/(tt\d+)$/);
    const r = m && RATING[m[1]];
    return r ? ok({ imdbId: m[1], ...r }) : ok({ imdbId: m && m[1], found: false }, 404);
  }
  if (url.host === "sktorrent.eu" && p.endsWith("/details.php")) {
    const row = DB.find(r => r[0] === params.id);
    return ok(row ? `<html><a href="download.php?id=${row[0]}">x</a>${row[3] ? `<a href="https://www.csfd.cz/film/${row[3]}-x/prehled/">ČSFD</a>` : ""}</html>` : "<html></html>");
  }
  if (url.host === "sktorrent.eu") {
    if (sktMode === "timeout") { await sleep(10); throw Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" }); }
    if (LAT) await sleep(LAT);
    const words = norm(String(params.search)).split(" ");
    const hits = DB.filter(([, n]) => words.every(w => norm(n).includes(w)));
    const page = +(params.page || 0);
    const slice = hits.slice(page * PER, page * PER + PER);
    const pages = Math.ceil(hits.length / PER);
    const pag = Array.from({ length: pages }, (_, i) => `<a href="torrents_v2.php?search=x&page=${i}">${i + 1}</a>`).join("");
    return ok(`<table>${slice.map(([hh, n, c]) => `<tr><td><b>${c}</b><a href="details.php?id=${hh}" title="${n}"><img src="p.jpg"></a> Velkost 1 GB | Odosielaju : 3</td></tr>`).join("")}</table>${pag}`);
  }
  if (url.host === "api.themoviedb.org") {
    if (p.includes("/find/")) return ok({ movie_results: [], tv_results: [{ id: 45, name: "Melania Rea", first_air_date: "2026-10-01" }] });
    return ok({ name: "Melania Rea", seasons: [{ season_number: 1, air_date: "2026-10-01" }] });
  }
  if (url.host === "api.torbox.app") {
    if (p.endsWith("/checkcached")) return ok({ success: true, data: {} });
    if (p.endsWith("/mylist") || p.endsWith("/getqueued")) return ok({ success: true, data: [] });
  }
  throw new Error("Nemockovaná URL: " + cfg.url);
};
const skCalls = () => calls.filter(c => c.startsWith("sktorrent.eu/torrent/torrents_v2.php")).map(c => c.replace("sktorrent.eu/torrent/torrents_v2.php ", ""));

const skt = require(P + "/lib/skt");
const { findTorrents } = require(P + "/lib/search");
const { getCsfdForImdb } = require(P + "/lib/csfd");
const { makeJudge } = require(P + "/tools/replay");

(async () => {
  // ================= 1: jistič po pauze =================
  const SVU = { en: "Law & Order: Special Victims Unit", cz: "Zákon a pořádek: Útvar pro zvláštní oběti", sk: "", year: "1999", seasonYears: { 1: "1999" } };
  DB = [[h(1), "Law & Order: Special Victims Unit S01 (1999)(EN)[1080p]", "Seriál"]];
  // Otevřít jistič: SKT nejede
  skt._resetBreaker(); sktMode = "timeout";
  await findTorrents({ type: "series", season: 1, episode: 1, titles: SVU });
  eq("po timeoutech je jistič otevřený", skt.breakerOpen(), true);
  // Pauza vyprší, SKT zase jede
  skt._breaker().openUntil = Date.now() - 1; sktMode = "ok"; LAT = 150; calls.length = 0;
  let f = await findTorrents({ type: "series", season: 1, episode: 1, titles: SVU });
  const errs = f.audit.queries.filter(q => q.err).length;
  eq("po pauze: všechny souběžné dotazy dostanou výsledek (žádný „jistič“)", errs, 0);
  eq("po pauze: proběhne i kolo s EN názvem a najde balík", [skCalls().some(q => /^Law Order Special Victims Unit/.test(q)), f.batchTorrents.map(t => t.hash)], [true, [h(1)]]);
  eq("jistič zavřený", [skt.breakerOpen(), skt._breaker().openUntil], [false, 0]);
  // Zkušební dotaz selže → čekající dotazy chyba, jistič zase otevřený
  sktMode = "timeout"; skt._resetBreaker();
  await findTorrents({ type: "series", season: 1, episode: 2, titles: SVU });
  skt._breaker().openUntil = Date.now() - 1;
  f = await findTorrents({ type: "series", season: 1, episode: 3, titles: SVU });
  eq("zkušební dotaz selže: ostatní „jistič“, jistič znovu otevřený", [f.sktDown, f.audit.queries.filter(q => q.err === "jistič").length >= 3, skt.breakerOpen()], [true, true, true]);
  skt._resetBreaker(); sktMode = "ok"; LAT = 0;

  // ================= 2: nová sezóna — holý název a „seri“ jen 1. stránka =================
  const foreign = Array.from({ length: 60 }, (_, i) => [h(100 + i), `Special Ops ${i} S0${(i % 5) + 1} (2025)`, "Seriál"]);
  DB = foreign;
  calls.length = 0;
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: { en: "CIA", cz: "CIA", sk: "", year: String(YEAR), seasonYears: { 1: String(YEAR) } } });
  eq("nový seriál bez našeho titulu na 1. stránce: jen 1. stránky", skCalls().filter(q => / p\d/.test(q)), []);
  calls.length = 0;
  f = await findTorrents({ type: "series", season: 3, episode: 1, titles: { en: "CIA", cz: "CIA", sk: "", year: "2015", seasonYears: { 1: "2015", 2: "2016", 3: "2017" } } });
  eq("stará sezóna: stránkuje se jako dřív", skCalls().filter(q => / p\d/.test(q)).length > 0, true);
  DB = [...Array.from({ length: 30 }, (_, i) => [h(200 + i), `CIA S01E0${(i % 9) + 1} verze ${i} (CZ)`, "Seriál"]), ...foreign];
  skt._resetBreaker(); calls.length = 0;
  f = await findTorrents({ type: "series", season: 1, episode: 5, titles: { en: "CIA", cz: "CIA", sk: "", year: String(YEAR), seasonYears: { 1: String(YEAR) } } });
  eq("nový seriál s naším titulem na 1. stránce: stránkuje dál", skCalls().filter(q => / p\d/.test(q)).length > 0, true);

  // ================= 3: ČSFD název a záchrana pro IMDb tituly =================
  eq("getCsfdForImdb: ČSFD ID a český název", await getCsfdForImdb("tt45114341", "series"), { csfdId: 1500000, title: "Melania Rea: Případ, který otřásl Itálií", year: 2026 });
  eq("getCsfdForImdb: neznámé IMDb → null", await getCsfdForImdb("tt9999999", "movie"), null);
  csfdDelay = 400;
  const slow = await getCsfdForImdb("tt0203259", "series", 100);
  await sleep(450);
  csfdDelay = 0; calls.length = 0;
  const later = await getCsfdForImdb("tt0203259", "series", 100);
  eq("pomalá odpověď: hned null, příště z cache bez dotazu", [slow, later?.csfdId, calls.filter(c => c.startsWith("csfd")).length], [null, 70000, 0]);

  const MEL = { en: "Melania Rea", cz: "Melania Rea", sk: "", year: "2026", seasonYears: { 1: "2026" }, csfdId: 1500000, csfdTitle: "Melania Rea: Případ, který otřásl Itálií" };
  DB = [
    [h(300), "Melania Rea: Případ, který otřásl Itálií S01E01 (CZ/IT/EN)[1080p][WEB-DL][HEVC]", "Seriál", 1500000],
    [h(301), "Melania Rea Vražda u Ascoli S01E01 (CZ)[720p]", "Seriál", 1500000],            // jiný podtitul, ČSFD sedí → záchrana
    [h(302), "Melania Rea Story S01E01 (2026)(EN)", "Seriál", 999]                            // začíná naším názvem, jiné ČSFD → dál neprojde
  ];
  skt._resetBreaker(); calls.length = 0;
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: MEL });
  eq("Melania Rea S01E01: ČSFD název + záchrana přes detail", f.torrents.map(t => t.hash).sort(), [h(300), h(301)]);
  eq("detail jen u sporných torrentů (ne u toho, který prošel názvem)", calls.filter(c => /details\.php/.test(c)).map(c => c.slice(-40)).sort(), [h(301), h(302)]);
  skt._resetBreaker();
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: { ...MEL, csfdId: undefined, csfdTitle: undefined } });
  eq("bez ČSFD (služba nedostupná) jako dřív: nic", f.torrents.length, 0);
  const LO = { en: "Law & Order", cz: "Zákon a pořádek", sk: "", year: "1990", seasonYears: { 1: "1990" }, csfdId: 4100, csfdTitle: "Zákon a pořádek" };
  skt._resetBreaker();
  DB = [[h(400), "Law & Order: Organized Crime S01E01 (2021)", "Seriál", 9200], [h(401), "Law & Order: Organized Crime S01E01", "Seriál", 9200],
        [h(402), "Black Clover: Meč Krále čarodějů / Black Clover: Sword of the Wizard King (2023)", "Filmy Kreslené", 777]];
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: LO });
  eq("Law & Order: spin-off Organized Crime neprojde (s rokem ani bez)", f.torrents.length + f.batchTorrents.length, 0);
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: { en: "Black Clover", cz: "Black Clover", sk: "", year: "2017", csfdId: 400000, csfdTitle: "Black Clover" } });
  eq("Black Clover: film neprojde pro seriál", f.torrents.length + f.batchTorrents.length, 0);
  DB = Array.from({ length: 10 }, (_, i) => [h(500 + i), `Melania Rea varianta ${i} S01E01`, "Seriál", 1500000]);
  skt._resetBreaker(); calls.length = 0;
  await findTorrents({ type: "series", season: 1, episode: 1, titles: MEL });
  eq("nejvýš 4 detaily (záchrana) na hledání", calls.filter(c => /details\.php/.test(c)).length, 4);

  // Replay: ČSFD název a záchrana u IMDb záznamu
  const j = makeJudge({ kind: "stream", type: "series", id: "tt45114341:1:1", year: "2026", titles: { en: "Melania Rea", cz: "Melania Rea", sk: "", csfdId: 1500000, csfdTitle: MEL.csfdTitle },
    torrents: [{ n: "Melania Rea Vražda u Ascoli S01E01 (CZ)[720p]", cat: "Seriál", csfd: 1500000 }] });
  eq("replay: ČSFD název i záchrana", [j({ n: "Melania Rea: Případ, který otřásl Itálií S01E01 (CZ)", cat: "Seriál" }).ok, j({ n: "Melania Rea Vražda u Ascoli S01E01 (CZ)[720p]", cat: "Seriál" }).ok], [true, true]);

  // HTTP: stream pro tt45114341:1:1 — TMDB + ČSFD souběžně
  DB = [[h(300), "Melania Rea: Případ, který otřásl Itálií S01E01 (CZ/IT/EN)[1080p][WEB-DL][HEVC]", "Seriál", 1500000]];
  process.env.PUBLIC_URL = "";
  const app = require(P + "/index.js");
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const r = await (await fetch(`${base}/--TMDBKEY--uid1--pass1--0--TBKEY/stream/series/tt45114341:1:1.json`)).json();
  eq("stream Melania Rea S01E01", r.streams.length, 1);
  srv.close();

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
