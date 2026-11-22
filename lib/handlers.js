// Obsluha katalogu, detailu, streamů a přehrání — bez Express, sdílí ji addon (index.js)
// a plugin pro Nuvio na Apple TV (nuvio-plugins/sktorrent). Adresy dodává volající:
// link.play(prov, hash, sel) a link.file(název) vrací pole streamu ({ url } nebo { resolve }),
// link.fileUrl(název) adresu obrázku/videa z public/.
const { getTitle } = require("./meta");
const { parseCsfdId, getCsfdTitle, getCsfdForImdb } = require("./csfd");
const { searchSKT, getCachedTorrent } = require("./skt");
const { findTorrents } = require("./search");
const { PROVIDERS, activeProviders, checkCachedTB } = require("./debrid");
const archive = require("./archive");
const { isHash, flagsFromName, cleanTorrentName, formatBytes, removeDiacritics, keyId } = require("./util");
const { isMoviePack, selKey, makeForeignTitleCheck, makeYearMatch } = require("./matching");
const { orderPicked, isDead, accountNote } = require("./streams");
const { createCache } = require("./cache");

// Promise s časovým limitem (po limitu null; původní volání doběhne na pozadí)
const withTimeout=(promise,ms)=>Promise.race([promise,new Promise(r=>setTimeout(()=>r(null),ms).unref?.())]);

// na serveru setImmediate, v pluginu (bez setImmediate) setTimeout 0
const defer=typeof setImmediate==="function"?setImmediate:(fn)=>setTimeout(fn,0);

const MAX_EP_TORRENTS = 12;      // max torrentů s přesnou epizodou / filmů
const MAX_ALL_TORRENTS = 15;     // max torrentů celkem (včetně balíků)

// ============ CATALOG (přímé hledání SKT) ============
// Katalog „SKTorrent“ (přímé hledání na SKT) → { metas }
async function catalogFor(query, cfg, link){
    const { sktUid, sktPass }=cfg;
    query=String(query||"").trim();
    if(!query) return { metas:[] };
    console.log(`\n🔍 Catalog search: "${query}"`);
    const results=await searchSKT(query,sktUid,sktPass);
    const metas=results.map(t=>{
        const flags=flagsFromName(t.name);
        return {
            id:`skt${t.hash}`, type:"movie", name:cleanTorrentName(t),
            poster:t.poster||undefined, posterShape:"regular",
            background:t.poster||link.fileUrl("logo.png"),
            description:`📁 ${t.cat||"SKT"}  📀 ${t.size}  👤 ${t.seeds}${flags?" "+flags:""}`
        };
    });
    console.log(`🔍 Catalog: ${metas.length} výsledků`);
    archive.write({ kind:"catalog", q:query, count:results.length,
        torrents:results.map(t=>({ n:t.name, cat:t.cat, s:t.size, seeds:t.seeds, h:t.hash })) });
    return { metas };
}

// ============ META (detail SKT torrentu) ============
// Detail SKT torrentu z katalogu → { meta }
function metaFor(id){
    const hash=id.replace(/^skt/,"").toLowerCase();
    if(!id.startsWith("skt")||!isHash(hash)) return { meta:null };
    const t=getCachedTorrent(hash);
    if(!t) return { meta:{ id, type:"movie", name:hash, description:"Torrent z SKTorrent" } };
    const flags=flagsFromName(t.name);
    return { meta:{
        id, type:"movie", name:cleanTorrentName(t),
        poster:t.poster||undefined, posterShape:"regular", background:t.poster||undefined, logo:t.poster||undefined,
        description:`📁 Kategorie: ${t.cat||"SKT"}\n📀 Velikost: ${t.size}\n👤 Seeds: ${t.seeds}${flags?" "+flags:""}\n\n${t.name}`
    }};
}

// ============ STREAM ============
async function tbCachedSet(cfg,hashes){
    if(!cfg.tbKey||!hashes.length) return null;
    return await checkCachedTB(cfg.tbKey,hashes);   // null = nepodařilo se zjistit
}

function providerLine(p,cached){
    if(p.id==="tb") return cached===true?"⚡ TorBox":cached===false?"⏳ TorBox":"TorBox";
    return "Real-Debrid";   // stav cache u RD se neřeší
}
function streamName(p,cat,cached){
    return `SKT+${p.short}${p.id==="tb"&&cached===true?" ⚡":""}\n${cat}`;
}

// Přímý stream SKT torrentu z katalogu — soubory se jen vypíšou, odemyká se až při kliknutí
async function sktDirectStreams(link,cfg,hash){
    const t=getCachedTorrent(hash);
    const cat=t?.cat||"SKT";
    const thumb=t?.poster||undefined;
    const provs=activeProviders(cfg);
    const cachedSet=await tbCachedSet(cfg,[hash]);
    const perProv=await Promise.all(provs.map(async p=>{
        const cached=p.id==="tb"?(cachedSet?cachedSet.has(hash):null):undefined;
        let r;
        try{ r=await p.listFiles(p.key(cfg),hash,{ cached:cached===true }); }
        catch(e){ r={ status:"error", reason:e.message }; }
        const out=[];
        if(r.status==="ready"){
            r.files.forEach((f,i)=>out.push({
                name:r.files.length>1?`SKT+${p.short}\n📁 ${i+1}/${r.files.length}`:streamName(p,cat,cached),
                description:`${f.name}\n📀 ${formatBytes(f.size)}\n${providerLine(p,cached)}`,
                ...link.play(p.id,hash,{ fileId:f.id }),
                behaviorHints:{ notWebReady:true, bingeGroup:`skt-${p.id}-${hash.slice(0,8)}` },
                thumbnail:thumb
            }));
        }else if(r.status==="downloading"||r.status==="notadded"||r.status==="queued"||r.status==="limit"){
            const txt=r.status==="notadded"?"⏳ Není v cache — po kliknutí se začne stahovat"
                :r.status==="queued"?"⏳ Ve frontě TorBoxu (plné sloty stahování)\nZkuste za chvíli znovu."
                :r.status==="limit"?`⏸️ ${r.reason}\nZkuste za chvíli znovu.`
                :`🕐 Torrent se stahuje${r.progress?` (${r.progress} %)`:""}…\nZkuste za chvíli znovu.`;
            out.push({ name:streamName(p,cat,cached), description:`${txt}\n${providerLine(p,cached)}`, ...link.play(p.id,hash,{}), behaviorHints:{ notWebReady:true }, thumbnail:thumb });
        }else{
            console.log(`[SKT ${p.short}] ❌ ${r.reason}`);
        }
        return out;
    }));
    return perProv.flat();
}

// Streamy pro tt… / csfd:… / skt… → { streams[, cacheMaxAge] }
// link.play(prov, hash, sel) → pole streamu s odkazem (server: url na /play, plugin: resolve),
// link.file(název) → pole streamu s informačním videem
async function streamsFor(type, id, cfg, link){
    const provs=activeProviders(cfg);
    if(!provs.length) return { streams:[] };

    try{
        // SKT přímý stream (z katalogu)
        if(id.startsWith("skt")){
            const hash=id.slice(3).toLowerCase();
            if(!isHash(hash)) return { streams:[] };
            console.log(`\n🎬 SKT stream: ${hash}`);
            return { streams:await sktDirectStreams(link,cfg,hash) };
        }

        // IMDb „tt123:S:E“ (názvy z TMDB) nebo jen ČSFD „csfd:123:S:E“ (názvy z csfd-ratings, číslování dílů podle ČSFD)
        let imdbId, season, episode, csfd=null;
        if(id.startsWith("csfd:")){
            csfd=parseCsfdId(id);
            if(!csfd) return { streams:[] };
            imdbId=`csfd:${csfd.csfdId}`; season=csfd.season; episode=csfd.episode;
        }else{
            const [iid,sRaw,eRaw]=id.split(":");
            if(!/^tt\d+$/.test(iid)) return { streams:[] };
            imdbId=iid;
            season=sRaw!==undefined?parseInt(sRaw):undefined;
            episode=eRaw!==undefined?parseInt(eRaw):undefined;
        }
        const isSeries=type==="series"&&Number.isInteger(season)&&Number.isInteger(episode);
        console.log(`\n🎬 ${type} ${imdbId} S${season??"-"}E${episode??"-"}`);

        // IMDb tituly: souběžně s TMDB i ČSFD ID a český název z ČSFD (nejvýš 3 s, jinak až příště)
        let titles;
        if(csfd) titles=await getCsfdTitle(type,csfd.csfdId);
        else{
            const [tm,cs]=await Promise.all([getTitle(imdbId,cfg.tmdbKey,type),getCsfdForImdb(imdbId,type)]);
            titles=tm&&cs?{ ...tm, csfdId:cs.csfdId, csfdTitle:cs.title }:tm;
        }
        if(!titles){
            archive.write({ kind:"stream", type, id, note:csfd?"bez názvu z csfd-ratings":"bez názvu z TMDB/OMDb" });
            return { streams:[] };
        }

        const found=await findTorrents({
            type, season:isSeries?season:undefined, episode:isSeries?episode:undefined,
            titles, sktUid:cfg.sktUid, sktPass:cfg.sktPass
        });
        const { torrents, batchTorrents, epTag }=found;
        // Záznam do anonymního archivu (sent = pořadí ve výpisu, tb = v cache TorBoxu)
        const archiveStream=(sentMap,cachedSet)=>archive.write({
            kind:"stream", type, id, year:titles.year||null, ...(found.seasonYear?{ seasonYear:found.seasonYear }:{}), ...(found.seasonAfter?{ seasonAfter:found.seasonAfter }:{}),
            titles:{ en:titles.en||titles.title||"", cz:titles.cz||"", sk:titles.sk||"", ...(titles.alt?.length?{ alt:titles.alt }:{}),
                ...(titles.csfdTitle?{ csfdTitle:titles.csfdTitle }:{}), ...(!csfd&&titles.csfdId?{ csfdId:titles.csfdId }:{}) },
            names:found.names, queries:found.audit.queries, ms:found.ms,
            ...(found.sktDown?{ sktDown:true }:{}), ...(found.queuedMs?{ queuedMs:found.queuedMs }:{}),
            providers:provs.map(p=>p.id), logged:!!(cfg.sktUid&&cfg.sktPass),
            streams:sentMap?sentMap.size:0,
            torrents:found.audit.torrents.map(({ t, ok, reason })=>{
                const rec={ n:t.name, cat:t.cat, s:t.size, seeds:t.seeds, h:t.hash, ok, r:reason };
                // Tituly csfd: — ČSFD ID z detailu torrentu (null = bez odkazu); chybí = detail se nestahoval
                if(found.csfdOf?.has(t.hash)) rec.csfd=found.csfdOf.get(t.hash);
                if(sentMap?.has(t.hash)) rec.sent=sentMap.get(t.hash);
                if(!isSeries&&ok&&isMoviePack(t.name)) rec.pack=true;
                if(cachedSet) rec.tb=cachedSet.has(t.hash);
                return rec;
            })
        });
        if(!torrents.length&&!batchTorrents.length){
            archiveStream(null,null);
            // SKT neodpovídá: místo prázdného výpisu (= „titul na SKT není“) jedna informační položka
            if(found.sktDown) return { streams:[{
                name:"SKTorrent\n⚠️ nedostupný",
                description:"⚠️ SKTorrent teď neodpovídá — výsledky nejde načíst.\nZkuste to znovu za chvíli.",
                ...link.file("skt-nedostupne.mp4"),
                behaviorHints:{ notWebReady:true, bingeGroup:"skt-nedostupne" }
            }], cacheMaxAge:0 };
            return { streams:[] };
        }

        let picked=[
            ...torrents.slice(0,MAX_EP_TORRENTS).map(t=>({ t, isBatch:false })),
            ...batchTorrents.map(t=>({ t, isBatch:true }))
        ].slice(0,MAX_ALL_TORRENTS);

        const hashes=picked.map(x=>x.t.hash);
        // Cache TorBoxu + stav torrentů, které už jsou v účtu (nejvýš 2,5 s — popisek není důležitější než rychlost)
        const [cachedSet,accounts]=await Promise.all([
            tbCachedSet(cfg,hashes),
            Promise.all(provs.map(p=>withTimeout(p.accountStatus(p.key(cfg),hashes),2500).catch(()=>null)))
        ]);
        // Epizody před balíky, v rámci nich napřed z cache TorBoxu; torrenty s 0 seedery mimo cache na konec
        // U seriálů navíc: možná cizí seriál stejného jména (Most / Bron pro MOST!) až za ostatní, sedící rok napřed
        const ourNames=[titles.en,titles.title,titles.original,titles.cz,titles.sk,...(titles.all||[]),...(titles.alt||[])];
        picked=orderPicked(picked,cachedSet,isSeries?{ uncertain:makeForeignTitleCheck(ourNames), yearOk:makeYearMatch(found.seasonYear||titles.year) }:{});

        // Kolekce filmů: při přehrání se vybere soubor podle roku / názvu (slug v URL)
        const movieYear=String(titles.year||"").slice(0,4).replace(/\D/g,"");
        const slug=removeDiacritics(titles.en||titles.title||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80)||"x";
        const streams=[];
        for(const { t, isBatch } of picked){
            const flags=flagsFromName(t.name);
            const cat=t.cat||"SKT";
            const isPack=!isSeries&&isMoviePack(t.name);
            const sel=isSeries?{ season, episode }:isPack?{ pack:true, year:movieYear, title:slug }:{};
            const label=`${cleanTorrentName(t)}${isBatch?` 📦 ${epTag} z balíku`:""}${isPack?" 📦 kolekce":""}`;
            for(const [pi,p] of provs.entries()){
                const cached=p.id==="tb"?(cachedSet?cachedSet.has(t.hash):null):undefined;
                const note=accountNote(accounts[pi]?.get(t.hash),p.label);
                const dead=!note&&isDead(t,cached)?"\n⚠️ 0 seedů a není v cache — stažení je nepravděpodobné":"";
                streams.push({
                    name:streamName(p,cat,cached),
                    description:`${label}\n👤 ${t.seeds}  📀 ${t.size}${flags?"  "+flags:""}\n${providerLine(p,cached)}${note?"\n"+note:""}${dead}`,
                    ...link.play(p.id,t.hash,sel),
                    behaviorHints:{ bingeGroup:`skt-${p.id}-${t.hash.slice(0,8)}`, notWebReady:true }
                });
            }
        }
        console.log(`✅ ${streams.length} streamů (${picked.length} torrentů × ${provs.length} služby)`);
        archiveStream(new Map(picked.map((x,i)=>[x.t.hash,i+1])),cachedSet);
        if(isSeries) prefetchNext(imdbId,type,season,episode,titles,cfg);
        return { streams };
    }catch(e){
        console.error("[STREAM] Error:",e.message);
        return { streams:[] };
    }
}


// Předhledání dalšího dílu na pozadí: výsledky jdou do paměti (6 h), další díl se pak otevře hned
const prefetched=createCache({ ttl:6*3600*1000, max:5000 });
function prefetchNext(imdbId,type,season,episode,titles,cfg){
    const key=`${cfg.sktUid||"anon"}|${imdbId}:${season}:${episode+1}`;
    if(prefetched.get(key)) return;
    prefetched.set(key,true);
    defer(()=>{
        console.log(`🔮 Předhledání ${imdbId} S${season}E${episode+1}`);
        findTorrents({ type, season, episode:episode+1, titles, sktUid:cfg.sktUid, sktPass:cfg.sktPass, background:true })
            .then(r=>{ if(!r){ prefetched.delete(key); console.log(`🔮 Předhledání ${imdbId} S${season}E${episode+1} vynecháno (moc souběžných hledání)`); } })
            .catch(e=>console.error("[Předhledání]",e.message));
    });
}

// ============ PLAY ============
// Krátká paměť výsledku přehrání (chyba / fronta / limit 90 s, stahuje se 25 s): přehrávač po neúspěchu
// opakuje každé ~2 s — opakování v téhle době nevolají API služby a nezapisují se znovu do archivu.
const playMemo=createCache({ ttl:90*1000, max:5000 });
const PLAY_MEMO=new Set(["error","queued","limit"]);
const PLAY_MEMO_DOWNLOADING_MS=25*1000;

// Přehrání → { url } (odkaz služby), { file } (informační video) nebo { error, status }.
// archiveIt: zapsat do archivu (server jen u GET, ne u HEAD)
async function playFor(cfg,provId,hash,sel,{ archiveIt=true }={}){
    const p=PROVIDERS[provId];
    const key=p?.key(cfg);
    if(!key) return { error:`Chybí klíč pro ${p?.label||provId}`, status:400 };
    hash=hash.toLowerCase();
    const what=sel.fileId!==undefined?`file ${sel.fileId}`:sel.pack?`kolekce → ${sel.title} (${sel.year||"?"})`:`S${sel.season??"-"}E${sel.episode??"-"}`;
    console.log(`\n▶️ Play ${p.short}: ${hash} ${what}`);
    const mk=`${p.id}:${keyId(key)}:${hash}:${selKey(sel)}`;
    let r=playMemo.get(mk);
    if(r){ r={ ...r, fromCache:true, memo:true }; console.log(`[Play] 💾 ${r.status} z paměti (${r.reason||""})`); }
    else{
        try{ r=await p.resolve(key,hash,sel); }
        catch(e){ r={ status:"error", reason:e.message }; }
        if(PLAY_MEMO.has(r.status)) playMemo.set(mk,{ status:r.status, reason:r.reason, videos:r.videos, ...(r.plan?{ plan:true }:{}) });
        else if(r.status==="downloading") playMemo.set(mk,{ status:r.status, progress:r.progress, state:r.state },PLAY_MEMO_DOWNLOADING_MS);
    }
    // Archiv: jen GET a ne opakované požadavky z cache (přehrávač volá /play víckrát)
    if(archiveIt&&!r.fromCache){
        const t=getCachedTorrent(hash);
        const rec={ kind:"play", prov:p.id, h:hash, n:t?.name||null, sel, status:r.status };
        if(r.file) rec.file=r.file;
        if(r.reason) rec.r=r.reason;
        if(r.call) rec.call=r.call;          // které volání API služby chybu vrátilo (TorBox)
        if(r.plan) rec.plan=true;            // plán účtu služby nedovoluje API
        if(r.status==="downloading"){ rec.progress=r.progress||0; if(r.state) rec.state=r.state; if(r.since) rec.since=r.since; }
        if(r.videos) rec.videos=r.videos;
        archive.write(rec);
    }
    if(r.status==="ready") return { url:r.url };
    if(r.status==="downloading"||r.status==="notadded"){
        if(!r.memo) console.log(`[Play] 🕐 Stahuje se → info video`);
        return { file:"downloading.mp4" };
    }
    if(r.status==="queued"||r.status==="limit"){
        if(!r.memo) console.log(`[Play] ⏳ ${r.reason} → info video`);
        return { file:r.plan?"torbox-plan.mp4":"fronta.mp4" };
    }
    if(!r.memo) console.log(`[Play] ❌ ${r.reason}`);
    return { error:`Chyba: ${r.reason}`, status:502 };
}

module.exports = { catalogFor, metaFor, streamsFor, playFor, sktDirectStreams, MAX_EP_TORRENTS, MAX_ALL_TORRENTS };
