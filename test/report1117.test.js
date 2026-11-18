// Opravy z nočního reportu 2026-11-17 (v3.9.2): rychlé chyby SKT a jistič (http status, 429, opakování),
// „N. část“ v názvu filmu (Fear Street), „náš název - podtitul / cizí název“ (Saint Seiya), dokument o filmu
// (Total Recall), NFC a latinský začátek uvnitř slova (Ovečka Shaun, To LOVEる), starý seriál s rokem premiéry (seaQuest)
process.env.SKT_SEARCH_BUDGET_MS = "8000";
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const h = (i) => i.toString(16).padStart(40, "0");

// ---------- simulované SKT ----------
let DB = [];
let mode = "ok";            // ok | 404 | 429 | timeout | 404once
let calls = 0;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const httpErr = (status, headers = {}) => { const e = new Error(`Request failed with status code ${status}`); e.response = { status, headers, data: "" }; return e; };
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host !== "sktorrent.eu") throw new Error("Nemockovaná URL: " + cfg.url);
  calls++;
  if (mode === "404") throw httpErr(404);
  if (mode === "404once") { mode = "ok"; throw httpErr(404); }
  if (mode === "429") throw httpErr(429, { "retry-after": "7" });
  if (mode === "timeout") throw Object.assign(new Error("timeout of 20000ms exceeded"), { code: "ECONNABORTED" });
  const words = norm(String(params.search)).split(" ");
  const hits = DB.filter(([, n]) => words.every(w => norm(n).includes(w)));
  return ok(`<table>${hits.map(([hh, n, c]) => `<tr><td><b>${c}</b><a href="details.php?id=${hh}" title="${n}"><img src="p.jpg"></a> Velkost 1 GB | Odosielaju : 3</td></tr>`).join("")}</table>`);
};

const M = require(P + "/lib/matching");
const { normalizeQuery } = require(P + "/lib/util");
const skt = require(P + "/lib/skt");
const { findTorrents } = require(P + "/lib/search");

(async () => {
  // ================= 1: rychlé chyby SKT =================
  skt._resetBreaker(); mode = "404"; calls = 0;
  let r = await skt.searchSKTPage("Tulsa King S01E01", "", "", 0);
  eq("http 404: druh chyby + zpráva, jeden opakovaný pokus", [r.err, /404/.test(r.msg || ""), r.firstErr, calls], ["http 404", true, "http 404", 2]);
  await skt.searchSKTPage("Tulsa King", "", "", 0); await skt.searchSKTPage("VisionQuest", "", "", 0);
  eq("3× rychlá chyba neotevře jistič", skt.breakerOpen(), false);
  mode = "404once"; calls = 0;
  r = await skt.searchSKTPage("Bump S01E01", "", "", 0);
  eq("rychlá chyba a pak úspěch: výsledek bez chyby, označený opakováním", [r.err, r.retried, r.firstErr, calls], [undefined, true, "http 404", 2]);
  skt._resetBreaker(); mode = "timeout";
  for (const q of ["A1", "A2", "A3"]) await skt.searchSKTPage(q, "", "", 0);
  eq("3× timeout jistič otevře (beze změny)", skt.breakerOpen(), true);
  skt._resetBreaker(); mode = "429"; calls = 0;
  r = await skt.searchSKTPage("Dragon Ball Z", "", "", 0);
  const r2 = await skt.searchSKTPage("Dragon Ball Z S01", "", "", 0);
  eq("http 429: pauza podle Retry-After, další dotaz se neposílá, jistič zavřený", [r.err, r2.err, calls, skt.breakerOpen(), skt.isPaused("", "")], ["http 429", "pauza 429", 1, false, true]);
  skt._resetBreaker(); mode = "ok";

  // ================= 2: „N. část“ v názvu filmu =================
  const fs1666 = M.makeStrictTitleMatcher(["Fear Street: 1666", "Ulice strachu – 3. část: 1666"], { colonNeedsYear: true, filmYear: "2021" });
  eq("Fear Street 1666: oba torrenty z reportu + přesně stejný název",
    [fs1666("HD Filmy Ulice strachu - 3. cast: 1666 / Fear Street Part 3: 1666 (2021)(CZ/EN)[WebRip][1080p]", "HD Filmy"),
     fs1666("Filmy CZ/SK dabing Ulice strachu - 3. cast: 1666 / Fear Street Part 3: 1666 (2021)(CZ)[WebRip]", "Filmy CZ/SK dabing"),
     fs1666("Ulice strachu – 3. část: 1666 / Fear Street: 1666 (2021)", "")], [true, true, true]);
  eq("jiný díl (2. část: 1978) neprojde", [fs1666("Ulice strachu - 2. cast: 1978 / Fear Street Part 2: 1978 (2021)", ""), fs1666("Fear Street Part 2: 1978 (2021)", "")], [false, false]);
  eq("„Part 3“ bez přesného roku neprojde", fs1666("Fear Street Part 3: 1666 (2020)", ""), false);
  const fs1994 = M.makeStrictTitleMatcher(["Fear Street: 1994", "Ulice strachu – 1. část: 1994"], { colonNeedsYear: true, filmYear: "2021" });
  eq("Fear Street 1994: „Ulice strachu: 1 Cast: 1994“", fs1994("Filmy CZ/SK dabing Ulice strachu: 1 Cast: 1994 / Fear Street Part 1 1994 (2021)(CZ)[WebRip]", "Filmy CZ/SK dabing"), true);
  eq("seriály: „1. díl“ dál utíná název (bez čísla v našem názvu)", M.titleSegment("Ulice strachu 3. díl (CZ)", "", new Set()).trim(), "Ulice strachu");

  // ================= 3: podtitul v téže části / dokument o filmu =================
  const ss = M.makeStrictTitleMatcher(["Saint Seiya"]);
  eq("Saint Seiya (1986): remake „- Knights of the Zodiac / Rytiri zverokruhu“ neprojde v žádném pořadí",
    [ss("Seriál Saint Seiya - Knights of the Zodiac / Rytiri zverokruhu (S01)(720p)(x264)(WebDl)", "Seriál"), ss("Seriál SAINT SEIYA - Rytiri zverokruhu / Saint Seiya - Knights of the Zodiac (S01)(2019)", "Seriál")], [false, false]);
  eq("beze změny: Conan, Most!, Kill la Kill, KonoSuba, Zlatá sedmdesátá",
    [M.makeStrictTitleMatcher(["Detective Conan", "Detektiv Conan"])("Seriál Detektiv Conan - 1. série (CZ)", "Seriál"),
     M.makeStrictTitleMatcher(["MOST!"])("Most! - 1. serie (CZ)[WebRip][1080p]", "Seriál"),
     M.makeStrictTitleMatcher(["Kill la Kill"])("Seriál Kill la Kill - 1. serie + OVA", "Seriál"),
     M.makeStrictTitleMatcher(["KONOSUBA – God's blessing on this wonderful world!", "KONOSUBA"])("Seriál KonoSuba - 2. serie + OVA / Kono subarashii sekai ni shukufuku wo 2 (2017)", "Seriál"),
     M.makeStrictTitleMatcher(["Zlatá sedmdesátá"])("Zlatá sedmdesátá + Zlatá devadesátá - Komplet (CZ)", "Seriál")], [true, true, true, true, true]);
  eq("beze změny: CZ - EN název, Arcane - podtitul, 2 filmy přes pomlčku",
    [M.makeStrictTitleMatcher(["Vesničko má středisková", "My Sweet Little Village"])("HD Filmy Vesnicko ma strediskova - My Sweet Little Village (1985)(Remastered)(1080p)(CZ)", "HD Filmy"),
     M.makeStrictTitleMatcher(["Arcane"])("Seriál Arcane - League of Legends (S1-S2)(2021-2024)(CZ)", "Seriál"),
     M.makeStrictTitleMatcher(["Dobrý voják Švejk", "The Good Soldier Švejk"])("HD Filmy Dobrý voják Švejk - Poslušně hlásím (1956-1957)(CZ)[1080p]", "HD Filmy")], [true, true, true]);
  eq("dokument o filmu: jen když ho náš název nemá", [M.isMakingOf("Dokument Total Recall - Dokument o filmu (1990)(CZ)[1080p]", ["Total Recall", "Total Recall"]), M.isMakingOf("Making of Star Wars (2010)", ["Making of Star Wars"]), M.isMakingOf("Total Recall (1990)", ["Total Recall"])], [true, false, false]);
  DB = [[h(1), "Total Recall - Dokument o filmu (1990)(CZ)[1080p]", "Dokument"], [h(2), "Total Recall (1990)(CZ/EN)[1080p]", "HD Filmy"]];
  skt._resetBreaker();
  let f = await findTorrents({ type: "movie", titles: { en: "Total Recall", cz: "Total Recall", year: "1990" } });
  eq("Total Recall 1990: jen film, dokument s důvodem", [f.torrents.map(t => t.hash), f.audit.torrents.find(a => a.t.hash === h(1)).reason], [[h(2)], "dokument o filmu"]);

  // ================= 4: NFC a latinský začátek uvnitř slova =================
  const nfd = "Ovečka Shaun";
  eq("NFD „Ovečka“ → dotaz „Ovečka Shaun“", [normalizeQuery(nfd), M.buildSearchNames({ en: "Shaun the Sheep", cz: nfd }).cz[0]], ["Ovečka Shaun", "Ovečka Shaun"]);
  eq("„To LOVEる -とらぶる-“ → nic; „PSYREN サイレン“ beze změny", [M.latinName("To LOVEる -とらぶる-"), M.latinName("PSYREN サイレン"), M.latinName("PSYREN -サイレン-")], ["", "PSYREN", "PSYREN"]);

  // ================= 5: starý seriál s rokem premiéry =================
  const sq = M.makeSeasonYearCheck("1994", 2, ["seaQuest DSV", "Strážce moře"], { seriesYear: "1993" });
  eq("seaQuest (1993) pro S02 z 1994 neodmítnut", sq("Seriál Strážce moře / SeaQuest DSV (1993)(CZ/EN)[TvRip]"), null);
  const cy = M.makeSeasonYearCheck("2026", 2, ["Cyberpunk: Edgerunners"], { seriesYear: "2022" });
  eq("Cyberpunk: Edgerunners (2022) pro S02 z 2026 dál odmítnut", cy("Cyberpunk: Edgerunners (2022)(JP/EN)[1080p]"), "jiná sezóna (rok 2022 < 2026)");
  eq("starý seriál, ale torrent s jiným rokem než premiéra dál odmítnut", sq("Strážce moře (1992)"), "jiná sezóna (rok 1992 < 1994)");

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
