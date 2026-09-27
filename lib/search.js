// Hledání torrentů na SKT pro IMDb titul (film / epizoda seriálu)
const { searchSKT, isPaused } = require("./skt");
const { episodeFilters, makeTitleMatcher, buildSearchNames, filterYear } = require("./matching");
const { delay } = require("./util");

const SEARCH_BUDGET_MS = 25000;   // celkový čas na hledání, ať Stremio nevyprší

async function findTorrents({ type, season, episode, titles, sktUid, sktPass }){
    const started=Date.now();
    const overBudget=()=>Date.now()-started>SEARCH_BUDGET_MS;
    const paused=()=>isPaused(sktUid,sktPass);
    const search=async(q)=>{ const r=await searchSKT(q,sktUid,sktPass); return r; };

    let torrents=[], batchTorrents=[];
    const isSeries=type==="series"&&season!==undefined&&episode!==undefined;
    const f=isSeries?episodeFilters(season,episode):null;
    const movieYear=(type==="movie"&&titles.year)?String(titles.year).replace(/[–-].*$/,"").trim():"";

    const addBatch=(list)=>{ for(const t of list) if(!batchTorrents.some(b=>b.hash===t.hash)) batchTorrents.push(t); };

    async function searchWithName(name){
        if(paused()||overBudget()) return;
        const matchesTitle=makeTitleMatcher(name);

        if(isSeries){
            // 1. Přesná epizoda
            if(!torrents.length){
                const found=(await search(`${name} ${f.epTag}`)).filter(t=>matchesTitle(t.name));
                const ep=found.filter(t=>f.matchesExactEpisode(t.name));
                if(ep.length) torrents=ep;
                addBatch(found.filter(t=>f.isBatchSeason(t.name)));
                await delay(300);
            }
            // 2. Balík sezóny
            if(!batchTorrents.length&&!paused()&&!overBudget()){
                const found=(await search(`${name} ${f.seTag}`)).filter(t=>matchesTitle(t.name));
                addBatch(found.filter(t=>f.isBatchSeason(t.name)));
                if(!torrents.length){ const ep=found.filter(t=>f.matchesExactEpisode(t.name)); if(ep.length) torrents=ep; }
                await delay(300);
            }
            // 3. Holý název
            if(!batchTorrents.length&&!paused()&&!overBudget()){
                const found=(await search(name)).filter(t=>matchesTitle(t.name));
                if(!torrents.length){ const ep=found.filter(t=>f.matchesExactEpisode(t.name)); if(ep.length) torrents=ep; }
                addBatch(found.filter(t=>f.isBatchSeason(t.name)));
                const noSeason=found.filter(t=>f.isNoSeasonCandidate(t.name));
                if(noSeason.length){
                    noSeason.forEach(t=>console.log(`[SKT] 📦 +batch: "${t.name.slice(0,80)}"`));
                    addBatch(noSeason);
                }
                await delay(300);
            }
        }else if(!torrents.length){
            torrents=filterYear(await search(name),movieYear).filter(t=>matchesTitle(t.name));
            await delay(300);
        }
    }

    const { en, cz }=buildSearchNames(titles);
    for(const name of en){
        await searchWithName(name);
        if(torrents.length||batchTorrents.length) break;
    }
    if(!torrents.length&&!batchTorrents.length){
        for(const name of cz){
            await searchWithName(name);
            if(torrents.length||batchTorrents.length) break;
        }
    }
    // Epizody nepatří mezi balíky
    batchTorrents=batchTorrents.filter(b=>!torrents.some(t=>t.hash===b.hash));
    console.log(`[SKT] Výsledek: ${torrents.length} epizod/filmů, ${batchTorrents.length} balíků (${Date.now()-started} ms)`);
    return { torrents, batchTorrents, epTag:f?.epTag||"" };
}

module.exports = { findTorrents };
