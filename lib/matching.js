// Párování názvů torrentů / souborů na titul, sezónu a epizodu
const { removeDiacritics, isVideo, isSample, basename } = require("./util");

const pad = (n)=>String(n).padStart(2,"0");
const escRe = (s)=>String(s).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

// ============ Filtry torrentů podle názvu (výsledky hledání SKT) ============
function episodeFilters(season, episode){
    const sn=String(season);
    const seTag=`S${pad(season)}`;
    const epTag=`S${pad(season)}E${pad(episode)}`;
    const exactRe=new RegExp(`(?<![a-z0-9])S0*${season}\\s?E0*${episode}(?!\\d)`,"i");
    const exactRangeRe=new RegExp(`(?<![a-z0-9])S0*${season}\\s?E0*${episode}\\s*-\\s*E?\\d`,"i");

    // Přesně naše epizoda (S01E05, ne S01E050 ani rozsah S01E05-E08 — ten je balík)
    const matchesExactEpisode=(name)=>exactRe.test(name)&&!exactRangeRe.test(name);

    // Název obsahuje nějakou epizodu naší sezóny (ne rozsah)
    const hasAnyEpisode=(name)=>{
        if(new RegExp(`(?<![a-z0-9])S0*${season}\\s?E\\d{1,3}`,"i").test(name)) return true;
        if(/(?<![\dx])\d{1,2}x\d{2,3}(?![\dp])/i.test(name)) return true;          // 1x05 (ne 1920x1080)
        if(/[._\- ]E\d{2}[._\- ]/i.test(name)&&!/E\d{2}\s*-\s*E?\d{2}/i.test(name)) return true;
        return false;
    };

    // Rozsah epizod v názvu: S01E01-E10 / E01-E10 / E01-10 → balík jen když obsahuje naši epizodu
    const episodeRange=(name)=>{
        const m=name.match(/(?:(?<![a-z0-9])S(\d{1,2}))?[ ._\-]?E(\d{1,3})\s*-\s*E?(\d{1,3})(?!\d)/i);
        if(!m) return null;
        const s=m[1]!==undefined?parseInt(m[1]):null;
        return { season:s, from:parseInt(m[2]), to:parseInt(m[3]) };
    };

    const isBatchSeason=(name)=>{
        const r=episodeRange(name);
        if(r){
            if(r.season!==null&&r.season!==season) return false;
            return episode>=r.from&&episode<=r.to;
        }
        const up=name.toUpperCase();
        const norm=removeDiacritics(name).toLowerCase();
        const hasSe=new RegExp(`(?<![A-Z0-9])${seTag}(?!\\d)`).test(up)
            ||(new RegExp(`(^|\\W)${sn}\\s*\\.?\\s*s[eé]ri[ea]`,"i")).test(name)
            ||(new RegExp(`s[eé]ri[ea]\\s*${sn}(\\W|$)`,"i")).test(name)
            ||(new RegExp(`(^|\\W)${sn}\\s*\\.?\\s*serie`,"i")).test(norm);
        if(hasSe&&!hasAnyEpisode(name)) return true;
        if(/\b(komplet|complete)\b/i.test(name)&&!hasAnyEpisode(name)) return true;
        const rangeMatch=name.match(/S(\d{2})\s*-\s*S(\d{2})/i);
        if(rangeMatch){
            const from=parseInt(rangeMatch[1]),to=parseInt(rangeMatch[2]);
            if(season>=from&&season<=to&&!hasAnyEpisode(name)) return true;
        }
        const czRange=norm.match(/(\d+)\s*-\s*(\d+)\s*\.?\s*serie/i);
        if(czRange){
            const from=parseInt(czRange[1]),to=parseInt(czRange[2]);
            if(season>=from&&season<=to&&!hasAnyEpisode(name)) return true;
        }
        return false;
    };

    // Torrent bez sezóny/epizody v názvu (např. „Seriál 1-5“) — může obsahovat naši sezónu
    const isNoSeasonCandidate=(name)=>{
        if(matchesExactEpisode(name)||isBatchSeason(name)) return false;
        if(hasAnyEpisode(name)) return false;
        if(episodeRange(name)) return false;
        const up=name.toUpperCase();
        const norm=removeDiacritics(name).toLowerCase();
        const sMatch=up.match(/(?<![A-Z0-9])S(\d{2})(?!\d)/g);
        if(sMatch&&!sMatch.some(s=>s===seTag)) return false;
        const czMatch=norm.match(/(\d+)\s*\.?\s*serie/i);
        if(czMatch&&czMatch[1]!==sn) return false;
        const cleanForNum=norm.replace(/\b(19|20)\d{2}\b/g,"").replace(/\b\d{3,4}p\b/g,"").replace(/\b\d+\s*(gb|mb|kb)\b/gi,"");
        const numMatch=cleanForNum.match(/(?:^|\s|[/\-])0*(\d{1,2})(?:\s|$|[/\-\.])/g);
        if(numMatch){
            const seasonNums=numMatch.map(n=>parseInt(n.trim().replace(/[^0-9]/g,""))).filter(n=>n>=1&&n<=30);
            if(seasonNums.length>0&&!seasonNums.includes(season)) return false;
        }
        return true;
    };

    return { seTag, epTag, matchesExactEpisode, hasAnyEpisode, isBatchSeason, isNoSeasonCandidate };
}

// ============ Ověření, že torrent patří k titulu ============
function titleWordsOf(name){
    const clean=removeDiacritics(name).replace(/['’]/g,"").replace(/S\d{2}E?\d{0,2}/gi,"").replace(/\d+x\d+/g,"").trim();
    return clean.toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(w=>w.length>=2);
}

function makeTitleMatcher(searchName){
    const titleWords=titleWordsOf(searchName);
    const titleSet=new Set(titleWords);
    const phrase=titleWords.join(" ");
    const wordRe=(w)=>new RegExp(`(^|[^a-z0-9])${escRe(w)}([^a-z0-9]|$)`);
    const phraseRe=phrase?wordRe(phrase):null;

    return (tname)=>{
        if(titleWords.length===0) return true;
        let tn=removeDiacritics(tname).toLowerCase().replace(/['’]/g,"").replace(/[^a-z0-9\s\/\-\.]/g," ").replace(/\s+/g," ");
        tn=tn.replace(/^stiahni si\s+\w+\s+/i,"");
        const epPos=tn.search(/s\d{2}e\d{2}/i);
        if(epPos>=0){ const d=tn.indexOf(" - ",epPos); if(d>=0) tn=tn.slice(0,d); }
        // Ořízni za "=", "(", "csfd" nebo rokem, který NENÍ součástí názvu (Blade Runner 2049, 1917)
        let cut=tn.length;
        const stop=tn.search(/[=(]|\bcsfd\b/);
        if(stop>=0) cut=stop;
        for(const m of tn.matchAll(/\b(19|20)\d{2}\b/g)){
            if(m.index>=cut) break;
            if(!titleSet.has(m[0])){ cut=m.index; break; }
        }
        const titlePart=tn.slice(0,cut).trim();
        const parts=titlePart.split(/\s*\/\s*/).map(p=>p.replace(/[.\-]/g," ").replace(/\s+/g," ").trim());
        if(phraseRe&&parts.some(p=>phraseRe.test(p))) return true;
        if(titleWords.length>=2){
            return parts.some(p=>{
                if(!titleWords.every(w=>wordRe(w).test(p))) return false;
                const positions=titleWords.map(w=>p.search(wordRe(w)));
                return Math.max(...positions)-Math.min(...positions)<phrase.length+15;
            });
        }
        return parts.some(p=>wordRe(titleWords[0]).test(p));
    };
}

// ============ Hledané názvy ============
function buildSearchNames(titles){
    const enNames=[], czNames=[];
    const addTo=(arr,s)=>{ s=s?.trim(); if(s&&s.length>=2&&!arr.includes(s)) arr.push(s); };
    const en=(titles.en||titles.title||"").replace(/\(.*?\)/g,"").replace(/TV (Mini )?Series/gi,"").trim();
    if(en){
        addTo(enNames,en);
        addTo(enNames,removeDiacritics(en));
        if(en.includes(":")) addTo(enNames,en.split(":")[0].trim());
        if(en.includes(" - ")) addTo(enNames,en.split(" - ")[0].trim());
    }
    const cz=(titles.cz||"").replace(/\(.*?\)/g,"").replace(/TV (Mini )?Series/gi,"").trim();
    if(cz&&cz!==en&&/[a-zA-Z]/.test(cz)){
        addTo(czNames,cz);
        addTo(czNames,removeDiacritics(cz));
        if(cz.includes(":")){
            addTo(czNames,cz.split(":")[0].trim());
            addTo(czNames,removeDiacritics(cz.split(":")[0].trim()));
        }
    }
    return { en:enNames, cz:czNames };
}

// Filmy: rok v názvu torrentu musí sedět ±1 (torrent bez roku projde)
function filterYear(list, year){
    if(!year) return list;
    const y=parseInt(year);
    return list.filter(t=>{
        const years=t.name.match(/\b(19|20)\d{2}\b/g);
        if(!years) return true;
        return years.some(v=>Math.abs(parseInt(v)-y)<=1);
    });
}

// ============ Výběr souboru z torrentu ============
// Značky sezón v cestě (S02, Season 2, 2. série) — pro volné vzory epizod
function seasonMarkers(path){
    const s=new Set();
    const n=removeDiacritics(path);
    for(const m of n.matchAll(/(?<![a-z0-9])s(\d{1,2})(?=e\d|[^a-z0-9]|$)/gi)) s.add(+m[1]);
    for(const m of n.matchAll(/season[ ._\-]*(\d{1,2})(?!\d)/gi)) s.add(+m[1]);
    for(const m of n.matchAll(/(?<!\d)(\d{1,2})[ ._]*\.?[ ._]*seri[ea]/gi)) s.add(+m[1]);
    for(const m of n.matchAll(/seri[ea][ ._\-]*(\d{1,2})(?!\d)/gi)) s.add(+m[1]);
    return s;
}

const largest=(arr)=>arr.reduce((a,b)=>(b.size||0)>(a.size||0)?b:a);

/**
 * files: [{name (cesta), size, ...}]
 * Bez sezóny/epizody → největší video. Se sezónou/epizodou → jen skutečná shoda,
 * jinak null (žádný tichý fallback na jiný díl). Jediné video v torrentu se vrací vždy.
 */
function pickEpisodeFile(files, season, episode){
    let vids=(files||[]).filter(f=>isVideo(f.name));
    if(!vids.length) return null;
    const noSample=vids.filter(f=>!isSample(f.name));
    if(noSample.length) vids=noSample;
    if(season===undefined||episode===undefined||vids.length===1) return largest(vids);

    const S=season, e=`0*${episode}`;
    const strict=[
        new RegExp(`(?<![a-z0-9])s0*${S}[ ._\\-]*e${e}(?!\\d)`,"i"),
        new RegExp(`(?<![\\dx])${S}x${e}(?![\\dp])`,"i")
    ];
    for(const re of strict){
        const hit=vids.filter(f=>re.test(removeDiacritics(basename(f.name))));
        if(hit.length) return largest(hit);
    }
    // Volné vzory jen pro soubory bez značky jiné sezóny
    const cand=vids.filter(f=>{ const ss=seasonMarkers(f.name); return ss.size===0||ss.has(S); });
    const stem=(f)=>removeDiacritics(basename(f.name)).replace(/\.[a-z0-9]{2,4}$/i,"");
    const loose=[
        new RegExp(`(?<![a-z0-9])(?:e|ep|episode|dil|cast)[ ._\\-]*${e}(?:v\\d)?(?!\\d)`,"i"),
        new RegExp(`[ ._]-[ ._]*${e}(?:v\\d)?(?!\\d)`,"i"),
        new RegExp(`\\[${e}(?:v\\d)?\\]`,"i"),
        new RegExp(`(?<!\\d)${e}[ ._]*\\.?[ ._]*(?:dil|cast)`,"i"),
        new RegExp(`^${e}(?:v\\d)?(?!\\d)`,"i")
    ];
    for(const re of loose){
        const hit=cand.filter(f=>re.test(stem(f)));
        if(hit.length) return largest(hit);
    }
    // Holé číslo — jen když je jednoznačné
    const bare=new RegExp(`(?<![a-z0-9.])${e}(?![0-9.]|p\\b|bit|ch\\b|k\\b)`,"i");
    const hit=cand.filter(f=>bare.test(stem(f)));
    if(hit.length===1) return hit[0];
    return null;
}

module.exports = { episodeFilters, makeTitleMatcher, buildSearchNames, filterYear, pickEpisodeFile, seasonMarkers, pad };
