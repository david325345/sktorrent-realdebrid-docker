// Integrační test se simulovanými API (RD, TorBox, SKT, TMDB)
const P = process.argv[2] || require("path").join(__dirname, "..");
const axios = require(P + "/node_modules/axios");
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);
const calls = [];
let fail = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name} → ${JSON.stringify(got)}${ok ? "" : " (čekáno " + JSON.stringify(exp) + ")"}`); };

// ---- RD stav ----
let rdId = 0; const rdT = {};
const rdFiles = {
  [A]: [{ id: 1, path: "/Show.S01E05.mkv", bytes: 900 }],
  [B]: [{ id: 1, path: "/Show S01/Show.S01E04.mkv", bytes: 800 }, { id: 2, path: "/Show S01/Show.S01E05.mkv", bytes: 800 }, { id: 3, path: "/Show S01/info.nfo", bytes: 1 }],
  [D]: [{ id: 1, path: "/Pack/Predator.2.1990.mkv", bytes: 9000 }, { id: 2, path: "/Pack/Predator.1987.mkv", bytes: 5000 }, { id: 3, path: "/Pack/Prey.2022.mkv", bytes: 7000 }],
  [C]: [{ id: 1, path: "/C/Show.S01E01.mkv", bytes: 500 }, { id: 2, path: "/C/Show.S01E02.mkv", bytes: 500 }, { id: 3, path: "/C/Show.S01E03.mkv", bytes: 500 }]
};
// starý záznam C z v2 — vybraná jen E01
rdT["old"] = { id: "old", hash: C, status: "downloaded", files: rdFiles[C].map(f => ({ ...f, selected: f.id === 1 ? 1 : 0 })), links: ["L-old-1"] };
const rdCached = new Set([B, C, D]);
function rdInfoOf(t) { return { id: t.id, hash: t.hash, status: t.status, progress: t.status === "downloaded" ? 100 : 0, files: t.files, links: t.links }; }

// ---- TB stav ----
let tbId = 100; const tbT = {};
const tbCached = new Set([B]);
const tbFilesOf = { [B]: [{ id: 0, name: "Show S01/Show.S01E05.mkv", short_name: "Show.S01E05.mkv", size: 800 }, { id: 7, name: "Show S01/Show.S01E04.mkv", short_name: "Show.S01E04.mkv", size: 800 }] };

const skHtml = (items) => `<table>${items.map(([h, n]) => `<tr><td><b>Seriály CZ</b><a href="details.php?id=${h}" title="${n}"><img src="p.jpg"></a> Velkost 1.2 GB | Odosielaju : 5</td></tr>`).join("")}</table>`;

axios.defaults.adapter = async (cfg) => {
  const url = new URL(cfg.url, "http://x"); const p = url.pathname; const q = Object.fromEntries(url.searchParams); const params = { ...q, ...(cfg.params || {}) };
  const m = (cfg.method || "get").toUpperCase();
  calls.push(`${m} ${url.host}${p}`);
  const ok = (data, status = 200) => ({ data, status, statusText: "OK", headers: {}, config: cfg, request: {} });
  // SKT
  if (url.host === "sktorrent.eu") {
    const s = String(params.search || "");
    if (/S01E05/.test(s)) return ok(skHtml([[A, "Show S01E05 CZ"]]));
    if (/S01$/.test(s)) return ok(skHtml([[B, "Show S01 CZ komplet"]]));
    return ok(skHtml([]));
  }
  // TMDB
  if (url.host === "api.themoviedb.org") {
    if (p.includes("/find/")) return ok({ movie_results: [{ id: 9, title: "Wrong Movie", release_date: "2001-01-01" }], tv_results: [{ id: 5, name: "Show", first_air_date: "2020-01-01" }] });
    if (p.includes("/tv/5")) return ok({ name: params.language === "cs-CZ" ? "Show" : "Show" });
    return ok({ title: "WRONG" });
  }
  // RD
  if (url.host === "api.real-debrid.com") {
    const body = new URLSearchParams(cfg.data || "");
    if (p.endsWith("/user")) return ok({ username: "david", type: "premium", expiration: "2027-01-01T00:00:00Z" });
    if (p.endsWith("/torrents") && m === "GET") return ok(Object.values(rdT).map(t => ({ id: t.id, hash: t.hash, status: t.status, progress: 0, links: t.links })));
    if (p.endsWith("/torrents/addMagnet")) {
      const h = body.get("magnet").match(/btih:([a-f0-9]{40})/)[1]; const id = "rd" + (++rdId);
      rdT[id] = { id, hash: h, status: "waiting_files_selection", files: rdFiles[h].map(f => ({ ...f, selected: 0 })), links: [] };
      return ok({ id });
    }
    if (p.includes("/torrents/selectFiles/")) {
      const t = rdT[p.split("/").pop()]; const ids = body.get("files").split(",").map(Number);
      t.files.forEach(f => f.selected = ids.includes(f.id) ? 1 : 0);
      if (rdCached.has(t.hash)) { t.status = "downloaded"; t.links = t.files.filter(f => f.selected).sort((a, b) => a.id - b.id).map(f => `L-${t.id}-${f.id}`); }
      else t.status = "downloading";
      return ok("", 204);
    }
    if (p.includes("/torrents/info/")) return ok(rdInfoOf(rdT[p.split("/").pop()]));
    if (p.endsWith("/unrestrict/link")) return ok({ download: `https://rd.cdn/${body.get("link")}` });
  }
  // TB
  if (url.host === "api.torbox.app") {
    if (p.endsWith("/user/me")) return ok({ success: true, data: { plan: 2, premium_expires_at: "2027-01-01T00:00:00Z" } });
    if (p.endsWith("/checkcached")) { const d = {}; String(params.hash).split(",").forEach(h => { if (tbCached.has(h)) d[h] = { name: "x", size: 1, hash: h }; }); return ok({ success: true, data: d }); }
    if (p.endsWith("/mylist")) {
      if (params.id) return ok({ success: true, data: tbT[params.id] });
      return ok({ success: true, data: Object.values(tbT) });
    }
    if (p.endsWith("/createtorrent")) {
      const magnet = cfg.data.get("magnet"); const h = magnet.match(/btih:([a-f0-9]{40})/)[1]; const id = ++tbId;
      const cached = tbCached.has(h);
      tbT[id] = { id, hash: h, download_state: cached ? "cached" : "downloading", download_present: cached, download_finished: cached, progress: cached ? 1 : 0.1, files: cached ? tbFilesOf[h] : [] };
      return ok({ success: true, detail: cached ? "Found Cached Torrent" : "Added", data: { torrent_id: id, hash: h } });
    }
    if (p.endsWith("/requestdl")) return ok({ success: true, data: `https://tb.cdn/${params.torrent_id}/${params.file_id}` });
  }
  throw new Error("Nemockovaná URL: " + m + " " + cfg.url);
};

(async () => {
  process.env.PUBLIC_URL = "";
  const app = require(P + "/index.js");
  const srv = app.listen(0); const port = srv.address().port; const base = `http://127.0.0.1:${port}`;
  const TOK = "RDTOKEN--TMDBKEY--uid1--pass1--1--TBKEY";
  const get = (u, o = {}) => fetch(base + u, { redirect: "manual", ...o });
  const count = (re) => calls.filter(c => re.test(c)).length;

  let r = await (await get(`/${TOK}/manifest.json`)).json();
  eq("manifest name", r.name, "SKTorrent+RD+TB");
  eq("manifest resources skt", r.resources.length, 3);
  let res = await get(`/${TOK}/configure`);
  const html = await res.text();
  eq("configure 200 + předvyplnění", [res.status, html.includes('"tb":"TBKEY"')], [200, true]);
  eq("legacy token (bez TB) manifest", (await (await get(`/RDTOKEN--x--y--z--0/manifest.json`)).json()).name, "SKTorrent+RD");

  r = await (await get(`/${TOK}/stream/series/tt0000001:1:5.json`)).json();
  eq("počet streamů (2 torrenty × 2 služby)", r.streams.length, 4);
  eq("názvy streamů", r.streams.map(s => s.name.split("\n")[0]), ["SKT+RD", "SKT+TB", "SKT+RD", "SKT+TB ⚡"]);
  eq("URL", r.streams.map(s => s.url.replace(base, "").replace(TOK, "T")), [`/T/play/rd/${A}/e/1/5/video.mp4`, `/T/play/tb/${A}/e/1/5/video.mp4`, `/T/play/rd/${B}/e/1/5/video.mp4`, `/T/play/tb/${B}/e/1/5/video.mp4`]);
  eq("TMDB vzal seriál (ne film)", count(/themoviedb.org\/3\/tv\/5/), 2);
  const skt1 = count(/sktorrent/);
  await get(`/${TOK}/stream/series/tt0000001:1:5.json`);
  eq("SKT cache: druhý dotaz bez nových requestů", count(/sktorrent/) - skt1, 0);

  // RD play balíku B – 3 souběžné requesty → 1 addMagnet
  const plays = await Promise.all([1, 2, 3].map(() => get(`/${TOK}/play/rd/${B}/e/1/5/video.mp4`)));
  eq("RD play E05 redirect", plays.map(x => x.headers.get("location")), Array(3).fill("https://rd.cdn/L-rd1-2"));
  eq("RD souběžně = 1 addMagnet", count(/addMagnet/), 1);
  res = await get(`/${TOK}/play/rd/${B}/e/1/4/video.mp4`);
  eq("RD E04 ze stejného záznamu", [res.headers.get("location"), count(/addMagnet/)], ["https://rd.cdn/L-rd1-1", 1]);
  res = await get(`/${TOK}/play/rd/${B}/e/1/9/video.mp4`);
  eq("RD E09 neexistuje → 502 (žádný špatný díl)", res.status, 502);
  res = await get(`/${TOK}/play/${B}/1/5/video.mp4`);
  eq("Legacy URL /play/HASH/1/5", res.headers.get("location"), "https://rd.cdn/L-rd1-2");
  const ANOTHER = "RDOTHER--x--y--z--0";
  res = await get(`/${ANOTHER}/play/rd/${B}/e/1/5/video.mp4`);
  eq("Jiný uživatel nedostane cizí link z cache", count(/unrestrict/) >= 3, true);

  // Starý záznam C (vybraná jen E01)
  res = await get(`/${TOK}/play/rd/${C}/e/1/2/video.mp4`);
  eq("RD C E02: starý záznam → nový se všemi videi", [res.headers.get("location"), count(/addMagnet/)], ["https://rd.cdn/L-rd2-2", 2]);
  res = await get(`/${TOK}/play/rd/${C}/e/1/3/video.mp4`);
  eq("RD C E03: použije plný záznam, nepřidává", [res.headers.get("location"), count(/addMagnet/)], ["https://rd.cdn/L-rd2-3", 2]);

  // RD nenacachovaný A
  rdCached.delete(A);
  // A už je? ne – přidá se a stahuje
  res = await get(`/${TOK}/play/rd/${A}/e/1/5/video.mp4`);
  eq("RD necachovaný → info video", res.headers.get("location"), `${base}/static/downloading.mp4`);
  const addsA = count(/addMagnet/);
  res = await get(`/${TOK}/play/rd/${A}/e/1/5/video.mp4`);
  eq("RD necachovaný podruhé → bez dalšího addMagnet", [res.headers.get("location").endsWith("downloading.mp4"), count(/addMagnet/) - addsA], [true, 0]);

  // TB
  res = await get(`/${TOK}/play/tb/${B}/e/1/4/video.mp4`);
  eq("TB E04 podle jména (id 7, ne pořadí)", res.headers.get("location"), "https://tb.cdn/101/7");
  res = await get(`/${TOK}/play/tb/${B}/e/1/5/video.mp4`);
  eq("TB E05 bez nového createtorrent", [res.headers.get("location"), count(/createtorrent/)], ["https://tb.cdn/101/0", 1]);
  res = await get(`/${TOK}/play/tb/${A}/e/1/5/video.mp4`);
  eq("TB necachovaný → info video", res.headers.get("location"), `${base}/static/downloading.mp4`);

  // SKT přímý stream
  const unrBefore = count(/unrestrict|requestdl/);
  r = await (await get(`/${TOK}/stream/movie/skt${B}.json`)).json();
  eq("SKT přímý nic neodemyká", count(/unrestrict|requestdl/) - unrBefore, 0);
  eq("SKT přímý: RD 2 soubory + TB 2 soubory", r.streams.map(s => s.url.replace(base, "").replace(TOK, "T")), [`/T/play/rd/${B}/f/1/video.mp4`, `/T/play/rd/${B}/f/2/video.mp4`, `/T/play/tb/${B}/f/7/video.mp4`, `/T/play/tb/${B}/f/0/video.mp4`]);
  res = await get(`/${TOK}/play/tb/${B}/f/7/video.mp4`);
  eq("play f/7", res.headers.get("location"), "https://tb.cdn/101/7");

  res = await get(`/${TOK}/play/rd/${D}/m/1987/predator/video.mp4`);
  eq("Kolekce: Predator 1987 (ne největší soubor)", res.headers.get("location"), `https://rd.cdn/L-rd${rdId}-2`);
  res = await get(`/${TOK}/play/rd/${D}/m/0/prey/video.mp4`);
  eq("Kolekce bez roku: podle názvu", res.headers.get("location"), `https://rd.cdn/L-rd${rdId}-3`);
  res = await get(`/${TOK}/play/rd/${D}/m/1979/alien/video.mp4`);
  eq("Kolekce: film chybí → 502", res.status, 502);

  // Validace + statika + verify + 404
  eq("neplatný hash → 404", (await get(`/${TOK}/play/rd/xyz/video.mp4`)).status, 404);
  eq("play bez TB klíče → 400", (await get(`/RD--a--b--c--0/play/tb/${B}/video.mp4`)).status, 400);
  eq("static video", (await get(`/static/downloading.mp4`)).status, 200);
  r = await (await get(`/api/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rd: "x", tb: "y" }) })).json();
  eq("verify", [r.rd.success, r.tb.success, r.tb.plan], [true, true, "Pro"]);
  eq("health", (await (await get(`/health`)).json()).status, "ok");

  srv.close();
  console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
