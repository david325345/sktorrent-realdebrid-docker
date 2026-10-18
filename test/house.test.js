const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0; const q = [];
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const h = (i) => (i + 1000).toString(16).padStart(40, "0");
// SKT od nejnovějších: nejdřív šum se „dr“/„house“/„seri“, sezónní balíky až hluboko
const DB = [
  ...Array.from({ length: 30 }, (_, i) => [`Rod Draka / House of the Dragon S0${1 + (i % 2)}E0${1 + (i % 8)} (2022)(CZ)[1080p]`, "Seriál"]),
  ...Array.from({ length: 20 }, (_, i) => [`VA - Deep House Drama Mix ${i} (2026)`, "Hudba"]),
  ...Array.from({ length: 30 }, (_, i) => [`Drsný seriál ${i} House serie S0${1 + (i % 3)} (CZ)`, "Seriál"]),
  ["Dr  House S08E22 1080p SK CZ EN BDrip", "Seriál"],
  ["Dr. House / House M.D. 1-8. serie (2004-2011)(CZ/SK/EN)[1080p] = CSFD 87%", "Seriál"],
  ...Array.from({ length: 25 }, (_, i) => [`Dramatická série ${i} / Drama House serial (2015)`, "Seriál"]),
  ["Dr. House / House M.D. 8. serie (2011)(CZ)[720p]", "Seriál"],
  ["Dr. House / House M.D. 6. serie (2009)(CZ)[720p]", "Seriál"],
  ["Dr. House 2.séria (2005)(SK)[DVDRip]", "Seriál"],
  ["Dr. House / House M.D. 2. serie (2005)(CZ)[720p]", "Seriál"],
  ["Dr. House / House M.D. 1. serie (2004)(CZ)[720p]", "Seriál"],
  ["Svet ve valce / The World At War E01-E26 (1973)(CZ) = CSFD 90%", "Dokument"],
  ["Svet ve valce / The World at War (1973)(CZ/EN)", "Dokument"],
  ["Mentalista / The Mentalist 1.-5 serie (2008-2012)(CZ)[TvRip]", "Seriál"],
  ["Mentalista / The Mentalist 6. serie (2013)(CZ)[TvRip]", "Seriál"],
  ["Kancl / The Office 1. série (2005)(CZ/EN)[1080p][HEVC]", "Seriál"],
  ["Kancl - Mini Série (2014) = CSFD 52%", "Seriál"],
].map(([n, c], i) => ({ n, c, hash: h(i) }));
const PER = 24;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
axios.defaults.adapter = async (cfg) => {
  const s = cfg.params.search, page = cfg.params.page || 0; q.push(`${s}${page ? " p" + page : ""}`);
  const words = norm(s).split(" ");
  const hits = DB.filter(t => words.every(w => norm(t.n).includes(w)));
  const slice = hits.slice(page * PER, page * PER + PER), pages = Math.ceil(hits.length / PER);
  const pag = Array.from({ length: pages }, (_, i) => `<a href="torrents_v2.php?search=x&page=${i}">${i + 1}</a>`).join("");
  return { data: `<table>${slice.map(t => `<tr><td><b>${t.c}</b><a href="details.php?id=${t.hash}" title="Stiahni si ${t.c} ${t.n}"><img src="p.jpg"></a> Velkost 1 GB | Odosielaju : 3</td></tr>`).join("")}</table>${pag}`, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} };
};
const { findTorrents } = require(P + "/lib/search");
const short = (l) => l.map(t => t.name.replace(/^Stiahni si (Seriál|Dokument) /, "").slice(0, 40));
(async () => {
  const T = { en: "House", cz: "Dr. House", sk: "Dr. House" };
  let r = await findTorrents({ type: "series", season: 2, episode: 1, titles: T });
  eq("S02E01 epizody", short(r.torrents), []);
  eq("S02E01 balíky", short(r.batchTorrents).sort(), ["Dr. House / House M.D. 1-8. serie (2004-", "Dr. House / House M.D. 2. serie (2005)(C", "Dr. House 2.séria (2005)(SK)[DVDRip]"].sort());
  console.log("   dotazy:", q.splice(0).join(" | "));
  r = await findTorrents({ type: "series", season: 8, episode: 22, titles: T });
  eq("S08E22 epizoda", short(r.torrents), ["Dr  House S08E22 1080p SK CZ EN BDrip"]);
  eq("S08E22 balíky", short(r.batchTorrents).sort(), ["Dr. House / House M.D. 1-8. serie (2004-", "Dr. House / House M.D. 8. serie (2011)(C"].sort());
  console.log("   dotazy:", q.splice(0).join(" | "));
  r = await findTorrents({ type: "series", season: 1, episode: 3, titles: T });
  eq("S01E03 balíky", short(r.batchTorrents).sort(), ["Dr. House / House M.D. 1-8. serie (2004-", "Dr. House / House M.D. 1. serie (2004)(C"].sort());
  console.log("   dotazy:", q.splice(0).join(" | "));
  r = await findTorrents({ type: "series", season: 1, episode: 26, titles: { en: "The World at War", cz: "Svět ve válce", sk: "Svet vo vojne" } });
  eq("Svět ve válce: balík E01-E26 + komplet bez sezóny (na konci)", short(r.batchTorrents), ["Svet ve valce / The World At War E01-E26", "Svet ve valce / The World at War (1973)("]);
  r = await findTorrents({ type: "series", season: 3, episode: 1, titles: { en: "The Mentalist", cz: "Mentalista" } });
  eq("Mentalista S03: rozsah 1.-5 serie", short(r.batchTorrents), ["Mentalista / The Mentalist 1.-5 serie (2"]);
  r = await findTorrents({ type: "series", season: 1, episode: 2, titles: { en: "The Office", cz: "Kancl" } });
  eq("Kancl S01: bez cizí „Kancl - Mini Série“", short(r.batchTorrents), ["Kancl / The Office 1. série (2005)(CZ/EN"]);
  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})();
