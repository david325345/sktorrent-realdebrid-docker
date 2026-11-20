// Přehraje záznamy archivu aktuální logikou porovnávání a vrátí torrenty, u kterých by se verdikt změnil.
// Slouží k ověření, že úprava parseru mění jen to, co má (a k noční kontrole).
const path = require("path");
const root = process.env.SKT_ROOT || path.join(__dirname, "..");
const M = require(path.join(root, "lib/matching"));
const { ALLOWED } = require(path.join(root, "lib/search"));

/** Verdikt jednoho torrentu pro záznam typu „stream“: { ok, r } */
function makeJudge(rec){
    const ti=rec.titles||{};
    const all=[ti.en,ti.cz,ti.sk,...(ti.alt||[]),...(M.dashShortNames?M.dashShortNames([ti.en,ti.cz]):[]),...(ti.csfdTitle?[ti.csfdTitle]:[])];
    const strictRaw=M.makeStrictTitleMatcher(all,{ colonNeedsYear:rec.type==="movie", filmYear:rec.type==="movie"?String(rec.year||"").slice(0,4):null });
    // Tituly csfd: — ČSFD ID z detailu torrentu (pole csfd v archivu) má přednost před názvem
    const idParts=String(rec.id||"").split(":");
    const isCsfd=idParts[0]==="csfd";
    // csfd: tituly — ČSFD rozhoduje oběma směry; IMDb tituly se známým ČSFD ID (od 3.9.0) — záchrana,
    // od 3.9.3 i veto u torrentu s cizí částí názvu za „/“ („Mistr iluze / Deception“)
    const ourCsfd=isCsfd?+idParts[1]:(ti.csfdId?+ti.csfdId:null);
    const csfdOf=new Map((rec.torrents||[]).filter(t=>ourCsfd&&t.csfd!==undefined).map(t=>[t.n,t.csfd]));
    const csfdState=(n)=>{ if(!csfdOf.has(n)||csfdOf.get(n)===null) return null; return csfdOf.get(n)===ourCsfd?"match":"other"; };
    const foreign=M.makeForeignPartCheck?M.makeForeignPartCheck(all,strictRaw):()=>false;
    const vetoed=(n,cat)=>csfdState(n)==="other"&&(isCsfd||foreign(n,cat));
    const strict=(n,cat,o)=>{ const st=csfdState(n); return st==="match"?true:vetoed(n,cat)?false:strictRaw(n,cat,o); };
    const nameReason=(n,cat)=>vetoed(n,cat)?`jiné ČSFD (${csfdOf.get(n)})`:"název nesedí";
    const base=M.makeStrictTitleMatcher(all.filter(Boolean).map(n=>n.replace(/(^|\s)\d{1,2}(?=\s|$)/g," ").trim()));
    const [s, e]=isCsfd?idParts.slice(2):idParts.slice(1);
    const f=s?M.episodeFilters(+s,+e):null;
    const year=rec.type==="movie"?String(rec.year||"").slice(0,4):"";
    const allowed=ALLOWED[rec.type==="series"?"series":"movie"];
    const tooOld=f?M.makeSeriesYearCheck(rec.year,all):()=>null;
    // seasonYear v archivu od 3.5.2, seasonAfter (sezóna novější než TMDB zná) od 3.8.0
    const beforeSeason0=f?M.makeSeasonYearCheck(rec.seasonYear,+s,all,{ lastKnownYear:rec.seasonAfter, seriesYear:rec.year }):()=>null;
    // od 3.9.3: torrent bez sezóny s jediným rokem jiným než premiéra i hledaná sezóna
    const otherYear=f&&M.makeNoSeasonYearCheck?M.makeNoSeasonYearCheck(rec.seasonYear,rec.year,all):()=>null;
    const beforeSeason=(n)=>beforeSeason0(n)||otherYear(n);
    return (t)=>{
        if(t.cat&&!allowed.test(t.cat)) return { ok:false, r:`kategorie mimo (${t.cat})` };
        if(!f){
            if(csfdState(t.n)!=="match"&&!M.filterYear([{ name:t.n }],year).length) return { ok:false, r:"rok nesedí" };
            if(M.isMakingOf&&M.isMakingOf(t.n,all)) return { ok:false, r:"dokument o filmu" };
            if(!(strict(t.n,t.cat)||(M.isMoviePack(t.n)&&base(t.n,t.cat)))) return { ok:false, r:nameReason(t.n,t.cat) };
            return { ok:true, r:M.isMoviePack(t.n)?"kolekce":"film" };
        }
        if(!strict(t.n,t.cat)) return { ok:false, r:nameReason(t.n,t.cat) };
        const old=csfdState(t.n)==="match"?null:tooOld(t.n);
        if(old) return { ok:false, r:old };
        if(f.matchesExactEpisode(t.n)) return { ok:true, r:"epizoda" };
        if(f.isBatchSeason(t.n)) return { ok:true, r:"balík" };
        if(f.isNoSeasonCandidate(t.n)&&strict(t.n,t.cat,{ whole:true })){
            const before=beforeSeason(t.n);
            return before?{ ok:false, r:before }:{ ok:true, r:"balík (bez sezóny?)" };
        }
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
