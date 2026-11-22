// sktorrent.eu — hledání a přihlášení
const https = require("https");
const axios = require("axios");
const cheerio = require("cheerio");
const { createCache, createPersistentCache, once } = require("./cache");
const { keyId, normalizeQuery, removeDiacritics } = require("./util");

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
// Odpověď SKT nejvýš 20 s (večer bývá SKT pomalé — dotazy za 7–13 s), celý dotaz včetně čekání na spojení 22 s.
// Celé hledání má dál rozpočet 25 s (search.js), takže první kolo dotazů se stihne i při pomalém SKT.
const RESPONSE_TIMEOUT_MS = +process.env.SKT_TIMEOUT_MS||20000;
const http = axios.create({ httpsAgent:new TimedAgent({ keepAlive:true, maxSockets:6 }), timeout:RESPONSE_TIMEOUT_MS, headers:{ "User-Agent":UA } });
const HARD_LIMIT_MS = +process.env.SKT_HARD_LIMIT_MS||22000;    // celý dotaz včetně čekání na spojení (axios timeout platí až od přiděleného spojení)

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
// Druh chyby pro archiv: 403 / http <status> (429, 404, 5xx…) / timeout / síť / chyba
function errKind(e){
    const st=e?.response?.status;
    if(st===403) return "403";
    if(st) return `http ${st}`;
    if(e?.code==="ECONNABORTED"||e?.code==="ETIMEDOUT"||/timeout/i.test(String(e?.message||""))) return "timeout";
    if(e?.name==="CanceledError"||e?.code==="ERR_CANCELED") return "timeout";
    if(/^E[A-Z]+$/.test(String(e?.code||""))) return "síť";
    return "chyba";
}
// Jen tohle je výpadek SKT (počítá se do jističe). Rychlé 4xx a neznámé chyby ne — dotaz se jednou zopakuje.
const isOutage=(err)=>err==="timeout"||err==="síť"||/^http 5\d\d$/.test(err);
const errMsgShort=(e)=>String(e?.message||"").replace(/\s+/g," ").slice(0,80);
// 429 Too Many Requests → krátká pauza podle Retry-After (sekundy nebo datum), výchozí 10 s, nejvýš 120 s
function retryAfterMs(e){
    const v=e?.response?.headers?.["retry-after"];
    if(v===undefined||v===null||v==="") return 10000;
    const n=Number(v);
    const ms=Number.isFinite(n)?n*1000:Date.parse(String(v))-Date.now();
    return Math.min(120000,Math.max(1000,Number.isFinite(ms)?ms:10000));
}
// ============ Omezení rychlosti požadavků na SKT ============
// SKT vrací 429 s Retry-After 60 s (od 11/2026 už při ~16 požadavcích za minutu). Klouzavé okno pro všechny požadavky
// addonu na SKT (hledání, detaily, přihlášení) společně — SKT nejspíš počítá podle IP serveru: nejvýš SKT_RATE_PER_MIN
// (výchozí 15) za 60 s. Požadavek počká na místo nejvýš SKT_RATE_WAIT_MS (3 s), jinak se přeskočí jako při pauze
// (výsledky z paměti platí, do „2 chyb po sobě“ se nepočítá). Méně důležité požadavky (low: přednačtení dalšího dílu,
// SK / zkrácené názvy, další stránky, detaily ČSFD) nechávají poslední RATE_RESERVE místa hlavním dotazům.
// Prvních 60 s po skončení pauzy 429 platí poloviční limit, ať hned nepřijde druhá pauza.
const envInt=(k,d)=>{ const v=parseInt(process.env[k],10); return Number.isFinite(v)?v:d; };
const RATE_PER_MIN=Math.max(1,envInt("SKT_RATE_PER_MIN",15));
const RATE_WAIT_MS=Math.max(0,envInt("SKT_RATE_WAIT_MS",3000));
const RATE_WINDOW_MS=60000, RATE_RESERVE=3, RATE_SLOW_MS=60000;
const rateLog=[];            // časy požadavků v okně (vzestupně)
let rateSlowUntil=0;         // do kdy platí poloviční limit (konec pauzy 429 + 60 s)
const rateCap=()=>Date.now()<rateSlowUntil?Math.max(1,Math.floor(RATE_PER_MIN/2)):RATE_PER_MIN;
function ratePrune(now){ while(rateLog.length&&rateLog[0]<=now-RATE_WINDOW_MS) rateLog.shift(); }
/** Místo v okně → { wait (ms), ts }, nebo { wait, ts:0 } = místo se do RATE_WAIT_MS neuvolní (požadavek neposílat) */
async function rateSlot(low){
    const t0=Date.now();
    for(;;){
        const now=Date.now(); ratePrune(now);
        const cap=Math.max(low?0:1,rateCap()-(low?RATE_RESERVE:0));
        if(rateLog.length<cap){ rateLog.push(now); return { wait:now-t0, ts:now }; }
        const freeAt=cap>0?rateLog[rateLog.length-cap]+RATE_WINDOW_MS:Infinity;
        if(freeAt-t0>RATE_WAIT_MS) return { wait:now-t0, ts:0 };
        await new Promise(r=>setTimeout(r,Math.max(5,freeAt-now+5)));
    }
}
/** Požadavek se nakonec neposlal (jistič) → vrátit místo */
function rateUnslot(ts){ const i=rateLog.indexOf(ts); if(i>=0) rateLog.splice(i,1); }
/** Zapsat požadavek bez čekání (přihlášení — nesmí selhat kvůli limitu) */
function rateNote(){ ratePrune(Date.now()); rateLog.push(Date.now()); }
/** Pauza 429 skončí za pauseMs → potom ještě 60 s poloviční limit */
function rateSlowAfter(pauseMs){ rateSlowUntil=Math.max(rateSlowUntil,Date.now()+pauseMs+RATE_SLOW_MS); }

const torrentCache = createCache({ ttl: 12*3600*1000, max: 20000 }); // hash → torrent (pro meta/stream u skt ID)
const pausedUntil = new Map();  // účet → čas konce pauzy po 403 / 429
const pauseReason = new Map();  // účet → "pauza 403" | "pauza 429"
const pauseKind=(uid,pass)=>pauseReason.get(accountKey(uid,pass))||"pauza 403";

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
 * skipped: true = dotaz se na SKT vůbec neposlal (pauza / jistič / „limit addonu“); pause: délka pauzy v s, kterou tenhle
 * dotaz spustil (403 / 429); rl: čekání v limitu rychlosti addonu (ms). opts.low = méně důležitý dotaz (viz limit rychlosti).
 */
async function searchSKTPage(query, uid, pass, page=0, opts={}){
    query=normalizeQuery(query);
    const empty={ items:[], hasMore:false };
    if(!query) return empty;
    const acct=accountKey(uid,pass);
    const ck=`${acct}|${query.toLowerCase()}|${page}`;
    const label=`"${query}"${page?` str. ${page+1}`:""}`;
    const cached=queryCache.get(ck);
    if(cached){ console.log(`[SKT] 💾 ${label} (${cached.items.length})`); return { items:cached.items, hasMore:cached.hasMore, cached:true }; }
    // Pauza / jistič: z paměti se odpoví (výše), ostatní dotazy hned chybou bez dotazu na SKT (skipped)
    if(isPaused(uid,pass)){ console.log(`[SKT] ⏸️ Pauza po 403/429, přeskakuji ${label}`); return { ...empty, err:pauseKind(uid,pass), skipped:true }; }
    if(breakerOpen()){ console.log(`[SKT] ⚡ Jistič — přeskakuji ${label}`); return { ...empty, err:"jistič", skipped:true }; }

    return once(`skt:${ck}`, ()=>fetchPage(query,uid,pass,page,ck,label,acct,false,!!opts.low));
}

async function fetchPage(query, uid, pass, page, ck, label, acct, retry=false, low=false){
    const empty={ items:[], hasMore:false };
    if(retry&&isPaused(uid,pass)) return { ...empty, err:pauseKind(uid,pass), skipped:true };
    {
        // Limit rychlosti addonu (před jističem — přeskočený dotaz se nesmí stát zkušebním dotazem jističe)
        const slot=await rateSlot(low);
        const rlw=slot.wait>=50?{ rl:slot.wait }:{};
        if(!slot.ts){ console.log(`[SKT] 🚦 Limit ${rateCap()} požadavků/min — přeskakuji ${label}${low?" (méně důležitý)":""}`); return { ...empty, err:"limit addonu", skipped:true, ...rlw }; }
        if(isPaused(uid,pass)){ rateUnslot(slot.ts); return { ...empty, err:pauseKind(uid,pass), skipped:true, ...rlw }; }
        const waitedProbe=BREAKER.probing;
        const g0=Date.now();
        const gate=await breakerGate();
        // Čekání na zkušební dotaz jističe (do archivu — jinak není vidět, proč hledání trvalo dlouho)
        const probeWait=waitedProbe?Date.now()-g0:0;
        const pw={ ...(probeWait>=50?{ probeWait }:{}), ...rlw };
        if(!gate){ rateUnslot(slot.ts); console.log(`[SKT] ⚡ Jistič — přeskakuji ${label}${probeWait?` (po ${probeWait} ms čekání na zkušební dotaz)`:""}`); return { ...empty, err:"jistič", skipped:true, ...pw }; }
        if(waitedProbe&&isPaused(uid,pass)){ rateUnslot(slot.ts); return { ...empty, err:pauseKind(uid,pass), skipped:true, ...pw }; }
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
            const res={ items:[...items], hasMore:items.raw>=FULL_PAGE&&maxPage(r.data)>page, ms:Date.now()-t0, ...pw };
            const wait=r.request?.sktWait;
            if(Number.isFinite(wait)&&wait>=50) res.wait=wait;
            items.forEach(t=>torrentCache.set(t.hash,t));
            queryCache.set(ck,{ items:res.items, hasMore:res.hasMore });
            breakerOk();
            console.log(`[SKT] Nalezeno: ${items.length} (${res.ms} ms${res.wait?`, z toho ${res.wait} ms čekání na spojení`:""})${res.hasMore?" — další stránky existují":""}`);
            return res;
        }catch(e){
            const ms=Date.now()-t0;
            if(ctrl.signal.aborted&&ctrl.signal.reason==="jistič") return { ...empty, err:"jistič", ms, ...pw };
            const err=errKind(e);
            const msg=errMsgShort(e);
            let pause=null;
            if(err==="403"||err==="http 429"){
                const pauseMs=err==="403"?60000:retryAfterMs(e);
                pause=Math.round(pauseMs/1000);
                console.error(`[SKT] ⛔ ${err} — pauza ${Math.round(pauseMs/1000)} s (${acct==="anon"?"anonymní":"účet"})`);
                pausedUntil.set(acct,Date.now()+pauseMs); pauseReason.set(acct,err==="403"?"pauza 403":"pauza 429");
                if(err==="http 429") rateSlowAfter(pauseMs);
                if(BREAKER.probing) breakerOk();          // server odpovídá (jen omezuje) → jistič zavřít
            }else if(isOutage(err)){
                console.error(`[SKT] ❌ ${label}: ${err} po ${ms} ms (${e.message})`);
                breakerFail();
            }else{
                // Rychlá chyba, která není výpadek (4xx, chyba zpracování) — jistič se nepočítá, jednou zopakovat
                if(BREAKER.probing) breakerOk();
                if(!retry){
                    console.error(`[SKT] ⚠️ ${label}: ${err} po ${ms} ms (${msg}) — zkusím znovu za 1 s`);
                    inflight.delete(ctrl);
                    await new Promise(r=>setTimeout(r,1000));
                    const again=await fetchPage(query,uid,pass,page,ck,label,acct,true,low);
                    return { ...again, firstErr:err, ...(again.err?{}:{ retried:true }) };
                }
                console.error(`[SKT] ⚠️ ${label}: ${err} po ${ms} ms (${msg}) — ani napodruhé`);
            }
            return { ...empty, err, ms, ...(msg?{ msg }:{}), ...(pause?{ pause }:{}), ...pw };
        }finally{ inflight.delete(ctrl); }
    }
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
        const slot=await rateSlot(true);              // detail = méně důležitý požadavek
        if(!slot.ts){ console.log(`[SKT] 🚦 Limit ${rateCap()} požadavků/min — detail ${hash.slice(0,8)} přeskočen`); return undefined; }
        if(isPaused(uid,pass)){ rateUnslot(slot.ts); return undefined; }
        if(!await breakerGate()){ rateUnslot(slot.ts); return undefined; }
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
            if(err==="403"||err==="http 429"){
                const pauseMs=err==="403"?60000:retryAfterMs(e);
                pausedUntil.set(accountKey(uid,pass),Date.now()+pauseMs); pauseReason.set(accountKey(uid,pass),err==="403"?"pauza 403":"pauza 429");
                if(err==="http 429") rateSlowAfter(pauseMs);
                if(BREAKER.probing) breakerOk();
            }
            else if(isOutage(err)) breakerFail();
            else if(BREAKER.probing) breakerOk();
            console.error(`[SKT] 🎬 detail ${hash.slice(0,8)}: ${err} (${e.message})`);
            return undefined;
        }finally{ inflight.delete(ctrl); }
    });
}

/** Detail torrentu je v trvalé paměti (ČSFD odkaz zjištěný dřív) — přečte se bez dotazu na SKT */
function hasDetail(hash){ return detailCache.get(String(hash||"").toLowerCase())!==undefined; }
/** ČSFD z detailu v paměti: číslo | null (bez odkazu) | undefined (detail v paměti není) */
function cachedCsfd(hash){ const c=detailCache.get(String(hash||"").toLowerCase()); return c===undefined?undefined:c.csfd; }

// ============ Co SKT najde ============
// SKT hledá slova dotazu (AND) jako podřetězce v názvu torrentu — bez diakritiky a velikosti písmen, slova o 1 znaku
// ignoruje. Prohledává jen samotný název, ne „Stiahni si <kategorie>“ ani „= CSFD 75%“ z atributu title.
// Ověřeno na archivu hledání: 14 181 ze 14 184 dotazů dalo stejný počet (zbylé 3 = prázdné výsledky z paměti verze 3.5).
const fold=(s)=>removeDiacritics(String(s||"")).toLowerCase();
function searchedText(t){
    let n=String(t.name||"").replace(/^\s*stiahni si\s+/i,"");
    if(t.cat&&n.toLowerCase().startsWith(String(t.cat).toLowerCase())) n=n.slice(t.cat.length);
    return fold(n.replace(/\s*=\s*csfd\s*\d+\s*%\s*$/i,""));
}
/** Torrenty z výsledků dotazu Q, které SKT vrátí i pro dotaz „Q extra“ (ten je podmnožinou Q — stejné pořadí) */
function filterLikeSKT(items, extra){
    const words=fold(normalizeQuery(extra)).split(" ").filter(w=>w.length>=2);
    return (items||[]).filter(t=>{ const n=searchedText(t); return words.every(w=>n.includes(w)); });
}

function _resetBreaker(){ BREAKER.fails=0; BREAKER.openUntil=0; endProbe(false); pausedUntil.clear(); pauseReason.clear(); queryCache.map.clear(); detailCache.map.clear(); rateLog.length=0; rateSlowUntil=0; }
function _rate(){ return { log:rateLog, cap:rateCap(), perMin:RATE_PER_MIN, slowUntil:rateSlowUntil }; }   // pro testy
function _breaker(){ return BREAKER; }   // pro testy

async function searchSKT(query, uid, pass){ return (await searchSKTPage(query,uid,pass,0)).items; }

function getCachedTorrent(hash){ return torrentCache.get(hash); }

async function sktLogin(username, password){
    rateNote();
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

module.exports = { BASE_URL, searchSKT, searchSKTPage, normalizeQuery, isPaused, pauseKind, breakerOpen, getCachedTorrent, sktLogin, getTorrentCsfd, csfdFromDetail, hasDetail, cachedCsfd, filterLikeSKT, _resetBreaker, _breaker, _rate, HARD_LIMIT_MS };
