import http from "node:http";

const originalCreateServer = http.createServer;

function isFastMediaMasterRequest(request) {
  if (!request || (request.method !== "GET" && request.method !== "HEAD")) {
    return false;
  }
  try {
    const url = new URL(request.url || "/", `http://${request.headers?.host || "localhost"}`);
    return /^\/api\/media-hls\/[^/]+\/master\.m3u8$/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function buildFastMasterPlaylist() {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",AUTOSELECT=YES,DEFAULT=YES,URI="audio0.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=35000000,AUDIO="audio"',
    "video0.m3u8",
    ""
  ].join("\n");
}

function wrapListener(listener) {
  return function fastMasterListener(request, response) {
    if (isFastMediaMasterRequest(request)) {
      const body = Buffer.from(buildFastMasterPlaylist(), "utf8");
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "private, no-store",
        "Content-Length": body.length,
        "Content-Type": "application/vnd.apple.mpegurl"
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        response.end(body);
      }
      console.log("[hls-fast-master] served Prehrajto master immediately");
      return;
    }
    return listener(request, response);
  };
}

http.createServer = function patchedCreateServer(optionsOrListener, maybeListener) {
  if (typeof optionsOrListener === "function") {
    return originalCreateServer.call(this, wrapListener(optionsOrListener));
  }
  if (typeof maybeListener === "function") {
    return originalCreateServer.call(this, optionsOrListener, wrapListener(maybeListener));
  }
  return originalCreateServer.apply(this, arguments);
};
