// Opravy z nočního reportu 2026-10-18 (v3.5.1): rozsahy sezón, rok před začátkem seriálu,
// alternativní názvy z TMDB, lomítko „⁄“
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };

// ---- simulované TMDB a SKT ----
const h = (i) => i.toString(16).padStart(40, "0");
let DB = [];
const PER = 24;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const TMDB = {
  tt1: { tv: { id: 1, name: "Arcane", first_air_date: "2021-11-06" }, cz: "Arcane", alt: { results: [
    { iso_3166_1: "US", title: "Arcane: League of Legends" }, { iso_3166_1: "FR", title: "Arcane : League of Legends FR" },
    { iso_3166_1: "CZ", title: "Arcane" }, { iso_3166_1: "GB", title: "Arcane 2" }] } },
  tt2: { tv: { id: 2, name: "Batman", first_air_date: "1966-01-12" }, cz: "Batman", alt: { results: [{ iso_3166_1: "US", title: "Batman '66" }] } },
  tt3: { mv: { id: 3, title: "Up", release_date: "2009-05-28" }, cz: "Vzhůru do oblak", alt: { titles: [{ iso_3166_1: "US", title: "Up 3D" }] } }
};
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host === "api.themoviedb.org") {
    const p = url.pathname;
    if (p.includes("/find/")) { const t = TMDB[p.split("/").pop()]; return ok({ tv_results: t.tv ? [t.tv] : [], movie_results: t.mv ? [t.mv] : [] }); }
    const id = +p.split("/").pop(); const t = Object.values(TMDB).find(x => (x.tv || x.mv).id === id);
    const d = t.tv ? { name: params.language === "cs-CZ" ? t.cz : t.tv.name } : { title: params.language === "cs-CZ" ? t.cz : t.mv.title };
    if (/alternative_titles/.test(params.append_to_response || "")) d.alternative_titles = t.alt;
    return ok(d);
  }
  const s = cfg.params.search, page = cfg.params.page || 0;
  const words = norm(s).split(" ");
  const hits = DB.filter(t => words.every(w => norm(t.n).includes(w)));
  const slice = hits.slice(page * PER, page * PER + PER);
  const pages = Math.ceil(hits.length / PER);
  const pag = Array.from({ length: pages }, (_, i) => `<a href="torrents_v2.php?search=x&page=${i}">${i + 1}</a>`).join("");
  return ok(`<table>${slice.map(t => `<tr><td><b>${t.c}</b><a href="details.php?id=${t.hash}" title="${t.n}"><img src="p.jpg"></a> Velkost 1 GB | Odosielaju : 3</td></tr>`).join("")}</table>${pag}`);
};
const setDB = (rows) => { DB = rows.map(([n, c], i) => ({ n, c, hash: h(i + 1) })); };

const M = require(P + "/lib/matching");
const { getTitle } = require(P + "/lib/meta");
const { findTorrents } = require(P + "/lib/search");
const { makeJudge } = require(P + "/tools/replay");

(async () => {
  // 1) Víc sezón v jednom torrentu
  const ss = (n) => [...(M.seasonSet(n) || [])];
  eq("Season 1-4", ss("Vymítač Boner / Bogdan Boner: Egzorcysta - Season 1-4 (2020-2023)"), [1, 2, 3, 4]);
  eq("Season 1 & 2", ss("Arcane / Arcane: League of Legends (Season 1 & 2)(2021-2024)[2160p]"), [1, 2]);
  eq("(S1-S2)", ss("Arcane - League of Legends (S1-S2)(2021-2024)(CZ)"), [1, 2]);
  eq("1-5. série (beze změny)", ss("Perníkový táta / Breaking Bad 1-5. série komplet (CZ)"), [1, 2, 3, 4, 5]);
  eq("1. a 2. série", ss("Dr. House 1. a 2. série (CZ)"), [1, 2]);
  eq("Série 1, 2 a 3", ss("Show Série 1, 2 a 3"), [1, 2, 3]);
  eq("S01-S03 (beze změny)", ss("Vigil S01-S03 (EN)[WebRip][1080p][HEVC]"), [1, 2, 3]);
  eq("„Season 1 - 04“ je epizoda, ne sezóny", ss("Show Season 1 - 04 [1080p]"), []);
  eq("„S01 - 04“ není rozsah sezón", ss("Show S01 - 04"), []);
  eq("jedna sezóna není rozsah", [ss("Show 2. série (2009)"), ss("Show Season 2 (2020)"), ss("Show S01E01-E10")], [[], [], []]);
  const V = "Seriál Vymítač Boner / Bogdan Boner: Egzorcysta - Season 1-4 (2020-2023)";
  const f25 = M.episodeFilters(2, 5), f11 = M.episodeFilters(1, 1), f61 = M.episodeFilters(6, 1);
  eq("Vymítač S02E05: balík", f25.isBatchSeason(V), true);
  eq("Vymítač S01E01: balík, ale ne „balík naší sezóny“", [f11.isBatchSeason(V), f11.isSeasonPack(V)], [true, false]);
  eq("Vymítač S06E01: jiné sezóny", [f61.isBatchSeason(V), f61.isNoSeasonCandidate(V), f61.rejectReason(V)], [false, false, "jiné sezóny (S01-S04)"]);
  eq("Arcane S02: oba balíky", ["Arcane - League of Legends (S1-S2)(2021-2024)(CZ)", "Arcane / Arcane: League of Legends (Season 1 & 2)(2021-2024)"].map(n => M.episodeFilters(2, 1).isBatchSeason(n)), [true, true]);
  eq("S02 balík pořád „balík naší sezóny“", M.episodeFilters(2, 1).isSeasonPack("Show S02 (CZ)"), true);

  // 2) Rok před začátkem seriálu
  const yc = M.makeSeriesYearCheck("2019", ["MOST!"]);
  eq("Most / Bron (2011) pro MOST! 2019 → pryč", yc("Seriál Most / Bron 1.serie (2011)(CZ)[WebRip]"), "rok před začátkem seriálu (2011 < 2019)");
  eq("MOST! (2019), bez roku, rozsah přes start → projde", [yc("Most! S01E01 (CZ)(2019)"), yc("Most / Bron/Broen / The Bridge S01-S04"), yc("Show (2011-2020)"), yc("Show (2018)")], [null, null, null, null]);
  eq("rok v našem názvu se nepočítá (1923)", M.makeSeriesYearCheck("2022", ["1923"])("1923 S01E01 [1080p]"), null);
  eq("bez roku TMDB nic neodmítá", M.makeSeriesYearCheck("", ["X"])("X (1990)"), null);

  // 4) Lomítko „⁄“
  const st = M.makeStrictTitleMatcher(["MobLand", "Země gangů"]);
  eq("„Země gangů ⁄ MobLand“ projde", st("Stiahni si Seriál Země gangů ⁄ MobLand 1. série (CZ⁄EN)[1080p][WEB-DL]", "Seriál"), true);
  eq("i ∕ a ／", [st("Země gangů ∕ MobLand S01", ""), st("Země gangů ／ MobLand S01", "")], [true, true]);

  // 3) Alternativní názvy z TMDB
  const arc = await getTitle("tt1", "k".repeat(32), "series");
  eq("Arcane: alt jen US/GB/CZ/SK, začíná naším názvem, se slovy", arc.alt, ["Arcane: League of Legends"]);
  const bat = await getTitle("tt2", "k".repeat(32), "series");
  eq("Batman: „Batman '66“ (jen číslo) není alt", bat.alt, []);
  eq("„Batman: The Animated Series“ pro Batman dál neprojde", M.makeStrictTitleMatcher([bat.en, bat.cz, ...bat.alt])("Batman: The Animated Series S01 (CZ)", "Seriál"), false);
  const up = await getTitle("tt3", "k".repeat(32), "movie");
  eq("film: alt z .titles; „Up 3D“ (bez slova) ne", up.alt, []);
  const strictArc = M.makeStrictTitleMatcher([arc.en, arc.cz, ...arc.alt]);
  eq("„Arcane: League of Legends S02“ projde s alt názvem", strictArc("Stiahni si Seriál Arcane: League of Legends S02 (CZ/EN)[WEB-DL][1080p]", "Seriál"), true);
  eq("bez alt názvu neprojde (jako dřív)", M.makeStrictTitleMatcher(["Arcane"])("Arcane: League of Legends S02 (CZ/EN)", "Seriál"), false);
  eq("cizí „Arcane Legends“ neprojde ani s alt", strictArc("Arcane Legends S01", "Seriál"), false);

  // Hledání: Arcane S02E03 — epizoda na SKT není, balík S02 s podtitulem a balíky S1-S2 ano
  setDB([
    ["Arcane: League of Legends S02 (CZ/EN)[WEB-DL][1080p]", "Seriál"],
    ["Arcane - League of Legends (S1-S2)(2021-2024)(CZ)", "Seriál"],
    ["Arcane / Arcane: League of Legends (Season 1 & 2)(2021-2024)(CZ/EN)[2160p][Remux]", "Seriál"],
    ["Arcane: League of Legends S01 (CZ/EN)", "Seriál"],
    ["Arcane Legends S01", "Seriál"]
  ]);
  let r = await findTorrents({ type: "series", season: 2, episode: 3, titles: { ...arc } });
  eq("Arcane S02E03: 3 balíky (S02 podtitul + 2× S1-S2)", r.batchTorrents.map(t => t.name.slice(0, 30)).sort(),
    ["Arcane - League of Legends (S1", "Arcane / Arcane: League of Leg", "Arcane: League of Legends S02 "]);

  // Hledání: MOST! 2019 — skandinávský Most / Bron (2011) pryč
  setDB([
    ["Most! S01E01 (CZ)(2019)[1080p]", "Seriál"],
    ["Most / Bron 1.serie (2011)(CZ)[WebRip][720pLQ]", "Seriál"],
    ["Most / Bron - 1.serie (2011)(CZ)[TvRip]", "Seriál"]
  ]);
  r = await findTorrents({ type: "series", season: 1, episode: 1, titles: { en: "MOST!", cz: "MOST!", sk: "MOST!", year: "2019" } });
  eq("MOST! S01E01: jen vlastní epizoda", [r.torrents.map(t => t.name.slice(0, 12)), r.batchTorrents.length], [["Most! S01E01"], 0]);
  eq("důvod v archivu", r.audit.torrents.filter(a => !a.ok).map(a => a.reason), ["rok před začátkem seriálu (2011 < 2019)", "rok před začátkem seriálu (2011 < 2019)"]);

  // Hledání: Vymítač Boner S03E04 — balík Season 1-4
  setDB([["Vymítač Boner / Bogdan Boner: Egzorcysta - Season 1-4 (2020-2023)", "Seriál"], ["Vymítač Boner S06E01 (CZ)", "Seriál"]]);
  r = await findTorrents({ type: "series", season: 3, episode: 4, titles: { en: "Bad Exorcist", cz: "Vymítač Boner", sk: "Bogdan Boner: Egzorcysta", year: "2020" } });
  eq("Vymítač S03E04: balík Season 1-4", r.batchTorrents.map(t => t.name.slice(0, 13)), ["Vymítač Boner"]);

  // Replay používá stejnou logiku (alt názvy i rok z archivu)
  const j = makeJudge({ kind: "stream", type: "series", id: "tt8610916:1:1", year: "2019", titles: { en: "MOST!", cz: "MOST!", sk: "MOST!" } });
  eq("replay: rok před začátkem", j({ n: "Stiahni si Seriál Most / Bron 1.serie (2011)(CZ)", cat: "Seriál" }).ok, false);
  const j2 = makeJudge({ kind: "stream", type: "series", id: "tt1:2:1", year: "2021", titles: { en: "Arcane", cz: "Arcane", sk: "", alt: ["Arcane: League of Legends"] } });
  eq("replay: alt názvy z archivu", j2({ n: "Stiahni si Seriál Arcane: League of Legends S02 (CZ/EN)", cat: "Seriál" }), { ok: true, r: "balík" });

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})();
