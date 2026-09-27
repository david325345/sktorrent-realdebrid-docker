// Token v URL: "RDTOKEN--TMDBKEY--SKTUID--SKTPASS--SKTSEARCH--TBKEY"
// Všechny části kromě aspoň jednoho debrid klíče jsou volitelné.
// Šestá část (TorBox) je na konci, takže staré nainstalované URL fungují dál.
function parseToken(token){
    const p=String(token||"").split("--");
    return {
        rdToken: (p[0]||"").trim(),
        tmdbKey: (p[1]||"").trim(),
        sktUid:  (p[2]||"").trim(),
        sktPass: (p[3]||"").trim(),
        sktSearch: p[4]==="1",
        tbKey:   (p[5]||"").trim()
    };
}

module.exports = { parseToken };
