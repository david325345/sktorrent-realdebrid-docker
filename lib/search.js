// Hledání torrentů na SKT pro IMDb titul (film / epizoda seriálu)
// SKT: hledá všechna slova dotazu (AND), ignoruje diakritiku, řadí od nejnovějších a stránkuje.
const { searchSKTPage, isPaused } = require("./skt");
const { episodeFilters, makeTitleMatcher, buildSearchNames, filterYear, isMoviePack } = require("./matching");
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

    // Jedna stránka výsledků, jen povolené kategorie
    const page=async(q,p=0)=>{
        const r=await searchSKTPage(q,sktUid,sktPass,p);
        const items=r.items.filter(t=>!t.cat||allowed.test(t.cat));
        const dropped=r.items.filter(t=>t.cat&&!allowed.test(t.cat));
        if(dropped.length) console.log(`[SKT]   ⏭️ kategorie mimo ${type}: ${[...new Set(dropped.map(t=>t.cat))].join(", ")} (${dropped.length})`);
        return { items, hasMore:r.hasMore };
    };

    let torrents=[], batchTorrents=[];
    const isSeries=type==="series"&&season!==undefined&&episode!==undefined;
    const f=isSeries?episodeFilters(season,episode):null;
    const movieYear=(type==="movie"&&titles.year)?String(titles.year).replace(/[–-].*$/,"").trim():"";
    const addBatch=(list)=>{ for(const t of list) if(!batchTorrents.some(b=>b.hash===t.hash)&&!torrents.some(e=>e.hash===t.hash)) batchTorrents.push(t); };

    const { en, cz }=buildSearchNames(titles);
    const names=[...en,...cz];

    // ============ FILM ============
    async function movieQuery(name,q,maxPages){
        const exact=makeTitleMatcher(name);
        // Kolekce („Predator 1-5“) nemá číslo pokračování v názvu → u kolekcí stačí název bez čísel (rok hlídá rozsah)
        const base=makeTitleMatcher(name.replace(/(^|\s)\d{1,2}(?=\s|$)/g," ").trim()||name);
        const matchesTitle=(tn)=>exact(tn)||(isMoviePack(tn)&&base(tn));
        for(let p=0;p<maxPages&&!stop();p++){
            const r=await page(q,p);
            const byYear=filterYear(r.items,movieYear);
            const byTitle=byYear.filter(t=>matchesTitle(t.name));
            console.log(`[SKT] 🎞️ "${q}"${p?` str. ${p+1}`:""}: ${r.items.length} → rok ${byYear.length} → název ${byTitle.length}`);
            r.items.filter(t=>!byYear.includes(t)).slice(0,3).forEach(t=>console.log(`[SKT]   ⏭️ rok: "${t.name.slice(0,90)}"`));
            byYear.filter(t=>!byTitle.includes(t)).slice(0,3).forEach(t=>console.log(`[SKT]   ⏭️ název: "${t.name.slice(0,90)}"`));
            for(const t of byTitle) if(!torrents.some(x=>x.hash===t.hash)) torrents.push(t);
            if(torrents.length||!r.hasMore) break;
            await delay(300);
        }
        await delay(300);
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
    async function seriesWithName(name){
        const matchesTitle=makeTitleMatcher(name);
        // 1. Přesná epizoda
        if(!torrents.length&&!stop()){
            const found=(await page(`${name} ${f.epTag}`)).items.filter(t=>matchesTitle(t.name));
            const ep=found.filter(t=>f.matchesExactEpisode(t.name));
            if(ep.length) torrents=ep;
            addBatch(found.filter(t=>f.isBatchSeason(t.name)));
            await delay(300);
        }
        // 2. Balík sezóny
        if(!batchTorrents.length&&!stop()){
            const found=(await page(`${name} ${f.seTag}`)).items.filter(t=>matchesTitle(t.name));
            if(!torrents.length){ const ep=found.filter(t=>f.matchesExactEpisode(t.name)); if(ep.length) torrents=ep; }
            addBatch(found.filter(t=>f.isBatchSeason(t.name)));
            await delay(300);
        }
        // 3. Holý název přes víc stránek (komplety / „2. série“ bez S02 v názvu)
        if(!batchTorrents.length){
            for(let p=0;p<MAX_PAGES&&!stop();p++){
                const r=await page(name,p);
                const found=r.items.filter(t=>matchesTitle(t.name));
                if(!torrents.length){ const ep=found.filter(t=>f.matchesExactEpisode(t.name)); if(ep.length) torrents=ep; }
                addBatch(found.filter(t=>f.isBatchSeason(t.name)));
                const noSeason=found.filter(t=>f.isNoSeasonCandidate(t.name));
                noSeason.forEach(t=>console.log(`[SKT] 📦 +balík: "${t.name.slice(0,80)}"`));
                addBatch(noSeason);
                await delay(300);
                if(!r.hasMore) break;
            }
        }
    }

    if(isSeries){
        for(const name of en){
            await seriesWithName(name);
            if(torrents.length||batchTorrents.length||stop()) break;
        }
        if(!torrents.length&&!batchTorrents.length){
            for(const name of cz){
                await seriesWithName(name);
                if(torrents.length||batchTorrents.length||stop()) break;
            }
        }
    }

    batchTorrents=batchTorrents.filter(b=>!torrents.some(t=>t.hash===b.hash));
    console.log(`[SKT] Výsledek: ${torrents.length} ${isSeries?"epizod":"filmů"}, ${batchTorrents.length} balíků (${Date.now()-started} ms)`);
    return { torrents, batchTorrents, epTag:f?.epTag||"" };
}

module.exports = { findTorrents };
