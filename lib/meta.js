// Názvy titulů: TMDB (EN/CZ/SK) → OMDb záloha
const axios = require("axios");
const { createPersistentCache } = require("./cache");
const { normTitle } = require("./matching");

const TMDB = "https://api.themoviedb.org/3";
const OMDB_KEY = process.env.OMDB_API_KEY || "91fa16b4";
// Názvy z TMDB/OMDb trvale na disku (data/cache/tmdb.json), obnova po 30 dnech
const titleCache = createPersistentCache({ name:"tmdb", ttl: 30*24*3600*1000, max: 50000 });

// v3 API key → ?api_key=, v4 read token (JWT) → Bearer
function tmdbReq(key){
    return key.length>40 ? { headers:{ Authorization:`Bearer ${key}` }, params:{} } : { headers:{}, params:{ api_key:key } };
}

// Alternativní názvy z TMDB pro přísnou kontrolu názvu torrentu — jen CZ/SK/US/GB a jen ty, které ZAČÍNAJÍ
// některým naším názvem a pokračují slovy („Arcane: League of Legends“ pro „Arcane“). Obecné „Název: cokoli“
// se nepovoluje, takže „Batman: The Animated Series“ pro „Batman“ dál neprojde.
const ALT_COUNTRIES=new Set(["CZ","SK","US","GB"]);
function altTitles(data, ours){
    const list=(data&&(data.results||data.titles))||[];
    const base=[...new Set(ours.filter(Boolean).map(normTitle).filter(n=>n.length>=2))];
    const out=[];
    for(const a of list){
        if(!a||!a.title||!ALT_COUNTRIES.has(a.iso_3166_1)) continue;
        const n=normTitle(a.title);
        const ok=base.some(b=>n.startsWith(b+" ")&&/[a-z]{2}/.test(n.slice(b.length)));
        if(ok&&!base.includes(n)&&!out.includes(a.title)) out.push(a.title);
    }
    return out.slice(0,5);
}

async function getTitleTMDB(imdbId, tmdbKey, type){
    try{
        const a=tmdbReq(tmdbKey);
        const find=await axios.get(`${TMDB}/find/${imdbId}`,{ headers:a.headers, params:{ ...a.params, external_source:"imdb_id" }, timeout:5000 });
        const d=find.data||{};
        const mv=d.movie_results?.[0], tv=d.tv_results?.[0];
        // Typ ze Stremia má přednost — /find může vrátit film i seriál zároveň
        let item, isTV;
        if(type==="series"){ item=tv||mv; isTV=!!tv; }
        else { item=mv||tv; isTV=!mv&&!!tv; }
        if(!item) return null;

        const enTitle=isTV?(item.name||item.original_name):(item.title||item.original_title);
        const origTitle=item.original_title||item.original_name||enTitle;
        const year=(isTV?(item.first_air_date||""):(item.release_date||"")).slice(0,4);
        const path=`${TMDB}/${isTV?"tv":"movie"}/${item.id}`;
        const [cz,sk]=await Promise.allSettled([
            axios.get(path,{ headers:a.headers, params:{ ...a.params, language:"cs-CZ", append_to_response:"alternative_titles" }, timeout:5000 }),
            axios.get(path,{ headers:a.headers, params:{ ...a.params, language:"sk-SK" }, timeout:5000 })
        ]);
        const pick=(r)=>r.status==="fulfilled"?(isTV?r.value.data.name:r.value.data.title)||"":"";
        const czTitle=pick(cz), skTitle=pick(sk);
        const alt=cz.status==="fulfilled"?altTitles(cz.value.data.alternative_titles,[enTitle,origTitle,czTitle,skTitle]):[];
        // Rok premiéry každé sezóny (seriály) — pro torrenty bez sezóny v názvu („(2022)“ ≠ S02 z roku 2026)
        const seasonYears={};
        if(isTV&&cz.status==="fulfilled") for(const s of cz.value.data.seasons||[]){
            const y=String(s?.air_date||"").slice(0,4);
            if(s&&Number.isInteger(s.season_number)&&s.season_number>0&&/^\d{4}$/.test(y)) seasonYears[s.season_number]=y;
        }
        console.log(`[TMDB] EN:"${enTitle}" CZ:"${czTitle}" SK:"${skTitle}" (${year})${alt.length?` alt: ${alt.map(x=>`"${x}"`).join(", ")}`:""}`);
        return { title:czTitle||enTitle, original:origTitle, en:enTitle, cz:czTitle, sk:skTitle, year, alt, seasonYears,
                 all:[...new Set([enTitle,origTitle,czTitle,skTitle].filter(Boolean))] };
    }catch(e){ console.error("[TMDB]",e.response?.status||"",e.message); return null; }
}

async function getTitleOMDB(imdbId){
    try{
        const r=await axios.get("https://www.omdbapi.com/",{ params:{ i:imdbId, apikey:OMDB_KEY }, timeout:5000 });
        if(r.data?.Title){
            console.log(`[OMDb] "${r.data.Title}" (${r.data.Year})`);
            return { title:r.data.Title, original:r.data.Title, en:r.data.Title, cz:"", sk:"", year:r.data.Year||"", all:[r.data.Title] };
        }
    }catch(e){ console.error("[OMDb]",e.message); }
    return null;
}

async function getTitle(imdbId, tmdbKey, type){
    const ck=`v3|${imdbId}|${type}|${tmdbKey?"tmdb":"omdb"}`;      // v3: + roky sezón (staré záznamy se načtou znovu)
    const c=titleCache.get(ck);
    if(c) return c;
    let t=null;
    if(tmdbKey){
        t=await getTitleTMDB(imdbId,tmdbKey,type);
        if(!t) console.log("[TMDB] Fallback na OMDb");
    }
    if(!t) t=await getTitleOMDB(imdbId);
    if(t) titleCache.set(ck,t);
    return t;
}

function titleCacheSize(){ return titleCache.size; }

module.exports = { getTitle, titleCacheSize };
