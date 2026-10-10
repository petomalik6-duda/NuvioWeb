import { gunzipSync, gzipSync } from 'node:zlib';

const PUBLIC_BASE = 'https://czsk-iptv.onrender.com';
const M3U_SOURCES = [
  { country: 'sk', url: 'https://iptv-org.github.io/iptv/countries/sk.m3u' },
  { country: 'cz', url: 'https://iptv-org.github.io/iptv/countries/cz.m3u' }
];
const EPG_SOURCES = [
  { country: 'sk', url: 'https://epgshare01.online/epgshare01/epg_ripper_SK1.xml.gz' },
  { country: 'cz', url: 'https://epgshare01.online/epgshare01/epg_ripper_CZ1.xml.gz' }
];
const TTL = 6 * 60 * 60 * 1000;
const cache = {
  entries: { at: 0, value: null },
  m3u: { at: 0, value: null },
  epg: { at: 0, value: null },
  epgGz: { at: 0, value: null },
  stats: { at: 0, value: null }
};

async function fetchOk(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'StreamletWeb-IPTV/1.1', 'Accept': '*/*' },
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) throw new Error(`${new URL(url).hostname} HTTP ${r.status}`);
  return r;
}

function attr(text, name) {
  const m = String(text || '').match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeName(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*(?:p|k|fps|not\s*24\/7)[^)]*\)/gi, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:hd|sd|uhd|fhd|4k|czech republic|czechia|slovakia|slovensko|cesko|cz|sk)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function idBase(id) {
  return String(id || '').split('@')[0].split('.')[0];
}

function targetCountry(entry) {
  const id = String(entry.id || '').toLowerCase();
  if (id.includes('@slovakia') || /\.sk(?:@|$)/.test(id)) return 'sk';
  if (id.includes('@czech') || /\.cz(?:@|$)/.test(id)) return 'cz';
  return entry.country || '';
}

function parseM3u(text, country) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const entries = [];
  let block = [];
  let info = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF')) {
      block = [line];
      info = line;
      continue;
    }
    if (!block.length) continue;
    block.push(line);
    if (!line.startsWith('#')) {
      const name = info.includes(',') ? info.slice(info.lastIndexOf(',') + 1).trim() : '';
      entries.push({
        id: attr(info, 'tvg-id'),
        name,
        url: line,
        lines: [...block],
        country
      });
      block = [];
      info = '';
    }
  }
  return entries;
}

async function getPlaylistEntries() {
  if (cache.entries.value && Date.now() - cache.entries.at < TTL) return cache.entries.value;
  const sources = await Promise.all(M3U_SOURCES.map(async s => ({ ...s, text: await (await fetchOk(s.url)).text() })));
  const seenUrls = new Set();
  const entries = [];
  for (const source of sources) {
    for (const entry of parseM3u(source.text, source.country)) {
      if (seenUrls.has(entry.url)) continue;
      seenUrls.add(entry.url);
      entries.push(entry);
    }
  }
  cache.entries = { at: Date.now(), value: entries };
  return entries;
}

async function buildM3u() {
  if (cache.m3u.value && Date.now() - cache.m3u.at < TTL) return cache.m3u.value;
  const entries = await getPlaylistEntries();
  const epgUrl = `${PUBLIC_BASE}/iptv/czsk.xml`;
  const out = [`#EXTM3U x-tvg-url="${epgUrl}" url-tvg="${epgUrl}"`];
  for (const entry of entries) out.push(...entry.lines);
  const value = `${out.join('\n')}\n`;
  cache.m3u = { at: Date.now(), value };
  return value;
}

function decodeMaybeGzip(buffer) {
  const b = Buffer.from(buffer);
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return gunzipSync(b).toString('utf8');
  return b.toString('utf8');
}

function extractBlocks(xml, tag) {
  return String(xml || '').match(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi')) || [];
}

function displayNames(block) {
  return [...String(block || '').matchAll(/<display-name(?:\s[^>]*)?>([\s\S]*?)<\/display-name>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
}

function replaceAttr(block, tag, name, value) {
  const re = new RegExp(`(<${tag}\\b[^>]*\\b${name}=")[^"]*(")`, 'i');
  return String(block).replace(re, `$1${xmlEscape(value)}$2`);
}

function epgChannelCandidates(channel) {
  const keys = new Set();
  for (const name of channel.names) {
    const key = normalizeName(name);
    if (key) keys.add(key);
  }
  const idKey = normalizeName(String(channel.id || '').replace(/\.(?:hd|sd)\b/gi, ' ').replace(/\.(?:sk|cz)\b/gi, ' '));
  if (idKey) keys.add(idKey);
  return [...keys];
}

function playlistCandidates(entry) {
  const keys = new Set();
  for (const raw of [entry.name, idBase(entry.id)]) {
    const key = normalizeName(raw);
    if (key) keys.add(key);
  }
  const aliases = {
    amceurope: ['amc'],
    canalplusactioneurope: ['canalaction', 'canalplusaction'],
    filmboxpluslovecrime: ['filmboxlovecrime'],
    minimaxcee: ['minimax'],
    rtgint: ['rtg'],
    tvpaprika: ['paprika']
  };
  for (const key of [...keys]) for (const a of aliases[key] || []) keys.add(a);
  return [...keys];
}

function pickChannel(entry, byKey) {
  let hits = [];
  for (const key of playlistCandidates(entry)) {
    const found = byKey.get(key) || [];
    if (found.length) { hits = found; break; }
  }
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];

  const country = targetCountry(entry);
  const sameCountry = hits.filter(h => h.country === country);
  if (sameCountry.length === 1) return sameCountry[0];
  if (sameCountry.length > 1) hits = sameCountry;

  const base = normalizeName(idBase(entry.id));
  const idMatch = hits.find(h => normalizeName(h.id) === base || normalizeName(String(h.id).replace(/\.(?:hd|sd|sk|cz)\b/gi, '')) === base);
  return idMatch || hits[0];
}

async function loadEpgSources() {
  return Promise.all(EPG_SOURCES.map(async source => {
    const xml = decodeMaybeGzip(await (await fetchOk(source.url)).arrayBuffer());
    const channels = extractBlocks(xml, 'channel').map(block => ({
      id: attr(block, 'id'),
      names: displayNames(block),
      block,
      country: source.country
    })).filter(c => c.id);

    const programmesByChannel = new Map();
    for (const block of extractBlocks(xml, 'programme')) {
      const id = attr(block, 'channel');
      if (!id) continue;
      if (!programmesByChannel.has(id)) programmesByChannel.set(id, []);
      programmesByChannel.get(id).push(block);
    }
    return { country: source.country, channels, programmesByChannel };
  }));
}

async function buildEpg() {
  if (cache.epg.value && Date.now() - cache.epg.at < TTL) return cache.epg.value;

  const [entries, sources] = await Promise.all([getPlaylistEntries(), loadEpgSources()]);
  const allChannels = sources.flatMap(s => s.channels);
  const byKey = new Map();
  for (const channel of allChannels) {
    for (const key of epgChannelCandidates(channel)) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(channel);
    }
  }

  const sourceByCountry = new Map(sources.map(s => [s.country, s]));
  const sourceForChannel = new Map();
  for (const source of sources) for (const channel of source.channels) sourceForChannel.set(`${channel.country}|${channel.id}`, source);

  const channelBlocks = [];
  const programmeBlocks = [];
  const seenChannelIds = new Set();
  const seenProgrammes = new Set();
  let matched = 0;
  let withProgrammes = 0;
  let programmeCount = 0;

  for (const entry of entries) {
    if (!entry.id || seenChannelIds.has(entry.id)) continue;
    seenChannelIds.add(entry.id);

    const matchedChannel = pickChannel(entry, byKey);
    if (!matchedChannel) {
      channelBlocks.push(`<channel id="${xmlEscape(entry.id)}"><display-name>${xmlEscape(entry.name || entry.id)}</display-name></channel>`);
      continue;
    }

    matched += 1;
    const renamedChannel = replaceAttr(matchedChannel.block, 'channel', 'id', entry.id);
    channelBlocks.push(renamedChannel);

    const source = sourceForChannel.get(`${matchedChannel.country}|${matchedChannel.id}`) || sourceByCountry.get(matchedChannel.country);
    const programmes = source?.programmesByChannel.get(matchedChannel.id) || [];
    if (programmes.length) withProgrammes += 1;

    for (const block of programmes) {
      const start = attr(block, 'start');
      const stop = attr(block, 'stop');
      const key = `${entry.id}|${start}|${stop}`;
      if (seenProgrammes.has(key)) continue;
      seenProgrammes.add(key);
      programmeBlocks.push(replaceAttr(block, 'programme', 'channel', entry.id));
      programmeCount += 1;
    }
  }

  const value = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="CZ+SK IPTV EPG remapped for ARVIO">\n${channelBlocks.join('\n')}\n${programmeBlocks.join('\n')}\n</tv>\n`;
  cache.epg = { at: Date.now(), value };
  cache.epgGz = { at: Date.now(), value: gzipSync(Buffer.from(value, 'utf8'), { level: 6 }) };
  cache.stats = {
    at: Date.now(),
    value: {
      playlistChannels: entries.length,
      epgChannelIds: channelBlocks.length,
      matchedChannels: matched,
      channelsWithProgrammes: withProgrammes,
      programmes: programmeCount,
      epgBytes: Buffer.byteLength(value)
    }
  };
  return value;
}

async function buildEpgGz() {
  if (cache.epgGz.value && Date.now() - cache.epgGz.at < TTL) return cache.epgGz.value;
  await buildEpg();
  return cache.epgGz.value;
}

function send(res, status, body, contentType, extra = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=1800, stale-while-revalidate=21600',
    'Access-Control-Allow-Origin': '*',
    ...extra
  });
  res.end(body);
}

export async function handleIptvRoute(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  if (url.pathname === '/iptv/czsk.m3u') {
    const body = await buildM3u();
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/vnd.apple.mpegurl; charset=utf-8');
    return true;
  }

  if (url.pathname === '/iptv/czsk.xml') {
    const body = await buildEpg();
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/xml; charset=utf-8');
    return true;
  }

  if (url.pathname === '/iptv/czsk.xml.gz') {
    const body = await buildEpgGz();
    send(res, 200, req.method === 'HEAD' ? Buffer.alloc(0) : body, 'application/gzip', {
      'Content-Encoding': 'identity',
      'Content-Disposition': 'inline; filename="czsk.xml.gz"'
    });
    return true;
  }

  if (url.pathname === '/iptv/status.json') {
    await Promise.all([buildM3u(), buildEpg()]);
    const body = JSON.stringify({
      ok: true,
      playlistSources: M3U_SOURCES.map(s => s.url),
      epgSources: EPG_SOURCES.map(s => s.url),
      cacheHours: TTL / 3600000,
      epgRemapped: true,
      ...cache.stats.value
    });
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/json; charset=utf-8');
    return true;
  }

  return false;
}
