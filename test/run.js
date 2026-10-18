// Spustí všechny testy (každý v samostatném procesu s vlastní dočasnou složkou dat).
// Použití: npm test   (nebo node test/run.js)
const { spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const root = path.join(__dirname, "..");
const tests = fs.readdirSync(__dirname).filter(f => f.endsWith(".test.js")).sort();
let failed = 0;
for (const t of tests) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skt-test-"));
    const env = { ...process.env, DATA_DIR: tmp, ARCHIVE: t === "gh.test.js" ? "1" : "0", ARCHIVE_DIR: path.join(tmp, "hledani"),
                  ADMIN_KEY: "testkey", GH_ARCHIVE_REPO: t === "gh.test.js" ? "test/repo" : "", GH_ARCHIVE_TOKEN: t === "gh.test.js" ? "ghp_TEST_TOKEN" : "" };
    const r = spawnSync(process.execPath, [path.join(__dirname, t), root], { env, encoding: "utf8", timeout: 120000 });
    const out = (r.stdout || "") + (r.stderr || "");
    const ok = r.status === 0 && /VŠE OK/.test(out);
    if (!ok) failed++;
    console.log(`${ok ? "✔" : "✘"} ${t}`);
    if (!ok || process.env.VERBOSE) console.log(out.split("\n").filter(l => /FAIL|Error|error/.test(l) || process.env.VERBOSE).slice(0, 40).join("\n"));
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} testů selhalo` : `\nVšech ${tests.length} testů prošlo`);
process.exit(failed ? 1 : 0);
