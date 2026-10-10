import http from 'node:http';
import { handleIptvRoute } from './iptv.mjs';

const port = Number(process.env.PORT || 3000);

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
      const channelCount = (m3uText.match(/^#EXTINF/gm) || []).length;
      console.log(`[IPTV selftest] M3U status=${m3u.status} channels=${channelCount} bytes=${Buffer.byteLength(m3uText)}`);

      const epg = await fetch(`http://127.0.0.1:${port}/iptv/czsk.xml`);
      const epgText = await epg.text();
      const epgChannels = (epgText.match(/<channel\b/gi) || []).length;
      const programmes = (epgText.match(/<programme\b/gi) || []).length;
      console.log(`[IPTV selftest] EPG status=${epg.status} channels=${epgChannels} programmes=${programmes} bytes=${Buffer.byteLength(epgText)}`);
    } catch (e) {
      console.error(`[IPTV selftest] failed: ${e?.message || e}`);
    }
  }, 1500);
});
