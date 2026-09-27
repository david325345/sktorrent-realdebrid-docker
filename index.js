// SKTorrent + Real-Debrid / TorBox Stremio Addon v3.0
// TMDB pro CZ/SK názvy, OMDb jako záloha
const path = require("path");
const express = require("express");

const { parseToken } = require("./lib/config");
const { getTitle } = require("./lib/meta");
const { searchSKT, getCachedTorrent, sktLogin } = require("./lib/skt");
const { findTorrents } = require("./lib/search");
const { PROVIDERS, activeProviders, checkCachedTB, rdVerify, tbVerify } = require("./lib/debrid");
const { configPage } = require("./lib/html");
const { isHash, flagsFromName, cleanTorrentName, formatBytes, baseUrl } = require("./lib/util");

const PORT = process.env.PORT || 3009;
const VERSION = "3.0.0";
const MAX_EP_TORRENTS = 12;      // max torrentů s přesnou epizodou / filmů
const MAX_ALL_TORRENTS = 15;     // max torrentů celkem (včetně balíků)

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

// CORS pro všechny odpovědi (Stremio web)
app.use((req,res,next)=>{ res.setHeader("Access-Control-Allow-Origin","*"); res.setHeader("Access-Control-Allow-Headers","*"); next(); });
app.use("/static", express.static(path.join(__dirname,"public"), { maxAge:"7d" }));

const staticUrl = (req,file)=>`${baseUrl(req)}/static/${file}`;

app.get("/health",(req,res)=>res.json({ status:"ok", version:VERSION }));
app.get(["/","/configure"],(req,res)=>res.type("html").send(configPage(null)));
app.get("/:token/configure",(req,res)=>res.type("html").send(configPage(parseToken(req.params.token))));

// ============ MANIFEST ============
app.get("/:token/manifest.json",(req,res)=>{
    const cfg=parseToken(req.params.token);
    const provs=activeProviders(cfg);
    const suffix=provs.length?provs.map(p=>p.short).join("+"):"RD";
    const catalogs=cfg.sktSearch?[{ type:"movie", id:"skt-search", name:"SKTorrent", extra:[{ name:"search", isRequired:true }] }]:[];
    const resources=cfg.sktSearch?[
        { name:"stream", types:["movie","series"], idPrefixes:["tt","skt"] },
        { name:"catalog", types:["movie"], idPrefixes:["skt"] },
        { name:"meta", types:["movie"], idPrefixes:["skt"] }
    ]:[
        { name:"stream", types:["movie","series"], idPrefixes:["tt"] }
    ];
    res.json({
        id:"org.stremio.sktorrent.rd",   // beze změny, ať není nutná reinstalace
        version:VERSION,
        name:`SKTorrent+${suffix}`,
        description:"CZ/SK torrenty ze sktorrent.eu přes Real-Debrid a/nebo TorBox",
        logo:staticUrl(req,"logo.png"),
        types:["movie","series"],
        catalogs, resources,
        behaviorHints:{ configurable:true, configurationRequired:provs.length===0 }
    });
});

// ============ CATALOG (přímé hledání SKT) ============
app.get("/:token/catalog/:type/:id/:extra.json",async(req,res)=>{
    const { sktUid, sktPass }=parseToken(req.params.token);
    const m=String(req.params.extra||"").match(/(?:^|&)search=([^&]+)/);
    if(!m) return res.json({ metas:[] });
    let query;
    try{ query=decodeURIComponent(m[1]).trim(); }catch(e){ query=m[1]; }
    if(!query) return res.json({ metas:[] });
    console.log(`\n🔍 Catalog search: "${query}"`);
    const results=await searchSKT(query,sktUid,sktPass);
    const metas=results.map(t=>{
        const flags=flagsFromName(t.name);
        return {
            id:`skt${t.hash}`, type:"movie", name:cleanTorrentName(t),
            poster:t.poster||undefined, posterShape:"regular",
            background:t.poster||staticUrl(req,"logo.png"),
            description:`📁 ${t.cat||"SKT"}  📀 ${t.size}  👤 ${t.seeds}${flags?" "+flags:""}`
        };
    });
    console.log(`🔍 Catalog: ${metas.length} výsledků`);
    res.json({ metas });
});

// ============ META (detail SKT torrentu) ============
app.get("/:token/meta/:type/:id.json",(req,res)=>{
    const { id }=req.params;
    const hash=id.replace(/^skt/,"").toLowerCase();
    if(!id.startsWith("skt")||!isHash(hash)) return res.json({ meta:null });
    const t=getCachedTorrent(hash);
    if(!t) return res.json({ meta:{ id, type:"movie", name:hash, description:"Torrent z SKTorrent" } });
    const flags=flagsFromName(t.name);
    res.json({ meta:{
        id, type:"movie", name:cleanTorrentName(t),
        poster:t.poster||undefined, posterShape:"regular", background:t.poster||undefined, logo:t.poster||undefined,
        description:`📁 Kategorie: ${t.cat||"SKT"}\n📀 Velikost: ${t.size}\n👤 Seeds: ${t.seeds}${flags?" "+flags:""}\n\n${t.name}`
    }});
});

// ============ STREAM ============
const playUrl=(req,prov,hash,sel={})=>{
    const b=`${baseUrl(req)}/${req.params.token}/play/${prov}/${hash}`;
    if(sel.fileId!==undefined) return `${b}/f/${sel.fileId}/video.mp4`;
    if(sel.season!==undefined) return `${b}/e/${sel.season}/${sel.episode}/video.mp4`;
    return `${b}/video.mp4`;
};

async function tbCachedSet(cfg,hashes){
    if(!cfg.tbKey||!hashes.length) return null;
    return await checkCachedTB(cfg.tbKey,hashes);   // null = nepodařilo se zjistit
}

function providerLine(p,cached){
    if(p.id==="tb") return cached===true?"⚡ TorBox (v cache)":cached===false?"⏳ TorBox (není v cache)":"📦 TorBox";
    return "Real-Debrid";   // stav cache u RD se neřeší
}
function streamName(p,cat,cached){
    return `SKT+${p.short}${p.id==="tb"&&cached===true?" ⚡":""}\n${cat}`;
}

// Přímý stream SKT torrentu z katalogu — soubory se jen vypíšou, odemyká se až při kliknutí
async function sktDirectStreams(req,cfg,hash){
    const t=getCachedTorrent(hash);
    const cat=t?.cat||"SKT";
    const thumb=t?.poster||undefined;
    const provs=activeProviders(cfg);
    const cachedSet=await tbCachedSet(cfg,[hash]);
    const perProv=await Promise.all(provs.map(async p=>{
        const cached=p.id==="tb"?(cachedSet?cachedSet.has(hash):null):undefined;
        let r;
        try{ r=await p.listFiles(p.key(cfg),hash,{ cached:cached===true }); }
        catch(e){ r={ status:"error", reason:e.message }; }
        const out=[];
        if(r.status==="ready"){
            r.files.forEach((f,i)=>out.push({
                name:r.files.length>1?`SKT+${p.short}\n📁 ${i+1}/${r.files.length}`:streamName(p,cat,cached),
                description:`${f.name}\n📀 ${formatBytes(f.size)}\n${providerLine(p,cached)}`,
                url:playUrl(req,p.id,hash,{ fileId:f.id }),
                behaviorHints:{ notWebReady:true, bingeGroup:`skt-${p.id}-${hash.slice(0,8)}` },
                thumbnail:thumb
            }));
        }else if(r.status==="downloading"||r.status==="notadded"){
            const txt=r.status==="notadded"?"⏳ Není v cache — po kliknutí se začne stahovat":`🕐 Torrent se stahuje${r.progress?` (${r.progress} %)`:""}…\nZkuste za chvíli znovu.`;
            out.push({ name:streamName(p,cat,cached), description:`${txt}\n${providerLine(p,cached)}`, url:playUrl(req,p.id,hash), behaviorHints:{ notWebReady:true }, thumbnail:thumb });
        }else{
            console.log(`[SKT ${p.short}] ❌ ${r.reason}`);
        }
        return out;
    }));
    return perProv.flat();
}

app.get("/:token/stream/:type/:id.json",async(req,res)=>{
    const { type, id }=req.params;
    const cfg=parseToken(req.params.token);
    const provs=activeProviders(cfg);
    if(!provs.length) return res.json({ streams:[] });

    try{
        // SKT přímý stream (z katalogu)
        if(id.startsWith("skt")){
            const hash=id.slice(3).toLowerCase();
            if(!isHash(hash)) return res.json({ streams:[] });
            console.log(`\n🎬 SKT stream: ${hash}`);
            return res.json({ streams:await sktDirectStreams(req,cfg,hash) });
        }

        const [imdbId,sRaw,eRaw]=id.split(":");
        if(!/^tt\d+$/.test(imdbId)) return res.json({ streams:[] });
        const season=sRaw!==undefined?parseInt(sRaw):undefined;
        const episode=eRaw!==undefined?parseInt(eRaw):undefined;
        const isSeries=type==="series"&&Number.isInteger(season)&&Number.isInteger(episode);
        console.log(`\n🎬 ${type} ${imdbId} S${season??"-"}E${episode??"-"}`);

        const titles=await getTitle(imdbId,cfg.tmdbKey,type);
        if(!titles) return res.json({ streams:[] });

        const { torrents, batchTorrents, epTag }=await findTorrents({
            type, season:isSeries?season:undefined, episode:isSeries?episode:undefined,
            titles, sktUid:cfg.sktUid, sktPass:cfg.sktPass
        });
        if(!torrents.length&&!batchTorrents.length) return res.json({ streams:[] });

        let picked=[
            ...torrents.slice(0,MAX_EP_TORRENTS).map(t=>({ t, isBatch:false })),
            ...batchTorrents.map(t=>({ t, isBatch:true }))
        ].slice(0,MAX_ALL_TORRENTS);

        const cachedSet=await tbCachedSet(cfg,picked.map(x=>x.t.hash));
        // S TorBoxem: v rámci epizod i balíků napřed torrenty z cache TorBoxu
        if(cachedSet){
            const rank=(x)=>(x.isBatch?2:0)+(cachedSet.has(x.t.hash)?0:1);
            picked=picked.map((x,i)=>({ ...x, i })).sort((a,b)=>rank(a)-rank(b)||a.i-b.i);
        }

        const sel=isSeries?{ season, episode }:{};
        const streams=[];
        for(const { t, isBatch } of picked){
            const flags=flagsFromName(t.name);
            const cat=t.cat||"SKT";
            const label=`${cleanTorrentName(t)}${isBatch?` 📦 ${epTag} z balíku`:""}`;
            for(const p of provs){
                const cached=p.id==="tb"?(cachedSet?cachedSet.has(t.hash):null):undefined;
                streams.push({
                    name:streamName(p,cat,cached),
                    description:`${label}\n👤 ${t.seeds}  📀 ${t.size}${flags?"  "+flags:""}\n${providerLine(p,cached)}`,
                    url:playUrl(req,p.id,t.hash,sel),
                    behaviorHints:{ bingeGroup:`skt-${p.id}-${t.hash.slice(0,8)}`, notWebReady:true }
                });
            }
        }
        console.log(`✅ ${streams.length} streamů (${picked.length} torrentů × ${provs.length} služby)`);
        res.json({ streams });
    }catch(e){
        console.error("[STREAM] Error:",e.message);
        res.json({ streams:[] });
    }
});

// ============ PLAY ============
async function handlePlay(req,res,provId,hash,sel){
    const cfg=parseToken(req.params.token);
    const p=PROVIDERS[provId];
    const key=p?.key(cfg);
    if(!key) return res.status(400).type("text/plain").send(`Chybí klíč pro ${p?.label||provId}`);
    hash=hash.toLowerCase();
    console.log(`\n▶️ Play ${p.short}: ${hash} ${sel.fileId!==undefined?`file ${sel.fileId}`:`S${sel.season??"-"}E${sel.episode??"-"}`}`);
    let r;
    try{ r=await p.resolve(key,hash,sel); }
    catch(e){ r={ status:"error", reason:e.message }; }
    if(r.status==="ready") return res.redirect(302,r.url);
    if(r.status==="downloading"||r.status==="notadded"){
        console.log(`[Play] 🕐 Stahuje se → info video`);
        return res.redirect(302,staticUrl(req,"downloading.mp4"));
    }
    console.log(`[Play] ❌ ${r.reason}`);
    return res.status(502).type("text/plain").send(`Chyba: ${r.reason}`);
}

const H="[a-fA-F0-9]{40}";
app.get(`/:token/play/:prov(rd|tb)/:hash(${H})/e/:season(\\d+)/:episode(\\d+)/video.mp4`,(req,res)=>
    handlePlay(req,res,req.params.prov,req.params.hash,{ season:parseInt(req.params.season), episode:parseInt(req.params.episode) }));
app.get(`/:token/play/:prov(rd|tb)/:hash(${H})/f/:fileId(\\d+)/video.mp4`,(req,res)=>
    handlePlay(req,res,req.params.prov,req.params.hash,{ fileId:parseInt(req.params.fileId) }));
app.get(`/:token/play/:prov(rd|tb)/:hash(${H})/video.mp4`,(req,res)=>
    handlePlay(req,res,req.params.prov,req.params.hash,{}));
// Starý formát URL (v2.x, jen RD) — kvůli rozkoukaným položkám v knihovně Stremia
app.get(`/:token/play/:hash(${H})/:season(\\d+)?/:episode(\\d+)?/video.mp4`,(req,res)=>{
    const s=req.params.season, e=req.params.episode;
    handlePlay(req,res,"rd",req.params.hash,(s!==undefined&&e!==undefined)?{ season:parseInt(s), episode:parseInt(e) }:{});
});

// ============ API pro konfigurační stránku ============
const TB_PLANS={ 0:"Free", 1:"Essential", 2:"Pro", 3:"Standard" };
app.post("/api/verify",express.json({ limit:"10kb" }),async(req,res)=>{
    const { rd, tb }=req.body||{};
    const [u,t]=await Promise.all([ rd?rdVerify(String(rd).trim()):null, tb?tbVerify(String(tb).trim()):null ]);
    res.json({
        rd: rd?(u?{ success:true, username:u.username, type:u.type, expiration:u.expiration }:{ success:false }):null,
        tb: tb?(t?{ success:true, plan:TB_PLANS[t.plan]??`plán ${t.plan}`, expires:t.premium_expires_at||null }:{ success:false }):null
    });
});

app.post("/api/skt-login",express.json({ limit:"10kb" }),async(req,res)=>{
    const { username, password }=req.body||{};
    if(!username||!password) return res.json({ success:false, error:"Zadej jméno a heslo" });
    try{
        const r=await sktLogin(String(username),String(password));
        if(r){ console.log("[SKT] ✅ Login OK"); return res.json({ success:true, uid:r.uid, pass:r.pass }); }
        console.log("[SKT] ❌ Login failed");
        res.json({ success:false, error:"Špatné jméno nebo heslo" });
    }catch(e){
        console.error("[SKT] Login error:",e.message);
        res.json({ success:false, error:"Chyba připojení k SKTorrent" });
    }
});

app.use((req,res)=>res.status(404).json({ error:"Not found" }));

if(require.main===module){
    app.listen(PORT,()=>console.log(`🚀 SKTorrent v${VERSION} http://localhost:${PORT}`));
}
module.exports = app;
