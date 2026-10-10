const PUBLIC_BASE = 'https://czsk-iptv.onrender.com';
const M3U_SOURCES = [
  { country: 'sk', url: 'https://iptv-org.github.io/iptv/countries/sk.m3u' },
  { country: 'cz', url: 'https://iptv-org.github.io/iptv/countries/cz.m3u' }
];
const TTL = 6 * 60 * 60 * 1000;
const cache = { entries: null, entriesAt: 0, m3u: null, m3uAt: 0, epg: null, epgAt: 0, stats: null };

const GROUPS = [
  ['01 Hlavné SK/CZ', [
    ['jednotka'], ['dvojka'], ['24'], ['markiza'], ['markizakrimi'], ['markizaklasik'],
    ['joj'], ['plus'], ['dajto'], ['doma'], ['jojkrimi'], ['joj24'], ['jojsvet'], ['folklorikatv','folklorika'],
    ['ta3'], ['ct1'], ['ct2'], ['ct24'], ['primask','prima'], ['primacoolsk','primacool'], ['primalovesk','primalove'],
    ['primakrimisk','primakrimi'], ['novainternational','novaintl'], ['televizeseznam','seznamcz','seznam'],
    ['senzi'], ['tvlux','lux'], ['tvnoe','noe'], ['relax'], ['sport','rtvssport']
  ]],
  ['02 Správy', [
    ['cnnprimanews','primacnnnews'], ['cnninternational','cnninteleurope','cnn'], ['bbcworldnews','bbcnews'],
    ['euronews'], ['bloombergeurope','bloomberg'], ['france24english','france24'], ['france24french'],
    ['deutschewelle','dwenglish','dw'], ['freedom'], ['skynews'], ['aljazeeraenglish','aljazeera']
  ]],
  ['03 Šport', [
    ['eurosport1'], ['eurosport2'], ['sport1'], ['sport2'], ['novasport1'], ['novasport2'], ['jojsport'], ['jojsport2'],
    ['canalplussportsk','canalplussport'], ['canalplussport2sk','canalplussport2'], ['canalplussport3sk','canalplussport3'],
    ['canalplussport4sk','canalplussport4'], ['canalplussport5sk','canalplussport5'], ['canalplussport6sk','canalplussport6'],
    ['canalplussport7sk','canalplussport7'], ['canalplussport8sk','canalplussport8'],
    ['novasport3'], ['novasport4'], ['novasport5'], ['novasport6'], ['premiersport'], ['premiersport2'], ['premiersport3'],
    ['arenasport1'], ['arenasport2'], ['golfchannel'], ['fightbox'], ['extremesports'], ['ginxesportstv','ginx']
  ]],
  ['04 Filmy a seriály', [
    ['jojcinema'], ['filmbox'], ['csfilm'], ['cshorror'], ['filmeurope'], ['amceurope','amc'], ['filmplus'],
    ['canalplusactioneurope','canalplusaction'], ['bbcfirst'], ['viasatepicdrama','epicdrama'],
    ['filmboxstars'], ['filmboxfamily'], ['filmboxextra'], ['filmboxpremium'], ['csmystery']
  ]],
  ['05 Dokumenty a lifestyle', [
    ['discoverychannel'], ['investigationdiscovery','id'], ['animalplanet'], ['history'], ['tlc'], ['tvpaprika'],
    ['viasathistory'], ['viasatexplore'], ['viasatnature'], ['viasattruecrime'], ['spektrum'], ['nationalgeographic','ngc'],
    ['nationalgeographicwild','natgeowild'], ['fishingandhunting'], ['travelchannel'], ['lovenature'], ['bbcearth'],
    ['crimeandinvestigation'], ['travelxp'], ['foodnetwork'], ['spektrumhome'], ['automotorsport']
  ]],
  ['06 Deti', [
    ['jojko'], ['lalatv'], ['turbotv'], ['jimjam'], ['nickelodeon'], ['minimaxcee','minimax'], ['disneychannel'],
    ['nicktoons'], ['cartoonnetwork'], ['tvrik','rik'], ['disneyjunior'], ['babytv'], ['nickjr'], ['ducktvm','ducktvplus','ducktv']
  ]],
  ['07 Hudba', [
    ['ocko'], ['ockostar'], ['ockoexpres'], ['ockoblack'], ['mtv'], ['retromusictv'], ['slageroriginal'], ['slagermuzika'],
    ['stingrayclassica'], ['stingraydjazz'], ['iconcerts'], ['musicboxclassic'], ['musicboxhits'], ['musicboxdance'], ['tvrebel']
  ]],
  ['08 Regionálne SK', [
    ['tvosem'], ['tvbratislava'], ['tvbanovce'], ['tvnitricka'], ['tvkomarno'], ['tvromana'], ['tvliptov'],
    ['tvruzomberok'], ['tvhronka'], ['tvbardejov'], ['tv7'], ['ktvkezmarska'], ['tvvega'], ['tvreduta'], ['tvslovensko'],
    ['tv9'], ['tvpoprad'], ['tvmistral'], ['tvmyjava'], ['tvpanorama'], ['tvbrezova'], ['tvcentral'], ['tvdk'], ['tvlocall']
  ]],
  ['09 Zahraničné', [
    ['rai1'], ['tvppolonia'], ['pro7'], ['rtl'], ['vox'], ['sat1'], ['welt'], ['raiitalia'], ['raistoria'], ['raiscuola'],
    ['cgtn'], ['cgtndocumentary'], ['tveinternational']
  ]]
];

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'CZSK-IPTV-Magio/1.0', 'Accept': '*/*' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} HTTP ${r.status}`);
  return r.text();
}

function attr(text, name) {
  const m = String(text || '').match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

function normalize(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*(?:p|k|fps|not\s*24\/7)[^)]*\)/gi, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:hd|sd|uhd|fhd|4k|czech republic|czechia|slovakia|slovensko|cesko|cz|sk)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function idBase(id) { return String(id || '').split('@')[0].split('.')[0]; }

function parseM3u(text, country) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let block = [], info = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF')) { block = [line]; info = line; continue; }
    if (!block.length) continue;
    block.push(line);
    if (!line.startsWith('#')) {
      const name = info.includes(',') ? info.slice(info.lastIndexOf(',') + 1).trim() : '';
      out.push({ id: attr(info, 'tvg-id'), name, url: line, lines: [...block], country });
      block = []; info = '';
    }
  }
  return out;
}

async function allEntries() {
  if (cache.entries && Date.now() - cache.entriesAt < TTL) return cache.entries;
  const sources = await Promise.all(M3U_SOURCES.map(async s => ({ ...s, text: await fetchText(s.url) })));
  const seen = new Set(), out = [];
  for (const source of sources) {
    for (const e of parseM3u(source.text, source.country)) {
      if (seen.has(e.url)) continue;
      seen.add(e.url);
      e.keys = new Set([normalize(e.name), normalize(idBase(e.id))].filter(Boolean));
      out.push(e);
    }
  }
  cache.entries = out; cache.entriesAt = Date.now();
  return out;
}

function groupLine(info, group) {
  if (/\bgroup-title="[^"]*"/i.test(info)) return info.replace(/\bgroup-title="[^"]*"/i, `group-title="${group}"`);
  const comma = info.indexOf(',');
  if (comma < 0) return `${info} group-title="${group}"`;
  return `${info.slice(0, comma)} group-title="${group}"${info.slice(comma)}`;
}

function linesFor(entry, group) {
  return entry.lines.map((line, i) => i === 0 ? groupLine(line, group) : line);
}

async function selectEntries() {
  const entries = await allEntries();
  const used = new Set();
  const selected = [];
  const missing = [];
  for (const [group, targets] of GROUPS) {
    for (const aliases of targets) {
      let hit = null;
      for (const aliasRaw of aliases) {
        const alias = normalize(aliasRaw);
        hit = entries.find(e => !used.has(e.url) && e.keys.has(alias));
        if (hit) break;
      }
      if (!hit) { missing.push(aliases[0]); continue; }
      used.add(hit.url);
      selected.push({ ...hit, group });
    }
  }
  return { selected, missing };
}

async function buildM3u() {
  if (cache.m3u && Date.now() - cache.m3uAt < TTL) return cache.m3u;
  const { selected, missing } = await selectEntries();
  const epg = `${PUBLIC_BASE}/iptv/magio-max.xml`;
  const out = [`#EXTM3U x-tvg-url="${epg}" url-tvg="${epg}"`];
  for (const e of selected) out.push(...linesFor(e, e.group));
  cache.m3u = `${out.join('\n')}\n`; cache.m3uAt = Date.now();
  cache.stats = { channels: selected.length, missingTargets: missing.length, missingSample: missing.slice(0, 30) };
  return cache.m3u;
}

function extractBlocks(xml, tag) {
  return String(xml || '').match(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi')) || [];
}

async function buildEpg() {
  if (cache.epg && Date.now() - cache.epgAt < TTL) return cache.epg;
  const { selected } = await selectEntries();
  const ids = new Set(selected.map(e => e.id).filter(Boolean));
  const source = await fetchText(`${PUBLIC_BASE}/iptv/czsk.xml`);
  const channels = extractBlocks(source, 'channel').filter(b => ids.has(attr(b, 'id')));
  const programmes = extractBlocks(source, 'programme').filter(b => ids.has(attr(b, 'channel')));
  cache.epg = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Magio Max style public CZ+SK">\n${channels.join('\n')}\n${programmes.join('\n')}\n</tv>\n`;
  cache.epgAt = Date.now();
  cache.stats = { ...(cache.stats || {}), epgChannels: channels.length, programmes: programmes.length, epgBytes: Buffer.byteLength(cache.epg) };
  return cache.epg;
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'public, max-age=1800, stale-while-revalidate=21600', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

export async function handleMagioRoute(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.pathname === '/iptv/magio-max.m3u' || url.pathname === '/iptv/magio-xl.m3u') {
    const body = await buildM3u();
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/vnd.apple.mpegurl; charset=utf-8');
    return true;
  }
  if (url.pathname === '/iptv/magio-max.xml' || url.pathname === '/iptv/magio-xl.xml') {
    const body = await buildEpg();
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/xml; charset=utf-8');
    return true;
  }
  if (url.pathname === '/iptv/magio-status.json') {
    await Promise.all([buildM3u(), buildEpg()]);
    send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({ ok: true, style: 'Magio TV XL/Max', source: 'public CZ+SK streams only', ...(cache.stats || {}) }), 'application/json; charset=utf-8');
    return true;
  }
  return false;
}
