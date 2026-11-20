// Opravy z nočního reportu 2026-11-15 (v3.9.1): „Kompletní / Kompletni seriál“ jako balík, torrenty bez sezóny
// i z dotazu „seri“, „ve frontě TorBoxu od …“, čekání na zkušební dotaz jističe v archivu, limit dotazu 20 s
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const h = (i) => i.toString(16).padStart(40, "0");

// ---------- simulované API ----------
let DB = [];
let sktMode = "ok", LAT = 0;
const tb = { queue: [] };
const PER = 24;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const p = url.pathname; const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host === "sktorrent.eu") {
    if (sktMode === "timeout") { await sleep(5); throw Object.assign(new Error("timeout of 20000ms exceeded"), { code: "ECONNABORTED" }); }
    if (LAT) await sleep(LAT);
    const words = norm(String(params.search)).split(" ");
    const hits = DB.filter(([, n]) => words.every(w => norm(n).includes(w)));
    const page = +(params.page || 0);
    const slice = hits.slice(page * PER, page * PER + PER);
    const pages = Math.ceil(hits.length / PER);
    const pag = Array.from({ length: pages }, (_, i) => `<a href="torrents_v2.php?search=x&page=${i}">${i + 1}</a>`).join("");
    return ok(`<table>${slice.map(([hh, n, c]) => `<tr><td><b>${c}</b><a href="details.php?id=${hh}" title="${n}"><img src="p.jpg"></a> Velkost 1 GB | Odosielaju : 3</td></tr>`).join("")}</table>${pag}`);
  }
  if (url.host === "api.torbox.app") {
    if (p.endsWith("/mylist")) return ok({ success: true, data: [] });
    if (p.endsWith("/getqueued")) return ok({ success: true, data: tb.queue });
  }
  throw new Error("Nemockovaná URL: " + cfg.url);
};

const M = require(P + "/lib/matching");
const skt = require(P + "/lib/skt");
const { findTorrents } = require(P + "/lib/search");
const { accountNote } = require(P + "/lib/streams");
const tbm = require(P + "/lib/tb");

(async () => {
  // ================= 1: komplet v češtině a slovenštině =================
  const ALLO = "Seriál Halo, halo! / 'Allo 'Allo! - Kompletni serial (CZ)[TvRip][1080p]";
  eq("„Kompletni serial“: balík pro S01E01 i S05E03", [M.episodeFilters(1, 1).isBatchSeason(ALLO), M.episodeFilters(5, 3).isBatchSeason(ALLO)], [true, true]);
  eq("tvary: Kompletní / Kompletná séria / kompletny / Komplet / Complete",
    ["X - Kompletní seriál (CZ)", "X - Kompletná séria (SK)", "X kompletny serial", "X Komplet (CZ)", "X Complete Series"].map(n => M.episodeFilters(2, 4).isBatchSeason(n)), [true, true, true, true, true]);
  eq("komplet jiné sezóny neprojde: „Kompletní 1. série“ / „S01 Kompletní“ pro S02",
    [M.episodeFilters(2, 1).isBatchSeason("X - Kompletní 1. série (CZ)"), M.episodeFilters(2, 1).isBatchSeason("X S01 Kompletní (CZ)")], [false, false]);
  eq("komplet s epizodou není balík", M.episodeFilters(1, 2).isBatchSeason("X S01E01 Kompletní verze"), false);
  eq("„Kompletni“ utne název (přísná kontrola projde)", M.makeStrictTitleMatcher(["'Allo 'Allo!", "Haló, haló!"])(ALLO, "Seriál"), true);
  eq("„kompletní“ uprostřed jiného slova nic neutne", M.titleSegment("Nekompletnikovi S01", "", new Set()).trim(), "Nekompletnikovi");

  // Hledání: komplet a torrent bez sezóny jen ve výsledcích „seri“ (holý název má 3+ stránky jiných torrentů)
  const junk = Array.from({ length: 80 }, (_, i) => [h(100 + i), `Haló haló ${i}. díl (CZ) S0${(i % 9) + 1}E${String(i + 10).slice(-2)}`, "Seriál"]);
  DB = [...junk,
    [h(1), "Halo, halo! / 'Allo 'Allo! - Kompletni serial (CZ)[TvRip][1080p]", "Seriál"],
    [h(2), "Haló, haló! / 'Allo 'Allo! serial (1982)(CZ)[DVDRip]", "Seriál"]];
  const T = { en: "'Allo 'Allo!", cz: "Haló, haló!", sk: "", year: "1982", seasonYears: { 1: "1982", 2: "1985", 3: "1986", 4: "1987", 5: "1988" } };
  let f = await findTorrents({ type: "series", season: 1, episode: 1, titles: T });
  eq("'Allo 'Allo! S01E01: komplet (z „seri“) jako balík + torrent bez sezóny na konci",
    [f.batchTorrents.map(t => t.hash)], [[h(1), h(2)]]);
  eq("komplet v archivu jako balík", f.audit.torrents.find(a => a.t.hash === h(1)).reason, "balík");

  // ================= 3c: fronta TorBoxu déle než 48 h =================
  const now = Date.parse("2026-11-16T10:00:00Z");
  eq("popis: fronta od 10. 11. (déle než 48 h)", accountNote({ queued: true, since: "2026-11-10T09:00:00Z" }, "TorBox", now), "⏳ Ve frontě TorBox od 10. 11. — zkontrolujte aktivní stahování v účtu");
  eq("popis: čerstvá fronta beze změny", accountNote({ queued: true, since: "2026-11-16T08:00:00Z" }, "TorBox", now), "⏳ Ve frontě TorBox (plné sloty stahování)");
  tb.queue = [{ id: 9, hash: h(900), created_at: new Date(Date.now() - 5 * 86400e3).toISOString() }];
  const r = await tbm.resolve("TBKEY", h(900), { season: 2, episode: 12 });
  eq("přehrání: důvod „ve frontě od …“", [r.status, /^TorBox: torrent ve frontě od \d{1,2}\. \d{1,2}\. \(plné sloty stahování\)$/.test(r.reason)], ["queued", true]);

  // ================= 4: čekání na zkušební dotaz jističe v archivu =================
  skt._resetBreaker(); sktMode = "timeout";
  DB = [[h(10), "Země gangů / MobLand S01E01 (CZ)", "Seriál"]];
  const MOB = { en: "MobLand", cz: "Země gangů", sk: "", year: "2025", seasonYears: { 1: "2025" } };
  await findTorrents({ type: "series", season: 1, episode: 1, titles: MOB });
  skt._breaker().openUntil = Date.now() - 1; sktMode = "ok"; LAT = 250;
  // dvě souběžná hledání: dotaz druhého čeká na zkušební dotaz prvního (od 3.9.3 jde nejdřív jen holý název)
  const two = await Promise.all([findTorrents({ type: "series", season: 1, episode: 2, titles: MOB }), findTorrents({ type: "series", season: 1, episode: 1, titles: { en: "Peaky Blinders", cz: "Gangy z Birminghamu", sk: "", year: "2013" } })]);
  f = two[0];
  const pw = two.flatMap(x => x.audit.queries).map(q => q.probeWait || 0);
  eq("dotazy čekající na zkušební dotaz mají probeWait", pw.filter(x => x >= 150).length >= 1, true);
  LAT = 0;

  // ================= limit dotazu 20 s =================
  eq("výchozí limit: odpověď 20 s, celý dotaz 22 s", skt.HARD_LIMIT_MS, 22000);

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
