// TorBox
// - checkcached: hromadné zjištění, co je v cache (⚡ ve výpisu streamů)
// - hash se nejdřív hledá v mylist (žádné duplikáty), až pak createtorrent
// - soubor se vybírá podle NÁZVU, ne podle pořadí (TorBox vrací file ID v jiném pořadí než torrent)
// - createtorrent pro necachované je omezený (60/h), proto se necachované přidávají až při přehrání
// - plné sloty stahování: TorBox torrent nezačne stahovat, ale zařadí do fronty („Torrent queued successfully.“,
//   bez torrent_id). To je stav „ve frontě“, ne chyba — a před přidáním se kontroluje i fronta (/torrents/getqueued),
//   aby se tentýž torrent nepřidával znovu („Download already queued.“).
// - po „60 per 1 hour“ / HTTP 429 se createtorrent pro daný klíč na 10 min pozastaví (cachované dál fungují)
const axios = require("axios");
const { createCache, once } = require("./cache");
const { isVideo, basename, delay, keyId, errMsg } = require("./util");
const { pickBySel, selKey } = require("./matching");

const TB_API = "https://api.torbox.app/v1/api";
const TRACKERS = ["udp://tracker.opentrackr.org:1337/announce","udp://ipv4announce.sktorrent.eu:6969/announce","udp://open.stealth.si:80/announce"];

const listCache   = createCache({ ttl: 30*1000, max: 1000 });
const queueCache  = createCache({ ttl: 30*1000, max: 1000 });
const LIMIT_PAUSE_MS = 10*60*1000;
const createPausedUntil = new Map();     // keyId → konec pauzy přidávání po limitu 60/h
const linkCache   = createCache({ ttl: 2*3600*1000, max: 10000 });

const auth = (k)=>({ Authorization:`Bearer ${k}` });
const fail = (reason)=>({ status:"error", reason });
const queued = (reason="TorBox: torrent ve frontě (plné sloty stahování)")=>({ status:"queued", reason });
const limited = (reason)=>({ status:"limit", reason });
const isQueuedMsg = (m)=>/queued/i.test(String(m||""));
const isLimitMsg = (m)=>/per\s*1\s*hour|rate.?limit|too many|\b429\b/i.test(String(m||""));

async function tbVerify(key){
    try{
        const r=await axios.get(`${TB_API}/user/me`,{ headers:auth(key), timeout:8000 });
        return r.data?.success ? r.data.data : null;
    }catch(e){ return null; }
}

/** Živé volání checkcached pokaždé (bez paměti). Vrací Set nacachovaných hashů; při chybě API null (neznámo) */
async function checkCached(key,hashes){
    const want=[...new Set(hashes.map(h=>h.toLowerCase()))];
    const result=new Set();
    try{
        for(let i=0;i<want.length;i+=100){
            const chunk=want.slice(i,i+100);
            const r=await axios.get(`${TB_API}/torrents/checkcached`,{ headers:auth(key), params:{ hash:chunk.join(","), format:"object", list_files:false }, timeout:10000 });
            const data=r.data?.data||{};
            for(const h of Object.keys(data)) if(want.includes(h.toLowerCase())) result.add(h.toLowerCase());
        }
    }catch(e){
        console.error("[TB] checkcached:",errMsg(e));
        return null;
    }
    console.log(`[TB] checkcached: ${result.size}/${want.length} v cache`);
    return result;
}

async function tbList(key){
    const k=keyId(key);
    const c=listCache.get(k);
    if(c) return c;
    return once(`tblist:${k}`, async()=>{
        const r=await axios.get(`${TB_API}/torrents/mylist`,{ headers:auth(key), params:{ bypass_cache:true }, timeout:15000 });
        const list=Array.isArray(r.data?.data)?r.data.data:[];
        listCache.set(k,list);
        return list;
    });
}
/** Torrenty ve frontě TorBoxu (čekají na volný slot) — nejsou v mylist. Při chybě API prázdný seznam. */
async function tbQueued(key){
    const k=keyId(key);
    const c=queueCache.get(k);
    if(c) return c;
    return once(`tbqueue:${k}`, async()=>{
        try{
            const r=await axios.get(`${TB_API}/torrents/getqueued`,{ headers:auth(key), params:{ bypass_cache:true }, timeout:10000 });
            const list=Array.isArray(r.data?.data)?r.data.data:[];
            queueCache.set(k,list);
            return list;
        }catch(e){ console.error("[TB] getqueued:",errMsg(e)); return []; }
    });
}
const inQueue=(list,hash)=>list.some(q=>String(q.hash||"").toLowerCase()===hash||String(q.magnet||"").toLowerCase().includes(`btih:${hash}`));

function createPaused(key){
    const until=createPausedUntil.get(keyId(key))||0;
    return until>Date.now()?until:0;
}
function pauseCreate(key,why){
    createPausedUntil.set(keyId(key),Date.now()+LIMIT_PAUSE_MS);
    console.log(`[TB] ⏸️ ${why} — přidávání pozastaveno na ${LIMIT_PAUSE_MS/60000} min`);
}

async function tbGet(key,id){
    const r=await axios.get(`${TB_API}/torrents/mylist`,{ headers:auth(key), params:{ id, bypass_cache:true }, timeout:10000 });
    return r.data?.data||null;
}
/** → { id } | { queued:true, detail } | { limit:true, detail }; jiná chyba = výjimka */
async function tbCreate(key,hash){
    const magnet=`magnet:?xt=urn:btih:${hash}${TRACKERS.map(t=>`&tr=${encodeURIComponent(t)}`).join("")}`;
    const fd=new FormData();
    fd.append("magnet",magnet);
    fd.append("seed","3");          // neseedovat
    fd.append("allow_zip","false");
    let d;
    try{
        const r=await axios.post(`${TB_API}/torrents/createtorrent`,fd,{ headers:auth(key), timeout:20000 });
        d=r.data||{};
    }catch(e){
        const msg=errMsg(e);
        if(e.response?.status===429||isLimitMsg(msg)) return { limit:true, detail:msg };
        if(isQueuedMsg(msg)) return { queued:true, detail:msg };
        throw e;
    }finally{
        listCache.delete(keyId(key)); queueCache.delete(keyId(key));
    }
    const msg=d.detail||d.error||"";
    if(d.success&&d.data?.torrent_id){
        console.log(`[TB] ➕ ${msg||"Přidáno"} (id ${d.data.torrent_id})`);
        return { id:d.data.torrent_id };
    }
    // Plné sloty: úspěch bez torrent_id (jen id ve frontě) nebo „Download already queued.“
    if((d.success&&(d.data?.queued_id||isQueuedMsg(msg)))||isQueuedMsg(msg)){
        console.log(`[TB] ⏳ ${msg||"Ve frontě"}`);
        return { queued:true, detail:msg };
    }
    if(isLimitMsg(msg)) return { limit:true, detail:msg };
    throw new Error(msg||"createtorrent selhal");
}
async function tbRequestDl(key,torrentId,fileId){
    const r=await axios.get(`${TB_API}/torrents/requestdl`,{ params:{ token:key, torrent_id:torrentId, file_id:fileId, zip_link:false }, timeout:15000 });
    if(!r.data?.success||!r.data?.data) throw new Error(r.data?.detail||r.data?.error||"requestdl selhal");
    return r.data.data;
}

const isReady=(t)=>!!(t&&(t.download_present||t.download_finished)&&Array.isArray(t.files)&&t.files.length);
const isFailed=(t)=>/error|fail/i.test(String(t?.download_state||""));
const progressOf=(t)=>Math.round((t?.progress||0)*100);

// Rozpracovaný torrent: průběh + stav TorBoxu („stalled (no seeds)“) a odkdy je v účtu — do archivu a popisu streamu
const downloading=(t)=>({ status:"downloading", progress:progressOf(t), state:t?.download_state||null, since:t?.created_at||null, seeds:t?.seeds??null });

/** Stav torrentů, které už jsou v účtu nebo ve frontě (bez přidávání): Map hash → { ready, queued, state, progress, since } */
async function accountStatus(key,hashes){
    const want=new Set(hashes.map(h=>h.toLowerCase()));
    const out=new Map();
    const [list,queue]=await Promise.all([tbList(key),tbQueued(key)]);
    for(const t of list){
        const h=(t.hash||"").toLowerCase();
        if(!want.has(h)||(out.has(h)&&out.get(h).ready)) continue;
        out.set(h,{ ready:isReady(t), failed:isFailed(t), state:t.download_state||null, progress:progressOf(t), since:t.created_at||null });
    }
    for(const q of queue){
        const h=String(q.hash||"").toLowerCase();
        if(want.has(h)&&!out.has(h)) out.set(h,{ ready:false, queued:true, state:"ve frontě", progress:0, since:q.created_at||null });
    }
    return out;
}

/** {status:"ready",torrent} | {status:"downloading",progress,state,since} | {status:"queued"} | {status:"limit"} | {status:"notadded"} | {status:"error",reason} */
function getTorrent(key,hash,{ allowCreate=true }={}){
    return once(`tb:${keyId(key)}:${hash}:${allowCreate?1:0}`, async()=>{
        try{
            const mine=(await tbList(key)).filter(t=>(t.hash||"").toLowerCase()===hash);
            const ready=mine.find(isReady);
            if(ready) return { status:"ready", torrent:ready };
            const prog=mine.find(t=>!isFailed(t));
            if(prog){ console.log(`[TB] 🕐 V účtu: ${prog.download_state} ${progressOf(prog)}%`); return downloading(prog); }
            if(mine.length) return fail(`TorBox: ${mine[0].download_state}`);
            if(inQueue(await tbQueued(key),hash)){ console.log("[TB] ⏳ Ve frontě TorBoxu (plné sloty stahování)"); return queued(); }
            if(!allowCreate) return { status:"notadded" };
            const until=createPaused(key);
            if(until) return limited(`TorBox: limit přidání — znovu za ${Math.ceil((until-Date.now())/60000)} min`);

            const c=await tbCreate(key,hash);
            if(c.limit){ pauseCreate(key,`limit TorBoxu (${c.detail||"429"})`); return limited(`TorBox: ${c.detail||"limit přidání"}`); }
            if(c.queued) return queued(`TorBox: ${c.detail||"ve frontě"}`);
            const id=c.id;
            let t=null;
            for(let i=0;i<5;i++){
                t=await tbGet(key,id);
                if(isReady(t)) return { status:"ready", torrent:t };
                if(isFailed(t)) return fail(`TorBox: ${t.download_state}`);
                if(i<4) await delay(1000);
            }
            return downloading(t);
        }catch(e){
            const msg=errMsg(e);
            console.error("[TB]",msg);
            if(e.response?.status===429||isLimitMsg(msg)){ pauseCreate(key,`limit TorBoxu (${msg})`); return limited(`TorBox: ${msg}`); }
            if(isQueuedMsg(msg)) return queued(`TorBox: ${msg}`);
            return fail(`TorBox: ${msg}`);
        }
    });
}

function tbFiles(t){
    return (t.files||[]).map(f=>({ id:f.id, name:f.name||f.short_name||"", short:f.short_name||basename(f.name), size:f.size||0, mime:f.mimetype||"" }));
}


/** sel: {} (největší video) | {season,episode} | {fileId} */
async function resolve(key,hash,sel={}){
    const lk=`${keyId(key)}:${hash}:${selKey(sel)}`;
    const c=linkCache.get(lk);
    if(c){ console.log("[TB] 💾 Link z cache"); return { status:"ready", url:c.url, file:c.file, fromCache:true }; }
    return once(`tbres:${lk}`, async()=>{
        const t=await getTorrent(key,hash);
        if(t.status!=="ready") return t;
        const files=tbFiles(t.torrent);
        if(!files.some(f=>isVideo(f.name))){
            if(files.some(f=>/\.zip$/i.test(f.name)||/zip/i.test(f.mime))) return fail("TorBox má torrent jen jako ZIP");
            return fail("Torrent neobsahuje video");
        }
        const file=pickBySel(files,sel);
        if(!file) return { ...fail("Hledaný díl/film v torrentu nenalezen"), videos:files.filter(f=>isVideo(f.name)).map(f=>({ n:f.name, s:f.size })) };
        try{
            const url=await tbRequestDl(key,t.torrent.id,file.id);
            linkCache.set(lk,{ url, file:file.name });
            console.log(`[TB] ✅ ${file.short}`);
            return { status:"ready", url, file:file.name };
        }catch(e){ return fail(`TorBox requestdl: ${errMsg(e)}`); }
    });
}

/** Seznam video souborů (přímé hledání SKT). Necachovaný torrent se nepřidává. */
async function listFiles(key,hash,{ cached }={}){
    const t=await getTorrent(key,hash,{ allowCreate:!!cached });
    if(t.status!=="ready") return t;
    const vids=tbFiles(t.torrent).filter(f=>isVideo(f.name)).map(f=>({ id:f.id, name:f.short, size:f.size }));
    vids.sort((a,b)=>a.name.localeCompare(b.name,undefined,{ numeric:true }));
    if(!vids.length) return fail("Bez video souborů (ZIP?)");
    return { status:"ready", files:vids };
}

function _reset(){ createPausedUntil.clear(); listCache.map.clear(); queueCache.map.clear(); linkCache.map.clear(); }   // pro testy

module.exports = { tbVerify, checkCached, resolve, listFiles, accountStatus, _reset };
