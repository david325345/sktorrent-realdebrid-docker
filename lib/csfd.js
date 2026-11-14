// Tituly jen na ČSFD (ID „csfd:12345“, díl „csfd:12345:S:E“) — název a rok ze služby csfd-ratings místo TMDB.
// GET {CSFD_URL}/meta/{movie|series}/csfd:ID.json → { meta:{ name, year, releaseInfo, titlesOther:[{ country, title }] } }
// CSFD_URL: interní adresa v síti Coolify (např. http://csfd:7020); když do 3 s neodpoví, zkusí se veřejná
// CSFD_PUBLIC_URL (výchozí https://csfd-rating.duckdns.org). Výsledek se drží na disku 7 dní.
const axios = require("axios");
const { createPersistentCache } = require("./cache");
const { latinName } = require("./matching");

const INTERNAL = (process.env.CSFD_URL || "").trim().replace(/\/+$/,"");
const PUBLIC = (process.env.CSFD_PUBLIC_URL ?? "https://csfd-rating.duckdns.org").trim().replace(/\/+$/,"");
const csfdCache = createPersistentCache({ name:"csfd", ttl:7*24*3600*1000, max:20000 });

// Anglicky mluvící země (název z nich se hledá jako „anglický“)
const EN_COUNTRY = /^(USA|Spojené státy|Velká Británie|Spojené království|Kanada|Austrálie|Irsko|Nový Zéland)$/i;
const CZ_COUNTRY = /^(Česko|Česká republika|Československo)$/i;
const SK_COUNTRY = /^Slovensko$/i;

/** „csfd:12345“ / „csfd:12345:2:5“ → { csfdId, season, episode } | null */
function parseCsfdId(id){
    const m=String(id||"").match(/^csfd:(\d{1,9})(?::(\d{1,4}):(\d{1,5}))?$/);
    if(!m) return null;
    return { csfdId:parseInt(m[1],10), season:m[2]!==undefined?parseInt(m[2],10):undefined, episode:m[3]!==undefined?parseInt(m[3],10):undefined };
}

/** Metadata z csfd-ratings → objekt názvů ve stejném tvaru jako z TMDB (+ csfdId, source:"csfd") */
function titlesFromMeta(meta, csfdId){
    const cz=String(meta?.name||"").trim();
    const others=(Array.isArray(meta?.titlesOther)?meta.titlesOther:[])
        .map(t=>typeof t==="string"?{ country:null, title:t }:t)
        .filter(t=>t&&typeof t.title==="string"&&t.title.trim())
        .map(t=>({ country:t.country?String(t.country).trim():null, title:t.title.trim() }));
    const sk=others.find(t=>t.country&&SK_COUNTRY.test(t.country))?.title||"";
    // Anglický: z anglicky mluvící země; jinak první latinkový název jiné země (originál)
    const en=others.find(t=>t.country&&EN_COUNTRY.test(t.country))?.title
        ||others.find(t=>t.country&&!CZ_COUNTRY.test(t.country)&&!SK_COUNTRY.test(t.country)&&latinName(t.title))?.title
        ||"";
    const year=String(meta?.year||meta?.releaseInfo||"").match(/\d{4}/)?.[0]||"";
    if(!cz&&!en&&!sk) return null;
    return {
        source:"csfd", csfdId,
        title:cz||en||sk, original:en||cz, en, cz, sk, year,
        // Všechny další názvy jdou do přísné kontroly názvu (hledá se jen CZ / SK / EN)
        alt:[...new Set(others.map(t=>t.title))].filter(t=>t!==cz&&t!==sk&&t!==en),
        all:[...new Set([cz,sk,en].filter(Boolean))]
    };
}

async function fetchMeta(base, type, csfdId, timeout){
    const r=await axios.get(`${base}/meta/${type}/csfd:${csfdId}.json`,{ timeout, headers:{ "User-Agent":"sktorrent-addon" } });
    return r.data?.meta||null;
}

/** Názvy a rok titulu csfd:ID (cache 7 dní). null = služba nedostupná nebo titul neexistuje. */
async function getCsfdTitle(type, csfdId){
    const t=type==="series"?"series":"movie";
    const ck=`${t}|${csfdId}`;
    const c=csfdCache.get(ck);
    if(c) return c;
    const bases=[...new Set([INTERNAL,PUBLIC].filter(Boolean))];
    if(!bases.length){ console.log("[ČSFD] Chybí CSFD_URL i CSFD_PUBLIC_URL — tituly csfd: nejde hledat"); return null; }
    for(const [i,base] of bases.entries()){
        try{
            const meta=await fetchMeta(base,t,csfdId,i===0&&bases.length>1?3000:8000);
            const titles=meta?titlesFromMeta(meta,csfdId):null;
            if(!titles){ console.log(`[ČSFD] csfd:${csfdId} — metadata bez názvu`); return null; }
            console.log(`[ČSFD] CZ:"${titles.cz}" SK:"${titles.sk}" EN:"${titles.en}" (${titles.year||"?"})${titles.alt.length?` další: ${titles.alt.length}`:""}${i?" — přes veřejnou adresu":""}`);
            csfdCache.set(ck,titles);
            return titles;
        }catch(e){
            const s=e.response?.status;
            console.error(`[ČSFD] ${base}: ${s||e.code||e.message}`);
            if(s===404) return null;          // titul neexistuje — záloha nepomůže
        }
    }
    return null;
}

// ============ IMDb tituly: ČSFD ID a český název z ČSFD ============
// GET {CSFD_URL}/rating/{imdbId}?type=movie|series → { found, csfdId, title, year } (mapa IMDb→ČSFD v csfd-ratings).
// Slouží k přísné kontrole názvu (ČSFD název s podtitulem, který TMDB nemá — „Melania Rea: Případ, který otřásl
// Itálií“) a k záchraně sporného torrentu přes ČSFD odkaz v detailu. Hledání nezdržuje: když odpověď nepřijde
// do 3 s, pokračuje se bez ní a výsledek se uloží pro příště. Nalezené 7 dní, nenalezené 1 den.
const imdbInflight=new Map();
async function fetchImdb(type, imdbId){
    const bases=[...new Set([INTERNAL,PUBLIC].filter(Boolean))];
    for(const [i,base] of bases.entries()){
        try{
            const r=await axios.get(`${base}/rating/${imdbId}`,{ params:{ type }, timeout:i===0&&bases.length>1?5000:10000,
                headers:{ "User-Agent":"sktorrent-addon" }, validateStatus:s=>s===200||s===404 });
            if(r.status===404||!r.data?.found||!r.data?.csfdId) return { none:true };
            return { csfdId:Number(r.data.csfdId), title:String(r.data.title||"").trim(), year:r.data.year||null };
        }catch(e){ console.error(`[ČSFD] ${base}/rating/${imdbId}: ${e.response?.status||e.code||e.message}`); }
    }
    return undefined;          // služba nedostupná — neukládat, zkusí se příště
}
/** { csfdId, title, year } | null; waitMs = jak dlouho nejvýš čekat (pak null a výsledek až příště) */
async function getCsfdForImdb(imdbId, type, waitMs=3000){
    if(!/^tt\d{5,10}$/.test(String(imdbId||""))) return null;
    if(!INTERNAL&&!PUBLIC) return null;
    const t=type==="series"?"series":"movie";
    const ck=`imdb|${t}|${imdbId}`;
    const c=csfdCache.get(ck);
    if(c) return c.none?null:c;
    let p=imdbInflight.get(ck);
    if(!p){
        p=fetchImdb(t,imdbId).then(v=>{
            if(v) csfdCache.set(ck,v,v.none?24*3600*1000:undefined);
            if(v&&!v.none) console.log(`[ČSFD] ${imdbId} → ČSFD ${v.csfdId} „${v.title}“`);
            return v&&!v.none?v:null;
        }).finally(()=>imdbInflight.delete(ck));
        imdbInflight.set(ck,p);
    }
    return Promise.race([p,new Promise(r=>setTimeout(()=>r(null),waitMs).unref())]);
}

module.exports = { parseCsfdId, titlesFromMeta, getCsfdTitle, getCsfdForImdb };
