import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  createBrowserMediaProxyHandler,
  isAllowedBrowserMediaUrl,
  rewriteBrowserMediaHlsPlaylist,
  sanitizeBrowserMediaHeaders
} from "./bridge.mjs";

async function withProxyServer(fetchImpl, callback) {
  const handler = createBrowserMediaProxyHandler({ fetchImpl });
  const server = http.createServer(async (request, response) => {
    const handled = await handler(request, response);
    if (!handled && !response.writableEnded) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("media proxy rejects non-streamstr destinations and unsafe protocols", () => {
  assert.equal(isAllowedBrowserMediaUrl("https://prehrajto.streamstr.stream/video"), true);
  assert.equal(isAllowedBrowserMediaUrl("https://cdn.streamstr.stream/video"), true);
  assert.equal(isAllowedBrowserMediaUrl("http://prehrajto.streamstr.stream/video"), false);
  assert.equal(isAllowedBrowserMediaUrl("https://streamstr.stream.evil.example/video"), false);
  assert.equal(isAllowedBrowserMediaUrl("https://127.0.0.1/video"), false);
});

test("provider headers are retained but hop-by-hop and browser security headers are removed", () => {
  const result = sanitizeBrowserMediaHeaders({
    Referer: "https://prehrajto.cz/",
    Authorization: "Bearer abc",
    Cookie: "session=abc",
    Host: "evil.example",
    Connection: "keep-alive",
    "Sec-Fetch-Site": "cross-site"
  });
  assert.equal(result.Referer, "https://prehrajto.cz/");
  assert.equal(result.Authorization, "Bearer abc");
  assert.equal(result.Cookie, "session=abc");
  assert.equal(result.Host, undefined);
  assert.equal(result.Connection, undefined);
  assert.equal(result["Sec-Fetch-Site"], undefined);
});

test("proxy forwards Range and provider headers and preserves a 206 media response", async () => {
  let upstreamRequest = null;
  const fetchImpl = async (url, options) => {
    upstreamRequest = { url, options };
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 206,
      headers: {
        "content-type": "video/mp4",
        "content-range": "bytes 0-3/100",
        "content-length": "4",
        "accept-ranges": "bytes"
      }
    });
  };

  await withProxyServer(fetchImpl, async (baseUrl) => {
    const register = await fetch(`${baseUrl}/api/media-proxy/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://prehrajto.streamstr.stream/media/signed-id",
        filename: "Movie.mp4",
        requestHeaders: { Referer: "https://prehrajto.cz/" }
      })
    });
    assert.equal(register.status, 200);
    const { playbackUrl } = await register.json();
    assert.match(playbackUrl, /^\/api\/media-proxy\/play\/[A-Za-z0-9_-]+\/Movie\.mp4$/);

    const media = await fetch(`${baseUrl}${playbackUrl}`, {
      headers: { Range: "bytes=0-3" }
    });
    assert.equal(media.status, 206);
    assert.equal(media.headers.get("content-type"), "video/mp4");
    assert.equal(media.headers.get("content-range"), "bytes 0-3/100");
    assert.deepEqual([...new Uint8Array(await media.arrayBuffer())], [1, 2, 3, 4]);
    assert.equal(upstreamRequest.url, "https://prehrajto.streamstr.stream/media/signed-id");
    assert.equal(upstreamRequest.options.headers.Range, "bytes=0-3");
    assert.equal(upstreamRequest.options.headers.Referer, "https://prehrajto.cz/");
  });
});

test("HTML verification responses are turned into an explicit 502 proxy error", async () => {
  const fetchImpl = async () =>
    new Response("<html><title>Ověření návštěvníka</title></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });

  await withProxyServer(fetchImpl, async (baseUrl) => {
    const register = await fetch(`${baseUrl}/api/media-proxy/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://prehrajto.streamstr.stream/media/signed-id",
        filename: "Movie.mp4"
      })
    });
    const { playbackUrl } = await register.json();
    const media = await fetch(`${baseUrl}${playbackUrl}`);
    assert.equal(media.status, 502);
    const payload = await media.json();
    assert.match(payload.error, /verification page/i);
  });
});

test("HLS playlists rewrite allowed streamstr variants and segments through opaque proxy URLs", () => {
  const registered = [];
  const playlist = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=5000000",
    "variant/high.m3u8",
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
    "segment-001.ts",
    "https://example.com/external.ts"
  ].join("\n");
  const rewritten = rewriteBrowserMediaHlsPlaylist(
    playlist,
    "https://prehrajto.streamstr.stream/hls/master.m3u8",
    (url) => {
      registered.push(url);
      return `/proxy/${registered.length}`;
    }
  );
  assert.match(rewritten, /\/proxy\/1/);
  assert.match(rewritten, /URI="\/proxy\/2"/);
  assert.match(rewritten, /\/proxy\/3/);
  assert.match(rewritten, /https:\/\/example\.com\/external\.ts/);
  assert.deepEqual(registered, [
    "https://prehrajto.streamstr.stream/hls/variant/high.m3u8",
    "https://prehrajto.streamstr.stream/hls/keys/key.bin",
    "https://prehrajto.streamstr.stream/hls/segment-001.ts"
  ]);
});
