// Opravy z nočního reportu 2026-11-21 (v3.9.4): holé „E01“ jako díl (War Factories, Dannemora) s předností před
// „N. část“ a pojistkou roku, ČSFD veto podle cizí části názvu (Mistr iluze / Deception), filmy nejdřív holé názvy
// (rok lokálně). Limit rychlosti SKT je v test/limit.test.js.
process.env.SKT_SEARCH_BUDGET_MS = "8000";
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const h = (i) => i.toString(16).padStart(40, "0");

// ---------- simulované SKT (jako skutečné: „Stiahni si <kategorie> … = CSFD NN%“, hledá jen v názvu) ----------
let DB = [];                 // [hash, název, kategorie, ČSFD z detailu]
let sktCalls = [], detailCalls = [];
const PER = 24;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const p = url.pathname; const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host !== "sktorrent.eu") throw new Error("Nemockovaná URL: " + cfg.url);
  if (p.endsWith("/details.php")) {
    detailCalls.push(params.id);
    const row = DB.find(r => r[0] === params.id);
    return ok(row ? `<html>${row[0]}${row[3] ? `<a href="https://www.csfd.cz/film/${row[3]}-x/prehled/">ČSFD</a>` : ""}</html>` : "<html></html>");
  }
  sktCalls.push(params.search + (params.page ? ` p${params.page}` : ""));
  const words = norm(String(params.search)).split(" ").filter(w => w.length >= 2);
  const hits = DB.filter(([, n]) => words.every(w => norm(n).includes(w)));
  const page = +(params.page || 0);
  const slice = hits.slice(page * PER, page * PER + PER);
  const pag = Array.from({ length: Math.ceil(hits.length / PER) }, (_, i) => `<a href="torrents_v2.php?search=x&page=${i}">${i + 1}</a>`).join("");
  return ok(`<table>${slice.map(([hh, n, c]) => `<tr><td><b>${c}</b><a href="details.php?id=${hh}" title="Stiahni si ${c} ${n} = CSFD 75%"><img src="p.jpg"></a> Velkost 1 GB | Odosielaju : 3</td></tr>`).join("")}</table>${pag}`);
};

const M = require(P + "/lib/matching");
const skt = require(P + "/lib/skt");
const { findTorrents } = require(P + "/lib/search");
const { makeJudge } = require(P + "/tools/replay");
const reset = () => { skt._resetBreaker(); sktCalls = []; detailCalls = []; };
const reason = (f, hash) => (f.audit.torrents.find(a => a.t.hash === hash) || {}).reason;

(async () => {
  // ================= 1a/b: holé „E01“ jako díl, přednost před „N. část“ =================
  const D1 = "Seriál Utek z vezeni v Dannemore / Escape at Dannemora E01 - Part 1 (2018)(CZ)[1080p]";
  const D7 = "Seriál Utek z vezeni v Dannemore / Escape at Dannemora E07 - Part 7 - 1. cast (2018)(CZ)[1080p]";
  const W3 = "Dokument Valecne tovarny / War Factories E03 - Vickers (2019)(CZ)[TvRip]";
  const ef = (s, e) => M.episodeFilters(s, e);
  eq("Dannemora: „E01 - Part 1“ = S01E01, „E07 … 1. cast“ ne S01E01 (jiný díl E07), ale S01E07",
    [ef(1, 1).matchesExactEpisode(D1), ef(1, 1).matchesExactEpisode(D7), ef(1, 1).rejectReason(D7), ef(1, 7).matchesExactEpisode(D7)], [true, false, "jiný díl (E07)", true]);
  eq("War Factories „E03 - Vickers“: S01E03 ano, S02E03 ne", [ef(1, 3).matchesExactEpisode(W3), ef(2, 3).matchesExactEpisode(W3)], [true, false]);
  eq("se značkou sezóny jen naše: „2. serie E05“ pro S02E05 ano, S01E05 ne", [ef(2, 5).matchesExactEpisode("X - 2. serie E05 (CZ)"), ef(1, 5).matchesExactEpisode("X - 2. serie E05 (CZ)")], [true, false]);
  eq("beze změny: „Bleach - E20(JP+CZtit)“ pro S01E01 ne, rozsah „E01-E04“ není díl, „3. díl“ a S01E03 dál", [ef(1, 1).matchesExactEpisode("Bleach - E20(JP+CZtit)"), ef(1, 2).matchesExactEpisode("X E01-E04 (CZ)"), ef(1, 2).isBatchSeason("X E01-E04 (CZ)"), ef(1, 3).matchesExactEpisode("X 3. díl (CZ)"), ef(1, 3).matchesExactEpisode("X S01E03 (CZ)")], [false, false, true, true, true]);
  eq("„N. díl“ s holým E stejného čísla dál platí", ef(1, 4).matchesExactEpisode("X E04 - 4. díl (CZ)"), true);

  // Hledání: War Factories S01E01 (dřív 0 streamů)
  const WF = { en: "War Factories", cz: "Válečné továrny", sk: "", year: "2019", seasonYears: { 1: "2019" } };
  DB = ["Nemecke letectvi", "Krupp", "Vickers", "General Motors", "Mitsubishi", "Sovetske tanky", "Americke lodstvo"]
    .map((x, i) => [h(1 + i), `Valecne tovarny / War Factories E0${i + 1} - ${x} (2019)(CZ)[TvRip]`, "Dokument"]);
  reset();
  let f = await findTorrents({ type: "series", season: 1, episode: 1, titles: WF });
  eq("War Factories S01E01: díl E01, jediný dotaz", [f.torrents.map(t => t.hash), sktCalls], [[h(1)], ["Válečné továrny"]]);
  f = await findTorrents({ type: "series", season: 1, episode: 4, titles: WF });
  eq("War Factories S01E04: díl E04", f.torrents.map(t => t.hash), [h(4)]);

  // Dannemora S01E01: správný díl první, „E07 … 1. cast“ vypadne
  const ED = { en: "Escape at Dannemora", cz: "Útěk z vězení v Dannemoře", sk: "", year: "2018", seasonYears: { 1: "2018" } };
  DB = [[h(11), "Utek z vezeni v Dannemore / Escape at Dannemora E07 - Part 7 - 1. cast (2018)(CZ)[1080p]", "Seriál"],
        [h(12), "Utek z vezeni v Dannemore / Escape at Dannemora E01 - Part 1 (2018)(CZ)[1080p]", "Seriál"],
        [h(13), "Utek z vezeni v Dannemore / Escape at Dannemora - 1. serie (TV seriál)(CZ)[TvRip]", "Seriál"]];
  reset();
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: ED });
  eq("Dannemora S01E01: díl E01 + balík 1. série; E07 vypadne", [f.torrents.map(t => t.hash), f.batchTorrents.map(t => t.hash), reason(f, h(11))], [[h(12)], [h(13)], "jiný díl (E07)"]);

  // ================= 1c: pojistka roku u holého E =================
  const MS = { en: "Multi Show", cz: "Multi Show", sk: "", year: "2021", seasonYears: { 1: "2021", 2: "2023" } };
  DB = [[h(21), "Multi Show E05 (2023)(CZ)[WebRip]", "Seriál"], [h(22), "Multi Show E05 (2021)(CZ)[TvRip]", "Seriál"], [h(23), "Multi Show E05 (CZ)", "Seriál"]];
  reset();
  f = await findTorrents({ type: "series", season: 1, episode: 5, titles: MS });
  eq("holé E05 s rokem 2. řady (2023) pro S01E05 vypadne, s rokem premiéry a bez roku projde",
    [f.torrents.map(t => t.hash).sort(), reason(f, h(21))], [[h(22), h(23)].sort(), "holý díl, jiný rok (2023)"]);
  eq("replay: stejná pojistka", makeJudge({ type: "series", id: "tt1:1:5", year: "2021", seasonYear: "2021", titles: { en: "Multi Show" } })({ n: "Stiahni si Seriál Multi Show E05 (2023)(CZ)[WebRip]", cat: "Seriál" }), { ok: false, r: "holý díl, jiný rok (2023)" });

  // ================= 1d: ČSFD veto podle cizí části názvu =================
  const DEC = { en: "Deception", cz: "Podvod", sk: "", year: "2013", seasonYears: { 1: "2013" }, csfdId: 328793, csfdTitle: "Podvod" };
  DB = [[h(31), "Mistr iluze / Deception E02 (CZ)[TvRip][1080i]", "Seriál", 533184],
        [h(32), "Mistr iluze / Deception E01 (CZ)[TvRip][1080i]", "Seriál", 533184],
        [h(33), "Mistr iluze / Deception S01 (2018)(CZ)[WebRip][1080p][HEVC]", "Seriál", 533184],
        [h(34), "Mistr iluze  / Deception / 1.Serie (2020)(CZ)", "Seriál", 533184],
        [h(35), "Majster iluzie  / Deception / 1.Serie (2020)(SK)", "Seriál", 533184],
        [h(36), "Zmizeli / Deception - 1. serie (CZ)[TVRip]", "Seriál", null]];
  reset();
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles: DEC });
  eq("Deception S01E01: žádný „Mistr iluze / Majster iluzie“ (ani E01 navíc nad limit 3 detailů), bez odkazu zůstane",
    [f.torrents.map(t => t.hash), f.batchTorrents.map(t => t.hash)], [[], [h(36)]]);
  eq("nejvýš 3 detaily na hledání + archiv počtu detailů", [detailCalls.length <= 3, f.details === detailCalls.length], [true, true]);
  eq("důvod u torrentu bez vlastního detailu: podle části názvu", f.audit.torrents.filter(a => /podle „(mistr iluze|majster iluzie)“/.test(a.reason || "")).length >= 1, true);
  // Další hledání: detaily z paměti, žádné nové stahování
  detailCalls = [];
  f = await findTorrents({ type: "series", season: 1, episode: 2, titles: DEC });
  eq("S01E02: díl E02 „Mistr iluze“ vypadne bez nového detailu", [f.torrents.map(t => t.hash), detailCalls.length], [[], 0]);
  // Replay: část se nepoužije, když některý torrent se stejnou částí odkazuje na naše ČSFD
  const jr = makeJudge({ type: "series", id: "tt2245029:1:1", year: "2013", seasonYear: "2013", titles: { en: "Deception", cz: "Podvod", csfdTitle: "Podvod", csfdId: 328793 },
    torrents: [{ n: "Stiahni si Seriál Mistr iluze / Deception S01 (2018)(CZ)", cat: "Seriál", csfd: 533184 },
               { n: "Stiahni si Seriál Klamání / Deception S01 (2013)(CZ)", cat: "Seriál", csfd: 328793 },
               { n: "Stiahni si Seriál Klamání / Deception S01 (2014)(CZ)", cat: "Seriál", csfd: 541140 }] });
  eq("replay: veto podle části („mistr iluze“), část s naším ČSFD se nepoužije („klamání“)",
    [jr({ n: "Stiahni si Seriál Mistr iluze / Deception E01 (CZ)[TvRip][1080i]", cat: "Seriál" }), jr({ n: "Stiahni si Seriál Klamání / Deception E01 (CZ)", cat: "Seriál" }).ok],
    [{ ok: false, r: "jiné ČSFD (533184, podle „mistr iluze“)" }, true]);

  // ================= 2a: filmy — nejdřív holé názvy, rok lokálně =================
  DB = [[h(41), "Wind River (2017)(CZ)[1080p]", "HD Filmy"], [h(42), "Wind River: The Next Chapter (2024)(EN)", "Filmy s titulkama"]];
  reset();
  f = await findTorrents({ type: "movie", titles: { en: "Wind River", cz: "Wind River", year: "2017" } });
  eq("film bez plné stránky: jen holý název na SKT, „název rok“ lokálně, nalezeno",
    [sktCalls, f.audit.queries.map(q => [q.q, q.ms === "lokálně" ? "L" : "SKT"]), f.torrents.map(t => t.hash)],
    [["Wind River"], [["Wind River", "SKT"], ["Wind River 2017", "L"]], [h(41)]]);
  DB = [];
  reset();
  f = await findTorrents({ type: "movie", titles: { en: "Whalefall", cz: "Velrybí pád", year: "2026" } });
  eq("film, který na SKT není: 2 dotazy místo 4", sktCalls.sort(), ["Velrybí pád", "Whalefall"].sort());

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
