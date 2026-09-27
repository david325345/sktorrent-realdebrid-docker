// Názvy titulů: TMDB (EN/CZ/SK) → OMDb záloha
const axios = require("axios");
const { createCache } = require("./cache");

const TMDB = "https://api.themoviedb.org/3";
const OMDB_KEY = process.env.OMDB_API_KEY || "91fa16b4";
const titleCache = createCache({ ttl: 24*3600*1000, max: 5000 });

// v3 API key → ?api_key=, v4 read token (JWT) → Bearer
function tmdbReq(key){
    return key.length>40 ? { headers:{ Authorization:`Bearer ${key}` }, params:{} } : { headers:{}, params:{ api_key:key } };
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
            axios.get(path,{ headers:a.headers, params:{ ...a.params, language:"cs-CZ" }, timeout:5000 }),
            axios.get(path,{ headers:a.headers, params:{ ...a.params, language:"sk-SK" }, timeout:5000 })
        ]);
        const pick=(r)=>r.status==="fulfilled"?(isTV?r.value.data.name:r.value.data.title)||"":"";
        const czTitle=pick(cz), skTitle=pick(sk);
        console.log(`[TMDB] EN:"${enTitle}" CZ:"${czTitle}" SK:"${skTitle}" (${year})`);
        return { title:czTitle||enTitle, original:origTitle, en:enTitle, cz:czTitle, sk:skTitle, year,
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
    const ck=`${imdbId}|${type}|${tmdbKey?"tmdb":"omdb"}`;
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

module.exports = { getTitle };
