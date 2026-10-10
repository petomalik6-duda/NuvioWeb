import http from 'node:http';
import { handleIptvRoute } from './iptv.mjs';
import { handleMagioRoute } from './magio.mjs';

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
        magioMaxPlaylist: '/iptv/magio-max.m3u',
        magioMaxEpg: '/iptv/magio-max.xml'
      }));
    }
    if (await handleMagioRoute(req, res, url)) return;
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
      const [czsk, magio] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/iptv/status.json`).then(r => r.json()),
        fetch(`http://127.0.0.1:${port}/iptv/magio-status.json`).then(r => r.json())
      ]);
      console.log(`[IPTV selftest] CZSK channels=${czsk.playlistChannels} epg=${czsk.channelsWithProgrammes} programmes=${czsk.programmes}`);
      console.log(`[Magio selftest] channels=${magio.channels} epgChannels=${magio.epgChannels} programmes=${magio.programmes} missingTargets=${magio.missingTargets}`);
      if (Array.isArray(magio.missingSample)) console.log(`[Magio selftest] missingSample=${magio.missingSample.join(' ; ')}`);
    } catch (e) {
      console.error(`[IPTV selftest] failed: ${e?.message || e}`);
    }
  }, 1500);
});
