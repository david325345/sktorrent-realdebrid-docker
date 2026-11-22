// SKTorrent + Real-Debrid / TorBox Stremio Addon v3.0
// TMDB pro CZ/SK názvy, OMDb jako záloha
const path = require("path");
const express = require("express");

const { parseToken } = require("./lib/config");
const { titleCacheSize } = require("./lib/meta");
const { sktLogin } = require("./lib/skt");
const { activeProviders, rdVerify, tbVerify } = require("./lib/debrid");
const { configPage } = require("./lib/html");
const archive = require("./lib/archive");
const ghupload = require("./lib/ghupload");
const { baseUrl } = require("./lib/util");
// Katalog, detail, streamy a přehrání (sdílené s pluginem pro Nuvio na Apple TV)
const { catalogFor, metaFor, streamsFor, playFor } = require("./lib/handlers");

const PORT = process.env.PORT || 3009;
const VERSION = "3.10.0";

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

// CORS pro všechny odpovědi (Stremio web)
app.use((req,res,next)=>{ res.setHeader("Access-Control-Allow-Origin","*"); res.setHeader("Access-Control-Allow-Headers","*"); next(); });
app.use("/static", express.static(path.join(__dirname,"public"), { maxAge:"7d" }));

const staticUrl = (req,file)=>`${baseUrl(req)}/static/${file}`;

app.get("/health",(req,res)=>res.json({ status:"ok", version:VERSION }));
archive.registerRoutes(app);   // /admin/hledani + /admin/hledani.jsonl.gz (jen s ADMIN_KEY)
// Ruční nahrání archivu na GitHub (jinak samo každých 48 h od 3:00)
app.get("/admin/github-upload",async(req,res)=>{
    if(!archive.adminOk(req)) return res.status(404).json({ error:"Not found" });
    res.json(await ghupload.uploadNow({ force:true }));
});
app.get(["/","/configure"],(req,res)=>res.type("html").send(configPage(null)));
app.get("/:token/configure",(req,res)=>res.type("html").send(configPage(parseToken(req.params.token))));

// ============ MANIFEST ============
app.get("/:token/manifest.json",(req,res)=>{
    const cfg=parseToken(req.params.token);
    const provs=activeProviders(cfg);
    const suffix=provs.length?provs.map(p=>p.short).join("+"):"RD";
    const catalogs=cfg.sktSearch?[{ type:"movie", id:"skt-search", name:"SKTorrent", extra:[{ name:"search", isRequired:true }] }]:[];
    // csfd: = tituly jen na ČSFD (katalog/metadata z csfd-ratings), streamy hledá tento addon
    const streamPrefixes=cfg.sktSearch?["tt","csfd:","skt"]:["tt","csfd:"];
    const resources=cfg.sktSearch?[
        { name:"stream", types:["movie","series"], idPrefixes:streamPrefixes },
        { name:"catalog", types:["movie"], idPrefixes:["skt"] },
        { name:"meta", types:["movie"], idPrefixes:["skt"] }
    ]:[
        { name:"stream", types:["movie","series"], idPrefixes:streamPrefixes }
    ];
    res.json({
        id:"org.stremio.sktorrent.rd",   // beze změny, ať není nutná reinstalace
        version:VERSION,
        name:`SKTorrent+${suffix}`,
        description:"CZ/SK torrenty ze sktorrent.eu přes Real-Debrid a/nebo TorBox",
        logo:staticUrl(req,"logo.png"),
        types:["movie","series"],
        idPrefixes:streamPrefixes,
        catalogs, resources,
        behaviorHints:{ configurable:true, configurationRequired:provs.length===0 }
    });
});

// ============ CATALOG (přímé hledání SKT) ============
app.get("/:token/catalog/:type/:id/:extra.json",async(req,res)=>{
    const m=String(req.params.extra||"").match(/(?:^|&)search=([^&]+)/);
    if(!m) return res.json({ metas:[] });
    let query;
    try{ query=decodeURIComponent(m[1]).trim(); }catch(e){ query=m[1]; }
    res.json(await catalogFor(query,parseToken(req.params.token),link(req)));
});

// ============ META (detail SKT torrentu) ============
app.get("/:token/meta/:type/:id.json",(req,res)=>res.json(metaFor(req.params.id)));

// ============ STREAM ============
const playUrl=(req,prov,hash,sel={})=>{
    const b=`${baseUrl(req)}/${req.params.token}/play/${prov}/${hash}`;
    if(sel.fileId!==undefined) return `${b}/f/${sel.fileId}/video.mp4`;
    if(sel.pack) return `${b}/m/${sel.year||0}/${sel.title||"x"}/video.mp4`;
    if(sel.season!==undefined) return `${b}/e/${sel.season}/${sel.episode}/video.mp4`;
    return `${b}/video.mp4`;
};

// Adresy pro obsluhu (lib/handlers.js): přehrání přes /play, informační videa z /static
const link=(req)=>({
    play:(prov,hash,sel)=>({ url:playUrl(req,prov,hash,sel) }),
    file:(name)=>({ url:staticUrl(req,name) }),
    fileUrl:(name)=>staticUrl(req,name)
});

app.get("/:token/stream/:type/:id.json",async(req,res)=>{
    res.json(await streamsFor(req.params.type,req.params.id,parseToken(req.params.token),link(req)));
});

// ============ PLAY ============
async function handlePlay(req,res,provId,hash,sel){
    const r=await playFor(parseToken(req.params.token),provId,hash,sel,{ archiveIt:req.method==="GET" });
    if(r.url) return res.redirect(302,r.url);
    if(r.file) return res.redirect(302,staticUrl(req,r.file));
    return res.status(r.status||502).type("text/plain").send(r.error);
}

const H="[a-fA-F0-9]{40}";
app.get(`/:token/play/:prov(rd|tb)/:hash(${H})/e/:season(\\d+)/:episode(\\d+)/video.mp4`,(req,res)=>
    handlePlay(req,res,req.params.prov,req.params.hash,{ season:parseInt(req.params.season), episode:parseInt(req.params.episode) }));
app.get(`/:token/play/:prov(rd|tb)/:hash(${H})/m/:year(\\d{1,4})/:title([a-z0-9-]{1,80})/video.mp4`,(req,res)=>
    handlePlay(req,res,req.params.prov,req.params.hash,{ pack:true, year:req.params.year!=="0"?req.params.year:"", title:req.params.title.replace(/-/g," ") }));
app.get(`/:token/play/:prov(rd|tb)/:hash(${H})/f/:fileId(\\d+)/video.mp4`,(req,res)=>
    handlePlay(req,res,req.params.prov,req.params.hash,{ fileId:parseInt(req.params.fileId) }));
app.get(`/:token/play/:prov(rd|tb)/:hash(${H})/video.mp4`,(req,res)=>
    handlePlay(req,res,req.params.prov,req.params.hash,{}));
// Starý formát URL (v2.x, jen RD) — kvůli rozkoukaným položkám v knihovně Stremia
app.get(`/:token/play/:hash(${H})/:season(\\d+)?/:episode(\\d+)?/video.mp4`,(req,res)=>{
    const s=req.params.season, e=req.params.episode;
    handlePlay(req,res,"rd",req.params.hash,(s!==undefined&&e!==undefined)?{ season:parseInt(s), episode:parseInt(e) }:{});
});

// ============ Archiv hledání z pluginu pro Nuvio ============
// Plugin na Apple TV (volba „Pomoct vylepšit hledání“, výchozí vypnutá) posílá anonymní záznam stejného
// tvaru jako tento addon. Uloží se jen známá pole s časem serveru a via:"nuvio" — nic o uživateli ani IP.
const archiveHits=new Map();   // IP → [časy] za poslední hodinu (300 záznamů / h)
const REC_KEYS=new Set(["kind","v","type","id","year","seasonYear","seasonAfter","titles","names","queries","ms","sktDown","queuedMs",
    "providers","logged","streams","torrents","note","q","count","prov","h","n","sel","status","file","r","call","plan","progress","state","since","videos"]);
const TORRENT_KEYS=["n","cat","s","seeds","h","ok","r","csfd","sent","pack","tb"];
app.post("/api/archive",express.json({ limit:"512kb" }),(req,res)=>{
    const ip=req.ip||"x", now=Date.now();
    const hits=(archiveHits.get(ip)||[]).filter(t=>now-t<3600*1000);
    if(hits.length>=300) return res.status(429).json({ ok:false });
    hits.push(now); archiveHits.set(ip,hits);
    if(archiveHits.size>5000) archiveHits.clear();
    const rec=req.body&&req.body.record;
    if(!rec||typeof rec!=="object"||!["stream","catalog","play"].includes(rec.kind)) return res.status(400).json({ ok:false });
    if(rec.torrents!==undefined&&(!Array.isArray(rec.torrents)||rec.torrents.length>500)) return res.status(400).json({ ok:false });
    const clean={ via:"nuvio" };
    for(const [k,v] of Object.entries(rec)) if(REC_KEYS.has(k)) clean[k]=v;
    if(Array.isArray(rec.torrents)) clean.torrents=rec.torrents.filter(t=>t&&typeof t==="object"&&typeof t.n==="string")
        .map(t=>Object.fromEntries(TORRENT_KEYS.filter(k=>t[k]!==undefined).map(k=>[k,t[k]])));
    archive.write(clean);
    res.json({ ok:true });
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
    app.listen(PORT,()=>{
        console.log(`🚀 SKTorrent v${VERSION} http://localhost:${PORT}`);
        console.log(`📝 Archiv hledání: ${archive.status()}`);
        console.log(`🎬 TMDB cache: ${titleCacheSize()} titulů (data/cache/tmdb.json)`);
        console.log(`📤 GitHub archiv: ${ghupload.status()}`);
        ghupload.start();
    });
}
module.exports = app;
