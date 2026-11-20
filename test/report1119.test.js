// Opravy z nočního reportu 2026-11-19 (v3.9.3): méně dotazů na SKT (holý název nejdřív, varianty lokálně; paměť
// při pauze 429 / jističi; 2 chyby po sobě), torrent bez sezóny s jiným rokem (Django), ČSFD veto u torrentu s cizí
// částí názvu (Mistr iluze / Deception), TorBox „not available on your plan“, „[Serie.12]“ jako sezóna
process.env.SKT_SEARCH_BUDGET_MS = "8000";
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
const fs = require("fs");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const h = (i) => i.toString(16).padStart(40, "0");

// ---------- simulované SKT (jako skutečné: atribut title „Stiahni si <kategorie> … = CSFD NN%“, hledá se jen
// v samotném názvu, slova o 1 znaku se ignorují) + TorBox ----------
let DB = [];                 // [hash, název, kategorie, ČSFD z detailu]
let mode = "ok";             // ok | 429 | timeout
let sktCalls = [], detailCalls = [];
const PER = 24;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const httpErr = (status, headers = {}, data = "") => { const e = new Error(`Request failed with status code ${status}`); e.response = { status, headers, data }; return e; };
const tb = { create: "ok", list: "ok", calls: [] };
const PLAN = { success: false, error: "PLAN_RESTRICTED_FEATURE", detail: "API feature not available on your plan. Please upgrade to a paid plan to access the API." };
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const p = url.pathname; const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host === "sktorrent.eu" && p.endsWith("/details.php")) {
    detailCalls.push(params.id);
    const row = DB.find(r => r[0] === params.id);
    return ok(row ? `<html>${row[0]}${row[3] ? `<a href="https://www.csfd.cz/film/${row[3]}-x/prehled/">ČSFD</a>` : ""}</html>` : "<html></html>");
  }
  if (url.host === "sktorrent.eu") {
    sktCalls.push(params.search + (params.page ? ` p${params.page}` : ""));
    if (mode === "429") throw httpErr(429, { "retry-after": "7" });
    if (mode === "timeout") throw Object.assign(new Error("timeout of 20000ms exceeded"), { code: "ECONNABORTED" });
    const words = norm(String(params.search)).split(" ").filter(w => w.length >= 2);
    const hits = DB.filter(([, n]) => words.every(w => norm(n).includes(w)));
    const page = +(params.page || 0);
    const slice = hits.slice(page * PER, page * PER + PER);
    const pag = Array.from({ length: Math.ceil(hits.length / PER) }, (_, i) => `<a href="torrents_v2.php?search=x&page=${i}">${i + 1}</a>`).join("");
    return ok(`<table>${slice.map(([hh, n, c]) => `<tr><td><b>${c}</b><a href="details.php?id=${hh}" title="Stiahni si ${c} ${n} = CSFD 75%"><img src="p.jpg"></a> Velkost 1 GB | Odosielaju : 3</td></tr>`).join("")}</table>${pag}`);
  }
  if (url.host === "api.torbox.app") {
    tb.calls.push(p.split("/").pop());
    if (p.endsWith("/mylist")) { if (tb.list === "plan") throw httpErr(403, {}, PLAN); return ok({ success: true, data: [] }); }
    if (p.endsWith("/getqueued")) return ok({ success: true, data: [] });
    if (p.endsWith("/createtorrent")) { if (tb.create === "plan") throw httpErr(403, {}, PLAN); return ok({ success: true, detail: "Added", data: { torrent_id: 5 } }); }
  }
  throw new Error("Nemockovaná URL: " + cfg.url);
};

const M = require(P + "/lib/matching");
const skt = require(P + "/lib/skt");
const { findTorrents } = require(P + "/lib/search");
const { makeJudge } = require(P + "/tools/replay");
const tbm = require(P + "/lib/tb");
const reset = () => { skt._resetBreaker(); mode = "ok"; sktCalls = []; detailCalls = []; };

(async () => {
  // ================= 1a: seriál — nejdřív jen holý název, varianty lokálně =================
  const VIG = { en: "Vigil", cz: "Vigil", sk: "", year: "2021", seasonYears: { 1: "2021", 2: "2023", 3: "2025" } };
  DB = [[h(1), "Vigil S03E01 (EN)[1080p][WEBRip][HEVC]", "Seriál"],
        [h(2), "Vigil S01-S03 (EN)[WebRip][1080p][HEVC]", "Seriál"],
        [h(3), "Vigil S03 (CZ)[WebRip][1080p]", "Seriál"],
        [h(4), "Vigil - 3. série (CZ)[TvRip]", "Seriál"],
        [h(5), "Vigil S03E02 (EN)[1080p]", "Seriál"],
        [h(6), "The Vigil (2019)[WebRip][1080p]", "Filmy s titulkama"]];
  reset();
  let f = await findTorrents({ type: "series", season: 3, episode: 1, titles: VIG });
  eq("Vigil S03E01: jediný dotaz na SKT (holý název)", sktCalls, ["Vigil"]);
  eq("epizoda + balíky (S01-S03, S03, „3. série“ z lokálního „seri“)", [f.torrents.map(t => t.hash), f.batchTorrents.map(t => t.hash).sort()], [[h(1)], [h(2), h(3), h(4)].sort()]);
  eq("archiv: varianty jako dotazy „lokálně“ s počtem jako na SKT",
    f.audit.queries.map(q => [q.q, q.n, q.ms === "lokálně" ? "L" : "SKT"]),
    [["Vigil", 6, "SKT"], ["Vigil S03E01", 1, "L"], ["Vigil S03", 4, "L"], ["Vigil seri", 1, "L"]]);      // „S01-S03“ obsahuje „s03“ i na SKT
  eq("„seri“ nehledá v „Stiahni si Seriál …“ (jen v názvu)", skt.filterLikeSKT([{ name: "Stiahni si Seriál Vigil S03E01 = CSFD 75%", cat: "Seriál" }], "seri").length, 0);

  // Plná stránka holého názvu → varianty se pošlou na SKT (souběžně)
  DB = [...Array.from({ length: 30 }, (_, i) => [h(100 + i), `Vigil S0${(i % 2) + 1}E${String(i + 1).padStart(2, "0")} (CZ)`, "Seriál"]),
        [h(7), "Vigil S03E01 (CZ)[1080p]", "Seriál"]];
  reset();
  f = await findTorrents({ type: "series", season: 3, episode: 1, titles: VIG });
  eq("plná stránka: holý název + S03E01, S03, seri na SKT", [sktCalls.slice(0, 1), sktCalls.slice(1, 4).sort()], [["Vigil"], ["Vigil S03", "Vigil S03E01", "Vigil seri"]]);
  eq("plná stránka: epizoda nalezena", f.torrents.map(t => t.hash).includes(h(7)), true);

  // ================= 1b: pauza 429 / jistič — výsledky z paměti, hledání se nezastaví předem =================
  DB = [[h(11), "Every Day S01E02 (JP+CZtit)[1080p]", "Seriál"], [h(12), "Every Day S01E03 (JP+CZtit)[1080p]", "Seriál"]];
  const ED = { en: "Every Day", cz: "", sk: "", year: "2025", seasonYears: { 1: "2025" } };
  reset();
  f = await findTorrents({ type: "series", season: 1, episode: 2, titles: ED });
  mode = "429"; await skt.searchSKTPage("Něco jiného", "", "", 0); sktCalls = [];
  eq("pauza 429 běží", skt.isPaused("", ""), true);
  f = await findTorrents({ type: "series", season: 1, episode: 3, titles: ED });
  eq("během pauzy: S01E03 z paměti (holý název z předchozího hledání), bez dotazu na SKT", [f.torrents.map(t => t.hash), sktCalls.length, !!f.sktDown], [[h(12)], 0, false]);
  // Jistič: stejné
  reset();
  await findTorrents({ type: "series", season: 1, episode: 2, titles: ED });
  skt._breaker().openUntil = Date.now() + 30000; sktCalls = [];
  f = await findTorrents({ type: "series", season: 1, episode: 3, titles: ED });
  eq("otevřený jistič: výsledky z paměti, bez dotazu na SKT", [f.torrents.map(t => t.hash), sktCalls.length], [[h(12)], 0]);
  // Bez paměti: chyba hned, bez dotazu na SKT
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: { en: "Nic Takového", cz: "", sk: "", year: "2025" } });
  eq("otevřený jistič bez paměti: sktDown, „jistič“, bez dotazu", [!!f.sktDown, f.audit.queries[0].err, sktCalls.length], [true, "jistič", 0]);

  // ================= 1c: 429 v archivu (délka pauzy) + 2 skutečné chyby po sobě =================
  reset(); mode = "429";
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: { en: "Sasaki and Peeps", cz: "Sasaki a Pípík", sk: "", year: "2024" } });
  eq("429: druh, pauza 7 s (Retry-After), další dotaz přeskočen bez dotazu na SKT",
    [f.audit.queries.map(q => q.err), f.audit.queries[0].pause, sktCalls.length], [["http 429", "pauza 429"], 7, 1]);
  reset(); mode = "timeout";
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: { en: "Alpha Show", cz: "Alfa seriál", sk: "Alfa šou", year: "2024" } });
  eq("2 chyby po sobě: třetí název se nezkouší (oprava počítadla z 3.9.2)", sktCalls, ["Alfa seriál", "Alpha Show"]);
  reset();

  // ================= 2a: Django — torrent bez sezóny s jiným rokem =================
  const DJ = { en: "Django", cz: "Django", sk: "", year: "2023", seasonYears: { 1: "2023" } };
  DB = [[h(21), "Django (2024)(CZ)[WEB-DL][1080p]", "Dokument"],
        [h(22), "Django S01 (CZ)[WebRip][720p]", "Seriál"]];
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: DJ });
  eq("Django S01E01: jen balík S01, dokument z 2024 vypadne s důvodem",
    [f.batchTorrents.map(t => t.hash), f.audit.torrents.find(a => a.t.hash === h(21)).reason], [[h(22)], "bez sezóny, jiný rok (2024)"]);
  const ny = M.makeNoSeasonYearCheck("1973", "1973", ["Svět ve válce"]);
  eq("rok = premiéra / sezóna, rozsah, bez roku, víc roků: beze změny",
    [ny("Svět ve válce (1973)(CZ)"), ny("Svět ve válce (1973-1974)"), ny("Svět ve válce (CZ)"), ny("Svět ve válce (1973)(2008 remaster)"), M.makeNoSeasonYearCheck("1994", "1993", [])("Strážce moře / SeaQuest DSV (1993)")], [null, null, null, null, null]);
  eq("rok seriálu v našem názvu se nepočítá („1923“)", M.makeNoSeasonYearCheck("2022", "2022", ["1923"])("1923 (CZ)[1080p]"), null);
  eq("replay: stejné pravidlo", makeJudge({ type: "series", id: "tt14084828:1:1", year: "2023", seasonYear: "2023", titles: { en: "Django", cz: "Django" } })({ n: "Stiahni si Dokument Django (2024)(CZ)[WEB-DL][1080p]", cat: "Dokument" }), { ok: false, r: "bez sezóny, jiný rok (2024)" });

  // ================= 2b: ČSFD veto — torrent jen přes jednu část názvu vedle cizího názvu =================
  const DEC = { en: "Deception", cz: "Podvod", sk: "", year: "2013", seasonYears: { 1: "2013" }, csfdId: 328793, csfdTitle: "Podvod" };
  DB = [[h(31), "Mistr iluze / Deception S01 (2018)(CZ)[WebRip][1080p][HEVC]", "Seriál", 541140],
        [h(32), "Deception S01E01 (CZ)[TvRip]", "Seriál", 328793],
        [h(33), "Zmizeli / Deception - 1. serie (CZ)[TVRip]", "Seriál", null],
        [h(34), "Klamání / Deception S01 (2013)(CZ)", "Seriál", 328793]];
  reset();
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: DEC });
  eq("Deception S01E01: „Mistr iluze“ (jiné ČSFD) vypadne, bez odkazu a se stejným ČSFD zůstane",
    [f.torrents.map(t => t.hash), f.batchTorrents.map(t => t.hash).sort(), f.audit.torrents.find(a => a.t.hash === h(31)).reason],
    [[h(32)], [h(33), h(34)].sort(), "jiné ČSFD (541140)"]);
  eq("detail jen u torrentů s cizí částí názvu (ne „Deception S01E01“)", detailCalls.sort(), [h(31), h(33), h(34)].sort());
  eq("archiv: ČSFD z detailu", [f.csfdOf.get(h(31)), f.csfdOf.get(h(33)), f.csfdOf.has(h(32))], [541140, null, false]);
  // limit 3 detailů na hledání
  DB = Array.from({ length: 5 }, (_, i) => [h(40 + i), `Cizí název ${i} / Deception S01 (2018)(CZ)`, "Seriál", 541140]);
  reset();
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: DEC });
  eq("veto: nejvýš 3 detaily na hledání", [detailCalls.length, f.batchTorrents.length], [3, 2]);
  // Detail z paměti se do limitu nepočítá a jde i během pauzy
  mode = "429"; await skt.searchSKTPage("Něco", "", "", 0); detailCalls = [];
  f = await findTorrents({ type: "series", season: 1, episode: 2, titles: DEC });
  eq("během pauzy: detaily z paměti platí, nové se nestahují", [detailCalls.length, f.batchTorrents.length], [0, 2]);
  reset();
  // csfd: tituly beze změny (veto oběma směry jako dřív); replay zrcadlí veto
  const jr = makeJudge({ type: "series", id: "tt2245029:1:1", year: "2013", seasonYear: "2013", titles: { en: "Deception", cz: "Podvod", csfdTitle: "Podvod", csfdId: 328793 },
    torrents: [{ n: "Stiahni si Seriál Mistr iluze / Deception S01 (2018)(CZ)", cat: "Seriál", csfd: 541140 }, { n: "Stiahni si Seriál Deception S01 (2018)(CZ)", cat: "Seriál", csfd: 541140 }] });
  eq("replay: veto jen s cizí částí názvu", [jr({ n: "Stiahni si Seriál Mistr iluze / Deception S01 (2018)(CZ)", cat: "Seriál" }), jr({ n: "Stiahni si Seriál Deception S01 (2018)(CZ)", cat: "Seriál" }).ok],
    [{ ok: false, r: "jiné ČSFD (541140)" }, true]);
  const fp = M.makeForeignPartCheck(["Deception", "Podvod"], M.makeStrictTitleMatcher(["Deception", "Podvod"]));
  eq("cizí část názvu: jen když jiná část není náš název", ["Mistr iluze / Deception S01", "Podvod / Deception S01", "Deception S01", "Dr. House / House M.D. S01"].map(n => fp(n, "Seriál")), [true, false, false, false]);

  // ================= 3: TorBox „not available on your plan“ =================
  tbm._reset(); tb.create = "plan"; tb.calls = [];
  let r = await tbm.resolve("TBKEY", h(51), { season: 1, episode: 1 });
  eq("plán: limit + plan + volání createtorrent + český důvod", [r.status, r.plan, r.call, r.reason], ["limit", true, "createtorrent", "TorBox: váš plán nedovoluje přidávat torrenty přes API, přehrát jdou jen ⚡ cachované"]);
  tb.calls = [];
  r = await tbm.resolve("TBKEY", h(52), { season: 1, episode: 1 });
  eq("plán: přidávání 10 min pozastaveno (bez createtorrent), stejné vysvětlení", [r.status, r.plan, tb.calls.includes("createtorrent")], ["limit", true, false]);
  tbm._reset(); tb.create = "ok"; tb.list = "plan";
  r = await tbm.resolve("TBKEY", h(53), {});
  eq("plán u mylist: limit + plan + volání mylist", [r.status, r.plan, r.call, /zkontrolujte předplatné/.test(r.reason)], ["limit", true, "mylist", true]);
  tbm._reset(); tb.list = "ok";
  eq("info video torbox-plan.mp4 existuje", fs.existsSync(P + "/public/torbox-plan.mp4"), true);

  // ================= 4: „[Serie.12]“, „Season.2“, „Serie_3“ jako sezóna =================
  const CM = "Seriál Myslenky zlocince / Criminal Minds (CZ)(2016)[Serie.12][TvRip]";
  const f1 = M.episodeFilters(1, 1), f12 = M.episodeFilters(12, 3);
  eq("[Serie.12] pro S01: ne „bez sezóny“, důvod jiná sezóna", [f1.isNoSeasonCandidate(CM), f1.isBatchSeason(CM), f1.rejectReason(CM)], [false, false, "jiná sezóna (serie 12)"]);
  eq("[Serie.12] pro S12: balík naší sezóny", [f12.isBatchSeason(CM), f12.isSeasonPack(CM)], [true, true]);
  eq("[Serie.1] pro S01: balík", f1.isBatchSeason("Criminal Minds (CZ)(2005)[Serie.1][TvRip]"), true);
  eq("Season.2 / Serie_3 / Série.4 / (Serie 2) pro S01: nejsou „bez sezóny“",
    ["X [Season.2]", "X Serie_3", "X Série.4 (CZ)", "X (Serie 2)"].map(n => f1.isNoSeasonCandidate(n)), [false, false, false, false]);
  eq("Season.2 pro S02: balík", M.episodeFilters(2, 1).isBatchSeason("X [Season.2][1080p]"), true);
  eq("beze změny: „Kancl - Mini Série“ a „Svět ve válce (1973)“ jsou bez sezóny", [f1.isNoSeasonCandidate("Kancl - Mini Série (CZ)"), f1.isNoSeasonCandidate("Svět ve válce (1973)(CZ)")], [true, true]);

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
