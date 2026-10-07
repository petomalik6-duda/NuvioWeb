import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  createBrowserMediaProxyHandler,
  sniffMediaMime
} from "./bridge.mjs";

function mp4Bytes() {
  return new Uint8Array([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00
  ]);
}

test("sniffMediaMime detects common media containers", () => {
  assert.equal(sniffMediaMime(mp4Bytes()), "video/mp4");
  assert.equal(sniffMediaMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61])), "video/x-matroska");
  assert.equal(sniffMediaMime(new TextEncoder().encode("<html><body>verify</body></html>")), "text/html");
  const ts = new Uint8Array(189);
  ts[0] = 0x47;
  ts[188] = 0x47;
  assert.equal(sniffMediaMime(ts), "video/mp2t");
});

async function withServer(fetchImpl, callback) {
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

test("generic upstream MP4 is exposed to Safari as video/mp4", async () => {
  const fetchImpl = async () =>
    new Response(mp4Bytes(), {
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "content-range": "bytes 0-15/1000",
        "content-length": "16",
        "accept-ranges": "bytes"
      }
    });

  await withServer(fetchImpl, async (baseUrl) => {
    const registered = await fetch(`${baseUrl}/api/media-proxy/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://prehrajto.streamstr.stream/media/signed-value",
        filename: "media"
      })
    });
    assert.equal(registered.status, 200);
    const { playbackUrl } = await registered.json();
    const response = await fetch(`${baseUrl}${playbackUrl}`, {
      headers: { Range: "bytes=0-15" }
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("x-nuvio-detected-mime"), "video/mp4");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...mp4Bytes()]);
  });
});
