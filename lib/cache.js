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

module.exports = { TTLCache, createCache, once };
