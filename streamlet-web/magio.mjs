import { gunzipSync } from 'node:zlib';
import { MAGIO_XL_GROUPS, MAGIO_ALIASES } from './magio-lineup.mjs';

const PUBLIC_BASE = 'https://czsk-iptv.onrender.com';
const STREAM_SOURCES = [
  'https://iptv-org.github.io/iptv/index.m3u'
];
const EPG_SOURCES = [
  { country: 'sk', url: 'https://epgshare01.online/epgshare01/epg_ripper_SK1.xml.gz' },
  { country: 'cz', url: 'https://epgshare01.online/epgshare01/epg_ripper_CZ1.xml.gz' }
];
const TTL = 6 * 60 * 60 * 1000;
const cache = {
  sourceEntries: null, sourceEntriesAt: 0,
  selections: null, selectionsAt: 0,
  epgData: null, epgDataAt: 0,
  masterEpg: null, masterEpgAt: 0,
  stats: null
};

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

function normalize(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*(?:p|k|fps|beta|not\s*24\/7)[^)]*\)/gi, ' ')
    .replace(/18\+/gi, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:hd|sd|uhd|fhd|4k|czech republic|czechia|slovakia|slovensko|cesko|czech|slovak)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function idBase(id) {
  return String(id || '').split('@')[0].replace(/\.[a-z]{2,3}$/i, '');
}

function canonicalId(name) {
  const slug = normalize(name) || 'channel';
  return `magio.${slug}`;
}

async function fetchBuffer(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'CZSK-IPTV-MagioXL/2.0', 'Accept': '*/*' },
    signal: AbortSignal.timeout(45000)
  });
  if (!r.ok) throw new Error(`${new URL(url).hostname} HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function fetchText(url) {
  return (await fetchBuffer(url)).toString('utf8');
}

function decodeMaybeGzip(buffer) {
  const b = Buffer.from(buffer);
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return gunzipSync(b).toString('utf8');
  return b.toString('utf8');
}

function parseM3u(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let block = [], info = '';
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
      const id = attr(info, 'tvg-id');
      const countryHint = (id.match(/\.([a-z]{2,3})(?:@|$)/i)?.[1] || '').toLowerCase();
      const keys = new Set([normalize(name), normalize(idBase(id))].filter(Boolean));
      out.push({ id, name, url: line, lines: [...block], keys, countryHint });
      block = []; info = '';
    }
  }
  return out;
}

async function sourceEntries() {
  if (cache.sourceEntries && Date.now() - cache.sourceEntriesAt < TTL) return cache.sourceEntries;
  const texts = await Promise.all(STREAM_SOURCES.map(fetchText));
  const seen = new Set();
  const entries = [];
  for (const text of texts) {
    for (const e of parseM3u(text)) {
      if (!/^https?:\/\//i.test(e.url) || seen.has(e.url)) continue;
      seen.add(e.url);
      entries.push(e);
    }
  }
  cache.sourceEntries = entries;
  cache.sourceEntriesAt = Date.now();
  return entries;
}

function aliasesFor(name) {
  const values = [name, ...(MAGIO_ALIASES[name] || [])];
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function scoreEntry(entry, aliases) {
  let score = -1;
  const nameKey = normalize(entry.name);
  const idKey = normalize(idBase(entry.id));
  for (const alias of aliases) {
    if (idKey === alias) score = Math.max(score, 130);
    if (nameKey === alias) score = Math.max(score, 120);
    if (entry.keys.has(alias)) score = Math.max(score, 115);
    if (alias.length >= 6 && idKey && (idKey.includes(alias) || alias.includes(idKey))) score = Math.max(score, 80);
    if (alias.length >= 6 && nameKey && (nameKey.includes(alias) || alias.includes(nameKey))) score = Math.max(score, 70);
  }
  if (score < 0) return score;
  if (entry.countryHint === 'sk' || entry.countryHint === 'cz') score += 5;
  if (/^https:/i.test(entry.url)) score += 2;
  if (/\.m3u8(?:\?|$)/i.test(entry.url)) score += 1;
  return score;
}

function chooseEntry(entries, officialName, usedUrls) {
  const aliases = aliasesFor(officialName);
  let best = null, bestScore = -1;
  for (const e of entries) {
    if (usedUrls.has(e.url)) continue;
    const score = scoreEntry(e, aliases);
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return bestScore >= 70 ? best : null;
}

async function buildSelections() {
  if (cache.selections && Date.now() - cache.selectionsAt < TTL) return cache.selections;
  const entries = await sourceEntries();
  const usedUrls = new Set();
  const selected = [];
  const missing = [];
  let globalOrder = 0;

  for (const [slug, groupName, officialNames] of MAGIO_XL_GROUPS) {
    let groupOrder = 0;
    for (const officialName of officialNames) {
      globalOrder += 1;
      groupOrder += 1;
      const hit = chooseEntry(entries, officialName, usedUrls);
      if (!hit) {
        missing.push({ slug, groupName, officialName, order: globalOrder });
        continue;
      }
      usedUrls.add(hit.url);
      selected.push({
        ...hit,
        officialName,
        canonicalId: canonicalId(officialName),
        slug,
        groupName,
        order: globalOrder,
        groupOrder
      });
    }
  }

  cache.selections = { selected, missing };
  cache.selectionsAt = Date.now();
  cache.masterEpg = null;
  cache.stats = null;
  return cache.selections;
}

function setAttr(info, name, value) {
  const escaped = String(value).replace(/"/g, '&quot;');
  const re = new RegExp(`\\b${name}="[^"]*"`, 'i');
  if (re.test(info)) return info.replace(re, `${name}="${escaped}"`);
  const comma = info.indexOf(',');
  return comma < 0 ? `${info} ${name}="${escaped}"` : `${info.slice(0, comma)} ${name}="${escaped}"${info.slice(comma)}`;
}

function rewriteExtinf(entry) {
  let info = entry.lines[0];
  info = setAttr(info, 'tvg-id', entry.canonicalId);
  info = setAttr(info, 'tvg-name', entry.officialName);
  info = setAttr(info, 'group-title', entry.groupName);
  info = setAttr(info, 'tvg-chno', entry.order);
  const comma = info.indexOf(',');
  if (comma >= 0) info = `${info.slice(0, comma + 1)}${entry.officialName}`;
  return [info, ...entry.lines.slice(1)];
}

async function buildPlaylist(slug = 'all') {
  const { selected } = await buildSelections();
  const subset = slug === 'all' ? selected : selected.filter(e => e.slug === slug);
  const epg = `${PUBLIC_BASE}/iptv/magio-xl.xml`;
  const out = [`#EXTM3U x-tvg-url="${epg}" url-tvg="${epg}"`];
  for (const e of subset) out.push(...rewriteExtinf(e));
  return `${out.join('\n')}\n`;
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
  if (re.test(block)) return String(block).replace(re, `$1${xmlEscape(value)}$2`);
  return String(block).replace(new RegExp(`<${tag}\\b`, 'i'), `<${tag} ${name}="${xmlEscape(value)}"`);
}

async function epgData() {
  if (cache.epgData && Date.now() - cache.epgDataAt < TTL) return cache.epgData;
  const sources = await Promise.all(EPG_SOURCES.map(async source => {
    const xml = decodeMaybeGzip(await fetchBuffer(source.url));
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
    return { ...source, channels, programmesByChannel };
  }));

  const allChannels = sources.flatMap(s => s.channels);
  const byKey = new Map();
  for (const ch of allChannels) {
    const keys = new Set([normalize(ch.id), ...ch.names.map(normalize)].filter(Boolean));
    for (const key of keys) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(ch);
    }
  }
  cache.epgData = { sources, allChannels, byKey };
  cache.epgDataAt = Date.now();
  return cache.epgData;
}

function chooseEpgChannel(entry, data) {
  const aliases = [...aliasesFor(entry.officialName), normalize(entry.name), normalize(idBase(entry.id))].filter(Boolean);
  let hits = [];
  for (const alias of aliases) {
    const found = data.byKey.get(alias) || [];
    if (found.length) { hits = found; break; }
  }
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  const sourceCountry = entry.countryHint;
  const countryHits = hits.filter(h => h.country === sourceCountry);
  if (countryHits.length === 1) return countryHits[0];
  return countryHits[0] || hits[0];
}

async function buildMasterEpg() {
  if (cache.masterEpg && Date.now() - cache.masterEpgAt < TTL) return cache.masterEpg;
  const [{ selected, missing }, data] = await Promise.all([buildSelections(), epgData()]);
  const channelBlocks = [];
  const programmeBlocks = [];
  const sourceForChannel = new Map();
  for (const s of data.sources) for (const ch of s.channels) sourceForChannel.set(`${ch.country}|${ch.id}`, s);
  let epgMatched = 0, withProgrammes = 0;
  const epgMissing = [];

  for (const entry of selected) {
    const ch = chooseEpgChannel(entry, data);
    if (!ch) {
      channelBlocks.push(`<channel id="${xmlEscape(entry.canonicalId)}"><display-name>${xmlEscape(entry.officialName)}</display-name></channel>`);
      epgMissing.push(entry.officialName);
      continue;
    }
    epgMatched += 1;
    channelBlocks.push(replaceAttr(ch.block, 'channel', 'id', entry.canonicalId));
    const source = sourceForChannel.get(`${ch.country}|${ch.id}`);
    const programmes = source?.programmesByChannel.get(ch.id) || [];
    if (programmes.length) withProgrammes += 1;
    for (const block of programmes) {
      programmeBlocks.push(replaceAttr(block, 'programme', 'channel', entry.canonicalId));
    }
  }

  cache.masterEpg = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Magio TV XL public-stream mapping 2026">\n${channelBlocks.join('\n')}\n${programmeBlocks.join('\n')}\n</tv>\n`;
  cache.masterEpgAt = Date.now();

  const groupStats = MAGIO_XL_GROUPS.map(([slug, groupName, officialNames]) => ({
    slug,
    groupName,
    official: officialNames.length,
    streamable: selected.filter(e => e.slug === slug).length
  }));
  cache.stats = {
    officialChannels: MAGIO_XL_GROUPS.reduce((n, [, , a]) => n + a.length, 0),
    streamableChannels: selected.length,
    missingStreams: missing.length,
    epgMatched,
    channelsWithProgrammes: withProgrammes,
    programmes: programmeBlocks.length,
    epgBytes: Buffer.byteLength(cache.masterEpg),
    groupStats,
    missingSample: missing.slice(0, 50).map(x => x.officialName),
    epgMissingSample: epgMissing.slice(0, 30)
  };
  return cache.masterEpg;
}

async function lineupJson() {
  const { selected, missing } = await buildSelections();
  await buildMasterEpg();
  const byName = new Map(selected.map(e => [e.officialName, e]));
  return {
    ok: true,
    source: 'Slovak Telekom official Magio TV cez internet lineup, valid from 31.7.2026',
    plan: 'XL',
    premiumPacksIncluded: false,
    ...cache.stats,
    groups: MAGIO_XL_GROUPS.map(([slug, name, officialNames]) => ({
      slug,
      name,
      channels: officialNames.map((officialName, i) => ({
        order: i + 1,
        name: officialName,
        streamAvailable: byName.has(officialName),
        sourceName: byName.get(officialName)?.name || null,
        sourceTvgId: byName.get(officialName)?.id || null
      }))
    })),
    missing: missing.map(x => x.officialName)
  };
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'public, max-age=1800, stale-while-revalidate=21600',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

export async function handleMagioRoute(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  if (url.pathname === '/iptv/magio-max.m3u' || url.pathname === '/iptv/magio-xl.m3u') {
    const body = await buildPlaylist('all');
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/vnd.apple.mpegurl; charset=utf-8');
    return true;
  }

  const groupMatch = url.pathname.match(/^\/iptv\/magio-xl\/([a-z0-9-]+)\.m3u$/i);
  if (groupMatch) {
    const slug = groupMatch[1].toLowerCase();
    if (!MAGIO_XL_GROUPS.some(g => g[0] === slug)) return false;
    const body = await buildPlaylist(slug);
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/vnd.apple.mpegurl; charset=utf-8');
    return true;
  }

  if (url.pathname === '/iptv/magio-max.xml' || url.pathname === '/iptv/magio-xl.xml') {
    const body = await buildMasterEpg();
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/xml; charset=utf-8');
    return true;
  }

  if (url.pathname === '/iptv/magio-xl-lineup.json') {
    const body = JSON.stringify(await lineupJson());
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/json; charset=utf-8');
    return true;
  }

  if (url.pathname === '/iptv/magio-status.json') {
    await Promise.all([buildPlaylist('all'), buildMasterEpg()]);
    send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({
      ok: true,
      style: 'Official Magio TV XL lineup mapping',
      source: 'Telekom lineup + public iptv-org streams',
      ...(cache.stats || {})
    }), 'application/json; charset=utf-8');
    return true;
  }

  return false;
}
