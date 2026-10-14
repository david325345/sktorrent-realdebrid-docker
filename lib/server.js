'use strict';

const express = require('express');
const axios = require('axios');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { ZipArchive } = require('archiver');

const auth = require('./lib/auth');
const r2 = require('./lib/r2');
const { TitulkyClient } = require('./lib/titulkyClient');
const finder = require('./lib/finder');
const match = require('./lib/matching');
const conv = require('./lib/convert');
const { detectProfile, noteManifest, listSeen, PROFILES } = require('./lib/clientDetect');
const pages = require('./lib/pages');
const premium = require('./lib/premium');
const catalog = require('./lib/catalog');
const settings = require('./lib/settings');

// Zdroj titulků: premium.titulky.com (hledání podle IMDb, jen pro VIP) nebo původní www (classic)
const MODE = process.env.TITULKY_MODE === 'classic' ? 'classic' : 'premium';

// Dashboard + vlastní (nahrané) titulky + admin záloha: zakonzervováno, zapnutí DASHBOARD=1
const DASHBOARD = process.env.DASHBOARD === '1';

auth.init();
r2.loadCacheIndex();

const app = express();
const PORT = process.env.PORT || 3007;
const MAX_RESULTS = 20;
const VERSION = '2.1.0';

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Async routy: chyba → error handler (Express 4 to sám neumí)
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Validace ─────────────────────────────────────────────────────

const RE_VIDEO_ID = /^tt\d{5,10}(?::\d{1,4}:\d{1,5})?$/;          // ID od Stremia
const RE_CUSTOM_ID = /^tt\d{5,10}(?:-\d{1,4}-\d{1,5})?$/;         // ID složky vlastních titulků
const RE_SAFE_FILE = /^[A-Za-z0-9._-]{1,140}$/;
const RE_SUB_ID = /^\d{1,10}$/;
const RE_EP = /^(0|S\d{2}E\d{2,3})$/;

function parseVideoId(type, id) {
  if (!RE_VIDEO_ID.test(id)) return null;
  const [imdbId, s, e] = id.split(':');
  if (type === 'series') {
    return { imdbId, season: s ? parseInt(s, 10) : 1, episode: e ? parseInt(e, 10) : 1 };
  }
  return { imdbId, season: null, episode: null };
}

// ── Logování bez hesel a configů ─────────────────────────────────

// Pozn.: zástupné texty v [hranatých] závorkách – Coolify zobrazuje log jako HTML a <…> by zmizelo
function redactPath(p) {
  return p.replace(/\/v2[A-Za-z0-9_-]{20,}/g, '/[config]').replace(/^\/[A-Za-z0-9_=-]{60,}(?=\/)/, '/[starý-config]');
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Podrobný log požadavků z přehrávačů (manifest, titulky, stažení).
// LOG_REQUESTS=basic → jen jeden řádek na požadavek.
const LOG_FULL = process.env.LOG_REQUESTS !== 'basic';
const HIDDEN_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);
const PLAYER_PATH = /(\/manifest\.json$|\/subtitles\/|^\/sub\/)/;
// Hlavičky, podle kterých jde poznat přehrávač
const DETECT_HEADERS = [
  'user-agent', 'origin', 'referer', 'x-requested-with', 'sec-ch-ua', 'sec-ch-ua-platform',
  'sec-ch-ua-mobile', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'accept', 'accept-language',
];

function detectHeadersForLog(headers) {
  const out = {};
  for (const h of DETECT_HEADERS) out[h] = headers[h] ? String(headers[h]).slice(0, 300) : '—';
  return out;
}

function headersForLog(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = HIDDEN_HEADERS.has(k) ? '[skryto]' : String(v).slice(0, 300);
  }
  return out;
}

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const start = Date.now();
  const path = redactPath(safeDecode(req.path));
  console.log(`[REQ] ${req.method} ${path}`);

  if (LOG_FULL && PLAYER_PATH.test(req.path)) {
    const lines = [`      ip: ${req.ip}`];
    if (Object.keys(req.query).length) lines.push(`      query: ${JSON.stringify(req.query)}`);
    // Extra parametry Stremia (filename, videoSize, videoHash…) z posledního segmentu cesty
    const m = req.path.match(/\/subtitles\/[^/]+\/[^/]+\/([^/]+)\.json$/);
    if (m) lines.push(`      extra: ${JSON.stringify(Object.fromEntries(new URLSearchParams(safeDecode(m[1]))))}`);
    lines.push(`      přehrávač: ${JSON.stringify(detectHeadersForLog(req.headers))}`);
    lines.push(`      všechny hlavičky: ${JSON.stringify(headersForLog(req.headers))}`);
    console.log(lines.join('\n'));
    res.on('finish', () => {
      console.log(`[RES] ${res.statusCode} ${path} (${Date.now() - start} ms, ${res.getHeader('content-length') || '?'} B)`);
    });
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Vypnutý dashboard → jeho stránky a API (vlastní titulky, nahrávání, admin) jako by neexistovaly
const RE_DASHBOARD_PATH = /^\/(?:[^/]+\/(?:dashboard|custom-list|upload|custom-delete|admin)(?:\/|$)|custom-sub(?:-raw)?\/)/;
app.use((req, res, next) => {
  if (!DASHBOARD && RE_DASHBOARD_PATH.test(req.path)) return res.status(404).send('Nenalezeno');
  next();
});

function hostOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function getConfig(req) {
  return auth.decryptConfig(req.params.config);
}

// ── Klienti Titulky.com (klíč = jméno + otisk hesla) ─────────────

const clients = new finder.BoundedCache(500, 0);

function getClient(config) {
  const key = `${config.u.toLowerCase()}:${auth.passwordFingerprint(config.p)}`;
  let c = clients.get(key);
  if (!c) {
    c = new TitulkyClient(config.u, config.p);
    clients.set(key, c);
  }
  return c;
}

const premiumClients = new finder.BoundedCache(500, 0);

function getPremiumClient(config) {
  const key = `${config.u.toLowerCase()}:${auth.passwordFingerprint(config.p)}`;
  let c = premiumClients.get(key);
  if (!c) {
    c = new premium.PremiumClient(config.u, config.p);
    premiumClients.set(key, c);
  }
  return c;
}

// ── Cinemeta ─────────────────────────────────────────────────────

const CINEMETA = (process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io').replace(/\/+$/, '');
const metaCache = new finder.BoundedCache(2000, 6 * 60 * 60 * 1000);

async function getMeta(type, imdbId) {
  const key = `${type}:${imdbId}`;
  const hit = metaCache.get(key);
  if (hit) return hit;
  try {
    const res = await axios.get(`${CINEMETA}/meta/${type}/${imdbId}.json`, { timeout: 8000 });
    const meta = res.data?.meta || null;
    if (meta) metaCache.set(key, meta);
    return meta;
  } catch {
    return null;
  }
}

// ── Real-Debrid: název přehrávaného souboru (když ho přehrávač neposlal) ──

async function rdFilename(token, name, season, episode) {
  const words = match.normalizeTitle(name).split(' ').filter(w => w.length > 2);
  if (!words.length) return '';
  const matches = fn => {
    if (!fn) return false;
    const n = match.normalizeTitle(fn);
    if (!words.every(w => n.includes(w))) return false;
    if (season != null) {
      const e = match.parseEpisode(fn);
      if (!e || e.season !== season || e.episode !== episode) return false;
    }
    return true;
  };
  const headers = { Authorization: `Bearer ${token}` };
  try {
    for (const path of ['downloads', 'torrents']) {
      const res = await axios.get(`https://api.real-debrid.com/rest/1.0/${path}?limit=30`, { headers, timeout: 5000 });
      const hit = (Array.isArray(res.data) ? res.data : []).find(d => matches(d.filename));
      if (hit) return hit.filename;
    }
  } catch (e) {
    console.log(`[RD] Chyba API: ${e.message}`);
  }
  return '';
}

// ── Stránky ──────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));
app.get('/', (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => res.type('html').send(pages.configurePage({ dashboard: DASHBOARD })));
app.get('/:config/configure', (req, res) => res.type('html').send(pages.configurePage({ dashboard: DASHBOARD })));

// ── Manifest ─────────────────────────────────────────────────────

const CATALOG_ID = 'titulky-nejnovejsi';
const catalogOn = config => !!config && settings.get(config.u, config).catalog; // uložené nastavení (starší config: k=0 = vypnuto)

function manifest(configured, config = null) {
  const withCatalog = configured && catalogOn(config);
  return {
    id: 'community.titulky.com',
    version: VERSION,
    name: 'Titulky.com',
    description: 'České a slovenské titulky z Titulky.com',
    // Jeden katalog s filmy i seriály – každá položka má vlastní typ
    // jen stránkování, bez hledání (ať se katalog neplete do výsledků vyhledávání)
    catalogs: withCatalog ? [{ type: 'movie', id: CATALOG_ID, name: 'Nejnovější titulky',
      extra: [{ name: 'skip', isRequired: false }], extraSupported: ['skip'] }] : [],
    resources: withCatalog ? ['subtitles', 'catalog'] : ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    logo: 'https://raw.githubusercontent.com/david325345/stremio-titulky.com-docker/main/public/logo.png',
    behaviorHints: { configurable: true, configurationRequired: !configured },
  };
}

app.get('/manifest.json', (req, res) => res.json(manifest(false)));
app.get('/:config/manifest.json', (req, res) => {
  // Starý nebo neplatný config → Stremio vyzve ke konfiguraci
  const config = getConfig(req);
  if (config) noteManifest(req, req.params.config);
  res.json(manifest(!!config, config));
});

// ── Katalog „Nejnovější titulky" (aktualizace 12:00 a 18:00, uložený na R2) ──
app.get('/:config/catalog/:type/:id/:extra?.json', (req, res) => {
  const config = getConfig(req);
  if (!config || !catalogOn(config) || req.params.id !== CATALOG_ID) return res.json({ metas: [] });
  const extra = new URLSearchParams(req.params.extra || '');
  // Hledání katalog nepodporuje (Nuvio ho přesto posílá) → prázdný výsledek
  if (extra.has('search') || extra.has('genre')) return res.json({ metas: [] });
  const skip = parseInt(extra.get('skip') || '0', 10) || 0;
  res.setHeader('Cache-Control', 'public, max-age=1800');
  res.json({ metas: skip > 0 ? [] : catalog.metasFor(hostOf(req)) });
});

// Plakáty katalogu uložené na disku
app.get('/poster/:file', (req, res) => {
  const m = String(req.params.file).match(/^(tt\d{5,10})\.jpg$/);
  const f = m && catalog.posterPath(m[1]);
  if (!f) return res.status(404).send('Nenalezeno');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.type('jpg').sendFile(f);
});

// ── Hledání titulků ──────────────────────────────────────────────

const FLAG = { cze: '🇨🇿', slk: '🇸🇰' };
const NUM_EMOJI = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const numberEmoji = n => NUM_EMOJI[n] || String(n);

function normalizeLang(lang) {
  const v = String(lang || '').trim().toLowerCase();
  if (['cs', 'cz', 'ces', 'cze'].includes(v)) return 'cze';
  if (['sk', 'slo', 'slk'].includes(v)) return 'slk';
  return v || 'cze';
}

// ── Popisky titulků ─────────────────────────────────────────────

// Bez délky filmu: „… (02:56:11, 02:56:12)" a useknuté „(02:5…" pryč
function cleanLabel(s) {
  return String(s || '')
    .replace(/\(\s*\d{1,2}:\d{2}(:\d{2})?[^)]*\)?/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s/,;-]+$/, '')
    .trim();
}

// Nuvio 3.4.1: popisek na kartě až na 2 řádky (~75 znaků), menu ho už nezahazuje
const NUVIO_MAX = 75;

function fitNuvio(text) {
  const chars = [...text];
  return chars.length <= NUVIO_MAX ? text : chars.slice(0, NUVIO_MAX - 1).join('').trimEnd() + '…';
}

// Celý název releasu; tečky a podtržítka → mezery (kvůli zalamování v Nuviu)
function nuvioLabel(icon, star, label) {
  const text = label
    .replace(/_+/g, ' ')
    // tečka zůstane jen v desetinném čísle (5.1, 7.1, 23.976), ne v „2022.1080p" ani „x265.10bit"
    .replace(/\./g, (m, i, str) => {
      const left = str.slice(0, i);
      const keep = /(^|\D)\d{1,2}$/.test(left) && !/\d\.\d{1,2}$/.test(left) && /^\d{1,3}(?![\dpi])/i.test(str.slice(i + 1));
      return keep ? '.' : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim() || 'Titulky.com';
  return fitNuvio(`${icon} ${star ? star + ' ' : ''}${text}`);
}

function isRowCached(row, ep) {
  return (ep && r2.isCached(`${row.id}-${ep}`)) || r2.isCached(row.id);
}

// Pořadí: titulky už v cache (R2, ✅) první → shoda s přehrávaným souborem → kvalita → počet stažení
function rankRows(rows, playTags, ep) {
  const hasPlay = match.hasUsefulTags(playTags);
  return rows
    .map(row => {
      const strings = [row.release, row.detail?.versionFor, row.title];
      const ml = hasPlay ? match.matchLevel(strings, playTags) : { level: 0, score: 0 };
      const quality = match.qualityScore(row.release || row.detail?.versionFor || row.title || '');
      return { ...row, cached: !!isRowCached(row, ep), level: ml.level, score: ml.score, quality };
    })
    .sort((a, b) =>
      (b.cached ? 1 : 0) - (a.cached ? 1 : 0) ||
      b.level - a.level ||
      b.score - a.score ||
      b.quality - a.quality ||
      (b.published === false ? 0 : 1) - (a.published === false ? 0 : 1) ||
      (b.downloads || 0) - (a.downloads || 0));
}

// ── Nuvio: obejití zahazování druhé odpovědi (mergeExternalSubtitles) ─────
// Nuvio se ptá 1) při načítání streamů bez názvu souboru, 2) z přehrávače s názvem
// souboru. Z 2) převezme jen titulky s NOVOU URL, takže popisky s ⭐/🎯 se ztratí.
// Proto na PRVNÍ dotaz bez souboru (config + IP + video, 30 min) vrátíme prázdno.
// Po dotazu s názvem souboru se značka smaže (příště zase prázdno → zase ⭐).
// Vypnutí: NUVIO_EMPTY_FIRST=0 (až Nuvio opraví mergeExternalSubtitles).
const NUVIO_EMPTY_FIRST = process.env.NUVIO_EMPTY_FIRST !== '0';
const NUVIO_FIRST_TTL = 30 * 60 * 1000;
const nuvioFirstSeen = new Map();

function nuvioSkipFirst(req, configStr, videoId, extra) {
  if (!NUVIO_EMPTY_FIRST) return false;
  const key = `${require('crypto').createHash('sha256').update(String(configStr)).digest('hex').slice(0, 16)}|${req.ip}|${videoId}`;
  const now = Date.now();
  if (nuvioFirstSeen.size > 5000) {
    for (const [k, t] of nuvioFirstSeen) if (now - t > NUVIO_FIRST_TTL) nuvioFirstSeen.delete(k);
  }
  const hasFile = !!(extra.get('filename') || extra.get('videoSize') || extra.get('videoHash'));
  if (hasFile) {                     // dotaz z přehrávače s názvem souboru → relace hotová
    nuvioFirstSeen.delete(key);
    return false;
  }
  const t = nuvioFirstSeen.get(key);
  if (t && now - t < NUVIO_FIRST_TTL) return false; // druhý dotaz bez souboru → normální odpověď
  nuvioFirstSeen.set(key, now);
  return true;
}

// ── Premium: hledání podle IMDb ─────────────────────────────────

const NOTICE_LABEL = {
  premium: '⚠️ Addon teď vyžaduje premium.titulky.com (VIP)',
  login: '⚠️ Přihlášení na premium.titulky.com selhalo',
  error: '⚠️ premium.titulky.com teď neodpovídá',
};
const NOTICE_TEXT = {
  premium: 'Addon teď hledá a stahuje titulky přes premium.titulky.com, který je jen pro účty s aktivním VIP (prémiovým) nebo překladatelským účtem. Váš účet ho nemá – aktivujte VIP na titulky.com a pak titulky naběhnou samy.',
  login: 'Přihlášení na premium.titulky.com selhalo. Pokud jste změnili heslo, nainstalujte addon znovu přes stránku konfigurace.',
  error: 'premium.titulky.com teď neodpovídá. Zkuste to prosím za chvíli.',
};

// { rows } nebo { notice: 'premium'|'login'|'error' }
async function premiumRows(config, vid) {
  const client = getPremiumClient(config);
  try {
    const acc = await client.checkAccount();
    if (!acc.ok) return { notice: 'login' };
    if (!acc.premium) return { notice: 'premium' };
    return { rows: await premium.findSubs(client, vid.imdbId, vid.season, vid.episode) };
  } catch (e) {
    if (e.code === 'login' || e.code === 'premium') {
      client.account = null;
      console.log(`[Premium] ${config.u}: ${e.code}${e.message && e.message !== e.code ? ` („${e.message.slice(0, 100)}")` : ''}`);
      return { notice: e.code };
    }
    console.log(`[Premium] Hledání ${vid.imdbId} selhalo: ${e.message}`);
    return { notice: 'error' };
  }
}

app.get('/notice/:code/:fmt/:file', (req, res) => {
  const { code, fmt } = req.params;
  const text = NOTICE_TEXT[code] || NOTICE_TEXT.error;
  sendSubtitle(req, res, conv.messageSrt(text), 'titulky-info.srt', fmt === 'vtt' ? 'vtt' : 'srt', { error: true });
});

app.get('/:config/subtitles/:type/:id/:extra?.json', ah(async (req, res) => {
  const config = getConfig(req);
  const { type } = req.params;
  const id = decodeURIComponent(req.params.id);
  if (!config || !['movie', 'series'].includes(type)) return res.json({ subtitles: [] });
  const vid = parseVideoId(type, id);
  if (!vid) return res.json({ subtitles: [] });

  // Uživatelské nastavení (jazyky, nepublikované, přehrávač) – mění se na webu bez přeinstalace
  const prefs = settings.get(config.u, config);
  const { profile, how: profileHow } = detectProfile(req, { ...config, c: prefs.client }, req.params.config);
  const allowed = row => prefs.langs.includes(normalizeLang(row.lang)) && (prefs.unpublished || row.published !== false);
  const host = hostOf(req);
  const configStr = req.params.config;
  const ep = type === 'series' ? match.episodeCode(vid.season, vid.episode) : null;

  const extra = new URLSearchParams(req.params.extra || '');

  // Nuvio: první dotaz bez názvu souboru (při načítání streamů) → prázdný seznam.
  // Nuvio pak odpověď z přehrávače (už s názvem souboru, s ⭐/🎯) nezahodí jako duplicitu.
  if (profile === 'nuvio' && nuvioSkipFirst(req, configStr, id, extra)) {
    console.log(`[Addon] ${type} ${id} | profil nuvio | první dotaz bez souboru → prázdný seznam (titulky pošlu přehrávači)`);
    if (MODE === 'premium') premiumRows(config, vid).catch(() => {}); // předehřát cache
    else {
      getMeta(type, vid.imdbId) // předehřát cache, ať je odpověď přehrávači rychlá
        .then(m => m && finder.findCandidates({ type, meta: m, season: vid.season, episode: vid.episode }))
        .catch(() => {});
    }
    return res.json({ subtitles: [] });
  }

  let meta;
  let candidates;
  let notice = null;
  if (MODE === 'premium') {
    // Hledání podle IMDb na premium.titulky.com (Cinemeta jen pro název do historie)
    const [m, pr] = await Promise.all([getMeta(type, vid.imdbId), premiumRows(config, vid)]);
    meta = m || {};
    candidates = pr.rows || [];
    notice = pr.notice || null;
  } else {
    meta = await getMeta(type, vid.imdbId);
    if (!meta) return res.json({ subtitles: [] });
  }
  const name = meta.name || candidates?.[0]?.title || '';

  // Název přehrávaného souboru (Stremio ho posílá v extra)
  let playing = (extra.get('filename') || '').trim();
  if (!notice && !match.hasUsefulTags(match.extractTags(playing)) && config.rd) {
    const fn = await rdFilename(config.rd, name, vid.season, vid.episode);
    if (fn) playing = fn;
  }
  const playTags = match.extractTags(playing);

  let rows;
  if (MODE === 'premium') {
    // Hledáno přímo podle IMDb → bez kontroly IMDb, jen řazení
    rows = rankRows(candidates.filter(allowed), playTags, ep).slice(0, MAX_RESULTS);
  } else {
    // Hledání → řazení → ověření IMDb u nejlepších → přeřazení (s „Verze pro“ z detailu)
    candidates = await finder.findCandidates({ type, meta, season: vid.season, episode: vid.episode });
    rows = rankRows(candidates.filter(allowed), playTags, ep);
    rows = await finder.verifyCandidates(rows, vid.imdbId, MAX_RESULTS);
    rows = rankRows(rows, playTags, ep);
  }

  console.log(`[Addon] ${type} ${id} "${name}" | ${MODE} | profil ${profile} (${profileHow}) | soubor: ${playing ? 'ano' : 'ne'} | výsledků ${rows.length}/${candidates.length}${notice ? ` | upozornění: ${notice}` : ''}`);

  r2.addToHistory(config.u, { imdbId: vid.imdbId, type, id, name, poster: meta.poster || null, time: Date.now() });

  const fmt = profile === 'omni' ? 'vtt' : 'srt';
  const epTok = ep || '0';
  const omniCounters = {};

  let noticeItem = null;
  if (notice) {
    // Jedna informační položka místo titulků (po kliknutí se zobrazí vysvětlení)
    const url = `${host}/notice/${notice}/${fmt}/titulky-info.${fmt}`;
    const text = NOTICE_LABEL[notice] || NOTICE_LABEL.error;
    noticeItem = profile === 'omni' ? { id: `titulky-notice-${notice}`, url, lang: '⚠️', SubEncoding: 'UTF-8', SubFormat: 'vtt' }
      : profile === 'nuvio' ? { id: fitNuvio(text), url, lang: 'cze', SubEncoding: 'UTF-8', SubFormat: 'srt' }
        : { id: `titulky-notice-${notice}`, url, lang: text, SubEncoding: 'UTF-8', SubFormat: 'srt' };
    rows = [];
  }

  const subtitles = rows.map(row => {
    const icon = row.cached ? '✅' : '⬇️';
    const match_ = row.level === 2 ? '🎯' : row.level === 1 ? '⭐' : '';
    const star = [match_, row.published === false ? '⏳' : ''].filter(Boolean).join(' '); // ⏳ = čeká na schválení
    const label = cleanLabel(row.release || row.detail?.versionFor || row.title || '');
    const url = `${host}/sub/${configStr}/${row.id}/${fmt}/${epTok}/${encodeURIComponent(row.linkFile)}.${fmt}`;
    const lang = normalizeLang(row.lang);

    if (profile === 'omni') {
      const quality = match.qualityEmoji(label);
      const group = `${icon}${star.replace(/ /g, '')}${quality}`;
      omniCounters[group] = (omniCounters[group] || 0) + 1;
      return { id: `titulky-${row.id}`, url, lang: `${group}${numberEmoji(omniCounters[group])}`, SubEncoding: 'UTF-8', SubFormat: 'vtt' };
    }
    if (profile === 'nuvio') {
      // Nuvio bere `lang` jako kód jazyka a `id` zobrazuje jako popis
      // Nuvio: popisek z `id` – ikona, hvězda a celý název releasu (max 75 znaků)
      return {
        id: nuvioLabel(icon, star, label),
        url, lang, SubEncoding: 'UTF-8', SubFormat: 'srt',
      };
    }
    const langName = lang === 'slk' ? 'Slovenčina' : 'Čeština';
    return {
      id: `titulky-${row.id}`,
      url,
      lang: `${icon} ${FLAG[lang] || ''} ${star ? star + ' ' : ''}${label || langName}`.replace(/\s+/g, ' ').trim(),
      SubEncoding: 'UTF-8',
      SubFormat: 'srt',
    };
  });

  if (noticeItem) subtitles.unshift(noticeItem);

  // Vlastní (nahrané) titulky nahoru – jen se zapnutým dashboardem
  const customId = type === 'series' ? id.replace(/:/g, '-') : vid.imdbId;
  const customSubs = DASHBOARD ? await r2.listCustomSubs(customId) : [];
  for (const cs of customSubs.slice().reverse()) {
    const ext = cs.filename.split('.').pop().toLowerCase();
    const isAss = ext === 'ass' || ext === 'ssa';
    let subFormat;
    let url;
    if (profile === 'omni' && isAss) {
      subFormat = ext;
      url = `${host}/custom-sub-raw/${customId}/${encodeURIComponent(cs.filename)}`;
    } else {
      subFormat = isAss || ext === 'vtt' ? 'vtt' : 'srt';
      url = `${host}/custom-sub/${customId}/${encodeURIComponent(cs.filename)}`;
    }
    const lang = normalizeLang(cs.lang);
    if (profile === 'omni') {
      omniCounters['📌'] = (omniCounters['📌'] || 0) + 1;
      subtitles.unshift({ id: `custom-${cs.key}`, url, lang: `📌${numberEmoji(omniCounters['📌'])}`, SubEncoding: 'UTF-8', SubFormat: subFormat });
    } else if (profile === 'nuvio') {
      subtitles.unshift({ id: fitNuvio(`📌 ${cs.label || cs.filename}`), url, lang, SubEncoding: 'UTF-8', SubFormat: subFormat });
    } else {
      subtitles.unshift({ id: `custom-${cs.key}`, url, lang: `📌 ${FLAG[lang] || ''} ${cs.label}`.replace(/\s+/g, ' ').trim(), SubEncoding: 'UTF-8', SubFormat: subFormat });
    }
  }

  res.json({ subtitles });
}));

// ── Stažení titulku ──────────────────────────────────────────────

const subCache = new finder.BoundedCache(300, 60 * 60 * 1000);
const inflight = new Map();

const ERROR_TEXT = {
  captcha: 'Titulky.com teď vyžaduje opsání kódu (captcha) – rychlá stažení na dnešek jsou nejspíš vyčerpaná. Zkuste titulky označené ✅ (jsou v cache) nebo to zkuste později.',
  limit: 'Vyčerpali jste denní limit stažení z Titulky.com. Počkejte do zítřka, nebo zatím použijte titulky označené ✅ – ty jsou v cache a stáhnou se vždy.',
  login: 'Přihlášení na Titulky.com selhalo. Nainstalujte addon znovu s aktuálním heslem.',
  premium: 'Stahování přes premium.titulky.com je jen pro účty s aktivním VIP (prémiovým) nebo překladatelským účtem. Titulky označené ✅ jsou v cache a stáhnou se i tak.',
  error: 'Titulky se nepodařilo stáhnout (chyba na straně Titulky.com). Zkuste to prosím později.',
};

function fileMatchesEpisode(filename, ep) {
  const e = match.parseEpisode(filename);
  return !!e && match.episodeCode(e.season, e.episode) === ep;
}

async function fpsFor(subId, linkFile, text, config) {
  if (conv.detectFormat(text) !== 'microdvd') return null;
  if (MODE === 'premium' && config) {
    const fps = await premium.fpsOf(getPremiumClient(config), subId);
    if (fps) return fps;
  }
  const d = await finder.getDetailById(subId, linkFile);
  return d?.fps || null;
}

async function loadSubtitle(config, subId, linkFile, ep) {
  const epKey = ep !== '0' ? `${subId}-${ep}` : null;

  for (const k of [epKey, subId].filter(Boolean)) {
    const hit = subCache.get(k);
    if (hit) return hit;
  }
  for (const k of [epKey, subId].filter(Boolean)) {
    const o = await r2.getSub(k);
    if (o) {
      const text = conv.toUtf8String(Buffer.from(o.content, 'utf8'));
      const out = { content: conv.toSrt(text, { fps: await fpsFor(subId, linkFile, text, config) }), filename: o.filename };
      subCache.set(k, out);
      return out;
    }
  }

  const result = MODE === 'premium'
    ? await getPremiumClient(config).download(subId)
    : await getClient(config).download(subId, linkFile);
  if (result.error) return { error: result.error };

  const files = result.files;
  let pick = null;
  let cacheId = subId;
  if (files.length > 1 && ep !== '0') {
    pick = files.find(f => fileMatchesEpisode(f.filename, ep));
    if (pick) cacheId = epKey;
  }
  if (!pick) pick = files.find(f => /\.srt$/i.test(f.filename)) || files[0];

  const text = conv.toUtf8String(pick.content);
  const srt = conv.toSrt(text, { fps: await fpsFor(subId, linkFile, text, config) });
  const filename = pick.filename.replace(/\.[^.]+$/, '') + '.srt';
  const out = { content: srt, filename };
  subCache.set(cacheId, out);
  r2.putSub(cacheId, srt, filename).catch(() => {});
  return out;
}

function contentDisposition(filename) {
  const ascii = match.stripDiacritics(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Odeslání s podporou HTTP Range (přehrávače Applu – NuvioTV/AVFoundation – se ptají
// po částech: bytes=0-1, bytes=0-…, HEAD). Jeden rozsah; víc rozsahů → celý soubor.
function sendRanged(req, res, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const total = buf.length;
  res.setHeader('Accept-Ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return res.send(buf);
  let start;
  let end;
  if (m[1] === '') {                       // bytes=-N → posledních N bajtů
    start = Math.max(0, total - Number(m[2]));
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (!total || start >= total || start > end) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  return res.status(206).send(buf.subarray(start, end + 1));
}

function sendSubtitle(req, res, srt, filename, fmt, { error = false } = {}) {
  const body = fmt === 'vtt' ? conv.srtToVtt(srt) : srt;
  const name = filename.replace(/\.srt$/i, '') + (fmt === 'vtt' ? '.vtt' : '.srt');
  res.setHeader('Content-Type', `${fmt === 'vtt' ? 'text/vtt' : 'text/plain'}; charset=utf-8`);
  res.setHeader('Content-Disposition', contentDisposition(name));
  res.setHeader('Cache-Control', error ? 'no-store' : 'public, max-age=86400');
  sendRanged(req, res, body);
}

app.get('/sub/:config/:subId/:fmt/:ep/:file', ah(async (req, res) => {
  const config = getConfig(req);
  const { subId, fmt, ep } = req.params;
  const linkFile = String(req.params.file).replace(/\.(srt|vtt)$/i, '');
  if (!config) return res.status(400).send('Neplatná konfigurace – nainstalujte addon znovu');
  if (!RE_SUB_ID.test(subId) || !['srt', 'vtt'].includes(fmt) || !RE_EP.test(ep) || !/^[^/\\]{1,200}$/.test(linkFile)) {
    return res.status(400).send('Neplatný požadavek');
  }

  const key = `${subId}|${ep}`;
  let p = inflight.get(key);
  if (!p) {
    p = loadSubtitle(config, subId, linkFile, ep).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const out = await p;
  if (out.error) {
    console.log(`[Addon] Stažení ${subId} selhalo: ${out.error}`);
    return sendSubtitle(req, res, conv.messageSrt(ERROR_TEXT[out.error] || ERROR_TEXT.error), 'titulky-chyba.srt', fmt, { error: true });
  }
  sendSubtitle(req, res, out.content, out.filename, fmt);
}));

// ── Vlastní titulky: servírování ─────────────────────────────────

async function loadCustom(req, res) {
  const { videoId, filename } = req.params;
  if (!r2.enabled) { res.status(404).send('R2 není nastavené'); return null; }
  if (!RE_CUSTOM_ID.test(videoId) || !RE_SAFE_FILE.test(filename)) { res.status(400).send('Neplatný požadavek'); return null; }
  const o = await r2.getObject(`custom/${videoId}/${filename}`);
  if (!o) { res.status(404).send('Nenalezeno'); return null; }
  return o;
}

app.get('/custom-sub/:videoId/:filename', ah(async (req, res) => {
  const o = await loadCustom(req, res);
  if (!o) return;
  const { filename } = req.params;
  const ext = filename.split('.').pop().toLowerCase();
  const text = conv.toUtf8String(o.body);
  let body;
  let ct;
  if (ext === 'ass' || ext === 'ssa') { body = conv.assToVtt(text); ct = 'text/vtt'; }
  else if (ext === 'vtt') { body = text; ct = 'text/vtt'; }
  else { body = conv.toSrt(text); ct = 'text/plain'; }
  res.setHeader('Content-Type', `${ct}; charset=utf-8`);
  res.setHeader('Content-Disposition', contentDisposition(filename));
  sendRanged(req, res, body);
}));

app.get('/custom-sub-raw/:videoId/:filename', ah(async (req, res) => {
  const o = await loadCustom(req, res);
  if (!o) return;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition(req.params.filename));
  sendRanged(req, res, conv.toUtf8String(o.body));
}));

// ── Dashboard a vlastní titulky: správa ──────────────────────────

app.get('/:config/dashboard', ah(async (req, res) => {
  const config = getConfig(req);
  if (!config) return res.status(401).type('html').send('<p>Neplatná konfigurace – <a href="/configure">přihlaste se znovu</a>.</p>');
  const history = await r2.getHistory(config.u);
  res.type('html').send(pages.dashboardPage({
    configStr: req.params.config, username: config.u, isAdmin: auth.isAdmin(config.u), history,
  }));
}));

app.get('/:config/custom-list/:videoId', ah(async (req, res) => {
  const config = getConfig(req);
  if (!config) return res.status(401).json({ error: 'Nepřihlášen' });
  if (!RE_CUSTOM_ID.test(req.params.videoId)) return res.status(400).json({ error: 'Neplatné ID' });
  res.json({ subs: await r2.listCustomSubs(req.params.videoId) });
}));

app.post('/:config/upload', express.json({ limit: '3mb' }), ah(async (req, res) => {
  const config = getConfig(req);
  if (!config) return res.status(401).json({ error: 'Nepřihlášen' });
  if (!r2.enabled) return res.status(500).json({ error: 'R2 není nastavené' });

  const { videoId, content, filename, label, lang } = req.body || {};
  if (!RE_CUSTOM_ID.test(String(videoId || ''))) return res.status(400).json({ error: 'Neplatné ID videa' });
  if (typeof content !== 'string' || typeof filename !== 'string') return res.status(400).json({ error: 'Chybí soubor' });

  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (!['srt', 'ssa', 'ass', 'sub', 'vtt'].includes(ext)) return res.status(400).json({ error: 'Nepodporovaný formát' });
  const buf = Buffer.from(content, 'base64');
  if (!buf.length || buf.length > 1_500_000) return res.status(400).json({ error: 'Soubor je prázdný nebo moc velký' });

  let safeName = match.stripDiacritics(filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);
  if (!RE_SAFE_FILE.test(safeName)) safeName = `titulky.${ext}`;
  if (await r2.headObject(`custom/${videoId}/${safeName}`)) safeName = `${Date.now()}_${safeName}`.slice(-140);

  const cleanLabel = String(label || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100)
    || safeName.replace(/\.[^.]+$/, '');
  const cleanLang = ['cze', 'slk', 'eng'].includes(lang) ? lang : 'cze';

  const ok = await r2.putCustomSub(videoId, safeName, conv.toUtf8String(buf), {
    label: cleanLabel, lang: cleanLang, uploader: config.u,
  });
  if (ok) console.log(`[Vlastní] Nahráno custom/${videoId}/${safeName} (${config.u})`);
  res.json({ success: ok, error: ok ? undefined : 'Uložení selhalo' });
}));

const RE_CUSTOM_KEY = /^custom\/tt\d{5,10}(?:-\d{1,4}-\d{1,5})?\/[A-Za-z0-9._-]{1,140}$/;

app.post('/:config/custom-delete', express.json({ limit: '10kb' }), ah(async (req, res) => {
  const config = getConfig(req);
  if (!config) return res.status(401).json({ error: 'Nepřihlášen' });
  const key = String(req.body?.key || '');
  if (!RE_CUSTOM_KEY.test(key)) return res.status(400).json({ error: 'Neplatný klíč' });
  if (!r2.enabled) return res.status(500).json({ error: 'R2 není nastavené' });

  const h = await r2.headObject(key);
  if (!h) return res.json({ success: true });
  const uploader = h.meta.uploader || 'unknown';
  if (!auth.isAdmin(config.u) && uploader.toLowerCase() !== config.u.toLowerCase()) {
    console.log(`[Vlastní] Mazání zamítnuto: ${config.u} → titulky od ${uploader}`);
    return res.status(403).json({ error: 'Nemáte oprávnění smazat tyto titulky' });
  }
  const ok = await r2.deleteCustomSub(key);
  if (ok) console.log(`[Vlastní] Smazáno ${key} (${config.u})`);
  res.json({ success: ok });
}));

// ── Admin ────────────────────────────────────────────────────────

function requireAdmin(req, res) {
  const config = getConfig(req);
  if (!config || !auth.isAdmin(config.u)) { res.status(403).json({ error: 'Zakázáno' }); return null; }
  if (!r2.enabled && !req.path.endsWith('/clients')) { res.status(500).json({ error: 'R2 není nastavené' }); return null; }
  return config;
}

// Záloha streamem: soubory se čtou a posílají postupně, nedrží se v paměti
app.get('/:config/admin/backup', ah(async (req, res) => {
  const config = requireAdmin(req, res);
  if (!config) return;
  console.log(`[Admin] Záloha (${config.u})`);

  const keys = await r2.listKeys('');
  const archive = new ZipArchive({ zlib: { level: 6 } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="titulky-zaloha-${new Date().toISOString().slice(0, 10)}.zip"`);
  archive.on('error', e => { console.error('[Admin] Záloha:', e.message); res.destroy(e); });
  archive.pipe(res);

  let total = 0;
  for (const { key } of keys) {
    if (res.destroyed) break;
    const o = await r2.getObject(key);
    if (!o) continue;
    if (o.meta && Object.keys(o.meta).length) {
      archive.append(Buffer.from(JSON.stringify(o.meta)), { name: `${key}.meta.json` });
    }
    const done = new Promise(r => archive.once('entry', r));
    archive.append(o.body, { name: key });
    await done;
    total++;
  }
  await archive.finalize();
  console.log(`[Admin] Záloha hotová: ${total} souborů`);
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
const RE_RESTORE_KEY = /^(subs|meta|history|custom)\/[A-Za-z0-9._%\/-]{1,200}$/;

app.post('/:config/admin/restore', upload.single('backup'), ah(async (req, res) => {
  const config = requireAdmin(req, res);
  if (!config) return;
  if (!req.file) return res.status(400).json({ error: 'Chybí soubor' });
  console.log(`[Admin] Obnova (${config.u}, ${(req.file.size / 1048576).toFixed(1)} MB)`);

  let zip;
  try { zip = new AdmZip(req.file.buffer); } catch { return res.json({ success: false, error: 'Neplatný ZIP' }); }
  let count = 0;
  let skipped = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || entry.entryName.endsWith('.meta.json')) continue;
    const key = entry.entryName;
    if (!RE_RESTORE_KEY.test(key) || key.includes('..')) { skipped++; continue; }
    let meta = {};
    const metaEntry = zip.getEntry(`${key}.meta.json`);
    if (metaEntry) { try { meta = JSON.parse(metaEntry.getData().toString('utf8')); } catch { meta = {}; } }
    const ext = key.split('.').pop().toLowerCase();
    const ct = ext === 'json' ? 'application/json' : ext === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8';
    if (await r2.putObject(key, entry.getData(), ct, meta)) {
      count++;
      if (key.startsWith('subs/')) r2.cachedIds.add(key.slice(5).replace(/\.srt$/, ''));
    }
  }
  r2.clearCustomCache();
  console.log(`[Admin] Obnoveno ${count}, přeskočeno ${skipped}`);
  res.json({ success: true, count, skipped });
}));

app.get('/:config/admin/clients', (req, res) => {
  const config = requireAdmin(req, res);
  if (!config) return;
  res.json({ clients: listSeen() });
});

// ── Nastavení uživatele (web po přihlášení) ──────────────────────
// Ověření = platný šifrovaný config (vydal ho server po přihlášení)
const accountInfo = new Map(); // jméno → platnost VIP (pro zobrazení na webu)

app.get('/:config/settings', ah(async (req, res) => {
  const config = getConfig(req);
  if (!config) return res.status(403).json({ success: false, error: 'config' });
  let until = accountInfo.get(config.u.toLowerCase());
  if (!until && MODE === 'premium') {
    // Po restartu serveru: platnost VIP z účtu (přihlášení se drží v cache 6 h)
    try {
      const acc = await getPremiumClient(config).checkAccount();
      if (acc.ok && acc.validUntil) { until = acc.validUntil; accountInfo.set(config.u.toLowerCase(), until); }
    } catch { /* jen informace */ }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, user: config.u, validUntil: until ? new Date(until).toISOString() : null, settings: settings.get(config.u, config) });
}));

app.post('/:config/settings', express.json({ limit: '4kb' }), (req, res) => {
  const config = getConfig(req);
  if (!config) return res.status(403).json({ success: false, error: 'config' });
  const before = settings.get(config.u, config);
  const saved = settings.save(config.u, req.body);
  console.log(`[Nastavení] ${config.u}: jazyky ${saved.langs.join('+')}, nepublikované ${saved.unpublished ? 'ano' : 'ne'}, katalog ${saved.catalog ? 'ano' : 'ne'}, přehrávač ${saved.client}`);
  res.json({ success: true, settings: saved, catalogChanged: before.catalog !== saved.catalog });
});

// ── Ověření přihlášení (vydává šifrovaný config) ─────────────────

const verifyHits = new Map(); // IP → [časy]
function verifyRateLimited(ip) {
  const now = Date.now();
  const arr = (verifyHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  arr.push(now);
  verifyHits.set(ip, arr);
  if (verifyHits.size > 5000) verifyHits.clear();
  return arr.length > 10;
}

app.post('/verify', express.json({ limit: '10kb' }), ah(async (req, res) => {
  if (verifyRateLimited(req.ip)) return res.status(429).json({ success: false, error: 'rate' });
  const { username, password, client, rdToken } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password
      || username.length > 100 || password.length > 200) {
    return res.json({ success: false, error: 'missing_credentials' });
  }
  const u = username.trim();
  let ok = false;
  let vipUntil = null;
  try {
    if (MODE === 'premium') {
      const c = new premium.PremiumClient(u, password);
      const acc = await c.checkAccount(true);
      if (acc.ok && !acc.premium) {
        console.log(`[Verify] ${u}: bez VIP`);
        return res.json({ success: false, error: 'not_premium' });
      }
      ok = acc.ok;
      vipUntil = acc.validUntil || null;
      if (ok) premiumClients.set(`${u.toLowerCase()}:${auth.passwordFingerprint(password)}`, c);
    } else {
      const c = new TitulkyClient(u, password);
      ok = await c.login(true);
      if (ok) clients.set(`${u.toLowerCase()}:${auth.passwordFingerprint(password)}`, c);
    }
  } catch (e) {
    console.log(`[Verify] Chyba: ${e.message}`);
    return res.json({ success: false, error: 'server' });
  }
  console.log(`[Verify] ${u}: ${ok ? 'OK' : 'špatné údaje'} (${MODE})`);
  if (!ok) return res.json({ success: false, error: 'bad_credentials' });

  const cfg = { u, p: password, c: PROFILES.includes(client) ? client : 'auto' };
  if (typeof rdToken === 'string' && /^[A-Za-z0-9]{20,100}$/.test(rdToken.trim())) cfg.rd = rdToken.trim();
  if (vipUntil) accountInfo.set(u.toLowerCase(), vipUntil);
  res.json({ success: true, config: auth.encryptConfig(cfg), user: u, validUntil: vipUntil ? new Date(vipUntil).toISOString() : null, settings: settings.get(u, cfg) });
}));

// ── Chyby a start ────────────────────────────────────────────────

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(`[Chyba] ${req.method} ${redactPath(req.path)}: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
  if (res.headersSent) return res.end();
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Soubor je moc velký' });
  res.status(500).json({ error: 'Chyba serveru' });
});

process.on('unhandledRejection', e => console.error('[Chyba] Neošetřený promise:', e && e.message ? e.message : e));

let server;
settings.load().catch(e => console.log(`[Nastavení] Načtení selhalo: ${e.message}`)).finally(() => {
server = app.listen(PORT, () => {
  console.log(`Titulky.com addon ${VERSION} běží na portu ${PORT} – konfigurace: /configure`);
  catalog.start().catch(e => console.log(`[Katalog] Start selhal: ${e.message}`));
});
});

async function shutdown(sig) {
  console.log(`[Stop] ${sig} – ukládám historii…`);
  if (server) server.close();
  try { await r2.flushAllHistory(); } catch { /* nic */ }
  try { await settings.flush(); } catch { /* nic */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
