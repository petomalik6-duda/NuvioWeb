import assert from "node:assert/strict";
import test from "node:test";
import {
  isStreamstrMediaUrl,
  prepareBrowserMediaProxyStream
} from "./browserMediaProxy.js";

test("browser media proxy only targets HTTPS streamstr hosts", () => {
  assert.equal(isStreamstrMediaUrl("https://prehrajto.streamstr.stream/video"), true);
  assert.equal(isStreamstrMediaUrl("https://cdn.streamstr.stream/video.mp4"), true);
  assert.equal(isStreamstrMediaUrl("http://prehrajto.streamstr.stream/video"), false);
  assert.equal(isStreamstrMediaUrl("https://streamstr.stream.evil.example/video"), false);
  assert.equal(isStreamstrMediaUrl("https://example.com/video.mp4"), false);
});

test("streamstr streams register an opaque same-origin playback URL and keep provider headers server-side", async () => {
  let request = null;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      async json() {
        return { playbackUrl: "/api/media-proxy/play/token123/Movie.mp4" };
      }
    };
  };
  const stream = {
    url: "https://prehrajto.streamstr.stream/media/signed-value",
    behaviorHints: {
      filename: "Movie.mp4",
      notWebReady: true,
      proxyHeaders: {
        request: {
          Referer: "https://prehrajto.cz/",
          Authorization: "Bearer private-provider-token"
        }
      }
    }
  };

  const prepared = await prepareBrowserMediaProxyStream(stream, { fetchImpl });
  assert.equal(request.url, "/api/media-proxy/register");
  assert.equal(request.init.method, "POST");
  const body = JSON.parse(request.init.body);
  assert.equal(body.url, stream.url);
  assert.equal(body.requestHeaders.Referer, "https://prehrajto.cz/");
  assert.equal(body.requestHeaders.Authorization, "Bearer private-provider-token");
  assert.equal(prepared.url, "/api/media-proxy/play/token123/Movie.mp4");
  assert.equal(prepared.behaviorHints.notWebReady, false);
  assert.equal(prepared.behaviorHints.browserMediaProxy, true);
});

test("non-streamstr sources remain untouched and do not call the proxy server", async () => {
  let called = false;
  const stream = { url: "https://example.com/movie.mp4" };
  const prepared = await prepareBrowserMediaProxyStream(stream, {
    fetchImpl: async () => {
      called = true;
      throw new Error("should not be called");
    }
  });
  assert.equal(called, false);
  assert.equal(prepared, stream);
});
