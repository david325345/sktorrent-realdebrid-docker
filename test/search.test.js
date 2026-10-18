// Test hledání: simulované SKT se stránkováním (od nejnovějších) a kategoriemi
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0; const q = [];
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const h = (i) => i.toString(16).padStart(40, "0");
// Databáze SKT: [název, kategorie], seřazeno od nejnovějšího
const DB = [
  ["TTS - Tim Lebbon - Predator - Vpad (2016) (CZ)", "Mluvené slovo"],
  ["Predátor: Nebezpečné území / Predator: Badlands (2025)[2160p]", "Filmy s titulkami"],
  ["Predator: Badlands (Original Motion Picture Soundtrack)", "Soundtrack"],
  ["Predátor: Evoluce / The Predator (2018)(CZ/EN)[2160p]", "Filmy CZ/SK dabing"],
  ...Array.from({ length: 30 }, (_, i) => [`Predator Something ${i} (2010)`, "Filmy CZ/SK dabing"]),
  ["Predátor 1-5. filmů / Predator 1-5. movie (1987-2022)(CZ/EN)[1080p]", "HD Filmy"],
  ["Predátor / Predator (1987)(CZ/EN)[1080p]", "Blu-ray Filmy"],
  ["Predátor 2 / Predator 2 (1990)(CZ/EN)[2160p]", "UHD Filmy"],
  ["Perníkový táta / Breaking Bad S02E01 (CZ)", "Seriál"],
  ["Perníkový táta: Film / El Camino: A Breaking Bad Movie (2019)", "Filmy s titulkami"],
  ["Perníkový táta / Breaking Bad 1-5. série komplet (CZ)", "Seriál"],
  ...Array.from({ length: 30 }, (_, i) => [`Perníkový táta fanvideo ${i} S09E0${i % 9}`, "Seriál"]),
  ["Perníkový táta / Breaking Bad 2. série (2009)(CZ)", "Seriál"]
].map(([n, c], i) => ({ n, c, hash: h(i + 1) }));
const PER = 24;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
axios.defaults.adapter = async (cfg) => {
  await new Promise(r => setTimeout(r, +(process.env.LAT || 0)));
  const s = cfg.params.search, page = cfg.params.page || 0; q.push(`${s}${page ? " p" + page : ""}`);
  const words = norm(s).split(" ");
  const hits = DB.filter(t => words.every(w => norm(t.n).includes(w)));
  const slice = hits.slice(page * PER, page * PER + PER);
  const pages = Math.ceil(hits.length / PER);
  const pag = Array.from({ length: pages }, (_, i) => `<a href="torrents_v2.php?search=x&page=${i}">${i + 1}</a>`).join("");
  const html = `<table>${slice.map(t => `<tr><td><b>${t.c}</b><a href="details.php?id=${t.hash}" title="${t.n}"><img src="p.jpg"></a> Velkost 1 GB | Odosielaju : 3</td></tr>`).join("")}</table>${pag}`;
  return { data: html, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} };
};
const { findTorrents } = require(P + "/lib/search");
const { pickMovieFile, isMoviePack, buildSearchNames } = require(P + "/lib/matching");
(async () => {
  let r = await findTorrents({ type: "movie", titles: { en: "Predator", cz: "Predátor", year: "1987" } });
  eq("Predator 1987: nalezeno", r.torrents.map(t => t.name.slice(0, 20)), ["Predátor 1-5. filmů ", "Predátor / Predator "]);
  eq("Predator: dotazy", q.splice(0), ["Predator 1987"]);
  r = await findTorrents({ type: "movie", titles: { en: "Predator 2", year: "1990" } });
  eq("Predator 2 (1990): ne původní 1987", r.torrents.map(t => t.name.slice(0, 20)), ["Predátor 2 / Predato"]);
  q.splice(0);
  eq("kolekce rozpoznána", ["Predátor 1-5. filmů / Predator 1-5. movie (1987-2022)", "Predátor / Predator (1987)(CZ/EN)[1080p]", "AVP I+II (2004-2007)", "Prey (2022) HDR10+ 5.1"].map(isMoviePack), [true, false, true, false]);

  // Rok na SKT jiný než v TMDB (±1) → fallback bez roku přes stránky
  r = await findTorrents({ type: "movie", titles: { en: "Predator 2", year: "1991" } });
  eq("Predator 2 (TMDB 1991, SKT 1990) přes stránky", r.torrents.map(t => t.name.slice(0, 20)).sort(), ["Predátor 1-5. filmů ", "Predátor 2 / Predato"]);
  console.log("   dotazy:", q.splice(0).join(" | "));

  // Seriál: film a nevideo kategorie pryč, komplet a 2. série z dalších stránek
  r = await findTorrents({ type: "series", season: 2, episode: 1, titles: { en: "Breaking Bad", cz: "Perníkový táta" } });
  eq("Perníkový táta S02E01 epizody", r.torrents.map(t => t.name), ["Perníkový táta / Breaking Bad S02E01 (CZ)"]);
  eq("balíky (bez filmu)", r.batchTorrents.map(t => t.name).sort(), ["Perníkový táta / Breaking Bad 1-5. série komplet (CZ)", "Perníkový táta / Breaking Bad 2. série (2009)(CZ)"].sort());
  console.log("   dotazy:", q.splice(0).join(" | "));

  eq("názvy bez duplicit diakritiky", buildSearchNames({ en: "Predator: Badlands", cz: "Predátor: Nebezpečné území" }), { en: ["Predator Badlands", "Predator"], cz: ["Predátor Nebezpečné území"], sk: [] });

  const F = (n) => n.map((x, i) => ({ id: i, name: x, size: 100 + i }));
  const pk = (n, y, t) => (pickMovieFile(F(n), y, t) || {}).name || null;
  const pack = ["Predator/Predator.1987.1080p.mkv", "Predator/Predator.2.1990.1080p.mkv", "Predator/The.Predator.2018.mkv", "Predator/Prey.2022.mkv"];
  eq("kolekce: rok 1987", pk(pack, "1987", "predator"), "Predator/Predator.1987.1080p.mkv");
  eq("kolekce: rok 1990", pk(pack, "1990", "predator 2"), "Predator/Predator.2.1990.1080p.mkv");
  eq("kolekce bez roků: název, ne pokračování", pk(["Predator 2.mkv", "Predator.mkv", "Predators.mkv"], "", "predator"), "Predator.mkv");
  eq("kolekce: nic nesedí → null", pk(["A.mkv", "B.mkv"], "1987", "predator"), null);
  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})();
