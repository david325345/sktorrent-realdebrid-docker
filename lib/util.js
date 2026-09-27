// Obecné pomocné funkce
const crypto = require("crypto");

const langToFlag = { CZ:"🇨🇿",SK:"🇸🇰",EN:"🇬🇧",US:"🇺🇸",DE:"🇩🇪",FR:"🇫🇷",IT:"🇮🇹",ES:"🇪🇸",RU:"🇷🇺",PL:"🇵🇱",HU:"🇭🇺",JP:"🇯🇵" };
const VIDEO_EXT = [".mkv",".mp4",".avi",".mov",".wmv",".flv",".webm",".ts",".m4v"];

function removeDiacritics(s){ return String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,""); }
function isVideo(p){ const f=String(p||"").toLowerCase(); return VIDEO_EXT.some(e=>f.endsWith(e)); }
function isSample(p){ return /(^|[\/._\-\s\[(])sample([\/._\-\s\])]|$)/i.test(String(p||"")); }
function basename(p){ return String(p||"").split(/[\\/]/).pop(); }
const delay = (ms)=>new Promise(r=>setTimeout(r,ms));
const isHash = (h)=>/^[a-f0-9]{40}$/i.test(String(h||""));

// Krátký otisk klíče pro cache klíče a logy (klíče samotné se nikam nelogují)
function keyId(s){ return s ? crypto.createHash("sha256").update(String(s)).digest("hex").slice(0,16) : "none"; }

function flagsFromName(name){
    const flags=(String(name||"").match(/\b([A-Z]{2})\b/g)||[]).map(c=>langToFlag[c]).filter(Boolean);
    return [...new Set(flags)].join("/");
}

function cleanTorrentName(t){
    let c=String(t.name||"").replace(/^Stiahni si\s*/i,"").trim();
    if(t.cat&&c.startsWith(t.cat)) c=c.slice(t.cat.length).trim();
    return c;
}

function formatBytes(b){
    if(!b||b<=0) return "";
    if(b>=1073741824) return `${(b/1073741824).toFixed(2)} GB`;
    return `${Math.round(b/1048576)} MB`;
}

// Veřejná adresa addonu (za reverzní proxy; vyžaduje app.set("trust proxy", true))
function baseUrl(req){
    if(process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/,"");
    const host=String(req.get("x-forwarded-host")||req.get("host")||"").split(",")[0].trim();
    return `${req.protocol}://${host}`;
}

// SKT hledá všechna slova dotazu (AND, podřetězce) a ignoruje diakritiku → interpunkci pryč
function normalizeQuery(q){
    return String(q||"").replace(/[:;,!?\/\\()\[\]{}"'’`&+*=<>|#@$%^~.–—-]/g," ").replace(/\s+/g," ").trim();
}

function errMsg(e){
    const d=e?.response?.data;
    if(d&&typeof d==="object") return d.detail||d.error||d.message||e.message;
    return e?.message||String(e);
}

module.exports = { langToFlag, VIDEO_EXT, removeDiacritics, isVideo, isSample, basename, delay, isHash, keyId, flagsFromName, cleanTorrentName, formatBytes, baseUrl, errMsg, normalizeQuery };
