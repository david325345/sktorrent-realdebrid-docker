// sktorrent.eu — hledání a přihlášení
const https = require("https");
const axios = require("axios");
const cheerio = require("cheerio");
const { createCache, createPersistentCache, once } = require("./cache");
const { keyId, normalizeQuery } = require("./util");

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;
const UA = "Mozilla/5.0";
// Nevideo kategorie — vyřazují se vždy (i v přímém hledání)
const excludedCats = /xXx|Knihy|Časopis|Ostatní|Game hall|Audio.*video|Soft.*app|Externe|Hry na|VR Hry|Hudba|Hudební|Mluven|Soundtrack|Programy|Mobil|Neschválen/i;

const queryCache = createCache({ ttl: 6*3600*1000, max: 5000 });   // výsledky hledání (6 h)
const FULL_PAGE = 20;   // stránka s méně výsledky je poslední (SKT dává ~24 na stránku)

// Udržované HTTPS spojení na SKT — bez nového TLS handshaku u každého dotazu.
// Agent měří, jak dlouho požadavek čekal na volné spojení (fronta při víc souběžných hledáních).
class TimedAgent extends https.Agent {
    addRequest(req,opts){
        const t0=Date.now();
        req.once("socket",()=>{ req.sktWait=Date.now()-t0; });
        return super.addRequest(req,opts);
    }
}
const http = axios.create({ httpsAgent:new TimedAgent({ keepAlive:true, maxSockets:6 }), timeout:10000, headers:{ "User-Agent":UA } });
const HARD_LIMIT_MS = +process.env.SKT_HARD_LIMIT_MS||12000;    // celý dotaz včetně čekání na spojení (axios timeout platí až od přiděleného spojení)

// ============ Jistič ============
// SKT občas přestane odpovídat. Po 3 dotazech po sobě, které skončí timeoutem / chybou spojení / 5xx
// (napříč všemi hledáními), se dotazy na SKT na 45 s zastaví a čekající dotazy se zruší hned.
// Po pauze projde jeden zkušební dotaz; dotazy, které mezitím přijdou, počkají na jeho výsledek
// (ne hned chyba — hledání posílá 4 dotazy najednou): uspěje → všechny se pošlou, selže → chyba a další pauza.
const BREAKER = { fails:0, openUntil:0, probing:false, probeDone:null, probeResolve:null };
const BREAKER_FAILS = 3, BREAKER_OPEN_MS = 45000;
const inflight = new Set();     // AbortController běžících dotazů
function breakerOpen(){ return BREAKER.openUntil>Date.now(); }
function endProbe(ok){
    const r=BREAKER.probeResolve;
    BREAKER.probing=false; BREAKER.probeDone=null; BREAKER.probeResolve=null;
    if(r) r(ok);
}
/** true = smí poslat, false = jistič (otevřený nebo zkušební dotaz selhal). Během zkušebního dotazu čeká. */
async function breakerGate(){
    if(breakerOpen()) return false;
    if(!BREAKER.openUntil) return true;
    if(BREAKER.probing){
        // Čeká na zkušební dotaz (nejdéle jeho tvrdý limit + rezerva)
        return Promise.race([BREAKER.probeDone,new Promise(r=>setTimeout(()=>r(false),HARD_LIMIT_MS+1000).unref())]);
    }
    BREAKER.probing=true;
    BREAKER.probeDone=new Promise(r=>{ BREAKER.probeResolve=r; });
    return true;
}
function breakerOk(){
    if(BREAKER.openUntil) console.log("[SKT] ✅ SKT zase odpovídá — jistič zavřen");
    BREAKER.fails=0; BREAKER.openUntil=0;
    endProbe(true);
}
function breakerFail(){
    BREAKER.fails++;
    if(BREAKER.probing||(!BREAKER.openUntil&&BREAKER.fails>=BREAKER_FAILS)){
        BREAKER.openUntil=Date.now()+BREAKER_OPEN_MS;
        console.error(`[SKT] ⚡ SKT neodpovídá (${BREAKER.fails}× po sobě) — dotazy pozastaveny na ${BREAKER_OPEN_MS/1000} s`);
        endProbe(false);
        for(const c of inflight) c.abort("jistič");
    }
}
// Druh chyby pro archiv: timeout / http 5xx / síť / 403 / chyba
function errKind(e){
    if(e?.response?.status===403) return "403";
    if(e?.response?.status>=500) return `http ${e.response.status}`;
    if(e?.code==="ECONNABORTED"||e?.code==="ETIMEDOUT"||/timeout/i.test(String(e?.message||""))) return "timeout";
    if(e?.name==="CanceledError"||e?.code==="ERR_CANCELED") return "timeout";
    if(/^E[A-Z]+$/.test(String(e?.code||""))) return "síť";
    return "chyba";
}
const torrentCache = createCache({ ttl: 12*3600*1000, max: 20000 }); // hash → torrent (pro meta/stream u skt ID)
const pausedUntil = new Map();  // účet → čas konce pauzy po 403

// Účet: s cookies vidí víc obsahu, proto se výsledky cachují zvlášť pro každý účet
const accountKey = (uid,pass)=>(uid&&pass)?`u:${keyId(uid+":"+pass)}`:"anon";

function isPaused(uid,pass){ return (pausedUntil.get(accountKey(uid,pass))||0)>Date.now(); }

function parseResults(html){
    const $=cheerio.load(html);
    const results=[];
    const seen=new Set();
    $('a[href*="details.php"] img').each((i,img)=>{
        const el=$(img).closest("a");
        const m=(el.attr("href")||"").match(/id=([a-fA-F0-9]{40})/);
        if(!m) return;
        const hash=m[1].toLowerCase();
        if(seen.has(hash)) return;
        const name=el.attr("title")||"";
        if(!name||name.length<3) return;
        const td=el.closest("td");
        const block=td.text().replace(/\s+/g," ").trim();
        const szM=block.match(/Velkost\s([^|]+)/i);
        if(!szM) return;
        const cat=td.find("b").first().text().trim();
        const sdM=block.match(/Odosielaju\s*:\s*(\d+)/i);
        let poster=$(img).attr("data-original")||$(img).attr("data-src")||$(img).attr("src")||"";
        td.find("img").each((j,timg)=>{
            const s=$(timg).attr("data-original")||$(timg).attr("data-src")||$(timg).attr("src")||"";
            if(s&&s.length>poster.length) poster=s;
        });
        if(poster&&!poster.startsWith("http")) poster=`${BASE_URL}/${poster.replace(/^\//,"")}`;
        seen.add(hash);
        results.push({ name, hash, size:szM[1].trim(), seeds:sdM?parseInt(sdM[1]):0, cat, poster });
    });
    if(results.length===0){
        $("table.lista tr").each((i,row)=>{
            const cells=$(row).find("td.lista");
            if(cells.length<2) return;
            const link=cells.eq(1).find("a[href*='details.php']");
            const m=(link.attr("href")||"").match(/id=([a-fA-F0-9]{40})/);
            if(!m) return;
            const hash=m[1].toLowerCase();
            if(seen.has(hash)) return;
            seen.add(hash);
            results.push({ name:link.text().trim(), hash, size:cells.eq(5).text().trim()||"?", seeds:parseInt(cells.eq(6).text().trim())||0, cat:cells.eq(0).text().trim()||"", poster:"" });
        });
    }
    const items=results.filter(t=>!excludedCats.test(t.cat));
    items.raw=results.length;      // počet před vyřazením kategorií (pro poznání plné stránky)
    return items;
}

// Nejvyšší číslo stránky v odkazech stránkování (SKT čísluje od 0)
function maxPage(html){
    let max=0;
    for(const m of String(html).matchAll(/[?&](?:amp;)?page=(\d+)/g)) max=Math.max(max,parseInt(m[1]));
    return max;
}

/**
 * Jedna stránka výsledků (SKT řadí od nejnovějších).
 * Vrací { items, hasMore, ms, wait } | z paměti { items, hasMore, cached:true } | při chybě { items:[], hasMore:false, err, ms }
 * err: "timeout" | "http 5xx" | "síť" | "403" | "pauza 403" | "jistič" | "chyba" — chyba SKT ≠ „nic nenalezeno“
 */
async function searchSKTPage(query, uid, pass, page=0){
    query=normalizeQuery(query);
    const empty={ items:[], hasMore:false };
    if(!query) return empty;
    const acct=accountKey(uid,pass);
    const ck=`${acct}|${query.toLowerCase()}|${page}`;
    const label=`"${query}"${page?` str. ${page+1}`:""}`;
    const cached=queryCache.get(ck);
    if(cached){ console.log(`[SKT] 💾 ${label} (${cached.items.length})`); return { items:cached.items, hasMore:cached.hasMore, cached:true }; }
    if(isPaused(uid,pass)){ console.log(`[SKT] ⏸️ Pauza po 403, přeskakuji ${label}`); return { ...empty, err:"pauza 403" }; }
    if(breakerOpen()){ console.log(`[SKT] ⚡ Jistič — přeskakuji ${label}`); return { ...empty, err:"jistič" }; }

    return once(`skt:${ck}`, async()=>{
        const waitedProbe=BREAKER.probing;
        if(!await breakerGate()){ console.log(`[SKT] ⚡ Jistič — přeskakuji ${label}`); return { ...empty, err:"jistič" }; }
        if(waitedProbe&&isPaused(uid,pass)) return { ...empty, err:"pauza 403" };
        console.log(`[SKT] 🔎 ${label}${BREAKER.probing?" (zkušební dotaz)":""}`);
        const ctrl=new AbortController();
        inflight.add(ctrl);
        const t0=Date.now();
        try{
            const headers={};
            if(uid&&pass) headers.Cookie=`uid=${uid}; pass=${pass}`;
            const params={ search:query, category:0, active:0 };
            if(page>0) params.page=page;
            const r=await http.get(SEARCH_URL,{ params, headers, signal:AbortSignal.any([ctrl.signal,AbortSignal.timeout(HARD_LIMIT_MS)]) });
            const items=parseResults(r.data);
            // Další stránka jen když je tahle plná a odkaz na vyšší stránku existuje
            const res={ items:[...items], hasMore:items.raw>=FULL_PAGE&&maxPage(r.data)>page, ms:Date.now()-t0 };
            const wait=r.request?.sktWait;
            if(Number.isFinite(wait)&&wait>=50) res.wait=wait;
            items.forEach(t=>torrentCache.set(t.hash,t));
            queryCache.set(ck,{ items:res.items, hasMore:res.hasMore });
            breakerOk();
            console.log(`[SKT] Nalezeno: ${items.length} (${res.ms} ms${res.wait?`, z toho ${res.wait} ms čekání na spojení`:""})${res.hasMore?" — další stránky existují":""}`);
            return res;
        }catch(e){
            const ms=Date.now()-t0;
            if(ctrl.signal.aborted&&ctrl.signal.reason==="jistič") return { ...empty, err:"jistič", ms };
            const err=errKind(e);
            if(err==="403"){
                console.error(`[SKT] ⛔ 403 — pauza 60 s (${acct==="anon"?"anonymní":"účet"})`);
                pausedUntil.set(acct,Date.now()+60000);
                if(BREAKER.probing) breakerOk();          // server odpovídá (jen blokuje účet) → jistič zavřít
            }else{
                console.error(`[SKT] ❌ ${label}: ${err} po ${ms} ms (${e.message})`);
                breakerFail();
            }
            return { ...empty, err, ms };
        }finally{ inflight.delete(ctrl); }
    });
}

// ============ ČSFD odkaz v detailu torrentu ============
// Detail (details.php?id=HASH, i bez přihlášení) má odkaz na csfd.cz/film/ID — u seriálu je první ID v adrese seriál.
// Odkaz se torrentu nemění, proto se drží trvale na disku (hash → ČSFD ID, nebo null = detail odkaz nemá).
const detailCache = createPersistentCache({ name:"sktdetail", ttl:365*24*3600*1000, max:100000 });
const DETAIL_URL = `${BASE_URL}/torrent/details.php`;

/** První ČSFD ID z HTML detailu torrentu, nebo null */
function csfdFromDetail(html){
    const m=String(html||"").match(/csfd\.(?:cz|sk)\/film\/(\d+)/i);
    return m?parseInt(m[1],10):null;
}

/** ČSFD ID torrentu: číslo | null (detail odkaz nemá) | undefined (detail se nepodařilo načíst — zkusí se příště) */
async function getTorrentCsfd(hash, uid, pass){
    hash=String(hash||"").toLowerCase();
    if(!/^[a-f0-9]{40}$/.test(hash)) return undefined;
    const c=detailCache.get(hash);
    if(c!==undefined) return c.csfd;
    if(isPaused(uid,pass)||breakerOpen()) return undefined;
    return once(`sktdetail:${hash}`, async()=>{
        if(!await breakerGate()) return undefined;
        const ctrl=new AbortController();
        inflight.add(ctrl);
        const t0=Date.now();
        try{
            const headers={};
            if(uid&&pass) headers.Cookie=`uid=${uid}; pass=${pass}`;
            const r=await http.get(DETAIL_URL,{ params:{ id:hash }, headers, signal:AbortSignal.any([ctrl.signal,AbortSignal.timeout(HARD_LIMIT_MS)]) });
            breakerOk();
            const html=String(r.data||"");
            // Jen skutečná stránka detailu (obsahuje hash) — přihlašovací/chybová stránka se neukládá
            if(!html.toLowerCase().includes(hash)){ console.log(`[SKT] 🎬 detail ${hash.slice(0,8)}: neplatná stránka (${Date.now()-t0} ms)`); return undefined; }
            const csfd=csfdFromDetail(html);
            detailCache.set(hash,{ csfd });
            console.log(`[SKT] 🎬 detail ${hash.slice(0,8)}: ${csfd?`ČSFD ${csfd}`:"bez ČSFD odkazu"} (${Date.now()-t0} ms)`);
            return csfd;
        }catch(e){
            if(ctrl.signal.aborted&&ctrl.signal.reason==="jistič") return undefined;
            const err=errKind(e);
            if(err==="403"){ pausedUntil.set(accountKey(uid,pass),Date.now()+60000); if(BREAKER.probing) breakerOk(); }
            else breakerFail();
            console.error(`[SKT] 🎬 detail ${hash.slice(0,8)}: ${err} (${e.message})`);
            return undefined;
        }finally{ inflight.delete(ctrl); }
    });
}

function _resetBreaker(){ BREAKER.fails=0; BREAKER.openUntil=0; endProbe(false); pausedUntil.clear(); queryCache.map.clear(); detailCache.map.clear(); }
function _breaker(){ return BREAKER; }   // pro testy   // pro testy

async function searchSKT(query, uid, pass){ return (await searchSKTPage(query,uid,pass,0)).items; }

function getCachedTorrent(hash){ return torrentCache.get(hash); }

async function sktLogin(username, password){
    const r=await http.post(`${BASE_URL}/torrent/login.php`,
        `uid=${encodeURIComponent(username)}&pwd=${encodeURIComponent(password)}`,
        { headers:{ "Content-Type":"application/x-www-form-urlencoded", "User-Agent":UA, "Referer":`${BASE_URL}/torrent/login.php` },
          maxRedirects:0, validateStatus:()=>true, timeout:10000 });
    let uid="", pass="";
    for(const c of (r.headers["set-cookie"]||[])){
        const um=c.match(/^uid=([^;]+)/); if(um) uid=um[1];
        const pm=c.match(/^pass=([^;]+)/); if(pm) pass=pm[1];
    }
    return (uid&&pass&&uid!=="deleted"&&pass!=="deleted") ? { uid, pass } : null;
}

module.exports = { BASE_URL, searchSKT, searchSKTPage, normalizeQuery, isPaused, breakerOpen, getCachedTorrent, sktLogin, getTorrentCsfd, csfdFromDetail, _resetBreaker, _breaker, HARD_LIMIT_MS };
