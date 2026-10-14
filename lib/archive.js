// Anonymní archiv hledání a přehrání — slouží k hromadné opravě parseru.
// Každý záznam = 1 řádek JSON v ARCHIVE_DIR/RRRR-MM-DD.jsonl.
// NEUKLÁDÁ se nic o uživateli: žádné RD/TorBox klíče, SKT jméno/cookies, token z URL ani IP.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, "..", "data", "hledani");
const ARCHIVE_DAYS = parseInt(process.env.ARCHIVE_DAYS || "30", 10) || 30;
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const DAY = 24 * 3600 * 1000;
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

let enabled = !/^(0|false|no|off)$/i.test(process.env.ARCHIVE || "");
if (enabled) {
    try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); fs.accessSync(ARCHIVE_DIR, fs.constants.W_OK); }
    catch (e) { enabled = false; console.log(`⚠️ Archiv hledání vypnutý — ${ARCHIVE_DIR} není zapisovatelný (${e.message})`); }
}

function write(rec) {
    if (!enabled) return;
    rec = { t: new Date().toISOString(), ...rec };
    const file = path.join(ARCHIVE_DIR, `${rec.t.slice(0, 10)}.jsonl`);
    fs.appendFile(file, JSON.stringify(rec) + "\n", (err) => {
        if (err && enabled) { enabled = false; console.log(`⚠️ Archiv hledání vypnutý — zápis selhal (${err.message})`); }
    });
}

// Smaže dny starší než ARCHIVE_DAYS (při startu a pak jednou denně)
function cleanup() {
    if (!enabled) return;
    const limit = new Date(Date.now() - ARCHIVE_DAYS * DAY).toISOString().slice(0, 10);
    fs.readdir(ARCHIVE_DIR, (err, names) => {
        if (err) return;
        names.filter((n) => FILE_RE.test(n) && n.slice(0, 10) < limit)
            .forEach((n) => fs.unlink(path.join(ARCHIVE_DIR, n), () => {}));
    });
}
cleanup();
setInterval(cleanup, DAY).unref();

function listFiles(days) {
    try {
        const names = fs.readdirSync(ARCHIVE_DIR).filter((n) => FILE_RE.test(n)).sort();
        return days ? names.slice(-days) : names;
    } catch (e) { return []; }
}

function adminOk(req) {
    const k = String(req.query.key || "");
    return !!ADMIN_KEY && k.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));
}

// /admin/hledani?key=…            → přehled souborů
// /admin/hledani.jsonl.gz?key=…&dni=N → stažení (N posledních dní, bez dni = vše)
// Bez ADMIN_KEY jsou obě adresy vypnuté (404).
function registerRoutes(app) {
    app.get("/admin/hledani", (req, res) => {
        if (!adminOk(req)) return res.status(404).json({ error: "Not found" });
        const soubory = listFiles().map((n) => ({ den: n.slice(0, 10), velikost: fs.statSync(path.join(ARCHIVE_DIR, n)).size }));
        res.json({ zapnuto: enabled, adresar: ARCHIVE_DIR, uchovavani_dni: ARCHIVE_DAYS, soubory });
    });
    app.get("/admin/hledani.jsonl.gz", (req, res) => {
        if (!adminOk(req)) return res.status(404).json({ error: "Not found" });
        const names = listFiles(parseInt(req.query.dni, 10) || 0);
        res.setHeader("Content-Type", "application/gzip");
        res.setHeader("Content-Disposition", `attachment; filename="skt-hledani-${new Date().toISOString().slice(0, 10)}.jsonl.gz"`);
        const gz = zlib.createGzip();
        gz.pipe(res);
        (function next(i) {
            if (i >= names.length) return gz.end();
            const rs = fs.createReadStream(path.join(ARCHIVE_DIR, names[i]));
            rs.on("error", () => next(i + 1));
            rs.on("end", () => next(i + 1));
            rs.pipe(gz, { end: false });
        })(0);
    });
}

function status() {
    return enabled ? `${ARCHIVE_DIR} (${ARCHIVE_DAYS} dní)${ADMIN_KEY ? "" : " — ⚠️ chybí ADMIN_KEY, stažení vypnuté"}` : "vypnutý";
}

module.exports = { write, registerRoutes, status };
