// Test nástroje pro noční analýzu archivu (tools/analyza.js + tools/replay.js)
const P = process.argv[2] || require("path").join(__dirname, "..");
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const { readRecords, analyze } = require(P + "/tools/analyza");
const { replay } = require(P + "/tools/replay");
let fail = 0; const eq = (n, ok) => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${n}`); };
const V = require(P + "/package.json").version;
const tor = (n, cat, ok, r) => ({ n: `Stiahni si ${cat} ${n}`, cat, h: Math.random().toString(16).slice(2).padEnd(40, "0"), ok, r });
const recs = [
  { t: "2026-10-18T10:00:00.000Z", v: V, kind: "stream", type: "series", id: "tt0412142:1:1", titles: { en: "House", cz: "Dr. House", sk: "" }, ms: 5200,
    queries: [{ q: "Dr House S01E01", p: 0, n: 3 }], torrents: [
      tor("Dr. House / House M.D. S01E01 (CZ)", "Seriál", true, "epizoda"),
      tor("Rod Draka / House of the Dragon S01E01", "Seriál", false, "název nesedí"),
      tor("Dr. House / House M.D. S02E01 (CZ)", "Seriál", false, "jiná sezóna (S02E01)")] },
  { t: "2026-10-18T10:05:00.000Z", v: "3.4.0", kind: "stream", type: "movie", id: "tt0093773", year: "1987", titles: { en: "Predator", cz: "Predátor" }, ms: 900,
    queries: [{ q: "Predator 1987", p: 0, n: 2 }], torrents: [
      tor("Predátor / Predator (1987)(CZ/EN)[1080p]", "Blu-ray Filmy", false, "název nesedí"),      // starý verdikt → teď přijato
      tor("Predator (1987) Soundtrack", "Soundtrack", false, "kategorie mimo (Soundtrack)")] },
  { t: "2026-10-18T10:06:00.000Z", v: V, kind: "stream", type: "series", id: "tt9999999:1:1", titles: { en: "Nonexistent Show" }, ms: 1200,
    queries: [{ q: "Nonexistent Show S01E01", p: 0, n: 0 }], torrents: [] },
  { t: "2026-10-18T10:07:00.000Z", kind: "play", prov: "tb", h: "a".repeat(40), n: "Stiahni si Seriál Show S01 pack", sel: { season: 1, episode: 3 },
    status: "error", r: "epizoda v torrentu nenalezena", videos: ["Show.S01E01.mkv", "Show.S01E02.mkv"] }
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skt-an-"));
fs.writeFileSync(path.join(dir, "a.jsonl.gz"), zlib.gzipSync(recs.map(r => JSON.stringify(r)).join("\n") + "\n"));
fs.writeFileSync(path.join(dir, "b.jsonl"), JSON.stringify(recs[0]) + "\n");          // duplicita v jiném souboru
const read = readRecords([dir]);
eq("načte .gz i .jsonl ze složky, duplicity jen jednou", read.length === 4);
eq("--since filtruje", readRecords([dir], "2026-10-18T10:06").length === 2);
const ch = replay(read);
eq("replay: starý verdikt Predátora se změní, aktuální verze beze změn", ch.length === 1 && ch[0].rec.id === "tt0093773" && ch[0].now.ok);
const { markdown, counts } = analyze(read);
eq("bez výsledku: Predátor (vše odmítnuto) a 1× SKT nic nevrátilo", counts.none === 2 && counts.noneRejected === 1 && /SKT nevrátilo nic \(1\)/.test(markdown) && /Nonexistent Show/.test(markdown));
eq("podezřelé odmítnutí seskupeno (House of the Dragon)", /House of the Dragon \| 1 \|/.test(markdown));
eq("chyba přehrání i se seznamem videí", counts.playErrors === 1 && /Show\.S01E02\.mkv/.test(markdown));
eq("pomalé hledání > 4 s", counts.slow === 1 && /\| 5200 \|/.test(markdown));
eq("změna verdiktu v reportu bez varování o aktuální verzi", counts.replay === 1 && !/⚠️/.test(markdown));
fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAIL` : "\nVŠE OK"); process.exit(fail ? 1 : 0);
