import { gunzipSync, gzipSync } from 'node:zlib';

const M3U_SOURCES = [
  'https://iptv-org.github.io/iptv/countries/sk.m3u',
  'https://iptv-org.github.io/iptv/countries/cz.m3u'
];
const EPG_SOURCES = [
  'https://epgshare01.online/epgshare01/epg_ripper_SK1.xml.gz',
  'https://epgshare01.online/epgshare01/epg_ripper_CZ1.xml.gz'
];
const TTL = 6 * 60 * 60 * 1000;
const cache = {
  m3u: { at: 0, value: null },
  epg: { at: 0, value: null },
  epgGz: { at: 0, value: null }
};

async function fetchOk(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'StreamletWeb-IPTV/1.0', 'Accept': '*/*' },
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) throw new Error(`${new URL(url).hostname} HTTP ${r.status}`);
  return r;
}

function parseM3u(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const entries = [];
  let block = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF')) {
      if (block.length) block = [];
      block.push(line);
      continue;
    }
    if (!block.length) continue;
    block.push(line);
    if (!line.startsWith('#')) {
      entries.push({ url: line, lines: [...block] });
      block = [];
    }
  }
  return entries;
}

async function buildM3u() {
  if (cache.m3u.value && Date.now() - cache.m3u.at < TTL) return cache.m3u.value;
  const texts = await Promise.all(M3U_SOURCES.map(async u => (await fetchOk(u)).text()));
  const seen = new Set();
  const out = ['#EXTM3U'];
  for (const text of texts) {
    for (const entry of parseM3u(text)) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      out.push(...entry.lines);
    }
  }
  const value = `${out.join('\n')}\n`;
  cache.m3u = { at: Date.now(), value };
  return value;
}

function decodeMaybeGzip(buffer) {
  const b = Buffer.from(buffer);
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return gunzipSync(b).toString('utf8');
  return b.toString('utf8');
}

function attr(block, name) {
  const m = block.match(new RegExp(`\\b${name}="([^"]+)"`, 'i'));
  return m ? m[1] : '';
}

function extractBlocks(xml, tag) {
  return String(xml || '').match(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi')) || [];
}

async function buildEpg() {
  if (cache.epg.value && Date.now() - cache.epg.at < TTL) return cache.epg.value;
  const xmls = await Promise.all(EPG_SOURCES.map(async u => decodeMaybeGzip(await (await fetchOk(u)).arrayBuffer())));

  const channels = [];
  const seenChannels = new Set();
  const programmes = [];
  const seenProgrammes = new Set();

  for (const xml of xmls) {
    for (const block of extractBlocks(xml, 'channel')) {
      const id = attr(block, 'id') || block;
      if (seenChannels.has(id)) continue;
      seenChannels.add(id);
      channels.push(block);
    }
    for (const block of extractBlocks(xml, 'programme')) {
      const key = `${attr(block, 'channel')}|${attr(block, 'start')}|${attr(block, 'stop')}`;
      if (seenProgrammes.has(key)) continue;
      seenProgrammes.add(key);
      programmes.push(block);
    }
  }

  const value = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Streamlet Web CZ+SK">\n${channels.join('\n')}\n${programmes.join('\n')}\n</tv>\n`;
  cache.epg = { at: Date.now(), value };
  cache.epgGz = { at: Date.now(), value: gzipSync(Buffer.from(value, 'utf8'), { level: 6 }) };
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
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/gzip', { 'Content-Disposition': 'inline; filename="czsk.xml.gz"' });
    return true;
  }
  if (url.pathname === '/iptv/status.json') {
    const body = JSON.stringify({
      ok: true,
      playlistSources: M3U_SOURCES,
      epgSources: EPG_SOURCES,
      cacheHours: TTL / 3600000
    });
    send(res, 200, req.method === 'HEAD' ? '' : body, 'application/json; charset=utf-8');
    return true;
  }
  return false;
}
