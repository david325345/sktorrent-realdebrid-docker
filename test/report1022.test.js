// Opravy z nočních reportů 2026-10-20 a 2026-10-22 (v3.5.2): Complete vs. jiná sezóna, „E20(“, film za dvojtečkou,
// rok premiéry sezóny, absolutní číslování, „Fahrenheit 9/11“, zkrácené názvy, „Série 5“, mrtvé torrenty, analyza.js
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };

// ---- simulované TMDB a SKT ----
const h = (i) => i.toString(16).padStart(40, "0");
let DB = [], QUERIES = [];
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const TMDB = {
  tt4: { tv: { id: 4, name: "Cyberpunk: Edgerunners", first_air_date: "2022-09-13" }, cz: "Cyberpunk: Edgerunners",
         seasons: [{ season_number: 0, air_date: "2022-01-01" }, { season_number: 1, air_date: "2022-09-13" }, { season_number: 2, air_date: "2026-05-01" }, { season_number: 3, air_date: null }] }
};
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host === "api.themoviedb.org") {
    const p = url.pathname;
    if (p.includes("/find/")) { const t = TMDB[p.split("/").pop()]; return ok({ tv_results: t.tv ? [t.tv] : [], movie_results: [] }); }
    const t = TMDB.tt4;
    return ok({ name: t.tv.name, seasons: params.language === "cs-CZ" ? t.seasons : undefined, alternative_titles: { results: [] } });
  }
  const s = cfg.params.search; QUERIES.push(s);
  const words = norm(s).split(" ");
  const hits = DB.filter(t => words.every(w => norm(t.n).includes(w)));
  return ok(`<table>${hits.map(t => `<tr><td><b>${t.c}</b><a href="details.php?id=${t.hash}" title="${t.n}"><img src="p.jpg"></a> Velkost 1 GB | Odosielaju : 3</td></tr>`).join("")}</table>`);
};
const setDB = (rows) => { DB = rows.map(([n, c], i) => ({ n, c, hash: h(i + 1) })); QUERIES = []; };

const M = require(P + "/lib/matching");
const { getTitle } = require(P + "/lib/meta");
const { findTorrents } = require(P + "/lib/search");
const { makeJudge } = require(P + "/tools/replay");
const S = require(P + "/lib/streams");
const { analyze } = require(P + "/tools/analyza");

(async () => {
  const f = (s, e) => M.episodeFilters(s, e);

  // 2026-10-20 / 1) „Complete“ nepřebije jinou sezónu
  const TL = "Stiahni si Seriál Na seznamu smrti / The Terminal List (S01)(2022)(HD)(720p)(Webrip)(Complete)(CZ+Multi 7 lang)";
  eq("Terminal List (S01)(Complete) pro S02E01 ✘", [f(2, 1).isBatchSeason(TL), f(2, 1).rejectReason(TL)], [false, "jiná sezóna (S01)"]);
  eq("… pro S01E01 ✔", f(1, 1).isBatchSeason(TL), true);
  eq("Lanterns_S01-komplet a Komplet bez sezóny dál ✔", [f(1, 1).isBatchSeason("Lanterns_S01-komplet_CZ_dab [1080p]"), f(6, 10).isBatchSeason("Zlata sedmdesata + Zlata devadesata - Komplet (TvRip)")], [true, true]);

  // 2026-10-20 / 2) „E20(“ bez mezery = jiný díl
  const BL = "Stiahni si Seriál Bleach: Sennen Kessen-hen / Bleach: Thousand Year Blood War - E20(JP+CZtit)";
  eq("Bleach TYBW E20( pro S01E01 ✘", [f(1, 1).hasAnyEpisode(BL), f(1, 1).isNoSeasonCandidate(BL), f(1, 1).rejectReason(BL)], [true, false, "jiný díl (E20)"]);
  eq("E21 na konci i E-AC3 / EAC3", [f(1, 1).hasAnyEpisode("Show - E21"), f(1, 1).hasAnyEpisode("Show (2020)[1080p][E-AC3]"), f(1, 1).hasAnyEpisode("Show [EAC3]")], [true, false, false]);
  eq("rozsah E01-E13 dál balík", f(1, 7).isBatchSeason("Druha svetova valka v barve / World War II in Colour E01-E13 (2009)(CZ)"), true);

  // 2026-10-20 / 3) Film: shoda za dvojtečkou jen s rokem
  const fm = M.makeStrictTitleMatcher(["V srdci divočiny", "Heart of the Beast"], { colonNeedsYear: true });
  eq("Vysoké Tatry: V srdci divočiny bez roku ✘, s rokem ✔", [
    fm("Stiahni si Dokument Vysoke Tatry: V srdci divociny / Tajomne Karpaty - Nesmrtelny les (SK)[TvRip][1080i]", "Dokument"),
    fm("Stiahni si Filmy Něco: V srdci divočiny (2026)[1080p]", "Filmy"), fm("Stiahni si Filmy V srdci divočiny [1080p]", "Filmy")], [false, true, true]);
  eq("seriály beze změny (Top Gear special: …)", M.makeStrictTitleMatcher(["Top Gear special: James May a lidové autíčko"])("Stiahni si Dokument Top Gear special: James May a lidove auticko 1.dil (CZ)", "Dokument"), true);

  // 2026-10-20 / 4) Rok premiéry sezóny
  const cp = await getTitle("tt4", "k".repeat(32), "series");
  eq("TMDB: roky sezón (bez specialů a bez data)", cp.seasonYears, { 1: "2022", 2: "2026" });
  const sy = M.makeSeasonYearCheck("2026", 2, [cp.en]);
  eq("(2022) pro S02 z 2026 ✘; (2026), rozsah, bez roku ✔", [sy("Cyberpunk: Edgerunners (CZ/EN/JAP)(1080p)(2022)(Web-DL)"), sy("X (2026)"), sy("X (2022-2026)"), sy("X [1080p]")],
    ["jiná sezóna (rok 2022 < 2026)", null, null, null]);
  eq("sezóna 1 se nekontroluje", M.makeSeasonYearCheck("2022", 1, [])("X (2010)"), null);
  setDB([["Cyberpunk: Edgerunners (CZ/EN/JAP)(1080p)(2022)(Web-DL)", "Seriál"]]);
  let r = await findTorrents({ type: "series", season: 2, episode: 1, titles: cp });
  eq("Cyberpunk S02E01: balík z 2022 už ne", [r.batchTorrents.length, r.seasonYear, r.audit.torrents[0].reason], [0, "2026", "jiná sezóna (rok 2022 < 2026)"]);
  r = await findTorrents({ type: "series", season: 1, episode: 1, titles: cp });
  eq("Cyberpunk S01E01: balík z 2022 dál ✔", r.batchTorrents.length, 1);
  eq("zkrácené „Cyberpunk“ se nehledá", QUERIES.some(q => /^Cyberpunk( |$)/.test(q) && !/Edgerunners/.test(q)), false);
  const jc = makeJudge({ kind: "stream", type: "series", id: "tt4:2:1", year: "2022", seasonYear: "2026", titles: { en: cp.en, cz: cp.cz, sk: "" } });
  eq("replay používá seasonYear z archivu", jc({ n: "Stiahni si Seriál Cyberpunk: Edgerunners (CZ/EN/JAP)(1080p)(2022)(Web-DL)", cat: "Seriál" }).ok, false);

  // 2026-10-20 / 5) Absolutní číslování
  const sb = M.makeStrictTitleMatcher(["Bleach"]);
  eq("„Bleach 1-109“ / „110-135“ projdou názvem", [sb("Stiahni si Seriál Bleach 1-109 (CZ)", "Seriál", { whole: true }), sb("Stiahni si Seriál Bleach 110-135 (CZ)", "Seriál", { whole: true })], [true, true]);
  eq("1-109 pro S01E01 ✔, pro S02 ✘; 110-135 ✘", [f(1, 1).isNoSeasonCandidate("Bleach 1-109 (CZ)"), f(2, 1).isNoSeasonCandidate("Bleach 1-109 (CZ)"), f(1, 1).isNoSeasonCandidate("Bleach 110-135 (CZ)"), f(1, 1).rejectReason("Bleach 110-135 (CZ)")],
    [true, false, false, "jiné díly (110-135, absolutní číslování)"]);
  eq("není absolutní rozsah: série, roky, E01-02, 9-1-1, se sezónou", ["Show 1-16. série", "Show (2008-2012)", "Show S01E01-02", "9-1-1 (2018)", "Bleach 168-265 S09-S13", "Show 1-5"].map(n => M.absoluteRange(n)), [null, null, null, null, null, null]);

  // 2026-10-22 / 1) „Fahrenheit 9/11“
  eq("Fahrenheit 9/11 projde", M.makeStrictTitleMatcher(["Fahrenheit 9/11"])("Stiahni si Dokument Fahrenheit 9/11 (2004)(EN)(CZtitulky)", "Dokument"), true);
  eq("„Most / Bron/Broen“ se dál dělí", M.makeStrictTitleMatcher(["Bron"])("Stiahni si Seriál Most / Bron/Broen / The Bridge S01-S04", "Seriál"), true);
  setDB([["Fahrenheit 9/11 (2004)(EN)(CZtitulky)", "Dokument"]]);
  r = await findTorrents({ type: "movie", titles: { en: "Fahrenheit 9/11", cz: "Fahrenheit 9/11", sk: "", year: "2004" } });
  eq("hledání Fahrenheit 9/11 najde film", r.torrents.length, 1);

  // 2026-10-22 / 3) Zkrácené názvy jen, když je přísná kontrola pustí
  setDB([["2. světová válka: Ženy v první linii / WWII - Women on the Frontline S01 (2023)", "Dokument"]]);
  r = await findTorrents({ type: "series", season: 1, episode: 9, titles: { en: "WWII in HD", cz: "2. světová válka: Ztracené filmy", sk: "WWII in HD", year: "2009" } });
  eq("WWII in HD: „2 světová válka“ se nehledá", [r.names, QUERIES.some(q => /^2 světová válka( S01| seri|$)/.test(q))], [["2 světová válka Ztracené filmy", "WWII in HD"], false]);
  r = await findTorrents({ type: "series", season: 1, episode: 1, titles: { en: "Arcane: League of Legends", cz: "Arcane", sk: "", alt: [], year: "2021" } });
  eq("Arcane: zkrácený název, který je mezi názvy TMDB, zůstane", [...r.names].sort(), ["Arcane", "Arcane League of Legends"]);
  r = await findTorrents({ type: "series", season: 1, episode: 1, titles: { en: "Evil Genius", cz: "Evil Genius: Pravdivý příběh", sk: "", year: "2018" } });
  eq("Evil Genius: zkrácený CZ = anglický název", r.names, ["Evil Genius Pravdivý příběh", "Evil Genius"]);

  // 2026-10-22 / 4) „Série 5“
  eq("Série 5 pro S01E01 = jiná sezóna; pro S05 balík", [f(1, 1).rejectReason("Perníkový táta / Breaking Bad Série 5 (2012)(CZ/EN)"), f(5, 1).isBatchSeason("Perníkový táta / Breaking Bad Série 5 (2012)(CZ/EN)")], ["jiná sezóna (serie 5)", true]);

  // 2026-10-22 / 2) Mrtvé torrenty a stav v účtu
  const T = (hash, seeds) => ({ hash, seeds, name: hash });
  const pk = [{ t: T("a", 0), isBatch: false }, { t: T("b", 5), isBatch: false }, { t: T("c", 3), isBatch: true }, { t: T("d", 0), isBatch: true }];
  eq("0 seedů mimo cache na konec", S.orderPicked(pk, null).map(x => x.t.hash), ["b", "c", "a", "d"]);
  eq("0 seedů, ale v cache TorBoxu zůstane vepředu", S.orderPicked(pk, new Set(["a"])).map(x => x.t.hash), ["a", "b", "c", "d"]);
  eq("isDead", [S.isDead({ seeds: 0 }, false), S.isDead({ seeds: 0 }, true), S.isDead({ seeds: 2 }, null), S.isDead({ seeds: 0 }, undefined)], [true, false, false, true]);
  const now = Date.parse("2026-10-21T18:26:00Z");
  eq("stojící stahování", S.accountNote({ state: "downloading", progress: 0, since: "2026-10-21T06:49:00Z" }, "TorBox", now), "⚠️ Stahování stojí — V účtu TorBox: downloading 0 % (12 h)");
  eq("čerstvé stahování a stalled", [S.accountNote({ state: "downloading", progress: 40, since: "2026-10-21T18:00:00Z" }, "TorBox", now), S.accountNote({ state: "stalled (no seeds)", progress: 0 }, "TorBox", now)],
    ["🕐 V účtu TorBox: downloading 40 % (26 min)", "⚠️ Stahování stojí — V účtu TorBox: stalled (no seeds) 0 %"]);
  eq("hotový / není v účtu → nic", [S.accountNote({ ready: true }, "TorBox"), S.accountNote(undefined, "TorBox")], ["", ""]);

  // analyza.js: opakované „stahuje se“ a odmítnutí, které aktuální logika hlásí jinak
  const play = (t, st, extra = {}) => ({ t, kind: "play", prov: "tb", h: "e".repeat(40), n: "Stiahni si Seriál Zmizeli / Gone - 1. serie (CZ)[TVRip]", sel: { season: 1, episode: 1 }, status: st, ...extra });
  const recs = [play("2026-10-21T06:49:16Z", "downloading", { progress: 0, state: "stalled (no seeds)" }), play("2026-10-21T08:41:39Z", "downloading"), play("2026-10-21T18:26:10Z", "downloading", { progress: 0 }),
    { t: "2026-10-21T18:40:00Z", kind: "stream", type: "series", id: "tt0903747:1:1", titles: { en: "Breaking Bad", cz: "Perníkový táta", sk: "" }, ms: 900, queries: [],
      torrents: [{ n: "Stiahni si Seriál Perníkový táta / Breaking Bad Série 5 (2012)(CZ/EN)[1080p]", cat: "Seriál", h: "f".repeat(40), ok: false, r: "nesedí sezóna/epizoda" }] }];
  const an = analyze(recs);
  eq("analyza: mrtvý torrent v oddílu „stahuje se“", [an.counts.stuck, /Zmizeli \/ Gone .* \| tb \| 3 \|.*0 → 0 %.*stalled/.test(an.markdown)], [1, true]);
  eq("analyza: „Série 5“ už není podezřelé odmítnutí", an.counts.susp, 0);

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})();
