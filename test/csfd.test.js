// Tituly jen na ČSFD (csfd:ID / csfd:ID:S:E): názvy z csfd-ratings, ověření přes ČSFD odkaz v detailu torrentu
process.env.CSFD_URL = "http://csfd:7020";
process.env.CSFD_PUBLIC_URL = "https://csfd-public.example";
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const h = (i) => i.toString(16).padStart(40, "0");

// ---------- simulované API ----------
const calls = [];
let internalDown = false;
const META = {
  1001: { name: "Starý film", year: 1985, releaseInfo: "1985", titlesOther: [{ country: "Slovensko", title: "Starý film SK" }, { country: "USA", title: "Old Movie" }, { country: "Japonsko", title: "古い映画" }] },
  2002: { name: "Seriálek", year: 2019, releaseInfo: "2019", titlesOther: [{ country: "Slovensko", title: "Seriálik" }, { country: null, title: "Serialek Uncut" }] }
};
let DB = [];                    // [hash, název, kategorie, ČSFD ID z detailu | null]
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const skHtml = (items) => `<table>${items.map(([hh, n, c]) => `<tr><td><b>${c}</b><a href="details.php?id=${hh}" title="${n}"><img src="p.jpg"></a> Velkost 1.2 GB | Odosielaju : 5</td></tr>`).join("")}</table>`;
axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const p = url.pathname; const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  calls.push(`${url.host}${p}${params.search ? " " + params.search : ""}${params.id ? " " + params.id : ""}`);
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host === "csfd:7020" || url.host === "csfd-public.example") {
    if (url.host === "csfd:7020" && internalDown) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const m = p.match(/\/meta\/(movie|series)\/csfd:(\d+)\.json$/);
    const meta = m && META[m[2]];
    if (!meta) { const e = new Error("404"); e.response = { status: 404, data: {} }; throw e; }
    return ok({ meta: { id: `csfd:${m[2]}`, type: m[1], ...meta } });
  }
  if (url.host === "sktorrent.eu" && p.endsWith("/details.php")) {
    const row = DB.find(r => r[0] === params.id);
    if (!row) return ok("<html>Torrent nenalezen</html>");
    return ok(`<html><a href="download.php?id=${row[0]}">Stiahnuť</a>${row[3] ? `<a href="https://www.csfd.cz/film/${row[3]}-nazev/${row[3] + 7}-serie-1/">ČSFD</a>` : ""}</html>`);
  }
  if (url.host === "sktorrent.eu") {
    const words = norm(String(params.search)).split(" ");
    return ok(skHtml(DB.filter(([, n]) => words.every(w => norm(n).includes(w)))));
  }
  if (url.host === "api.torbox.app") {
    if (p.endsWith("/checkcached")) return ok({ success: true, data: {} });
    if (p.endsWith("/mylist") || p.endsWith("/getqueued")) return ok({ success: true, data: [] });
  }
  throw new Error("Nemockovaná URL: " + cfg.url);
};

const { parseCsfdId, titlesFromMeta, getCsfdTitle } = require(P + "/lib/csfd");
const skt = require(P + "/lib/skt");
const { findTorrents } = require(P + "/lib/search");
const { makeJudge } = require(P + "/tools/replay");

(async () => {
  // ---- ID a názvy ----
  eq("parseCsfdId", [parseCsfdId("csfd:12345"), parseCsfdId("csfd:12345:2:5"), parseCsfdId("tt0111161"), parseCsfdId("csfd:abc")],
    [{ csfdId: 12345 }, { csfdId: 12345, season: 2, episode: 5 }, null, null]);
  const tf = titlesFromMeta(META[1001], 1001);
  eq("názvy: CZ z name, SK ze Slovenska, EN z USA, ostatní jen do kontroly", [tf.cz, tf.sk, tf.en, tf.year, tf.alt, tf.source, tf.csfdId],
    ["Starý film", "Starý film SK", "Old Movie", "1985", ["古い映画"], "csfd", 1001]);
  eq("bez anglicky mluvící země: první latinkový název jiné země", titlesFromMeta({ name: "Film", titlesOther: [{ country: "Japonsko", title: "映画" }, { country: "Francie", title: "Le Film" }] }, 1).en, "Le Film");
  eq("staré záznamy s názvy jako řetězce / country null", titlesFromMeta({ name: "X", titlesOther: ["Y"] }, 1).alt, ["Y"]);

  // ---- csfd-ratings: interní adresa, záloha veřejná, cache ----
  internalDown = true; calls.length = 0;
  let t = await getCsfdTitle("movie", 1001);
  eq("interní adresa nedostupná → veřejná záloha", [t?.cz, calls.filter(c => /csfd-public/.test(c)).length], ["Starý film", 1]);
  calls.length = 0;
  t = await getCsfdTitle("movie", 1001);
  eq("druhé volání z cache (bez dotazu)", [t?.cz, calls.length], ["Starý film", 0]);
  internalDown = false; calls.length = 0;
  const ser = await getCsfdTitle("series", 2002);
  eq("interní adresa funguje → veřejná se nevolá", [ser?.cz, calls.map(c => c.split("/")[0])], ["Seriálek", ["csfd:7020"]]);
  eq("neexistující titul (404) → null bez zálohy", [await getCsfdTitle("movie", 999), calls.filter(c => /csfd-public/.test(c)).length], [null, 0]);

  // ---- ČSFD odkaz v detailu ----
  eq("csfdFromDetail: první ID v odkazu (u seriálu seriál)", [skt.csfdFromDetail('<a href="https://www.csfd.cz/film/2002-serialek/2009-serie-1/">'), skt.csfdFromDetail("bez odkazu")], [2002, null]);

  // ---- Hledání filmu csfd: ----
  DB = [
    [h(1), "Starý film (1985)(CZ)[1080p]", "Filmy CZ/SK dabing", 1001],             // sedí název i ČSFD
    [h(2), "Starý film: Návrat domů (1985)(CZ)", "Filmy CZ/SK dabing", 1001],        // název by neprošel, ČSFD sedí → projde
    [h(3), "Starý film (1985)(CZ)[720p] remake", "Filmy CZ/SK dabing", 999],         // název sedí, jiné ČSFD → vypadne
    [h(4), "Starý film (1985)(CZ)[DVDRip]", "Filmy CZ/SK dabing", null],             // bez odkazu → rozhoduje název
    [h(5), "Starý film (1985) soundtrack", "Soundtrack", null]                        // kategorie mimo → detail se nestahuje
  ];
  calls.length = 0;
  let f = await findTorrents({ type: "movie", titles: tf });
  eq("film: ČSFD sedí i s jiným názvem, jiné ČSFD vypadne", f.torrents.map(x => x.hash).sort(), [h(1), h(2), h(4)]);
  eq("film: důvod u vyřazeného", f.audit.torrents.find(a => a.t.hash === h(3)).reason, "jiné ČSFD (999)");
  eq("film: detail jen u povolených kategorií", calls.filter(c => /details\.php/.test(c)).length, 4);
  eq("film: csfdOf pro archiv", [...f.csfdOf].sort(), [[h(1), 1001], [h(2), 1001], [h(3), 999], [h(4), null]]);
  calls.length = 0;
  await findTorrents({ type: "movie", titles: tf });
  eq("opakované hledání: detaily z trvalé cache", calls.filter(c => /details\.php/.test(c)).length, 0);

  // ---- Seriál csfd:2002:1:2 ----
  DB = [
    [h(11), "Seriálek S01E02 (CZ)[1080p]", "Seriál", 2002],
    [h(12), "Seriálek / Other Show S01E02 (CZ)", "Seriál", 3003],                    // seriál stejného jména
    [h(13), "Seriálek 1. série (2015)(CZ)", "Seriál", 2002],                          // rok před začátkem (2019), ale ČSFD sedí
    [h(14), "Seriálek S01E03 (CZ)", "Seriál", 2002]                                  // jiný díl — kontrola dílu platí vždy
  ];
  f = await findTorrents({ type: "series", season: 1, episode: 2, titles: ser });
  eq("seriál: epizoda + balík se sedícím ČSFD", [f.torrents.map(x => x.hash), f.batchTorrents.map(x => x.hash)], [[h(11)], [h(13)]]);
  eq("seriál: jiný díl dál vypadne, jiné ČSFD vypadne", [f.audit.torrents.find(a => a.t.hash === h(14)).reason, f.audit.torrents.find(a => a.t.hash === h(12)).reason], ["jiný díl (S01E03)", "jiné ČSFD (3003)"]);
  eq("seriál: pořadí názvů CZ, SK (bez EN, nejvýš 3)", f.names, ["Seriálek", "Seriálik"]);

  // ---- Strop 8 detailů na hledání ----
  skt._resetBreaker();
  DB = Array.from({ length: 14 }, (_, i) => [h(100 + i), `Seriálek S01E0${(i % 9) + 1} verze ${i} (CZ)`, "Seriál", 2002]);
  calls.length = 0;
  await findTorrents({ type: "series", season: 1, episode: 5, titles: ser });
  eq("nejvýš 8 detailů za hledání", calls.filter(c => /details\.php/.test(c)).length, 8);

  // ---- Replay se záznamem ČSFD ----
  const j = makeJudge({ kind: "stream", type: "series", id: "csfd:2002:1:2", year: "2019", titles: { en: "", cz: "Seriálek", sk: "Seriálik" },
    torrents: [{ n: "Seriálek / Other Show S01E02 (CZ)", cat: "Seriál", csfd: 3003 }, { n: "Seriálek 1. série (2015)(CZ)", cat: "Seriál", csfd: 2002 }] });
  eq("replay: jiné ČSFD / ČSFD sedí přes rok", [j({ n: "Seriálek / Other Show S01E02 (CZ)", cat: "Seriál" }), j({ n: "Seriálek 1. série (2015)(CZ)", cat: "Seriál" }).ok],
    [{ ok: false, r: "jiné ČSFD (3003)" }, true]);

  // ---- HTTP: manifest a stream pro csfd: ----
  skt._resetBreaker();
  DB = [[h(21), "Seriálek S01E02 (CZ)[1080p]", "Seriál", 2002]];
  process.env.PUBLIC_URL = "";
  const app = require(P + "/index.js");
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const TOK = "--TMDBKEY--uid1--pass1--0--TBKEY";
  const man = await (await fetch(`${base}/${TOK}/manifest.json`)).json();
  eq("manifest: csfd: v idPrefixes (resource stream i nahoře)", [man.resources[0].idPrefixes.includes("csfd:"), man.idPrefixes.includes("csfd:")], [true, true]);
  const r = await (await fetch(`${base}/${TOK}/stream/series/${encodeURIComponent("csfd:2002:1:2")}.json`)).json();
  eq("stream csfd:2002:1:2 → TorBox stream s epizodou", [r.streams.length, /\/play\/tb\/0+15\/e\/1\/2\/video\.mp4$/.test(r.streams[0]?.url || "")], [1, true]);
  const r2 = await (await fetch(`${base}/${TOK}/stream/movie/csfd:abc.json`)).json();
  eq("neplatné csfd: ID → prázdný výpis", r2.streams, []);
  srv.close();

  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
