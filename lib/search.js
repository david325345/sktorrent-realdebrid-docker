// Hledání torrentů na SKT pro IMDb titul (film / epizoda seriálu)
// SKT: hledá všechna slova dotazu (AND), ignoruje diakritiku, řadí od nejnovějších a stránkuje.
const { searchSKTPage, isPaused, breakerOpen, getTorrentCsfd } = require("./skt");
const { episodeFilters, makeStrictTitleMatcher, makeSeriesYearCheck, dashShortNames, makeSeasonYearCheck, lastKnownSeasonYear, buildSearchNames, filterYear, isMoviePack } = require("./matching");
const { delay } = require("./util");

const SEARCH_BUDGET_MS = +process.env.SKT_SEARCH_BUDGET_MS||25000;   // celkový čas na hledání (tvrdý limit, i pro dotazy čekající ve frontě), ať Stremio nevyprší
const ROUND_MIN_MS = Math.round(SEARCH_BUDGET_MS*0.32);              // 8 s: další kolo dotazů (název, stránka) nezačínat, když do konce rozpočtu zbývá míň
const MAX_PAGES = 3;              // kolik stránek číst u dotazů bez roku / holého názvu
const MAX_CONCURRENT = 4;         // nejvýš tolik hledání najednou (klienti, kteří předem načítají celé sezóny, by jinak zahltili SKT)
const MAX_DETAILS = 8;            // tituly csfd: — nejvýš tolik detailů torrentů (ČSFD odkaz) stažených za jedno hledání
const DETAIL_CONCURRENCY = 2;

// ============ Omezení souběžných hledání ============
let active=0;
const waiters=[];
function acquire(maxWaitMs, background){
    if(active<MAX_CONCURRENT){ active++; return Promise.resolve(true); }
    if(background||maxWaitMs<=0) return Promise.resolve(false);
    return new Promise(res=>{
        const w={ res };
        w.timer=setTimeout(()=>{ const i=waiters.indexOf(w); if(i>=0) waiters.splice(i,1); res(false); },maxWaitMs);
        waiters.push(w);
    });
}
function release(){
    const w=waiters.shift();
    if(w){ clearTimeout(w.timer); w.res(true); }      // místo rovnou předá dalšímu (active se nemění)
    else active--;
}
const timeLeft=(started)=>SEARCH_BUDGET_MS-(Date.now()-started);
const raceDeadline=(promise,ms,fallback)=>new Promise(res=>{
    const t=setTimeout(()=>res(fallback),Math.max(0,ms));
    promise.then(v=>{ clearTimeout(t); res(v); },()=>{ clearTimeout(t); res(fallback); });
});

// Povolené kategorie SKT (vše ostatní se vynechá). Prázdná kategorie projde.
const ALLOWED = {
    movie:  /film|dokument/i,                              // Filmy CZ/SK dabing, Filmy s titulkami, HD/Blu-ray/UHD/3D Filmy, Filmy Kreslené…, Dokument
    series: /seri[aá]l|po[rř]ad|dokument|kreslen/i         // Seriál, TV Pořad, Dokument, Filmy Kreslené (animované seriály)
};

/** background=true (předhledání dalšího dílu): když nejsou volná místa, nehledá se vůbec */
async function findTorrents(opts){
    const started=Date.now();
    const got=await acquire(SEARCH_BUDGET_MS-ROUND_MIN_MS-1000,!!opts.background);
    if(!got){
        if(opts.background) return null;
        console.log(`[SKT] ⏳ Příliš mnoho souběžných hledání — vzdávám po ${Date.now()-started} ms`);
        return { torrents:[], batchTorrents:[], epTag:"", names:[], seasonYear:null, ms:Date.now()-started, sktDown:true,
                 audit:{ queries:[{ q:"", p:0, n:0, err:"fronta hledání", ms:Date.now()-started }], torrents:[] } };
    }
    const queued=Date.now()-started;
    if(queued>=100) console.log(`[SKT] ⏳ Hledání čekalo ${queued} ms na volné místo`);
    try{ return await findTorrentsInner(opts,started,queued); }
    finally{ release(); }
}

async function findTorrentsInner({ type, season, episode, titles, sktUid, sktPass }, started, queuedMs){
    const overBudget=()=>timeLeft(started)<=0;
    // Chyby SKT (timeout, výpadek, 403): po 2 chybách v jednom hledání (nebo otevřeném jističi) se další dotazy nezkouší
    let failed=0;
    const sktFailing=()=>failed>=2||breakerOpen()||isPaused(sktUid,sktPass);
    const stop=()=>sktFailing()||overBudget();
    const canStartRound=()=>!stop()&&timeLeft(started)>=ROUND_MIN_MS;
    const allowed=ALLOWED[type==="series"?"series":"movie"];

    // Archiv hledání: každý torrent ze SKT s verdiktem a důvodem, plus provedené dotazy
    const audit=new Map(), queries=[];
    const mark=(t,ok,reason)=>{
        const prev=audit.get(t.hash);
        if(prev&&prev.ok&&!ok) return;              // jednou prošel (jiným názvem/dotazem) = prošel
        audit.set(t.hash,{ t, ok, reason });
    };

    // Jedna stránka výsledků, jen povolené kategorie. Dotaz se utne nejpozději s koncem rozpočtu hledání.
    const page=async(q,p=0)=>{
        const t0=Date.now();
        const r=await raceDeadline(searchSKTPage(q,sktUid,sktPass,p),timeLeft(started),{ items:[], hasMore:false, err:"limit hledání" });
        const rec={ q, p, n:r.items.length, more:r.hasMore, ms:r.cached?"cache":(r.ms??Date.now()-t0) };
        if(r.wait) rec.wait=r.wait;
        if(r.err){ rec.err=r.err; failed++; }
        queries.push(rec);
        const items=r.items.filter(t=>!t.cat||allowed.test(t.cat));
        const dropped=r.items.filter(t=>t.cat&&!allowed.test(t.cat));
        dropped.forEach(t=>mark(t,false,`kategorie mimo (${t.cat})`));
        if(dropped.length) console.log(`[SKT]   ⏭️ kategorie mimo ${type}: ${[...new Set(dropped.map(t=>t.cat))].join(", ")} (${dropped.length})`);
        await verifyCsfd(items);
        return { items, hasMore:r.hasMore, err:r.err };
    };

    let torrents=[], batchTorrents=[], noSeasonTorrents=[];
    const isSeries=type==="series"&&season!==undefined&&episode!==undefined;
    const f=isSeries?episodeFilters(season,episode):null;
    const movieYear=(type==="movie"&&titles.year)?String(titles.year).replace(/[–-].*$/,"").trim():"";
    const addBatch=(list)=>{ for(const t of list) if(!batchTorrents.some(b=>b.hash===t.hash)&&!torrents.some(e=>e.hash===t.hash)) batchTorrents.push(t); };

    const { en, cz, sk }=buildSearchNames(titles);
    // Pořadí hledání: nejdřív český název (SKT je CZ/SK, uploadeři ho dávají skoro vždy), pak anglický,
    // pak zkrácené varianty. Anglický se použije, když český chybí, je stejný, nebo nic nenajde.
    // Přísná kontrola názvu: torrent musí nést celý některý z našich názvů z TMDB (ne jen slovo z něj).
    // Nezávisí na tom, kterým názvem se zrovna hledalo.
    // + alternativní názvy z TMDB začínající naším názvem („Arcane: League of Legends“) — jen pro porovnání, nehledá se jimi
    const allNames0=[titles.en,titles.title,titles.original,titles.cz,titles.sk,...(titles.all||[]),...(titles.alt||[])];   // nelatinkové se očistí v matcheru
    // + krátký název před „ - “ („KonoSuba“ z „KONOSUBA - God's blessing…“) — hledá se jím i platí v přísné kontrole
    const allNames=[...allNames0,...dashShortNames([titles.en,titles.cz])];
    // U filmů platí shoda jen za dvojtečkou („Vysoké Tatry: V srdci divočiny“) jen s rokem v názvu torrentu
    // Filmy navíc (jen s přesně sedícím rokem): vynechaný střed názvu, prohozené části kolem dvojtečky
    const strictRaw=makeStrictTitleMatcher(allNames,{ colonNeedsYear:type!=="series", filmYear:movieYear||null });
    // Tituly csfd: — ČSFD ID z detailu torrentu má přednost před názvem: sedí → projde i s jiným názvem,
    // jiné ID → vypadne i se stejným názvem (remake, jiný seriál stejného jména), bez odkazu → přísná kontrola názvu.
    const ourCsfd=titles.source==="csfd"&&titles.csfdId?Number(titles.csfdId):null;
    const csfdOf=new Map();          // hash → ČSFD ID z detailu (null = detail odkaz nemá)
    const csfdByName=new Map();      // název torrentu → ČSFD ID (kontrola názvu dostává jen název)
    const csfdState=(name)=>{
        if(!ourCsfd||!csfdByName.has(name)) return null;
        const c=csfdByName.get(name);
        return c===null?null:c===ourCsfd?"match":"other";
    };
    const strict=(name,cat,opts)=>{
        const st=csfdState(name);
        if(st==="match") return true;
        if(st==="other") return false;
        return strictRaw(name,cat,opts);
    };
    const nameReason=(t)=>csfdState(t.name)==="other"?`jiné ČSFD (${csfdByName.get(t.name)})`:"název nesedí";
    let detailsLeft=MAX_DETAILS, dActive=0;
    const dWait=[];
    const dAcquire=()=>dActive<DETAIL_CONCURRENCY?(dActive++,Promise.resolve()):new Promise(r=>dWait.push(r));
    const dRelease=()=>{ const w=dWait.shift(); if(w) w(); else dActive--; };
    async function verifyCsfd(items){
        if(!ourCsfd) return;
        // Nejdřív torrenty, které projdou kontrolou názvu (potvrdit / vyřadit), pak ostatní (záchrana jiného názvu)
        const cand=items.filter(t=>!csfdOf.has(t.hash)&&(!t.cat||allowed.test(t.cat)))
            .sort((a,b)=>(strictRaw(b.name,b.cat)?1:0)-(strictRaw(a.name,a.cat)?1:0));
        const jobs=[];
        for(const t of cand){
            if(csfdOf.has(t.hash)) continue;
            if(detailsLeft<=0||stop()) break;
            detailsLeft--;
            csfdOf.set(t.hash,undefined);            // rozpracováno (ať ho souběžná stránka nestahuje znovu)
            jobs.push(dAcquire().then(async()=>{
                const c=stop()?undefined:await raceDeadline(getTorrentCsfd(t.hash,sktUid,sktPass),timeLeft(started),undefined);
                if(c===undefined) csfdOf.delete(t.hash);
                else{ csfdOf.set(t.hash,c); csfdByName.set(t.name,c); }
            }).finally(dRelease));
        }
        await Promise.all(jobs);
    }
    // Kolekce („Predator 1-5“) nemá v názvu číslo pokračování → u kolekcí název bez čísel (rok hlídá rozsah)
    const strictBase=makeStrictTitleMatcher(allNames.filter(Boolean).map(n=>n.replace(/(^|\s)\d{1,2}(?=\s|$)/g," ").trim()));
    // Zkrácené názvy (část před „:“ / „ - “) jen když je přísná kontrola sama pustí — jinak by dotazy na
    // „2 světová válka“ / „Cyberpunk“ vracely jen torrenty, které stejně neprojdou (a plný název najde SKT i tak)
    const names=[];
    const primary=new Set([cz[0],en[0],sk[0]].filter(Boolean));
    const usable=(n)=>primary.has(n)||strict(n,"")||(type!=="series"&&strictBase(n,""));
    // Tituly jen na ČSFD (převážně česká a slovenská tvorba): CZ, SK, pak anglický / originál — nejvýš 3 názvy
    // (bez EN názvu dá buildSearchNames český název mezi „en“ — proto cz[0]||en[0])
    const order=ourCsfd?[cz[0]||en[0],sk[0],en[0],...cz.slice(1),...en.slice(1)]:[cz[0],en[0],...cz.slice(1),...en.slice(1),...sk];
    for(const n of order) if(n&&!names.includes(n)&&usable(n)&&(!ourCsfd||names.length<3)) names.push(n);

    // ============ FILM ============
    const matchesMovie=(t)=>strict(t.name,t.cat)||(isMoviePack(t.name)&&strictBase(t.name,t.cat));
    // Vyhodnocení jedné stránky výsledků filmu (verdikty do archivu, nalezené do torrents)
    function judgeMovie(q,p,r){
        const byYear=r.items.filter(t=>csfdState(t.name)==="match"||filterYear([t],movieYear).length);
        const byTitle=byYear.filter(t=>matchesMovie(t));
        r.items.forEach(t=>{
            if(!byYear.includes(t)) mark(t,false,`rok nesedí (${(t.name.match(/\b(19|20)\d{2}\b/g)||[]).join(",")})`);
            else if(!byTitle.includes(t)) mark(t,false,nameReason(t));
            else mark(t,true,isMoviePack(t.name)?"kolekce":"film");
        });
        console.log(`[SKT] 🎞️ "${q}"${p?` str. ${p+1}`:""}: ${r.items.length} → rok ${byYear.length} → název ${byTitle.length}`);
        r.items.filter(t=>!byYear.includes(t)).slice(0,3).forEach(t=>console.log(`[SKT]   ⏭️ rok: "${t.name.slice(0,90)}"`));
        byYear.filter(t=>!byTitle.includes(t)).slice(0,3).forEach(t=>console.log(`[SKT]   ⏭️ název: "${t.name.slice(0,90)}"`));
        for(const t of byTitle) if(!torrents.some(x=>x.hash===t.hash)) torrents.push(t);
    }
    async function movieQuery(name,q,maxPages){
        for(let p=0;p<maxPages&&(p===0?canStartRound():!stop());p++){
            const r=await page(q,p);
            judgeMovie(q,p,r);
            if(torrents.length||!r.hasMore) break;
            await delay(300);            // jen mezi stránkami téhož dotazu
        }
    }

    if(!isSeries){
        // 1. Název + rok pro všechny názvy souběžně (přesné, starší filmy nejsou pohřbené pod novinkami);
        //    výsledky se vyhodnotí v pořadí názvů (CZ, EN, SK)
        if(movieYear&&names.length&&canStartRound()){
            const qs=names.slice(0,3).map(n=>`${n} ${movieYear}`);
            const rs=await Promise.all(qs.map(q=>page(q,0)));
            rs.forEach((r,i)=>judgeMovie(qs[i],0,r));
            // Další (zkrácené) názvy s rokem až potom, po jednom
            for(const name of names.slice(3)){
                if(torrents.length||!canStartRound()) break;
                await movieQuery(name,`${name} ${movieYear}`,1);
            }
        }
        // 2. Název bez roku (rok na SKT se může lišit o ±1): první stránky CZ / EN / SK souběžně, vyhodnocení
        //    v pořadí názvů; další stránky jen u prvního názvu, kde SKT má víc stránek.
        //    Letošní a loňský film jen 1 stránka — SKT řadí od nejnovějších a s rokem by ho našel už krok 1.
        if(!torrents.length&&names.length&&canStartRound()){
            const recent=movieYear&&parseInt(movieYear)>=new Date().getFullYear()-1;
            const maxPages=recent?1:MAX_PAGES;
            const qs=names.slice(0,3);
            const rs=await Promise.all(qs.map(q=>page(q,0)));
            rs.forEach((r,i)=>judgeMovie(qs[i],0,r));
            const more=rs.findIndex(r=>r.hasMore);
            if(!torrents.length&&more>=0){
                for(let p=1;p<maxPages&&!torrents.length&&canStartRound();p++){
                    await delay(300);
                    const r=await page(qs[more],p);
                    judgeMovie(qs[more],p,r);
                    if(!r.hasMore) break;
                }
            }
            for(const name of names.slice(3)){
                if(torrents.length||!canStartRound()) break;
                await movieQuery(name,name,maxPages);
            }
        }
    }

    // ============ SERIÁL ============
    // Verdikt pro archiv (withNoSeason: krok 3, kde se berou i torrenty bez sezóny v názvu)
    let titleSeen=0;      // kolik torrentů toho titulu (jakýkoli díl) SKT pod daným názvem vrátilo
    // Jiný seriál stejného jména: torrent jen s roky před začátkem našeho seriálu („Most / Bron (2011)“ pro „MOST!“ 2019)
    const tooOld=isSeries?makeSeriesYearCheck(titles.year,allNames):()=>null;
    // Torrent bez sezóny v názvu jen s roky před premiérou hledané sezóny = starší řada
    const seasonYear=isSeries?(titles.seasonYears||{})[season]:null;
    const seasonAfter=isSeries?lastKnownSeasonYear(titles.seasonYears,season):null;   // sezóna novější než TMDB zná
    const beforeSeason=isSeries?makeSeasonYearCheck(seasonYear,season,allNames,{ lastKnownYear:seasonAfter }):()=>null;
    const noSeasonOk=(t)=>f.isNoSeasonCandidate(t.name)&&strict(t.name,t.cat,{ whole:true })&&!beforeSeason(t.name);
    const judgeSeries=(items,matchesTitle,withNoSeason)=>items.forEach(t=>{
        if(!strict(t.name,t.cat)) return mark(t,false,nameReason(t));
        const old=csfdState(t.name)==="match"?null:tooOld(t.name);
        if(old) return mark(t,false,old);
        titleSeen++;
        if(f.matchesExactEpisode(t.name)) return mark(t,true,"epizoda");
        if(f.isBatchSeason(t.name)) return mark(t,true,"balík");
        if(withNoSeason&&f.isNoSeasonCandidate(t.name)){
            if(!strict(t.name,t.cat,{ whole:true })) return mark(t,false,"bez sezóny, název jen částečně");
            const before=beforeSeason(t.name);
            return before ? mark(t,false,before) : mark(t,true,"balík (bez sezóny v názvu)");
        }
        mark(t,false,f.rejectReason(t.name));
    });
    let bareErr=false;
    async function seriesWithName(name){
        if(!canStartRound()) return;
        const matchesTitle=(t)=>strict(t.name,t.cat)&&(csfdState(t.name)==="match"||!tooOld(t.name));
        const fit=(items)=>items.filter(t=>matchesTitle(t));
        const addEps=(list)=>{ for(const t of list) if(!torrents.some(x=>x.hash===t.hash)) torrents.push(t); };
        const take=(r)=>{ const found=fit(r.items); addEps(found.filter(t=>f.matchesExactEpisode(t.name))); addBatch(found.filter(t=>f.isBatchSeason(t.name))); };
        // Máme balík právě naší sezóny? (komplet „1-8. serie“ nestačí — pak se hledá dál)
        const haveSeasonPack=()=>batchTorrents.some(t=>f.isSeasonPack(t.name));
        const qSeri=`${name} seri`;     // „1. serie“, „2. séria“, „série“ (SKT hledá části slov, bez diakritiky)
        // Epizoda, sezóna, holý název a sezónní balíky najednou (čas = nejpomalejší dotaz, ne součet)
        const [ep,se,bare,seri]=await Promise.all([ page(`${name} ${f.epTag}`), page(`${name} ${f.seTag}`), page(name,0), page(qSeri,0) ]);
        if(bare.err) bareErr=true;      // holý název neprošel kvůli chybě SKT → další názvy by dopadly stejně
        for(const r of [ep,se,bare,seri]) take(r);
        judgeSeries(ep.items,matchesTitle,false);
        judgeSeries(se.items,matchesTitle,false);
        judgeSeries(seri.items,matchesTitle,false);

        // Další stránky dotazu „název seri“ — dokud nemáme balík naší sezóny
        const morePages=async(q,first,withNoSeason)=>{
            let r=first, p=0;
            while(true){
                if(withNoSeason){
                    // Torrenty bez sezóny v názvu („Svět ve válce (1973)“) — vždy, ale ve výpisu až na konci
                    judgeSeries(r.items,matchesTitle,true);
                    for(const t of fit(r.items).filter(noSeasonOk))
                        if(!noSeasonTorrents.some(x=>x.hash===t.hash)){ noSeasonTorrents.push(t); console.log(`[SKT] 📦 +bez sezóny: "${t.name.slice(0,80)}"`); }
                }else if(p>0) judgeSeries(r.items,matchesTitle,false);
                if(p>0) take(r);
                if(haveSeasonPack()||!r.hasMore||++p>=MAX_PAGES||!canStartRound()) break;
                await delay(300);        // jen mezi stránkami téhož dotazu
                r=await page(q,p);
            }
        };
        // Holý název a „seri“ souběžně
        await Promise.all([ morePages(name,bare,true), morePages(qSeri,seri,false) ]);
    }

    if(isSeries){
        for(const name of names){
            await seriesWithName(name);
            // Titul pod tímhle názvem na SKT je (aspoň jiné díly) → další názvy nic nového nepřinesou
            if(torrents.length||batchTorrents.length||noSeasonTorrents.length||titleSeen||bareErr||stop()) break;
        }
    }

    for(const t of noSeasonTorrents) addBatch([t]);       // až za balíky se sezónou
    batchTorrents=batchTorrents.filter(b=>!torrents.some(t=>t.hash===b.hash));
    // Hledání se vůbec nespustilo kvůli jističi / pauze po 403 → zapsat do archivu jako chybu
    if(!queries.length&&sktFailing()) queries.push({ q:"", p:0, n:0, ms:0, err:breakerOpen()?"jistič":"pauza 403" });
    // Nic nenalezeno a aspoň jeden dotaz skončil chybou SKT → nejde o „titul na SKT není“
    const sktDown=!torrents.length&&!batchTorrents.length&&queries.some(q=>q.err);
    console.log(`[SKT] Výsledek: ${torrents.length} ${isSeries?"epizod":"filmů"}, ${batchTorrents.length} balíků (${Date.now()-started} ms)${sktDown?" — ⚠️ SKT neodpovídá":""}`);
    return { torrents, batchTorrents, epTag:f?.epTag||"", names, seasonYear:seasonYear||null, ...(seasonAfter?{ seasonAfter }:{}), ms:Date.now()-started,
             ...(sktDown?{ sktDown:true }:{}), ...(queuedMs>=100?{ queuedMs }:{}),
             ...(ourCsfd?{ csfdOf:new Map([...csfdOf].filter(([,v])=>v!==undefined)) }:{}),
             audit:{ queries, torrents:[...audit.values()] } };
}

module.exports = { findTorrents, ALLOWED, SEARCH_BUDGET_MS, MAX_CONCURRENT };
