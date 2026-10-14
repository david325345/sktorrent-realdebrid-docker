// Hledání torrentů na SKT pro IMDb titul (film / epizoda seriálu)
// SKT: hledá všechna slova dotazu (AND), ignoruje diakritiku, řadí od nejnovějších a stránkuje.
const { searchSKTPage, isPaused } = require("./skt");
const { episodeFilters, makeStrictTitleMatcher, buildSearchNames, filterYear, isMoviePack } = require("./matching");
const { delay } = require("./util");

const SEARCH_BUDGET_MS = 25000;   // celkový čas na hledání, ať Stremio nevyprší
const MAX_PAGES = 3;              // kolik stránek číst u dotazů bez roku / holého názvu

// Povolené kategorie SKT (vše ostatní se vynechá). Prázdná kategorie projde.
const ALLOWED = {
    movie:  /film|dokument/i,                              // Filmy CZ/SK dabing, Filmy s titulkami, HD/Blu-ray/UHD/3D Filmy, Filmy Kreslené…, Dokument
    series: /seri[aá]l|po[rř]ad|dokument|kreslen/i         // Seriál, TV Pořad, Dokument, Filmy Kreslené (animované seriály)
};

async function findTorrents({ type, season, episode, titles, sktUid, sktPass }){
    const started=Date.now();
    const overBudget=()=>Date.now()-started>SEARCH_BUDGET_MS;
    const stop=()=>isPaused(sktUid,sktPass)||overBudget();
    const allowed=ALLOWED[type==="series"?"series":"movie"];

    // Archiv hledání: každý torrent ze SKT s verdiktem a důvodem, plus provedené dotazy
    const audit=new Map(), queries=[];
    const mark=(t,ok,reason)=>{
        const prev=audit.get(t.hash);
        if(prev&&prev.ok&&!ok) return;              // jednou prošel (jiným názvem/dotazem) = prošel
        audit.set(t.hash,{ t, ok, reason });
    };

    // Jedna stránka výsledků, jen povolené kategorie
    const page=async(q,p=0)=>{
        const r=await searchSKTPage(q,sktUid,sktPass,p);
        queries.push({ q, p, n:r.items.length, more:r.hasMore, ms:r.ms??"cache" });
        const items=r.items.filter(t=>!t.cat||allowed.test(t.cat));
        const dropped=r.items.filter(t=>t.cat&&!allowed.test(t.cat));
        dropped.forEach(t=>mark(t,false,`kategorie mimo (${t.cat})`));
        if(dropped.length) console.log(`[SKT]   ⏭️ kategorie mimo ${type}: ${[...new Set(dropped.map(t=>t.cat))].join(", ")} (${dropped.length})`);
        return { items, hasMore:r.hasMore };
    };

    let torrents=[], batchTorrents=[];
    const isSeries=type==="series"&&season!==undefined&&episode!==undefined;
    const f=isSeries?episodeFilters(season,episode):null;
    const movieYear=(type==="movie"&&titles.year)?String(titles.year).replace(/[–-].*$/,"").trim():"";
    const addBatch=(list)=>{ for(const t of list) if(!batchTorrents.some(b=>b.hash===t.hash)&&!torrents.some(e=>e.hash===t.hash)) batchTorrents.push(t); };

    const { en, cz }=buildSearchNames(titles);
    // Pořadí hledání: nejdřív český název (SKT je CZ/SK, uploadeři ho dávají skoro vždy), pak anglický,
    // pak zkrácené varianty. Anglický se použije, když český chybí, je stejný, nebo nic nenajde.
    const names=[];
    for(const n of [cz[0],en[0],...cz.slice(1),...en.slice(1)]) if(n&&!names.includes(n)) names.push(n);
    // Přísná kontrola názvu: torrent musí nést celý některý z našich názvů z TMDB (ne jen slovo z něj).
    // Nezávisí na tom, kterým názvem se zrovna hledalo.
    const allNames=[titles.en,titles.title,titles.original,titles.cz,titles.sk,...(titles.all||[])];
    const strict=makeStrictTitleMatcher(allNames);
    // Kolekce („Predator 1-5“) nemá v názvu číslo pokračování → u kolekcí název bez čísel (rok hlídá rozsah)
    const strictBase=makeStrictTitleMatcher(allNames.filter(Boolean).map(n=>n.replace(/(^|\s)\d{1,2}(?=\s|$)/g," ").trim()));

    // ============ FILM ============
    async function movieQuery(name,q,maxPages){
        const matchesTitle=(t)=>strict(t.name,t.cat)||(isMoviePack(t.name)&&strictBase(t.name,t.cat));
        for(let p=0;p<maxPages&&!stop();p++){
            const r=await page(q,p);
            const byYear=filterYear(r.items,movieYear);
            const byTitle=byYear.filter(t=>matchesTitle(t));
            r.items.forEach(t=>{
                if(!byYear.includes(t)) mark(t,false,`rok nesedí (${(t.name.match(/\b(19|20)\d{2}\b/g)||[]).join(",")})`);
                else if(!byTitle.includes(t)) mark(t,false,"název nesedí");
                else mark(t,true,isMoviePack(t.name)?"kolekce":"film");
            });
            console.log(`[SKT] 🎞️ "${q}"${p?` str. ${p+1}`:""}: ${r.items.length} → rok ${byYear.length} → název ${byTitle.length}`);
            r.items.filter(t=>!byYear.includes(t)).slice(0,3).forEach(t=>console.log(`[SKT]   ⏭️ rok: "${t.name.slice(0,90)}"`));
            byYear.filter(t=>!byTitle.includes(t)).slice(0,3).forEach(t=>console.log(`[SKT]   ⏭️ název: "${t.name.slice(0,90)}"`));
            for(const t of byTitle) if(!torrents.some(x=>x.hash===t.hash)) torrents.push(t);
            if(torrents.length||!r.hasMore) break;
            await delay(300);            // jen mezi stránkami téhož dotazu
        }
    }

    if(!isSeries){
        // 1. Název + rok (přesné, starší filmy nejsou pohřbené pod novinkami)
        if(movieYear){
            for(const name of names){
                if(stop()) break;
                await movieQuery(name,`${name} ${movieYear}`,1);
                if(torrents.length) break;
            }
        }
        // 2. Název bez roku, víc stránek (rok na SKT se může lišit o ±1)
        if(!torrents.length){
            for(const name of names){
                if(stop()) break;
                await movieQuery(name,name,MAX_PAGES);
                if(torrents.length) break;
            }
        }
    }

    // ============ SERIÁL ============
    // Verdikt pro archiv (withNoSeason: krok 3, kde se berou i torrenty bez sezóny v názvu)
    const judgeSeries=(items,matchesTitle,withNoSeason)=>items.forEach(t=>{
        if(!matchesTitle(t)) return mark(t,false,"název nesedí");
        if(f.matchesExactEpisode(t.name)) return mark(t,true,"epizoda");
        if(f.isBatchSeason(t.name)) return mark(t,true,"balík");
        if(withNoSeason&&f.isNoSeasonCandidate(t.name)) return mark(t,true,"balík (bez sezóny v názvu)");
        mark(t,false,f.rejectReason(t.name));
    });
    async function seriesWithName(name){
        if(stop()) return;
        const matchesTitle=(t)=>strict(t.name,t.cat);
        const fit=(items)=>items.filter(t=>matchesTitle(t));
        const addEps=(list)=>{ for(const t of list) if(!torrents.some(x=>x.hash===t.hash)) torrents.push(t); };
        const take=(r)=>{ const found=fit(r.items); addEps(found.filter(t=>f.matchesExactEpisode(t.name))); addBatch(found.filter(t=>f.isBatchSeason(t.name))); };
        // Máme balík právě naší sezóny? (komplet „1-8. serie“ nestačí — pak se hledá dál)
        const haveSeasonPack=()=>batchTorrents.some(t=>f.isSeasonPack(t.name));
        const qSeri=`${name} seri`;     // „1. serie“, „2. séria“, „série“ (SKT hledá části slov, bez diakritiky)
        // Epizoda, sezóna, holý název a sezónní balíky najednou (čas = nejpomalejší dotaz, ne součet)
        const [ep,se,bare,seri]=await Promise.all([ page(`${name} ${f.epTag}`), page(`${name} ${f.seTag}`), page(name,0), page(qSeri,0) ]);
        for(const r of [ep,se,bare,seri]) take(r);
        judgeSeries(ep.items,matchesTitle,false);
        judgeSeries(se.items,matchesTitle,false);
        judgeSeries(seri.items,matchesTitle,false);

        // Další stránky dotazu „název seri“ — dokud nemáme balík naší sezóny
        const morePages=async(q,first,withNoSeason)=>{
            let r=first, p=0;
            while(true){
                if(withNoSeason){
                    const useNoSeason=!batchTorrents.length;
                    judgeSeries(r.items,matchesTitle,useNoSeason);
                    if(useNoSeason){
                        const noSeason=fit(r.items).filter(t=>f.isNoSeasonCandidate(t.name));
                        noSeason.forEach(t=>console.log(`[SKT] 📦 +balík: "${t.name.slice(0,80)}"`));
                        addBatch(noSeason);
                    }
                }else if(p>0) judgeSeries(r.items,matchesTitle,false);
                if(p>0) take(r);
                if(haveSeasonPack()||!r.hasMore||++p>=MAX_PAGES||stop()) break;
                await delay(300);        // jen mezi stránkami téhož dotazu
                r=await page(q,p);
            }
        };
        // Holý název (torrenty bez sezóny v názvu jen když chybí jiný balík) a „seri“ souběžně
        await Promise.all([ morePages(name,bare,true), morePages(qSeri,seri,false) ]);
    }

    if(isSeries){
        for(const name of names){
            await seriesWithName(name);
            if(torrents.length||batchTorrents.length||stop()) break;
        }
    }

    batchTorrents=batchTorrents.filter(b=>!torrents.some(t=>t.hash===b.hash));
    console.log(`[SKT] Výsledek: ${torrents.length} ${isSeries?"epizod":"filmů"}, ${batchTorrents.length} balíků (${Date.now()-started} ms)`);
    return { torrents, batchTorrents, epTag:f?.epTag||"", names, ms:Date.now()-started,
             audit:{ queries, torrents:[...audit.values()] } };
}

module.exports = { findTorrents };
