// TTL cache s omezenou velikostí + sloučení souběžných požadavků
class TTLCache {
    constructor({ ttl, max = 5000 }){ this.ttl=ttl; this.max=max; this.map=new Map(); }
    get(k){
        const e=this.map.get(k);
        if(!e) return undefined;
        if(Date.now()>e.exp){ this.map.delete(k); return undefined; }
        return e.v;
    }
    set(k,v,ttl=this.ttl){
        if(this.map.has(k)) this.map.delete(k);
        this.map.set(k,{v,exp:Date.now()+ttl});
        if(this.map.size>this.max){
            this.prune();
            while(this.map.size>this.max) this.map.delete(this.map.keys().next().value);
        }
        return v;
    }
    delete(k){ this.map.delete(k); }
    prune(){ const n=Date.now(); for(const [k,e] of this.map) if(n>e.exp) this.map.delete(k); }
    get size(){ return this.map.size; }
}

const caches=[];
function createCache(opts){ const c=new TTLCache(opts); caches.push(c); return c; }
setInterval(()=>caches.forEach(c=>c.prune()),10*60*1000).unref();

// Stejný klíč běžící souběžně = jeden požadavek (např. víc range requestů přehrávače na /play)
const inflight=new Map();
function once(key,fn){
    if(inflight.has(key)) return inflight.get(key);
    const p=Promise.resolve().then(fn).finally(()=>inflight.delete(key));
    inflight.set(key,p);
    return p;
}

// Trvalá cache na disku (JSON v DATA_DIR/cache) — přežije deploy i restart.
// Zápis se sdružuje (nejvýš 1× za 30 s, atomicky přes dočasný soubor) a provede se i při ukončení.
// Když složka není zapisovatelná, funguje jen v paměti.
const fs = require("fs");
const path = require("path");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const persistent = [];

class PersistentCache {
    constructor({ name, ttl, max = 50000 }){
        this.ttl=ttl; this.max=max; this.map=new Map(); this.dirty=false;
        this.file=path.join(DATA_DIR, "cache", `${name}.json`);
        this.enabled=true;
        try{
            fs.mkdirSync(path.dirname(this.file), { recursive:true });
            fs.accessSync(path.dirname(this.file), fs.constants.W_OK);
        }catch(e){ this.enabled=false; console.log(`⚠️ Cache ${name}: ${path.dirname(this.file)} není zapisovatelná — jen v paměti`); }
        if(this.enabled){
            try{
                const now=Date.now();
                for(const [k,e] of Object.entries(JSON.parse(fs.readFileSync(this.file,"utf8")))) if(e&&e.exp>now) this.map.set(k,e);
            }catch(e){ if(e.code!=="ENOENT") console.log(`⚠️ Cache ${name}: soubor nejde načíst (${e.message}) — začínám prázdná`); }
        }
        persistent.push(this);
    }
    get(k){
        const e=this.map.get(k);
        if(!e) return undefined;
        if(Date.now()>e.exp){ this.map.delete(k); this.dirty=true; return undefined; }
        return e.v;
    }
    set(k,v,ttl=this.ttl){
        if(this.map.has(k)) this.map.delete(k);
        this.map.set(k,{ v, exp:Date.now()+ttl });
        while(this.map.size>this.max) this.map.delete(this.map.keys().next().value);
        this.dirty=true;
        return v;
    }
    get size(){ return this.map.size; }
    save(){
        if(!this.enabled||!this.dirty) return;
        try{
            const tmp=`${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
            fs.renameSync(tmp, this.file);
            this.dirty=false;
        }catch(e){ console.log(`⚠️ Cache: zápis ${this.file} selhal (${e.message})`); }
    }
}
function createPersistentCache(opts){ return new PersistentCache(opts); }
setInterval(()=>persistent.forEach(c=>c.save()), 30*1000).unref();
for(const sig of ["SIGTERM","SIGINT"]){
    process.once(sig, ()=>process.exit(0));          // docker stop / redeploy → uloží se v „exit“
}
process.on("exit", ()=>persistent.forEach(c=>c.save()));

module.exports = { TTLCache, createCache, once, createPersistentCache };
