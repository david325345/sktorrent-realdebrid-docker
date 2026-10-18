const P = process.argv[2] || require("path").join(__dirname, "..");
const { episodeFilters, makeTitleMatcher, pickEpisodeFile, filterYear } = require(P + "/lib/matching");
let fail = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name} → ${JSON.stringify(got)}${ok ? "" : " (čekáno " + JSON.stringify(exp) + ")"}`); };

// Titulky
const m = (s, t) => makeTitleMatcher(s)(t);
eq("Blade Runner 2049", m("Blade Runner 2049", "Stiahni si Filmy Blade Runner 2049 (2017) CZ dabing"), true);
eq("1917", m("1917", "1917 / 1917 (2019) 1080p CZ"), true);
eq("2012", m("2012", "2012 (2009) CZ dabing"), true);
eq("Up ≠ Supernatural", m("Up", "Supernatural S01 CZ"), false);
eq("Up = Up", m("Up", "Up / Vzhůru do oblak (2009)"), true);
eq("Dune: rok za názvem", m("Dune", "Dune 2021 2160p CZ"), true);
eq("Přeházené/tečky", m("The Office", "The.Office.US.S01E01.CZ"), true);
eq("Jiný film", m("Blade Runner 2049", "Blade Runner (1982) CZ"), false);

// Filtry epizod
const f = episodeFilters(1, 5);
eq("exact S01E05", f.matchesExactEpisode("Show S01E05 CZ"), true);
eq("exact ne S01E050", f.matchesExactEpisode("Show S01E050"), false);
eq("exact ne rozsah", f.matchesExactEpisode("Show S01E05-E08"), false);
eq("batch rozsah obsahuje", f.isBatchSeason("Show S01E01-E10 CZ"), true);
eq("batch rozsah neobsahuje", f.isBatchSeason("Show S01E06-E10 CZ"), false);
eq("batch rozsah jiná sezóna", f.isBatchSeason("Show S02E01-E10 CZ"), false);
eq("batch S01 komplet", f.isBatchSeason("Show S01 1080p CZ"), true);
eq("batch 1. serie", f.isBatchSeason("Seriál 1. série CZ"), true);
eq("batch S01-S03", f.isBatchSeason("Show S01-S03 CZ"), true);
eq("1920x1080 není epizoda", f.hasAnyEpisode("Show S01 1920x1080"), false);
eq("batch S01 s 1920x1080", f.isBatchSeason("Show S01 1920x1080 CZ"), true);
eq("noSeason 1-5 ne (S02)", f.isNoSeasonCandidate("Show S02 CZ"), false);
eq("noSeason bez čísla", f.isNoSeasonCandidate("Show CZ dabing"), true);

// Výběr souboru
const files = (names) => names.map((n, i) => ({ id: i, name: n, size: 1000 + i }));
const pick = (names, s, e) => { const r = pickEpisodeFile(files(names), s, e); return r ? r.name : null; };
eq("S01E05", pick(["Show/Show.S01E01.mkv", "Show/Show.S01E05.mkv", "Show/Show.S01E10.mkv"], 1, 5), "Show/Show.S01E05.mkv");
eq("1x05", pick(["Show 1x01.avi", "Show 1x05.avi", "Show 11x05.avi"], 1, 5), "Show 1x05.avi");
eq("11x05 ne pro S1", pick(["Show 11x05.avi", "Show 11x06.avi"], 1, 5), null);
eq("' - 05'", pick(["[Grp] Show - 04 [1080p].mkv", "[Grp] Show - 05 [1080p].mkv"], 1, 5), "[Grp] Show - 05 [1080p].mkv");
eq("05. díl", pick(["Seriál 04. díl.avi", "Seriál 05. díl.avi"], 1, 5), "Seriál 05. díl.avi");
eq("multi-season složky", pick(["Show/Season 1/05.mkv", "Show/Season 2/05.mkv"], 2, 5), "Show/Season 2/05.mkv");
eq("S02 soubory, chci S1E5", pick(["Show.S02E05.mkv", "Show.S02E06.mkv"], 1, 5), null);
eq("nenalezeno → null (žádný fallback)", pick(["a.mkv", "b.mkv"], 1, 5), null);
eq("jediné video", pick(["film.mkv", "info.nfo"], 1, 5), "film.mkv");
eq("sample ignorován", pick(["Show.S01E05.sample.mkv", "Show.S01E05.mkv"], 1, 5), "Show.S01E05.mkv");
eq("AAC 2.0 není E2", pick(["Show AAC 2.0 x.mkv", "Show - 02.mkv"], 1, 2), "Show - 02.mkv");
eq("10bit není E10", pick(["Show 10bit - 01.mkv", "Show 10bit - 10.mkv"], 1, 10), "Show 10bit - 10.mkv");
eq("film: největší", pickEpisodeFile([{ name: "a.mkv", size: 5 }, { name: "b.mkv", size: 9 }]).name, "b.mkv");

eq("rok filtr", filterYear([{ name: "Dune 2021" }, { name: "Dune 1984" }, { name: "Dune" }], "2021").map(x => x.name), ["Dune 2021", "Dune"]);
console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK");
process.exit(fail ? 1 : 0);
