// TorBox
// - checkcached: hromadné zjištění, co je v cache (⚡ ve výpisu streamů)
// - hash se nejdřív hledá v mylist (žádné duplikáty), až pak createtorrent
// - soubor se vybírá podle NÁZVU, ne podle pořadí (TorBox vrací file ID v jiném pořadí než torrent)
// - createtorrent pro necachované je omezený (60/h), proto se necachované přidávají až při přehrání
const axios = require("axios");
const { createCache, once } = require("./cache");
const { isVideo, basename, delay, keyId, errMsg } = require("./util");
const { pickEpisodeFile } = require("./matching");

const TB_API = "https://api.torbox.app/v1/api";
const TRACKERS = ["udp://tracker.opentrackr.org:1337/announce","udp://ipv4announce.sktorrent.eu:6969/announce","udp://open.stealth.si:80/announce"];

const listCache   = createCache({ ttl: 30*1000, max: 1000 });
const linkCache   = createCache({ ttl: 2*3600*1000, max: 10000 });

const auth = (k)=>({ Authorization:`Bearer ${k}` });
const fail = (reason)=>({ status:"error", reason });

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
async function tbGet(key,id){
    const r=await axios.get(`${TB_API}/torrents/mylist`,{ headers:auth(key), params:{ id, bypass_cache:true }, timeout:10000 });
    return r.data?.data||null;
}
async function tbCreate(key,hash){
    const magnet=`magnet:?xt=urn:btih:${hash}${TRACKERS.map(t=>`&tr=${encodeURIComponent(t)}`).join("")}`;
    const fd=new FormData();
    fd.append("magnet",magnet);
    fd.append("seed","3");          // neseedovat
    fd.append("allow_zip","false");
    const r=await axios.post(`${TB_API}/torrents/createtorrent`,fd,{ headers:auth(key), timeout:20000 });
    listCache.delete(keyId(key));
    if(!r.data?.success||!r.data?.data?.torrent_id) throw new Error(r.data?.detail||r.data?.error||"createtorrent selhal");
    console.log(`[TB] ➕ ${r.data.detail||"Přidáno"} (id ${r.data.data.torrent_id})`);
    return r.data.data.torrent_id;
}
async function tbRequestDl(key,torrentId,fileId){
    const r=await axios.get(`${TB_API}/torrents/requestdl`,{ params:{ token:key, torrent_id:torrentId, file_id:fileId, zip_link:false }, timeout:15000 });
    if(!r.data?.success||!r.data?.data) throw new Error(r.data?.detail||r.data?.error||"requestdl selhal");
    return r.data.data;
}

const isReady=(t)=>!!(t&&(t.download_present||t.download_finished)&&Array.isArray(t.files)&&t.files.length);
const isFailed=(t)=>/error|fail/i.test(String(t?.download_state||""));
const progressOf=(t)=>Math.round((t?.progress||0)*100);

/** {status:"ready",torrent} | {status:"downloading",progress} | {status:"notadded"} | {status:"error",reason} */
function getTorrent(key,hash,{ allowCreate=true }={}){
    return once(`tb:${keyId(key)}:${hash}:${allowCreate?1:0}`, async()=>{
        try{
            const mine=(await tbList(key)).filter(t=>(t.hash||"").toLowerCase()===hash);
            const ready=mine.find(isReady);
            if(ready) return { status:"ready", torrent:ready };
            const prog=mine.find(t=>!isFailed(t));
            if(prog){ console.log(`[TB] 🕐 V účtu: ${prog.download_state} ${progressOf(prog)}%`); return { status:"downloading", progress:progressOf(prog) }; }
            if(mine.length) return fail(`TorBox: ${mine[0].download_state}`);
            if(!allowCreate) return { status:"notadded" };

            const id=await tbCreate(key,hash);
            let t=null;
            for(let i=0;i<5;i++){
                t=await tbGet(key,id);
                if(isReady(t)) return { status:"ready", torrent:t };
                if(isFailed(t)) return fail(`TorBox: ${t.download_state}`);
                if(i<4) await delay(1000);
            }
            return { status:"downloading", progress:progressOf(t) };
        }catch(e){
            console.error("[TB]",errMsg(e));
            return fail(`TorBox: ${errMsg(e)}`);
        }
    });
}

function tbFiles(t){
    return (t.files||[]).map(f=>({ id:f.id, name:f.name||f.short_name||"", short:f.short_name||basename(f.name), size:f.size||0, mime:f.mimetype||"" }));
}

const selKey=(sel)=>sel.fileId!==undefined?`f${sel.fileId}`:(sel.season!==undefined?`e${sel.season}-${sel.episode}`:"main");

/** sel: {} (největší video) | {season,episode} | {fileId} */
async function resolve(key,hash,sel={}){
    const lk=`${keyId(key)}:${hash}:${selKey(sel)}`;
    const c=linkCache.get(lk);
    if(c){ console.log("[TB] 💾 Link z cache"); return { status:"ready", url:c }; }
    return once(`tbres:${lk}`, async()=>{
        const t=await getTorrent(key,hash);
        if(t.status!=="ready") return t;
        const files=tbFiles(t.torrent);
        if(!files.some(f=>isVideo(f.name))){
            if(files.some(f=>/\.zip$/i.test(f.name)||/zip/i.test(f.mime))) return fail("TorBox má torrent jen jako ZIP");
            return fail("Torrent neobsahuje video");
        }
        const file=sel.fileId!==undefined
            ? files.find(f=>String(f.id)===String(sel.fileId))||null
            : pickEpisodeFile(files,sel.season,sel.episode);
        if(!file) return fail("Epizoda v torrentu nenalezena");
        try{
            const url=await tbRequestDl(key,t.torrent.id,file.id);
            linkCache.set(lk,url);
            console.log(`[TB] ✅ ${file.short}`);
            return { status:"ready", url };
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

module.exports = { tbVerify, checkCached, resolve, listFiles };
