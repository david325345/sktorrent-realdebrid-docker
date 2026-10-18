// Nahrávání anonymního archivu hledání na GitHub (pro noční kontrolu parseru).
// Jednou za 48 h kdykoli od 3:00 (Europe/Prague) nahraje všechny záznamy od posledního nahrání
// jako jeden soubor <GH_ARCHIVE_DIR>/RRRR-MM-DD.jsonl.gz přes GitHub Contents API.
// Proměnné: GH_ARCHIVE_REPO (např. david325345/nimetodex-media), GH_ARCHIVE_TOKEN (fine-grained,
// Contents: Read and write jen pro ten repozitář), GH_ARCHIVE_DIR (výchozí sktorrent/hledani).
// Bez tokenu nebo repozitáře se nic nenahrává. Token se nikdy nezapisuje do logu.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const axios = require("axios");
const archive = require("./archive");

const REPO = (process.env.GH_ARCHIVE_REPO || "").trim();
const TOKEN = (process.env.GH_ARCHIVE_TOKEN || "").trim();
const DIR = (process.env.GH_ARCHIVE_DIR || "sktorrent/hledani").replace(/^\/+|\/+$/g, "");
const EVERY_MS = 48 * 3600 * 1000;
const START_HOUR = 3;                         // nejdřív ve 3:00 pražského času
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "gh-upload.json");

const enabled = !!(REPO && TOKEN && /^[\w.-]+\/[\w.-]+$/.test(REPO));
let running = false;

function readState(){
    try{ return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }catch(e){ return {}; }
}
function writeState(st){
    try{
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive:true });
        fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(st));
        fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
    }catch(e){ console.log(`⚠️ GitHub archiv: stav nejde uložit (${e.message})`); }
}

function pragueParts(d=new Date()){
    const f=new Intl.DateTimeFormat("en-CA",{ timeZone:"Europe/Prague", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", hourCycle:"h23" });
    const p=Object.fromEntries(f.formatToParts(d).map(x=>[x.type,x.value]));
    return { date:`${p.year}-${p.month}-${p.day}`, hour:parseInt(p.hour,10) };
}

// Záznamy archivu novější než `since` (ISO čas), seřazené podle souborů po dnech
function collect(since){
    const lines=[]; let last=since||"";
    for(const name of archive.listFiles()){
        if(since&&name.slice(0,10)<since.slice(0,10)) continue;     // celý den starší
        let text;
        try{ text=fs.readFileSync(path.join(archive.ARCHIVE_DIR,name),"utf8"); }catch(e){ continue; }
        for(const line of text.split("\n")){
            if(!line) continue;
            const m=line.match(/^\{"t":"([^"]+)"/);
            const t=m?m[1]:"";
            if(since&&t&&t<=since) continue;
            lines.push(line);
            if(t>last) last=t;
        }
    }
    return { lines, last };
}

const api=(url,opts={})=>axios({
    url:`https://api.github.com/repos/${REPO}/contents/${url}`,
    headers:{ Authorization:`Bearer ${TOKEN}`, Accept:"application/vnd.github+json", "User-Agent":"sktorrent-addon", "X-GitHub-Api-Version":"2022-11-28" },
    timeout:60000, maxBodyLength:Infinity, maxContentLength:Infinity, ...opts
});

async function putFile(file, buf, message){
    try{
        await api(file,{ method:"PUT", data:{ message, content:buf.toString("base64") } });
        return file;
    }catch(e){
        // Soubor s tímhle názvem už existuje (např. ruční nahrání týž den) → nový název s časem
        if(e.response&&(e.response.status===422||e.response.status===409)){
            const alt=file.replace(/\.jsonl\.gz$/,`_${new Date().toISOString().slice(11,16).replace(":","")}.jsonl.gz`);
            await api(alt,{ method:"PUT", data:{ message, content:buf.toString("base64") } });
            return alt;
        }
        throw e;
    }
}

/** Nahraje vše od posledního nahrání. force=true ignoruje 48h interval a hodinu. */
async function uploadNow({ force=false }={}){
    if(!enabled) return { ok:false, reason:"vypnuto (chybí GH_ARCHIVE_REPO nebo GH_ARCHIVE_TOKEN)" };
    if(running) return { ok:false, reason:"nahrávání už běží" };
    const st=readState();
    const now=Date.now();
    if(!force){
        if(st.lastUpload&&now-Date.parse(st.lastUpload)<EVERY_MS-3600*1000) return { ok:false, reason:"ještě neuběhlo 48 h" };
        if(pragueParts().hour<START_HOUR) return { ok:false, reason:"před 3:00" };
    }
    running=true;
    try{
        const { lines, last }=collect(st.lastRecord||"");
        if(!lines.length){
            writeState({ ...st, lastUpload:new Date(now).toISOString() });
            console.log("📤 GitHub archiv: nic nového k nahrání");
            return { ok:true, records:0 };
        }
        const buf=zlib.gzipSync(Buffer.from(lines.join("\n")+"\n"));
        const file=`${DIR}/${pragueParts().date}.jsonl.gz`;
        const saved=await putFile(file, buf, `SKTorrent historie hledání: ${lines.length} záznamů do ${last.slice(0,16)}`);
        writeState({ lastUpload:new Date(now).toISOString(), lastRecord:last, lastFile:saved });
        console.log(`📤 GitHub archiv: nahráno ${lines.length} záznamů (${Math.round(buf.length/1024)} kB) → ${REPO}/${saved}`);
        return { ok:true, records:lines.length, file:saved, bytes:buf.length };
    }catch(e){
        const s=e.response?.status;
        const reason=s?`GitHub odpověděl ${s}${s===401||s===403?" (zkontroluj token a jeho oprávnění)":s===404?" (repozitář nenalezen nebo token nemá přístup)":""}`:e.message;
        console.log(`⚠️ GitHub archiv: nahrání selhalo — ${reason}. Další pokus za hodinu.`);
        return { ok:false, reason };
    }finally{ running=false; }
}

function start(){
    if(!enabled) return;
    setTimeout(()=>uploadNow().catch(()=>{}), 60*1000).unref();
    setInterval(()=>uploadNow().catch(()=>{}), 3600*1000).unref();
}

function status(){
    if(!enabled) return "vypnuto (chybí GH_ARCHIVE_REPO / GH_ARCHIVE_TOKEN)";
    const st=readState();
    return `${REPO}/${DIR} každých 48 h od 3:00${st.lastUpload?` | naposledy ${st.lastUpload.slice(0,16).replace("T"," ")} UTC`:" | zatím nenahráno"}`;
}

module.exports = { uploadNow, start, status, collect };
