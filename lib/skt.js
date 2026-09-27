// sktorrent.eu — hledání a přihlášení
const axios = require("axios");
const cheerio = require("cheerio");
const { createCache, once } = require("./cache");
const { keyId, normalizeQuery } = require("./util");

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;
const UA = "Mozilla/5.0";
// Nevideo kategorie — vyřazují se vždy (i v přímém hledání)
const excludedCats = /xXx|Knihy|Časopis|Ostatní|Game hall|Audio.*video|Soft.*app|Externe|Hry na|VR Hry|Hudba|Hudební|Mluven|Soundtrack|Programy|Mobil|Neschválen/i;

const queryCache = createCache({ ttl: 15*60*1000, max: 3000 });   // výsledky hledání
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
    return results.filter(t=>!excludedCats.test(t.cat));
}

// Nejvyšší číslo stránky v odkazech stránkování (SKT čísluje od 0)
function maxPage(html){
    let max=0;
    for(const m of String(html).matchAll(/[?&](?:amp;)?page=(\d+)/g)) max=Math.max(max,parseInt(m[1]));
    return max;
}

/** Jedna stránka výsledků (SKT řadí od nejnovějších). Vrací { items, hasMore } */
async function searchSKTPage(query, uid, pass, page=0){
    query=normalizeQuery(query);
    const empty={ items:[], hasMore:false };
    if(!query) return empty;
    const acct=accountKey(uid,pass);
    const ck=`${acct}|${query.toLowerCase()}|${page}`;
    const label=`"${query}"${page?` str. ${page+1}`:""}`;
    const cached=queryCache.get(ck);
    if(cached){ console.log(`[SKT] 💾 ${label} (${cached.items.length})`); return cached; }
    if(isPaused(uid,pass)){ console.log(`[SKT] ⏸️ Pauza po 403, přeskakuji ${label}`); return empty; }

    return once(`skt:${ck}`, async()=>{
        console.log(`[SKT] 🔎 ${label}`);
        try{
            const headers={ "User-Agent":UA };
            if(uid&&pass) headers.Cookie=`uid=${uid}; pass=${pass}`;
            const params={ search:query, category:0, active:0 };
            if(page>0) params.page=page;
            const r=await axios.get(SEARCH_URL,{ params, headers, timeout:10000 });
            const items=parseResults(r.data);
            const res={ items, hasMore:maxPage(r.data)>page };
            items.forEach(t=>torrentCache.set(t.hash,t));
            queryCache.set(ck,res);
            console.log(`[SKT] Nalezeno: ${items.length}${res.hasMore?" (další stránky existují)":""}`);
            return res;
        }catch(e){
            if(e.response?.status===403){
                console.error(`[SKT] ⛔ 403 — pauza 60 s (${acct==="anon"?"anonymní":"účet"})`);
                pausedUntil.set(acct,Date.now()+60000);
            }else console.error("[SKT]",e.message);
            return empty;
        }
    });
}

async function searchSKT(query, uid, pass){ return (await searchSKTPage(query,uid,pass,0)).items; }

function getCachedTorrent(hash){ return torrentCache.get(hash); }

async function sktLogin(username, password){
    const r=await axios.post(`${BASE_URL}/torrent/login.php`,
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

module.exports = { BASE_URL, searchSKT, searchSKTPage, normalizeQuery, isPaused, getCachedTorrent, sktLogin };
