import http from "node:http";
import { execFile } from "node:child_process";

const originalCreateServer = http.createServer;
const probeCache = new Map();
const PROBE_TTL_MS = 2 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10000;

function parseMediaHlsRequest(request) {
  if (!request || (request.method !== "GET" && request.method !== "HEAD")) {
    return null;
  }
  try {
    const url = new URL(request.url || "/", `http://${request.headers?.host || "localhost"}`);
    const masterMatch = url.pathname.match(/^\/api\/media-hls\/([^/]+)\/master\.m3u8$/i);
    if (masterMatch) {
      return { kind: "master", token: decodeURIComponent(masterMatch[1]) };
    }
    const variantMatch = url.pathname.match(
      /^\/api\/media-hls\/([^/]+)\/(video0|audio0)\.m3u8$/i
    );
    if (variantMatch) {
      return {
        kind: "variant",
        token: decodeURIComponent(variantMatch[1]),
        track: variantMatch[2].toLowerCase()
      };
    }
    return null;
  } catch (_) {
    return null;
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

function rawMediaUrl(token) {
  const port = Number(process.env.PORT || 4173);
  return `http://127.0.0.1:${port}/api/media-proxy/play/${encodeURIComponent(token)}/media?__nuvio_raw=1`;
}

function probeDurationSeconds(token) {
  const cached = probeCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        rawMediaUrl(token)
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const duration = Number(String(stdout || "").trim());
        if (!Number.isFinite(duration) || duration <= 0) {
          reject(new Error("ffprobe returned no usable duration"));
          return;
        }
        resolve(duration);
      }
    );
  });

  probeCache.set(token, { promise, expiresAt: Date.now() + PROBE_TTL_MS });
  promise.catch(() => {
    const current = probeCache.get(token);
    if (current?.promise === promise) probeCache.delete(token);
  });
  return promise;
}

function buildFastVariantPlaylist(track, durationSeconds) {
  const isAudio = track === "audio0";
  const segmentDuration = isAudio ? 4.096 : 4;
  const targetDuration = Math.ceil(segmentDuration);
  const segmentCount = Math.max(1, Math.ceil(durationSeconds / segmentDuration));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:1",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-MAP:URI=\"${track}/init.mp4\"`
  ];

  for (let index = 1; index <= segmentCount; index += 1) {
    const start = (index - 1) * segmentDuration;
    const remaining = Math.max(0, durationSeconds - start);
    const currentDuration = Math.min(segmentDuration, remaining || segmentDuration);
    lines.push(`#EXTINF:${currentDuration.toFixed(6)},`);
    lines.push(`${track}/segment${index}.m4s`);
  }
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

function writePlaylist(request, response, bodyText) {
  const body = Buffer.from(bodyText, "utf8");
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "private, no-store",
    "Content-Length": body.length,
    "Content-Type": "application/vnd.apple.mpegurl"
  });
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

function wrapListener(listener) {
  return function fastHlsListener(request, response) {
    const match = parseMediaHlsRequest(request);
    if (!match) {
      return listener(request, response);
    }

    if (match.kind === "master") {
      writePlaylist(request, response, buildFastMasterPlaylist());
      console.log("[hls-fast-master] served Prehrajto master immediately");
      return;
    }

    void probeDurationSeconds(match.token)
      .then((durationSeconds) => {
        if (response.headersSent || response.writableEnded) return;
        writePlaylist(request, response, buildFastVariantPlaylist(match.track, durationSeconds));
        console.log(
          `[hls-fast-variant] served ${match.track} duration=${durationSeconds.toFixed(3)}s`
        );
      })
      .catch((error) => {
        console.warn(
          `[hls-fast-variant] probe failed track=${match.track}: ${error?.message || error}`
        );
        if (!response.headersSent && !response.writableEnded) {
          listener(request, response);
        }
      });
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
