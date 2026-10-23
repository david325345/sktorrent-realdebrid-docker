// Pořadí a popisky streamů (bez závislosti na Express — kvůli testům)

// Torrent mimo cache s 0 seedery na SKT — stažení je nepravděpodobné (počet seedů ze SKT bývá nepřesný,
// proto jen varování a řazení na konec, ne vyřazení). cached: true = v cache, false = ne, null/undefined = neznámo.
const isDead=(t,cached)=>Number(t?.seeds)===0&&cached!==true;

/** picked: [{ t, isBatch }] → nejdřív epizody, pak balíky; v rámci nich napřed z cache TorBoxu; mrtvé (0 seedů) na konec */
function orderPicked(picked, cachedSet){
    const cached=(x)=>cachedSet?cachedSet.has(x.t.hash):null;
    const rank=(x)=>(isDead(x.t,cached(x))?4:0)+(x.isBatch?2:0)+(cachedSet&&!cachedSet.has(x.t.hash)?1:0);
    return picked.map((x,i)=>({ ...x, i })).sort((a,b)=>rank(a)-rank(b)||a.i-b.i).map(({ i, ...x })=>x);
}

function ageText(since, now=Date.now()){
    const t=Date.parse(since||"");
    if(!Number.isFinite(t)||t>now) return "";
    const h=(now-t)/3600000;
    return h<1?`${Math.max(1,Math.round(h*60))} min`:h<48?`${Math.round(h)} h`:`${Math.round(h/24)} dní`;
}

// Torrent ve stahování déle než 3 h s průběhem do 5 % = stahování stojí
const STALL_MS=3*3600*1000;
function isStalled(st, now=Date.now()){
    if(!st||st.ready||st.failed) return false;
    if(/stalled|no seeds|dead/i.test(String(st.state||""))) return true;
    const t=Date.parse(st.since||"");
    return Number.isFinite(t)&&now-t>=STALL_MS&&(st.progress||0)<=5;
}

/** Řádek do popisu streamu pro torrent, který už je v účtu služby a ještě není stažený ("" = nic) */
function accountNote(st, label, now=Date.now()){
    if(!st||st.ready) return "";
    if(st.failed) return `❌ V účtu ${label}: ${st.state||"chyba"}`;
    const age=ageText(st.since,now);
    const base=`🕐 V účtu ${label}: ${st.state||"stahuje se"} ${st.progress||0} %${age?` (${age})`:""}`;
    return isStalled(st,now)?`⚠️ Stahování stojí — ${base.slice(2).trim()}`:base;
}

module.exports = { isDead, orderPicked, ageText, isStalled, accountNote };
