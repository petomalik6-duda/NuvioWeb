import http from 'node:http';
import { handleIptvRoute } from './iptv.mjs';

const port = Number(process.env.PORT || 3000);

function attr(text, name) {
  const m = String(text || '').match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:hd|sd|uhd|fhd|4k|1080p|720p|czech republic|czechia|slovakia|slovensko|cesko|cz|sk)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function idBase(id) {
  return String(id || '').split('@')[0].split('.')[0];
}

function m3uEntries(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let info = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) { info = line; continue; }
    if (info && line && !line.startsWith('#')) {
      const name = info.includes(',') ? info.slice(info.lastIndexOf(',') + 1).trim() : '';
      out.push({ id: attr(info, 'tvg-id'), name, url: line });
      info = '';
    }
  }
  return out;
}

function epgChannels(xml) {
  const out = [];
  const blocks = String(xml || '').match(/<channel\b[\s\S]*?<\/channel>/gi) || [];
  for (const block of blocks) {
    const id = attr(block, 'id');
    const names = [...block.matchAll(/<display-name(?:\s[^>]*)?>([\s\S]*?)<\/display-name>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim())
      .filter(Boolean);
    out.push({ id, names });
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/' || url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        ok: true,
        service: 'CZ+SK IPTV',
        playlist: '/iptv/czsk.m3u',
        epg: '/iptv/czsk.xml',
        epgGzip: '/iptv/czsk.xml.gz'
      }));
    }
    if (await handleIptvRoute(req, res, url)) return;
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    console.error('[IPTV]', e?.message || e);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: e?.message || 'IPTV upstream error' }));
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`CZ+SK IPTV listening on :${port}`);
  setTimeout(async () => {
    try {
      const m3u = await fetch(`http://127.0.0.1:${port}/iptv/czsk.m3u`);
      const m3uText = await m3u.text();
      const entries = m3uEntries(m3uText);
      console.log(`[IPTV selftest] M3U status=${m3u.status} channels=${entries.length} bytes=${Buffer.byteLength(m3uText)}`);

      const epg = await fetch(`http://127.0.0.1:${port}/iptv/czsk.xml`);
      const epgText = await epg.text();
      const channels = epgChannels(epgText);
      const programmes = (epgText.match(/<programme\b/gi) || []).length;
      const byName = new Map();
      for (const ch of channels) {
        for (const name of ch.names) {
          const key = norm(name);
          if (!key) continue;
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key).push(ch);
        }
      }

      const results = entries.map(e => {
        const candidates = [...new Set([norm(e.name), norm(idBase(e.id))].filter(Boolean))];
        let hits = [];
        for (const c of candidates) {
          const found = byName.get(c) || [];
          if (found.length) { hits = found; break; }
        }
        return { ...e, candidates, hits };
      });
      const matched = results.filter(r => r.hits.length === 1);
      const ambiguous = results.filter(r => r.hits.length > 1);
      const missing = results.filter(r => r.hits.length === 0);

      console.log(`[IPTV selftest] EPG status=${epg.status} channels=${channels.length} programmes=${programmes} bytes=${Buffer.byteLength(epgText)}`);
      console.log(`[IPTV fuzzy] uniqueMatches=${matched.length} ambiguous=${ambiguous.length} missing=${missing.length}`);
      console.log(`[IPTV fuzzy] matchSamples=${matched.slice(0,20).map(r => `${r.id}|${r.name}->${r.hits[0].id}|${r.hits[0].names[0]}`).join(' ; ')}`);
      console.log(`[IPTV fuzzy] missingSamples=${missing.slice(0,25).map(r => `${r.id}|${r.name}|${r.candidates.join('/')}`).join(' ; ')}`);
    } catch (e) {
      console.error(`[IPTV selftest] failed: ${e?.message || e}`);
    }
  }, 1500);
});
