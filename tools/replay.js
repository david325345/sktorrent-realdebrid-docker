// Přehraje záznamy archivu aktuální logikou porovnávání a vrátí torrenty, u kterých by se verdikt změnil.
// Slouží k ověření, že úprava parseru mění jen to, co má (a k noční kontrole).
const path = require("path");
const root = process.env.SKT_ROOT || path.join(__dirname, "..");
const M = require(path.join(root, "lib/matching"));
const { ALLOWED } = require(path.join(root, "lib/search"));

/** Verdikt jednoho torrentu pro záznam typu „stream“: { ok, r } */
function makeJudge(rec){
    const ti=rec.titles||{};
    const all=[ti.en,ti.cz,ti.sk];
    const strict=M.makeStrictTitleMatcher(all);
    const base=M.makeStrictTitleMatcher(all.filter(Boolean).map(n=>n.replace(/(^|\s)\d{1,2}(?=\s|$)/g," ").trim()));
    const [, s, e]=String(rec.id||"").split(":");
    const f=s?M.episodeFilters(+s,+e):null;
    const year=rec.type==="movie"?String(rec.year||"").slice(0,4):"";
    const allowed=ALLOWED[rec.type==="series"?"series":"movie"];
    return (t)=>{
        if(t.cat&&!allowed.test(t.cat)) return { ok:false, r:`kategorie mimo (${t.cat})` };
        if(!f){
            if(!M.filterYear([{ name:t.n }],year).length) return { ok:false, r:"rok nesedí" };
            if(!(strict(t.n,t.cat)||(M.isMoviePack(t.n)&&base(t.n,t.cat)))) return { ok:false, r:"název nesedí" };
            return { ok:true, r:M.isMoviePack(t.n)?"kolekce":"film" };
        }
        if(!strict(t.n,t.cat)) return { ok:false, r:"název nesedí" };
        if(f.matchesExactEpisode(t.n)) return { ok:true, r:"epizoda" };
        if(f.isBatchSeason(t.n)) return { ok:true, r:"balík" };
        if(f.isNoSeasonCandidate(t.n)&&strict(t.n,t.cat,{ whole:true })) return { ok:true, r:"balík (bez sezóny?)" };
        return { ok:false, r:f.rejectReason(t.n) };
    };
}

/** [{ rec, t, now:{ok,r} }] — torrenty, kde se nový verdikt liší od uloženého */
function replay(records){
    const out=[];
    for(const rec of records){
        if(rec.kind!=="stream"||!Array.isArray(rec.torrents)) continue;
        const judge=makeJudge(rec);
        for(const t of rec.torrents){
            const now=judge(t);
            if(now.ok!==t.ok) out.push({ rec, t, now });
        }
    }
    return out;
}

module.exports = { replay, makeJudge };

// Samostatné spuštění: node tools/replay.js soubor.jsonl[.gz] …
if(require.main===module){
    const { readRecords }=require("./analyza");
    const recs=readRecords(process.argv.slice(2));
    const ch=replay(recs);
    for(const { rec, t, now } of ch) console.log(`${t.ok?"✔→✘":"✘→✔"} ${String(rec.id).padEnd(16)} ${now.r.padEnd(22)} ${t.n.replace(/^Stiahni si /,"").slice(0,100)}`);
    console.log(`\nZměněný verdikt: ${ch.length}`);
}
