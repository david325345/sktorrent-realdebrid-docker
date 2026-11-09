// Opravy z nočních reportů 2026-11-03 až 2026-11-07 (v3.8.0): krátký název před „ - “ (KonoSuba),
// sezóna novější než TMDB zná (Apothecary Diaries S03), filmy — souběžné holé názvy, 1 stránka u nových,
// vynechaný střed názvu a prohozené části kolem dvojtečky; paměť přehrání pro „stahuje se“; čištění dotazů
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const h = (i) => i.toString(16).padStart(40, "0");

// ---------- simulované API ----------
const calls = [];
let DB = [];                // [hash, název, kategorie]
let LAT = 0;
const PER = 24;
const tb = { list: [] };
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const p = url.pathname; const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  calls.push({ at: Date.now(), u: `${url.host}${p}${params.search ? " " + params.search + (params.page ? " p" + params.page : "") : ""}` });
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host === "sktorrent.eu") {
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
    if (p.endsWith("/checkcached")) return ok({ success: true, data: {} });
    if (p.endsWith("/getqueued")) return ok({ success: true, data: [] });
    if (p.endsWith("/mylist")) return ok({ success: true, data: params.id ? tb.list.find(t => t.id == params.id) : tb.list });
  }
  throw new Error("Nemockovaná URL: " + cfg.url);
};
const skCalls = () => calls.filter(c => c.u.startsWith("sktorrent.eu")).map(c => c.u.replace("sktorrent.eu/torrent/torrents_v2.php ", ""));

const M = require(P + "/lib/matching");
const { normalizeQuery } = require(P + "/lib/util");
const skt = require(P + "/lib/skt");
const { findTorrents } = require(P + "/lib/search");
const { analyze } = require(P + "/tools/analyza");

(async () => {
  // ================= 1: krátký název před „ - “ =================
  const KONO_EN = "KONOSUBA – God's blessing on this wonderful world!";
  eq("dashShortNames: jen jedno slovo (6+ písmen) před pomlčkou a podtitul 3+ slova",
    M.dashShortNames([KONO_EN, "KONOSUBA - God's blessing on this wonderful world!", "Cyberpunk: Edgerunners", "Dune - Part Two", "Kancl - Mini Série", "Re:ZERO - Starting Life in Another World", "Arcane - League"]),
    ["KONOSUBA"]);
  DB = [
    [h(1), "KonoSuba - 2. serie + OVA / Kono subarashii sekai ni shukufuku wo 2 (2017)(JP/EN+CZtit.)[1080p][HEVC]", "Seriál"],
    [h(2), "KonoSuba - 1. serie + OVA / Kono subarashii sekai ni shukufuku wo (2016)(JP/EN+CZtit.)[1080p][HEVC]", "Seriál"],
    [h(3), "KonoSuba Legend Of Crimson / Kono subarashii sekai ni shukufuku wo! Kurenai densetsu (2019)(JP/EN+CZtit.)[1080p][HEVC]", "Filmy Kreslené"],
    [h(4), "Cyberpunk 2077 Phantom Liberty (2023)", "Hry"],
    [h(5), "Cyberpunk: Edgerunners S01 (2022)(CZ)", "Seriál"]
  ];
  calls.length = 0;
  let f = await findTorrents({ type: "series", season: 2, episode: 1, titles: { en: KONO_EN, cz: "", sk: "", year: "2016", seasonYears: { 1: "2016", 2: "2017", 3: "2024" } } });
  eq("KonoSuba S02E01: balík „KonoSuba - 2. serie“", [f.torrents.length, f.batchTorrents.map(t => t.hash)], [0, [h(1)]]);
  eq("KonoSuba: hledá se i krátký název", skCalls().some(q => /^KONOSUBA( |$)/.test(q)), true);
  f = await findTorrents({ type: "series", season: 1, episode: 3, titles: { en: KONO_EN, cz: "", sk: "", year: "2016", seasonYears: { 1: "2016", 2: "2017" } } });
  eq("KonoSuba S01E03: balík 1. série (ne 2.)", f.batchTorrents.map(t => t.hash), [h(2)]);
  calls.length = 0;
  f = await findTorrents({ type: "series", season: 2, episode: 1, titles: { en: "Cyberpunk: Edgerunners", cz: "", sk: "", year: "2022", seasonYears: { 1: "2022", 2: "2026" } } });
  eq("protipříklad s dvojtečkou: „Cyberpunk“ se samo nehledá", skCalls().some(q => /^Cyberpunk( S0\d.*)?$/.test(q) && !/Edgerunners/.test(q)), false);

  // Výběr souboru z balíku „+ OVA“: díl, nikdy OVA
  const F = (a) => a.map((n, i) => ({ id: i, name: n, size: 1e9 + i }));
  const pack = ["KonoSuba S2/[Judas] Kono Subarashii Sekai ni Shukufuku wo! 2 - 01.mkv", "KonoSuba S2/[Judas] Kono Subarashii Sekai ni Shukufuku wo! 2 - 02.mkv", "KonoSuba S2/[Judas] Kono Subarashii Sekai ni Shukufuku wo! 2 - OVA.mkv"];
  eq("„+ OVA“: S02E01 → díl 01, S02E03 (není) → nic", [M.pickEpisodeFile(F(pack), 2, 1)?.name.slice(-10), M.pickEpisodeFile(F(pack), 2, 3)], ["2 - 01.mkv", null]);

  // ================= 2: sezóna novější než TMDB zná =================
  DB = [[h(11), "Kusuriya no Hitorigoto / Zápisky Lékárnice / The Apothecary Diaries (2023-2025)(JP)[1080p]", "Seriál"]];
  const APO = { en: "The Apothecary Diaries", cz: "Deníky apatykářky", sk: "", year: "2023", seasonYears: { 1: "2023", 2: "2025" } };
  f = await findTorrents({ type: "series", season: 3, episode: 7, titles: APO });
  eq("Apothecary S03 (TMDB zná jen S01–S02): balík 2023-2025 odmítnut", [f.batchTorrents.length, f.audit.torrents[0].reason, f.seasonAfter], [0, "starší řada (roky do 2025, S03 je novější)", 2025]);
  f = await findTorrents({ type: "series", season: 2, episode: 7, titles: APO });
  eq("Apothecary S02: balík 2023-2025 projde jako dřív", f.batchTorrents.length, 1);
  eq("lastKnownSeasonYear", [M.lastKnownSeasonYear({ 1: "2023", 2: "2025" }, 3), M.lastKnownSeasonYear({ 1: "2023", 2: "2025" }, 2), M.lastKnownSeasonYear({}, 3), M.lastKnownSeasonYear(undefined, 3)], [2025, null, null, null]);

  // ================= 6+7: filmy s přesně sedícím rokem =================
  const kf = M.makeStrictTitleMatcher(["KONOSUBA – God's blessing on this wonderful world! Legend of Crimson", "この素晴らしい世界に祝福を！紅伝説"], { colonNeedsYear: true, filmYear: "2019" });
  const KF = "Filmy Kreslené KonoSuba Legend Of Crimson / Kono subarashii sekai ni shukufuku wo! Kurenai densetsu (2019)(JP/EN+CZtit.)[1080p][HEVC]";
  eq("vynechaný střed: KonoSuba Legend of Crimson (2019) projde", kf(KF, "Filmy Kreslené"), true);
  eq("vynechaný střed: jiný rok / 1 slovo konce / jiná slova neprojdou", [kf(KF.replace("2019", "2020"), "Filmy Kreslené"), kf("KonoSuba Crimson (2019)", ""), kf("KonoSuba World Legend (2019)", ""), kf("Legend of Crimson (2019)", "")], [false, false, false, false]);
  const nf = M.makeStrictTitleMatcher(["The Last: Naruto the Movie", "Poslední Naruto"], { colonNeedsYear: true, filmYear: "2014" });
  eq("prohozené části: Naruto the Movie: The Last (2014) projde, s jiným rokem ne", [nf("Filmy s titulkama Naruto the Movie: The Last (2014)[720p]", "Filmy s titulkama"), nf("Naruto the Movie: The Last (2015)", ""), nf("Naruto the Movie (2014)", "")], [true, false, false]);
  eq("bez filmYear (seriály) se nic nemění", M.makeStrictTitleMatcher(["The Last: Naruto the Movie"])("Naruto the Movie: The Last (2014)", ""), false);
  DB = [[h(3), "KonoSuba Legend Of Crimson / Kono subarashii sekai ni shukufuku wo! Kurenai densetsu (2019)(JP/EN+CZtit.)[1080p][HEVC]", "Filmy Kreslené"],
        [h(1), "KonoSuba - 2. serie + OVA / Kono subarashii sekai ni shukufuku wo 2 (2017)(JP/EN+CZtit.)[1080p][HEVC]", "Seriál"]];
  f = await findTorrents({ type: "movie", titles: { en: "KONOSUBA – God's blessing on this wonderful world! Legend of Crimson", cz: "", year: "2019" } });
  eq("film KonoSuba 2019: jen film, ne seriál", f.torrents.map(t => t.hash), [h(3)]);

  // ================= 3+5: filmy — holé názvy souběžně, nový film 1 stránka =================
  skt._resetBreaker();
  DB = Array.from({ length: 60 }, (_, i) => [h(100 + i), `Andělské vejce fanart ${i} (19${50 + (i % 30)})`, "Filmy CZ/SK dabing"]);
  LAT = 300; calls.length = 0;
  let t0 = Date.now();
  f = await findTorrents({ type: "movie", titles: { en: "Angel's Egg", cz: "Andělské vejce", sk: "Anjelské vajce", year: "1985" } });
  const took = Date.now() - t0;
  const bare = skCalls().filter(q => !/\b1985\b/.test(q));
  eq("starý film: holé názvy CZ/EN/SK souběžně + další stránky jen u CZ", bare, ["Andělské vejce", "Angel s Egg", "Anjelské vajce", "Andělské vejce p1", "Andělské vejce p2"]);
  eq("starý film: 2 souběžná kola + 2 stránky (≈ 5 dotazů času, ne 8)", took < 2600, true);
  const year = new Date().getFullYear();
  DB = Array.from({ length: 60 }, (_, i) => [h(200 + i), `The Beast ${i} (${1990 + (i % 30)})`, "Filmy CZ/SK dabing"]);
  calls.length = 0;
  f = await findTorrents({ type: "movie", titles: { en: "The Beast", cz: "", sk: "", year: String(year) } });
  eq("letošní film: holý název jen 1 stránka", skCalls().filter(q => !new RegExp(`\\b${year}\\b`).test(q)), ["The Beast"]);
  LAT = 0;

  // ================= 8: čištění dotazů =================
  eq("dotaz bez ●● a interpunkce", [normalizeQuery("Sósó no Frieren: ●● no mahó S01E01"), normalizeQuery("Angel's Egg 1985"), normalizeQuery("Top Gun™ × 2")], ["Sósó no Frieren no mahó S01E01", "Angel s Egg 1985", "Top Gun 2"]);

  // ================= 4: paměť přehrání pro „stahuje se“ =================
  process.env.PUBLIC_URL = "";
  const app = require(P + "/index.js");
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const TOK = "--TMDBKEY--uid1--pass1--0--TBKEY";
  tb.list = [{ id: 5, hash: h(500), download_state: "downloading", progress: 0.1, created_at: new Date().toISOString(), files: [] }];
  calls.length = 0;
  let res;
  for (let i = 0; i < 5; i++) res = await fetch(`${base}/${TOK}/play/tb/${h(500)}/e/1/1/video.mp4`, { redirect: "manual" });
  const tbCalls = calls.filter(c => /torbox/.test(c.u)).length;
  eq("stahuje se: 5 opakování přehrávače → info video, TorBox jen při prvním", [res.status, /downloading\.mp4$/.test(res.headers.get("location") || ""), tbCalls <= 2], [302, true, true]);
  srv.close();

  // analyza: dávka opakování přehrávače ≠ mrtvý torrent; 3 samostatné pokusy ano
  const play = (t, hh) => ({ t, kind: "play", prov: "tb", h: hh, n: "Stiahni si Seriál Ostré předměty S01", sel: { season: 1, episode: 1 }, status: "downloading", progress: 0, state: "metaDL" });
  const burst = ["2026-11-06T10:00:00.100Z", "2026-11-06T10:00:00.400Z", "2026-11-06T10:00:01.900Z", "2026-11-06T10:00:02.600Z"].map(t => play(t, h(600)));
  const three = ["2026-11-06T10:00:00Z", "2026-11-06T10:20:00Z", "2026-11-06T12:00:00Z"].map(t => play(t, h(601)));
  const an = analyze([...burst, ...three]);
  eq("analyza: 4 záznamy během 3 s = 1 pokus; 3 pokusy s pauzou = mrtvý torrent", [an.counts.stuck, /\| tb \| 3 \(3\) \|/.test(an.markdown), /\| tb \| 1 \(4\) \|/.test(an.markdown)], [1, true, false]);

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
