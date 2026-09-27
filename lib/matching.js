// Párování názvů torrentů / souborů na titul, sezónu a epizodu
const { removeDiacritics, isVideo, isSample, basename, normalizeQuery } = require("./util");

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
    return clean.toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(w=>w.length>=2||/^\d$/.test(w));   // i číslo pokračování (Predator 2)
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
// SKT ignoruje diakritiku a interpunkci → varianty, které by vrátily totéž, se nehledají dvakrát
function buildSearchNames(titles){
    const seen=new Set(), enNames=[], czNames=[];
    const add=(arr,s)=>{
        s=normalizeQuery(s);
        const k=removeDiacritics(s).toLowerCase();
        if(s.length>=2&&!seen.has(k)){ seen.add(k); arr.push(s); }
    };
    const clean=(s)=>String(s||"").replace(/\(.*?\)/g,"").replace(/TV (Mini )?Series/gi,"").trim();
    const en=clean(titles.en||titles.title);
    if(en){
        add(enNames,en);
        if(en.includes(":")) add(enNames,en.split(":")[0]);
        if(en.includes(" - ")) add(enNames,en.split(" - ")[0]);
    }
    const cz=clean(titles.cz);
    if(cz&&/[a-zA-Z]/.test(cz)){
        add(czNames,cz);
        if(cz.includes(":")) add(czNames,cz.split(":")[0]);
        if(cz.includes(" - ")) add(czNames,cz.split(" - ")[0]);
    }
    return { en:enNames, cz:czNames };
}

// Filmy: rok v názvu torrentu musí sedět ±1, nebo ležet v rozsahu (1987-2022). Torrent bez roku projde.
function filterYear(list, year){
    if(!year) return list;
    const y=parseInt(year);
    return list.filter(t=>{
        for(const m of t.name.matchAll(/\b((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2})\b/g)){
            if(y>=parseInt(m[1])-1&&y<=parseInt(m[2])+1) return true;
        }
        const years=t.name.match(/\b(19|20)\d{2}\b/g);
        if(!years) return true;
        return years.some(v=>Math.abs(parseInt(v)-y)<=1);
    });
}

// Kolekce filmů v jednom torrentu (Predátor 1-5. filmů, (1987-2022), Trilogie, AVP I+II…)
function isMoviePack(name){
    const n=removeDiacritics(name).toLowerCase();
    if(/\b(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}\b/.test(n)) return true;
    if(/\b\d+\s*[-–]\s*\d+\s*\.?\s*(film|movie|dil|diel|cast)/.test(n)) return true;
    if(/\b(kolekce|kolekcia|collection|trilogie|trilogia|trilogy|quadrilogy|tetralogie|pentalogie|saga|anthology)\b/.test(n)) return true;
    if(/\b(i+|\d)\s*\+\s*(i+|\d)\b/.test(n)) return true;
    return false;
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

/**
 * Výběr filmu z kolekce: 1) rok v cestě, 2) název v názvu souboru (ne pokračování „Predator 2“).
 * Nic nesedí → null (žádný tichý fallback na jiný film).
 */
function pickMovieFile(files, year, title){
    let vids=(files||[]).filter(f=>isVideo(f.name));
    if(!vids.length) return null;
    const noSample=vids.filter(f=>!isSample(f.name));
    if(noSample.length) vids=noSample;
    if(vids.length===1) return vids[0];
    const norm=(s)=>removeDiacritics(s).toLowerCase().replace(/\.[a-z0-9]{2,4}$/i,"").replace(/[^a-z0-9]+/g," ").trim();
    if(year){
        const re=new RegExp(`(^| )${year}( |$)`);
        const hit=vids.filter(f=>re.test(norm(f.name)));
        if(hit.length) return largest(hit);
    }
    const words=title?titleWordsOf(title).join(" "):"";
    if(words){
        const re=new RegExp(`(?:^| )${escRe(words)}(?= |$)(?: (\\S+))?`);
        const hit=vids.filter(f=>{
            const m=norm(basename(f.name)).match(re);
            return m&&!/^(\d{1,2}|ii|iii|iv|v|vi)$/.test(m[1]||"");
        });
        if(hit.length) return largest(hit);
    }
    return null;
}

/** sel: {} největší video | {season,episode} | {fileId} | {pack:true,year,title} film z kolekce */
function pickBySel(files, sel={}){
    if(sel.fileId!==undefined) return (files||[]).find(f=>String(f.id)===String(sel.fileId))||null;
    if(sel.pack) return pickMovieFile(files,sel.year,sel.title);
    return pickEpisodeFile(files,sel.season,sel.episode);
}
function selKey(sel={}){
    if(sel.fileId!==undefined) return `f${sel.fileId}`;
    if(sel.pack) return `m${sel.year||0}-${sel.title||""}`;
    if(sel.season!==undefined) return `e${sel.season}-${sel.episode}`;
    return "main";
}

module.exports = { episodeFilters, makeTitleMatcher, buildSearchNames, filterYear, isMoviePack, pickEpisodeFile, pickMovieFile, pickBySel, selKey, seasonMarkers, pad };
