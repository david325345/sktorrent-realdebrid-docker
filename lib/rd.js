// Real-Debrid
// - hash se nejdřív hledá v účtu (žádné duplikáty při každém přehrání)
// - vybírají se všechna videa → jeden torrent v účtu obslouží všechny epizody balíku
// - cache je klíčovaná tokenem uživatele (odkazy se nesdílí mezi účty)
const axios = require("axios");
const { createCache, once } = require("./cache");
const { isVideo, isSample, delay, keyId, errMsg } = require("./util");
const { pickBySel, selKey } = require("./matching");

const RD_API = "https://api.real-debrid.com/rest/1.0";
const BAD = new Set(["magnet_error","error","virus","dead"]);
const TRACKERS = ["udp://tracker.opentrackr.org:1337/announce","udp://ipv4announce.sktorrent.eu:6969/announce","udp://open.stealth.si:80/announce"];

const listCache = createCache({ ttl: 30*1000, max: 1000 });
const linkCache = createCache({ ttl: 50*60*1000, max: 10000 });

const auth = (t)=>({ Authorization:`Bearer ${t}` });
const form = (t)=>({ ...auth(t), "Content-Type":"application/x-www-form-urlencoded" });

async function rdVerify(token){
    try{ return (await axios.get(`${RD_API}/user`,{ headers:auth(token), timeout:5000 })).data; }
    catch(e){ return null; }
}
async function rdList(token){
    const k=keyId(token);
    const c=listCache.get(k);
    if(c) return c;
    return once(`rdlist:${k}`, async()=>{
        const r=await axios.get(`${RD_API}/torrents`,{ headers:auth(token), params:{ limit:2500 }, timeout:10000 });
        const list=Array.isArray(r.data)?r.data:[];   // 204 = prázdný účet
        listCache.set(k,list);
        return list;
    });
}
async function rdInfo(token,id){
    try{ return (await axios.get(`${RD_API}/torrents/info/${id}`,{ headers:auth(token), timeout:10000 })).data; }
    catch(e){ console.error("[RD] info:",errMsg(e)); return null; }
}
async function rdAdd(token,hash){
    const magnet=`magnet:?xt=urn:btih:${hash}${TRACKERS.map(t=>`&tr=${encodeURIComponent(t)}`).join("")}`;
    const r=await axios.post(`${RD_API}/torrents/addMagnet`,`magnet=${encodeURIComponent(magnet)}`,{ headers:form(token), timeout:15000 });
    listCache.delete(keyId(token));
    console.log(`[RD] ➕ Magnet přidán: ${r.data.id}`);
    return r.data.id;
}
async function rdSelect(token,id,files){
    await axios.post(`${RD_API}/torrents/selectFiles/${id}`,`files=${files}`,{ headers:form(token), timeout:10000 });
    listCache.delete(keyId(token));
}
async function rdDelete(token,id){
    try{ await axios.delete(`${RD_API}/torrents/delete/${id}`,{ headers:auth(token), timeout:5000 }); listCache.delete(keyId(token)); }catch(e){}
}
async function rdUnrestrict(token,link){
    const r=await axios.post(`${RD_API}/unrestrict/link`,`link=${encodeURIComponent(link)}`,{ headers:form(token), timeout:10000 });
    return r.data.download;
}

function videoIds(info){
    const v=(info.files||[]).filter(f=>isVideo(f.path));
    const ns=v.filter(f=>!isSample(f.path));
    return (ns.length?ns:v).map(f=>f.id);
}

async function pollInfo(token,id,done,tries=5){
    let info=null;
    for(let i=0;i<tries;i++){
        info=await rdInfo(token,id);
        if(!info) return null;
        if(done(info)||BAD.has(info.status)) return info;
        if(i<tries-1) await delay(1000);
    }
    return info;
}

const isReady=(i)=>i&&i.status==="downloaded"&&i.links?.length>0;
const fail=(reason)=>({ status:"error", reason });

async function selectAndWait(token,id,info){
    info=info||await rdInfo(token,id);
    if(!info) return fail("RD neodpovídá");
    const ids=videoIds(info);
    if(!ids.length){ await rdDelete(token,id); return fail("Torrent neobsahuje video"); }
    await rdSelect(token,id,ids.join(","));
    console.log(`[RD] ✔️ Vybráno ${ids.length} video souborů`);
    info=await pollInfo(token,id,isReady);
    if(!info) return fail("RD neodpovídá");
    if(BAD.has(info.status)){ await rdDelete(token,id); return fail(`RD: ${info.status}`); }
    if(isReady(info)) return { status:"ready", info };
    return { status:"downloading", progress:info.progress||0 };
}

/**
 * Najde nebo přidá torrent. Vrací {status:"ready",info,reused} | {status:"downloading",progress} | {status:"error",reason}
 * forceNew: přidá nový záznam (starý záznam má vybraný jen jeden soubor z balíku)
 */
function getTorrent(token,hash,{ forceNew=false }={}){
    return once(`rd:${keyId(token)}:${hash}:${forceNew?1:0}`, async()=>{
        try{
            const mine=(await rdList(token)).filter(t=>(t.hash||"").toLowerCase()===hash&&!BAD.has(t.status));
            if(!forceNew){
                // Víc záznamů stejného hashe (staré verze addonu) → ten s nejvíc soubory
                const done=mine.filter(t=>t.status==="downloaded").sort((a,b)=>(b.links?.length||0)-(a.links?.length||0))[0];
                if(done){
                    const info=await rdInfo(token,done.id);
                    if(isReady(info)) return { status:"ready", info, reused:true };
                }
            }
            // Rozpracovaný záznam má přednost před přidáním dalšího (i při forceNew)
            const waiting=mine.find(t=>t.status==="waiting_files_selection");
            if(waiting) return await selectAndWait(token,waiting.id);
            const prog=mine.find(t=>t.status!=="downloaded");
            if(prog){ console.log(`[RD] 🕐 V účtu: ${prog.status} ${prog.progress||0}%`); return { status:"downloading", progress:prog.progress||0 }; }
            const id=await rdAdd(token,hash);
            const info=await pollInfo(token,id,i=>i.status==="waiting_files_selection"||isReady(i));
            if(!info) return fail("RD neodpovídá");
            if(BAD.has(info.status)){ await rdDelete(token,id); return fail(`RD: ${info.status}`); }
            if(isReady(info)) return { status:"ready", info };
            if(info.status==="waiting_files_selection") return await selectAndWait(token,id,info);
            return { status:"downloading", progress:info.progress||0 };
        }catch(e){
            console.error("[RD]",errMsg(e));
            return fail(`RD: ${errMsg(e)}`);
        }
    });
}

// Vybrané soubory ↔ linky (RD vrací linky v pořadí vybraných souborů podle ID)
function mapLinks(info){
    const sel=(info.files||[]).filter(f=>f.selected===1).sort((a,b)=>a.id-b.id);
    if(sel.length!==(info.links||[]).length) return null;
    return sel.map((f,i)=>({ id:f.id, name:f.path, size:f.bytes, link:info.links[i] }));
}

// Soubor se hledá mezi VŠEMI soubory torrentu; když není vybraný (starý záznam), unselected=true
function pickFromInfo(info,sel){
    const all=(info.files||[]).map(f=>({ id:f.id, name:f.path, size:f.bytes, selected:f.selected===1 }));
    const target=pickBySel(all,sel);
    if(!target) return { file:null, unselected:false, reason:"Hledaný díl/film v torrentu nenalezen" };
    if(!target.selected) return { file:null, unselected:true, reason:"Soubor není v RD vybraný" };
    const mapped=mapLinks(info);
    if(!mapped) return { file:null, unselected:false, reason:"RD vrátil archiv místo jednotlivých souborů" };
    const file=mapped.find(f=>f.id===target.id)||null;
    return { file, unselected:false, reason:file?null:"Soubor nenalezen mezi linky" };
}


/** sel: {} (největší video) | {season,episode} | {fileId} */
async function resolve(token,hash,sel={}){
    const lk=`${keyId(token)}:${hash}:${selKey(sel)}`;
    const c=linkCache.get(lk);
    if(c){ console.log("[RD] 💾 Link z cache"); return { status:"ready", url:c }; }
    return once(`rdres:${lk}`, async()=>{
        let t=await getTorrent(token,hash);
        if(t.status!=="ready") return t;
        let p=pickFromInfo(t.info,sel);
        if(!p.file&&p.unselected&&t.reused){
            console.log("[RD] Starý záznam nemá vybraný potřebný soubor → přidávám znovu se všemi videi");
            t=await getTorrent(token,hash,{ forceNew:true });
            if(t.status!=="ready") return t;
            p=pickFromInfo(t.info,sel);
        }
        if(!p.file) return fail(p.reason);
        try{
            const url=await rdUnrestrict(token,p.file.link);
            if(!url) return fail("RD nevrátil odkaz");
            linkCache.set(lk,url);
            console.log(`[RD] ✅ ${p.file.name.split("/").pop()}`);
            return { status:"ready", url };
        }catch(e){ return fail(`RD unrestrict: ${errMsg(e)}`); }
    });
}

/** Seznam video souborů (pro přímé hledání SKT) — nic neodemyká */
async function listFiles(token,hash){
    let t=await getTorrent(token,hash);
    if(t.status!=="ready") return t;
    if(t.reused&&(t.info.files||[]).some(f=>isVideo(f.path)&&f.selected!==1)){
        t=await getTorrent(token,hash,{ forceNew:true });
        if(t.status!=="ready") return t;
    }
    const mapped=mapLinks(t.info);
    if(!mapped) return fail("RD vrátil archiv");
    const vids=mapped.filter(f=>isVideo(f.name)).map(f=>({ id:f.id, name:f.name.split("/").pop(), size:f.size }));
    vids.sort((a,b)=>a.name.localeCompare(b.name,undefined,{ numeric:true }));
    return { status:"ready", files:vids };
}

module.exports = { rdVerify, resolve, listFiles };
