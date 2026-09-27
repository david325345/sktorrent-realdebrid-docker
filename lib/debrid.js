// Společné rozhraní debrid služeb
const rd = require("./rd");
const tb = require("./tb");

const PROVIDERS = {
    rd: { id:"rd", short:"RD", label:"Real-Debrid", key:(cfg)=>cfg.rdToken, resolve:rd.resolve, listFiles:(k,h)=>rd.listFiles(k,h) },
    tb: { id:"tb", short:"TB", label:"TorBox",      key:(cfg)=>cfg.tbKey,   resolve:tb.resolve, listFiles:(k,h,o)=>tb.listFiles(k,h,o) }
};

// Pořadí ve výpisu: RD, pak TB. Když má uživatel oba klíče, každý torrent je ve výpisu 2×.
function activeProviders(cfg){
    return Object.values(PROVIDERS).filter(p=>p.key(cfg));
}

module.exports = { PROVIDERS, activeProviders, checkCachedTB: tb.checkCached, rdVerify: rd.rdVerify, tbVerify: tb.tbVerify };
