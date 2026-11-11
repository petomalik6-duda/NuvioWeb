import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const [file, handlerName, playlistPath, epgPath] of [
  ['iptv.mjs', 'handleIptvRoute', '/iptv/czsk.m3u', '/iptv/czsk.xml'],
  ['magio-v2.mjs', 'handleMagioRoute', '/iptv/magio-xl.m3u', '/iptv/magio-xl.xml']
]) {
  test(`${file}: concurrent cold requests, a broken source, cached outage and recovery`, async () => {
    const realFetch = globalThis.fetch;
    const realNow = Date.now;
    const realWarn = console.warn;
    let time = realNow();
    let failed = new Set(['cz']);
    let calls = 0;
    Date.now = () => time;
    console.warn = () => {};
    globalThis.fetch = async raw => {
      calls++;
      const url = String(raw);
      const country = /(?:\/cz\.m3u|_CZ1\.xml)/.test(url) ? 'cz' : 'sk';
      if (failed.has(country)) throw new Error('fixture outage');
      const name = country === 'cz' ? 'ČT1 HD' : 'Jednotka HD';
      const text = url.endsWith('.m3u')
        ? `#EXTM3U\n#EXTINF:-1 tvg-id="${country}",${name}\nhttps://stream.example/${country}.m3u8\n`
        : `<?xml version="1.0"?><tv><channel id="${country}"><display-name>${name}</display-name></channel><programme channel="${country}" start="20261111000000 +0000" stop="20261111010000 +0000"><title>Fixture</title></programme></tv>`;
      return new Response(text);
    };
    try {
      const mod = await import(`./${file}?fixture=${file}`);
      const request = async pathname => {
        let body;
        const res = { writeHead(status) { assert.equal(status, 200); }, end(value) { body = value; } };
        assert.equal(await mod[handlerName]({ method: 'GET' }, res, new URL(pathname, 'https://addon.example')), true);
        return String(body);
      };
      const [a, b] = await Promise.all([request(playlistPath), request(playlistPath)]);
      assert.equal(a, b);
      assert.ok(a.includes('https://stream.example/sk.m3u8'));
      const initialCalls = calls;
      await request(playlistPath);
      assert.equal(calls, initialCalls);
      assert.ok((await request(epgPath)).includes('<title>Fixture</title>'));
      time += 61_000;
      failed.clear();
      const recovered = await request(playlistPath);
      assert.ok(recovered.includes('https://stream.example/cz.m3u8'));
      time += 7 * 60 * 60 * 1000;
      failed = new Set(['sk', 'cz']);
      assert.equal(await request(playlistPath), recovered);
      assert.ok((await request(epgPath)).includes('<title>Fixture</title>'));
    } finally {
      globalThis.fetch = realFetch;
      Date.now = realNow;
      console.warn = realWarn;
    }
  });
}
