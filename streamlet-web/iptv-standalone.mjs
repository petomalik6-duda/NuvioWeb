import http from 'node:http';
import { handleIptvRoute } from './iptv.mjs';

const port = Number(process.env.PORT || 3000);

function attr(text, name) {
  const m = String(text || '').match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
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

function epgIds(xml) {
  const ids = new Set();
  for (const m of String(xml || '').matchAll(/<channel\b[^>]*\bid="([^"]+)"/gi)) ids.add(m[1]);
  return ids;
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
      const ids = epgIds(epgText);
      const programmes = (epgText.match(/<programme\b/gi) || []).length;
      const withId = entries.filter(e => e.id);
      const matched = withId.filter(e => ids.has(e.id));
      const missing = withId.filter(e => !ids.has(e.id));
      console.log(`[IPTV selftest] EPG status=${epg.status} channels=${ids.size} programmes=${programmes} bytes=${Buffer.byteLength(epgText)}`);
      console.log(`[IPTV mapping] playlistWithTvgId=${withId.length} exactMatches=${matched.length} missing=${missing.length}`);
      console.log(`[IPTV mapping] missingSamples=${missing.slice(0,20).map(e => `${e.id}|${e.name}`).join(' ; ')}`);
    } catch (e) {
      console.error(`[IPTV selftest] failed: ${e?.message || e}`);
    }
  }, 1500);
});
