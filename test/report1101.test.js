// Opravy z nočních reportů 2026-10-24 až 2026-11-01 (v3.6.0):
// fronta/limit TorBoxu, výpadky SKT (chyba ≠ nic, jistič, tvrdý limit, souběžná hledání), spin-off s pomlčkou,
// latinský zbytek japonského názvu, řazení cizího seriálu stejného jména, souběžné dotazy filmů
process.env.SKT_SEARCH_BUDGET_MS = "3000";   // zkrácený rozpočet hledání, ať test netrvá 25 s
process.env.SKT_HARD_LIMIT_MS = "2000";
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
let fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n} → ${JSON.stringify(g)}${ok ? "" : " (čekáno " + JSON.stringify(e) + ")"}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const h = (c) => c.repeat(40);

// ---------- simulované API ----------
const calls = [];
let sktMode = "ok";             // ok | timeout | hang | slow
let sktDB = [];                 // [[hash, název, kategorie]]
let sktInflight = 0, sktMaxInflight = 0;
const tb = { list: [], queue: [], create: "ok" };   // create: ok | queued | already | limit
const skHtml = (items) => `<table>${items.map(([hh, n, c]) => `<tr><td><b>${c || "Seriál"}</b><a href="details.php?id=${hh}" title="${n}"><img src="p.jpg"></a> Velkost 1.2 GB | Odosielaju : 5</td></tr>`).join("")}</table>`;
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const canceled = () => Object.assign(new Error("canceled"), { name: "CanceledError", code: "ERR_CANCELED" });

axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const p = url.pathname; const params = { ...Object.fromEntries(url.searchParams), ...(cfg.params || {}) };
  const m = (cfg.method || "get").toUpperCase();
  calls.push(`${m} ${url.host}${p}${params.search ? " " + params.search : ""}`);
  const ok = (data, status = 200) => ({ data, status, statusText: "OK", headers: {}, config: cfg, request: {} });
  if (url.host === "sktorrent.eu") {
    sktInflight++; sktMaxInflight = Math.max(sktMaxInflight, sktInflight);
    try {
      if (sktMode === "timeout") { await sleep(20); throw Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" }); }
      if (sktMode === "hang") await new Promise((_, rej) => cfg.signal?.addEventListener("abort", () => rej(canceled())));
      if (sktMode === "slow") await sleep(400);
      const words = norm(String(params.search)).split(" ");
      return ok(skHtml(sktDB.filter(([, n]) => words.every(w => norm(n).includes(w)))));
    } finally { sktInflight--; }
  }
  if (url.host === "api.themoviedb.org") {
    if (p.includes("/find/")) return ok({ movie_results: [], tv_results: [{ id: 5, name: "Show", first_air_date: "2020-01-01" }] });
    return ok({ name: "Show", seasons: [] });
  }
  if (url.host === "api.torbox.app") {
    if (p.endsWith("/checkcached")) return ok({ success: true, data: {} });
    if (p.endsWith("/mylist")) return ok({ success: true, data: params.id ? tb.list.find(t => t.id == params.id) : tb.list });
    if (p.endsWith("/getqueued")) return ok({ success: true, data: tb.queue });
    if (p.endsWith("/createtorrent")) {
      const hh = cfg.data.get("magnet").match(/btih:([a-f0-9]{40})/)[1];
      if (tb.create === "queued") { tb.queue.push({ id: 9, hash: hh }); return ok({ success: true, detail: "Torrent queued successfully.", data: { queued_id: 9, hash: hh } }); }
      if (tb.create === "already") return ok({ success: false, error: "DOWNLOAD_ALREADY_QUEUED", detail: "Download already queued." });
      if (tb.create === "limit") { const e = new Error("Request failed with status code 429"); e.response = { status: 429, data: { success: false, detail: "60 per 1 hour" } }; throw e; }
      tb.list.push({ id: 77, hash: hh, download_state: "downloading", progress: 0.1, files: [] });
      return ok({ success: true, detail: "Added", data: { torrent_id: 77, hash: hh } });
    }
  }
  throw new Error("Nemockovaná URL: " + m + " " + cfg.url);
};

const M = require(P + "/lib/matching");
const { orderPicked, accountNote } = require(P + "/lib/streams");
const skt = require(P + "/lib/skt");
const { findTorrents } = require(P + "/lib/search");
const tbm = require(P + "/lib/tb");

(async () => {
  // ================= C: porovnávání =================
  const conan = M.makeStrictTitleMatcher(["Detective Conan", "Detektiv Conan"]);
  eq("Conan: spin-off „Zero's Tea Time“ neprojde", conan("Stiahni si Seriál Detektiv Conan - Zero v jednom / Detective Conan: Zero's Tea Time S01 (CZ)[WebRip][1080p]", "Seriál"), false);
  eq("Conan: běžné balíky projdou", [conan("Seriál Detektiv Conan / Detective Conan S01 (CZ)", "Seriál"), conan("Seriál Detektiv Conan - 1. série (CZ)", "Seriál")], [true, true]);
  const jojoName = "Seriál JoJova prazvlastni dobrodruzstvi / JoJo's Bizarre Adventure - Phantom Blood-Battle Tendency (S01)";
  eq("JoJo projde (CZ kus celý i jen EN název)", [M.makeStrictTitleMatcher(["JoJo's Bizarre Adventure", "JoJova prazvláštní dobrodružství"])(jojoName, "Seriál"), M.makeStrictTitleMatcher(["JoJo's Bizarre Adventure"])(jojoName, "Seriál")], [true, true]);
  eq("Kill la Kill - 1. serie + OVA projde", M.makeStrictTitleMatcher(["Kill la Kill"])("Seriál Kill la Kill - 1. serie + OVA", "Seriál"), true);
  eq("Arcane balíky projdou (s alt i bez)", [M.makeStrictTitleMatcher(["Arcane", "Arcane: League of Legends"])("Arcane - League of Legends (S1-S2)(2021-2024)(CZ)", "Seriál"), M.makeStrictTitleMatcher(["Arcane"])("Arcane / Arcane: League of Legends (Season 1 & 2)", "Seriál")], [true, true]);
  eq("latinský zbytek: jen když jím název začíná",
    ["舞-乙HiME", "ゴブリンスレイヤー -GOBLIN'S CROWN-", "PSYREN -サイレン-", "PSYREN サイレン", "ぬきたし the Animation", "てつりょー！meet with 鉄道むすめ", "BLEACH 千年血戦篇", "Frieren"].map(M.latinName),
    ["", "", "PSYREN", "PSYREN", "", "", "BLEACH", "Frieren"]);
  eq("hledané názvy bez „HiME“ / „meet with“", [M.buildSearchNames({ en: "My-Otome", cz: "舞-乙HiME", sk: "舞-乙HiME" }), M.buildSearchNames({ en: "TETSURYO! Meet with Tetsudou Musume", cz: "てつりょー！meet with 鉄道むすめ" }).cz],
    [{ en: ["My Otome"], cz: [], sk: [] }, []]);
  eq("přísná kontrola: „Hime (2005)“ pro My-Otome neprojde", M.makeStrictTitleMatcher(["My-Otome", "舞-乙HiME"])("Hime (2005)", "Seriál"), false);

  // Řazení MOST! (report 2026-10-28): Most / Bron až za Most!
  const t = (n, seeds = 5) => ({ name: n, cat: "Seriál", hash: Math.random().toString(16).slice(2).padEnd(40, "0"), seeds });
  const most = [
    { t: t("Most / Bron/Broen / The Bridge S01-S04 (CZ)[WebRip][1080p][HEVC]"), isBatch: true },
    { t: t("Most! - 1. serie (CZ)[WebRip][1080p]"), isBatch: true },
    { t: t("Most / Bron 1.-3.serie (CZ)[TvRip]"), isBatch: true },
    { t: t("Most! - 1. serie (CZ)[720p]"), isBatch: true }
  ];
  const cachedMost = new Set([most[0].t.hash, most[1].t.hash]);
  const ord = orderPicked(most, cachedMost, { uncertain: M.makeForeignTitleCheck(["MOST!"]), yearOk: M.makeYearMatch("2019") }).map(x => x.t.name.slice(0, 14));
  eq("MOST!: cizí Most / Bron na konec (i když je v cache)", ord, ["Most! - 1. ser", "Most! - 1. ser", "Most / Bron/Br", "Most / Bron 1."]);
  eq("Dr. House / House M.D. není cizí titul", M.makeForeignTitleCheck(["House", "Dr. House"])("Dr. House / House M.D. S01 (CZ)", "Seriál"), false);
  const yr = orderPicked([{ t: t("Show S02 (CZ)"), isBatch: true }, { t: t("Show S02 (2024)(CZ)"), isBatch: true }], null, { yearOk: M.makeYearMatch("2024") }).map(x => x.t.name);
  eq("sedící rok před torrentem bez roku", yr, ["Show S02 (2024)(CZ)", "Show S02 (CZ)"]);
  eq("bez voleb pořadí jako dřív (epizody, balíky)", orderPicked([{ t: t("B"), isBatch: true }, { t: t("A"), isBatch: false }], null).map(x => x.t.name), ["A", "B"]);

  // ================= A: TorBox fronta / limit =================
  const KEY = "TBKEY";
  calls.length = 0; tb.create = "queued";
  let r = await tbm.resolve(KEY, h("1"), { season: 1, episode: 1 });
  eq("„Torrent queued successfully.“ = ve frontě, ne chyba", r.status, "queued");
  r = await tbm.resolve(KEY, h("1"), { season: 1, episode: 2 });
  eq("torrent ve frontě TorBoxu se znovu nepřidává", [r.status, calls.filter(c => /createtorrent/.test(c)).length], ["queued", 1]);
  tb.create = "already";
  r = await tbm.resolve(KEY, h("2"), {});
  eq("„Download already queued.“ = ve frontě", r.status, "queued");
  const st = await tbm.accountStatus(KEY, [h("1")]);
  eq("popis streamu: ve frontě", accountNote(st.get(h("1")), "TorBox"), "⏳ Ve frontě TorBox (plné sloty stahování)");
  tb.create = "limit"; calls.length = 0;
  r = await tbm.resolve(KEY, h("3"), {});
  eq("„60 per 1 hour“ = limit", [r.status, /60 per 1 hour/.test(r.reason)], ["limit", true]);
  r = await tbm.resolve(KEY, h("4"), {});
  eq("po limitu se 10 min nepřidává (bez volání createtorrent)", [r.status, calls.filter(c => /createtorrent/.test(c)).length, /znovu za 10 min/.test(r.reason)], ["limit", 1, true]);
  tbm._reset(); tb.create = "ok"; tb.queue.length = 0;

  // Přes HTTP: info video místo 502 a paměť výsledku (opakování přehrávače nevolá API)
  process.env.PUBLIC_URL = "";
  const app = require(P + "/index.js");
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const TOK = "--TMDBKEY--uid1--pass1--0--TBKEY";
  const get = (u) => fetch(base + u, { redirect: "manual" });
  tb.create = "limit"; calls.length = 0;
  let res = await get(`/${TOK}/play/tb/${h("5")}/e/1/1/video.mp4`);
  eq("play při limitu → 302 na fronta.mp4", [res.status, /\/static\/fronta\.mp4$/.test(res.headers.get("location") || "")], [302, true]);
  for (let i = 0; i < 5; i++) res = await get(`/${TOK}/play/tb/${h("5")}/e/1/1/video.mp4`);
  eq("5 opakování: z paměti, žádné další volání TorBoxu", [res.status, calls.filter(c => /torbox/.test(c)).length], [302, 3]);
  res = await fetch(base + "/static/fronta.mp4");
  eq("video fronta.mp4 existuje", [res.status, res.headers.get("content-type")], [200, "video/mp4"]);
  tbm._reset(); tb.create = "ok";

  // ================= B: výpadek SKT =================
  const titles = { en: "Show", cz: "Ukázka", sk: "", year: "2020" };
  sktDB = [[h("a"), "Ukázka S01E01 (CZ)"], [h("b"), "Ukázka / Show S01 (CZ)"]];
  skt._resetBreaker(); sktMode = "timeout"; calls.length = 0;
  let f = await findTorrents({ type: "series", season: 1, episode: 1, titles });
  const sktCalls = () => calls.filter(c => /sktorrent/.test(c));
  eq("timeout SKT: sktDown + chyba v dotazech", [f.sktDown, f.audit.queries.every(q => q.err === "timeout" || q.err === "jistič")], [true, true]);
  eq("timeout SKT: další názvy („Show“) se nezkouší", sktCalls().some(c => / Show( |$)/.test(c)), false);
  eq("po 3 timeoutech je jistič otevřený", skt.breakerOpen(), true);
  calls.length = 0;
  f = await findTorrents({ type: "series", season: 1, episode: 2, titles });
  eq("otevřený jistič: žádný dotaz na SKT, hledání skončí hned", [sktCalls().length, f.sktDown, f.audit.queries[0].err, f.ms < 200], [0, true, "jistič", true]);

  // Informační položka ve výpisu místo prázdného výsledku
  res = await (await get(`/${TOK}/stream/series/tt0000001:1:1.json`)).json();
  eq("výpis při výpadku: jedna položka „SKTorrent neodpovídá“", [res.streams.length, /neodpovídá/.test(res.streams[0]?.description || ""), /skt-nedostupne\.mp4$/.test(res.streams[0]?.url || "")], [1, true, true]);
  res = await fetch(base + "/static/skt-nedostupne.mp4");
  eq("video skt-nedostupne.mp4 existuje", res.status, 200);

  // Po pauze jeden zkušební dotaz → SKT zase odpovídá → normální hledání
  skt._resetBreaker(); sktMode = "ok";
  f = await findTorrents({ type: "series", season: 1, episode: 1, titles });
  eq("SKT odpovídá: nalezeno, bez sktDown", [f.torrents.length, f.batchTorrents.length, !!f.sktDown], [1, 1, false]);

  // Tvrdý limit: SKT neodpoví vůbec → hledání skončí v rozpočtu (3 s), dotazy se zruší
  skt._resetBreaker(); sktMode = "hang";
  let t0 = Date.now();
  f = await findTorrents({ type: "series", season: 1, episode: 3, titles });
  const took = Date.now() - t0;
  eq("SKT visí: hledání skončí do rozpočtu + rezervy", [took <= 3400, f.sktDown], [true, true]);
  await sleep(50);
  eq("visící dotazy jsou zrušené (nic neběží)", sktInflight, 0);

  // Souběžná hledání: nejvýš 4 najednou, předhledání při plné kapacitě se vynechá
  skt._resetBreaker(); sktMode = "slow"; sktMaxInflight = 0;
  const many = Array.from({ length: 6 }, (_, i) => findTorrents({ type: "series", season: 2, episode: i + 1, titles: { ...titles, en: `Show${i}`, cz: `Ukázka${i}` } }));
  await sleep(20);
  const bg = await findTorrents({ type: "series", season: 3, episode: 1, titles, background: true });
  const rs = await Promise.all(many);
  eq("max 4 hledání × 4 dotazy najednou", sktMaxInflight <= 16, true);
  eq("2 hledání čekala na volné místo", rs.filter(x => x.queuedMs >= 100).length, 2);
  eq("předhledání při plné kapacitě vynecháno", bg, null);

  // ================= C4: filmy — dotazy s rokem souběžně =================
  skt._resetBreaker(); sktMode = "slow"; calls.length = 0;
  sktDB = [[h("c"), "Muž z oceli / Man of Steel (2013)(CZ)", "Filmy CZ/SK dabing"]];
  t0 = Date.now();
  f = await findTorrents({ type: "movie", titles: { en: "Man of Steel", cz: "Muž z oceli", year: "2013" } });
  eq("film: CZ i EN dotaz s rokem souběžně (~1 kolo)", [f.torrents.length, sktCalls().length, Date.now() - t0 < 700], [1, 2, true]);

  srv.close();
  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
