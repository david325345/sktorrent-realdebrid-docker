// Analýza anonymního archivu hledání → Markdown report (pro noční kontrolu i ruční použití).
// Použití: node tools/analyza.js [--since RRRR-MM-DD] [--out report.md] soubor.jsonl[.gz] | složka …
// Nic nemění — jen čte záznamy a hledá podezřelá místa v parseru a hledání.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function readRecords(inputs, since=""){
    const files=[];
    for(const p of inputs){
        if(fs.statSync(p).isDirectory()) for(const f of fs.readdirSync(p).sort()) { if(/\.jsonl(\.gz)?$/.test(f)) files.push(path.join(p,f)); }
        else files.push(p);
    }
    const recs=[]; const seen=new Set();
    for(const f of files){
        let buf=fs.readFileSync(f);
        if(f.endsWith(".gz")) buf=zlib.gunzipSync(buf);
        for(const line of buf.toString("utf8").split("\n")){
            if(!line.trim()||seen.has(line)) continue;      // stejný záznam ve více souborech jen jednou
            seen.add(line);
            try{ const r=JSON.parse(line); if(!since||String(r.t||"")>=since) recs.push(r); }catch(e){}
        }
    }
    return recs.sort((a,b)=>String(a.t).localeCompare(String(b.t)));
}

const norm=s=>String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const clean=n=>String(n||"").replace(/^Stiahni si /,"").replace(/ = CSFD \d+%$/,"");
const stripCat=t=>{ let n=clean(t.n).trim(); if(t.cat&&n.startsWith(t.cat)) n=n.slice(t.cat.length); return n.trim(); };
const esc=s=>String(s).replace(/\|/g,"\\|").replace(/\n/g," ");
const quant=(a,q)=>{ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); return s[Math.min(s.length-1,Math.floor(q*s.length))]; };
const titleOf=r=>{ const t=r.titles||{}; return [t.cz,t.en].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i).join(" / ")||"?"; };
const what=r=>`${titleOf(r)} (${r.id}${r.type==="movie"&&r.year?`, ${r.year}`:""})`;
const LIMIT=40;

function analyze(recs){
    const { replay, makeJudge }=require("./replay");
    const streams=recs.filter(r=>r.kind==="stream");
    const plays=recs.filter(r=>r.kind==="play");
    const catalogs=recs.filter(r=>r.kind==="catalog");
    const L=[];
    const from=recs[0]?.t?.slice(0,16).replace("T"," "), to=recs.at(-1)?.t?.slice(0,16).replace("T"," ");
    const ms=streams.map(r=>r.ms).filter(Number.isFinite);
    const withRes=streams.filter(r=>(r.torrents||[]).some(t=>t.ok));
    L.push(`## Přehled`, ``,
        `- Období: ${from||"-"} – ${to||"-"} UTC`,
        `- Hledání: ${streams.length} (filmy ${streams.filter(r=>r.type==="movie").length}, epizody ${streams.filter(r=>r.type==="series").length}), s výsledkem ${withRes.length}, bez výsledku ${streams.length-withRes.length}`,
        `- Přehrání: ${plays.length} (chyb ${plays.filter(p=>p.status==="error").length}), katalog: ${catalogs.length}`,
        `- Doba hledání: medián ${quant(ms,0.5)} ms, p90 ${quant(ms,0.9)} ms, max ${ms.length?Math.max(...ms):0} ms`, ``);

    // 1) Bez výsledku — seskupeno podle titulu/epizody; zvlášť „SKT nic nevrátilo“ a „vše odmítnuto“
    const none=streams.filter(r=>!(r.torrents||[]).some(t=>t.ok));
    const groups=new Map();
    for(const r of none){ const g=groups.get(r.id)||{ r, n:0, raw:0 }; g.n++; g.r=r; g.raw=Math.max(g.raw,(r.torrents||[]).length); groups.set(r.id,g); }
    const rejected=[...groups.values()].filter(g=>g.raw>0), empty=[...groups.values()].filter(g=>g.raw===0);
    L.push(`## Hledání bez výsledku (${none.length} hledání, ${groups.size} titulů)`, ``);
    L.push(`### SKT něco vrátilo, ale vše bylo odmítnuto (${rejected.length}) — nejdůležitější ke kontrole`, ``);
    if(!rejected.length) L.push(`Žádné.`, ``);
    else{
        L.push(`| Titul | Hledáno × | Dotazy | Odmítnuto | Důvody |`, `|---|---|---|---|---|`);
        for(const { r, n, raw } of rejected.slice(0,LIMIT)){
            const q=(r.queries||[]).map(x=>`${x.q}${x.p?` p${x.p}`:""}→${x.n}`).join(", ");
            const reasons={}; for(const t of r.torrents||[]) reasons[t.r]=(reasons[t.r]||0)+1;
            L.push(`| ${esc(what(r))} | ${n} | ${esc(q)} | ${raw} | ${esc(Object.entries(reasons).map(([k,v])=>`${k} ×${v}`).join(", "))} |`);
        }
        L.push(``);
    }
    L.push(`### SKT nevrátilo nic (${empty.length}) — titul tam nejspíš není`, ``);
    if(!empty.length) L.push(`Žádné.`, ``);
    else{
        for(const { r, n } of empty.slice(0,LIMIT)) L.push(`- ${esc(what(r))}${n>1?` ×${n}`:""} — dotazy: ${esc((r.queries||[]).map(x=>x.q).filter((x,i,a)=>a.indexOf(x)===i).join(", ")||r.note||"-")}`);
        if(empty.length>LIMIT) L.push(`- … a dalších ${empty.length-LIMIT}`);
        L.push(``);
    }

    // 2) Odmítnuté kvůli názvu, i když jejich CZ/EN část začíná hledaným názvem — seskupeno podle titulu torrentu
    const M=require("../lib/matching");
    const susp=new Map();     // "hledané id" → Map(název torrentu → { n, r, ex })
    let suspN=0;
    for(const r of streams){
        const names=[r.titles?.en,r.titles?.cz,r.titles?.sk].filter(Boolean).map(norm).filter(n=>n.length>=3);
        const key=titleOf(r);
        let judge=null; try{ judge=makeJudge(r); }catch(e){}
        for(const t of r.torrents||[]){
            if(t.ok||!/^název nesedí|^nesedí sezóna/.test(t.r||"")) continue;
            if(judge&&judge(t).ok) continue;            // aktuální logika už ho přijímá (viz změny verdiktu níž)
            const parts=stripCat(t).split(/\s\/\s|\|/);
            const hit=parts.find(p=>{ const n2=norm(p); return names.some(n=>n2===n||n2.startsWith(n+" ")); });
            if(!hit) continue;
            const stem=(M.titleSegment(hit,"",new Set())||hit).replace(/\s+/g," ").trim().slice(0,70);
            if(!susp.has(key)) susp.set(key,new Map());
            const g=susp.get(key); const e=g.get(stem)||{ n:0, r:t.r, ex:clean(t.n) }; e.n++; g.set(stem,e); suspN++;
        }
    }
    L.push(`## Odmítnuté kvůli názvu, přestože začínají hledaným názvem (${suspN} torrentů)`, ``,
        `Kandidáti na příliš přísný filtr (i podle aktuální logiky), seskupeno podle titulu torrentu. Většinou správně jiný titul (např. „House of the Dragon“ u „House“) — podezřelé je, když je titul torrentu prakticky stejný jako hledaný.`, ``);
    if(susp.size){
        L.push(`| Hledáno | Titul torrentu | Počet | Příklad |`, `|---|---|---|---|`);
        let rows=0;
        for(const [key,g] of susp){
            for(const [stem,e] of [...g].sort((x,y)=>y[1].n-x[1].n)){
                if(rows++>=LIMIT*2) break;
                L.push(`| ${esc(key)} | ${esc(stem)} | ${e.n} | ${esc(e.ex.slice(0,100))} |`);
            }
        }
        L.push(``);
    }

    // 3) Přijaté torrenty, kde náš název není celý (podezření na příliš volný filtr)
    const loose=[]; const seenL=new Set();
    for(const r of streams){
        const names=[r.titles?.en,r.titles?.cz,r.titles?.sk].filter(Boolean).map(norm).filter(Boolean);
        for(const t of r.torrents||[]){
            if(!t.ok) continue;
            const nn=` ${norm(clean(t.n))} `;
            const key=`${r.id}|${t.h}`;
            if(!names.some(n=>nn.includes(` ${n} `))&&!seenL.has(key)){ seenL.add(key); loose.push({ r, t }); }
        }
    }
    L.push(`## Přijaté jen částečnou shodou názvu (${loose.length})`, ``,
        `Kandidáti na příliš volný filtr (krátký název, kolekce, název bez čísla dílu…).`, ``);
    if(loose.length){
        L.push(`| Hledáno | Verdikt | Torrent |`, `|---|---|---|`);
        for(const { r, t } of loose.slice(0,LIMIT)) L.push(`| ${esc(what(r))} | ${esc(t.r)} | ${esc(clean(t.n).slice(0,120))} |`);
        if(loose.length>LIMIT) L.push(``, `… a dalších ${loose.length-LIMIT}.`);
        L.push(``);
    }

    // 4) Chyby přehrání a výběr souboru
    const bad=plays.filter(p=>p.status==="error");
    L.push(`## Chyby přehrání (${bad.length})`, ``);
    if(!bad.length) L.push(`Žádné.`, ``);
    for(const p of bad.slice(0,LIMIT)){
        const s=p.sel||{};
        L.push(`- **${esc(clean(p.n||p.h))}** (${p.prov}, ${s.fileId!==undefined?`file ${s.fileId}`:s.pack?`kolekce ${s.title} ${s.year||""}`:`S${s.season??"-"}E${s.episode??"-"}`}) — ${esc(p.r||"?")}`);
        for(const v of (p.videos||[]).slice(0,15)) L.push(`  - \`${esc(typeof v==="string"?v:v.name||JSON.stringify(v))}\``);
    }
    if(bad.length) L.push(``);
    const okPlays=plays.filter(p=>p.status==="ready"&&p.file);
    if(okPlays.length){
        L.push(`### Úspěšná přehrání (kontrola výběru souboru)`, ``);
        for(const p of okPlays.slice(0,LIMIT)){
            const s=p.sel||{};
            L.push(`- ${s.season!==undefined?`S${s.season}E${s.episode}`:s.pack?`${s.title} ${s.year||""}`:"film"} ← \`${esc(p.file.split("/").pop())}\` z ${esc(clean(p.n||p.h).slice(0,80))}`);
        }
        L.push(``);
    }

    // 5) Pomalá hledání
    const slow=streams.filter(r=>r.ms>4000).sort((a,b)=>b.ms-a.ms);
    L.push(`## Pomalá hledání > 4 s (${slow.length})`, ``);
    if(!slow.length) L.push(`Žádná.`, ``);
    else{
        L.push(`| Titul | ms | Dotazů |`, `|---|---|---|`);
        for(const r of slow.slice(0,20)) L.push(`| ${esc(what(r))} | ${r.ms} | ${(r.queries||[]).length} |`);
        L.push(``);
    }

    // 6) Přehrání aktuální logikou
    let ch=[]; let err="";
    try{ ch=replay(streams); }catch(e){ err=e.message; }
    L.push(`## Změny verdiktu s aktuální logikou (${err?"chyba":ch.length})`, ``,
        `Rozdíl mezi tím, co addon tehdy rozhodl, a tím, co by rozhodl kód v repozitáři teď.`, ``);
    if(err) L.push(`Přehrání selhalo: ${esc(err)}`, ``);
    else if(!ch.length) L.push(`Žádné.`, ``);
    else{
        const cur=require("../package.json").version;
        const same=ch.filter(c=>c.rec.v===cur).length;
        if(same) L.push(`⚠️ ${same} změn u záznamů z aktuální verze ${cur} — logika v repozitáři se liší od nasazené, nebo je nedeterministická.`, ``);
        const seen=new Set(); const uniq=ch.filter(({ rec, t })=>{ const k=`${rec.id}|${t.h}`; if(seen.has(k)) return false; seen.add(k); return true; });
        L.push(`| Hledáno | Verze | Změna | Nový důvod | Torrent |`, `|---|---|---|---|---|`);
        for(const { rec, t, now } of uniq.slice(0,LIMIT)) L.push(`| ${esc(what(rec))} | ${rec.v||"≤3.4"} | ${t.ok?"✔→✘":"✘→✔"} | ${esc(now.r)} | ${esc(clean(t.n).slice(0,110))} |`);
        if(uniq.length>LIMIT) L.push(``, `… a dalších ${uniq.length-LIMIT}.`);
        L.push(``);
    }
    return { markdown:L.join("\n"), counts:{ streams:streams.length, none:none.length, noneRejected:rejected.length, susp:suspN, loose:loose.length, playErrors:bad.length, slow:slow.length, replay:ch.length } };
}

module.exports = { readRecords, analyze };

if(require.main===module){
    const args=process.argv.slice(2); let since="", out="", title="";
    const inputs=[];
    for(let i=0;i<args.length;i++){
        if(args[i]==="--since") since=args[++i];
        else if(args[i]==="--out") out=args[++i];
        else if(args[i]==="--title") title=args[++i];
        else inputs.push(args[i]);
    }
    if(!inputs.length){ console.error("Použití: node tools/analyza.js [--since RRRR-MM-DD] [--out report.md] [--title text] soubory|složky"); process.exit(2); }
    const recs=readRecords(inputs,since);
    const { markdown }=analyze(recs);
    const md=`# ${title||"SKTorrent — analýza hledání"}\n\n${markdown}\n`;
    if(out) fs.writeFileSync(out,md); else process.stdout.write(md);
}
