import http from "node:http";
import { normalizeYouTubeVideoId, resolveYouTubeStream } from "./youtubeStreamResolver.mjs";

const originalCreateServer = http.createServer.bind(http);
const ROUTE_PATTERN = /^\/api\/youtube-stream\/([^/]+)\/master\.m3u8$/;

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function handleYouTubeStreamRequest(request, response) {
  let parsed;
  try {
    parsed = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  } catch (_) {
    return false;
  }

  const match = parsed.pathname.match(ROUTE_PATTERN);
  if (!match) return false;

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Accept, Range",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    });
    response.end();
    return true;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    writeJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  let rawId = "";
  try {
    rawId = decodeURIComponent(match[1] || "");
  } catch (_) {
    writeJson(response, 400, { error: "Invalid YouTube id" });
    return true;
  }
  const videoId = normalizeYouTubeVideoId(rawId);
  if (!videoId) {
    writeJson(response, 400, { error: "Invalid YouTube id" });
    return true;
  }

  try {
    const resolved = await resolveYouTubeStream(videoId);
    if (!resolved?.url) {
      writeJson(response, 502, { error: "Could not resolve YouTube stream" });
      return true;
    }
    if (resolved.kind !== "hls") {
      // This public route intentionally has an HLS suffix so Nuvio selects the
      // HLS engine. Do not feed a progressive MP4 to an HLS parser.
      writeJson(response, 502, {
        error: "YouTube did not provide a single HLS source",
        resolverClient: resolved.client || null
      });
      return true;
    }

    console.log(`[youtube-stream] ytId=${videoId} client=${resolved.client || "unknown"} kind=hls`);
    response.writeHead(307, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      Location: resolved.url
    });
    response.end();
    return true;
  } catch (error) {
    console.warn(
      `[youtube-stream] ytId=${videoId} failed=${String(error?.message || error || "unknown")}`
    );
    writeJson(response, 502, { error: "Could not resolve YouTube stream" });
    return true;
  }
}

http.createServer = function nuvioYouTubeCreateServer(options, requestListener) {
  const hasOptions = typeof options !== "function";
  const listener = hasOptions ? requestListener : options;
  const wrappedListener = async (request, response) => {
    try {
      if (await handleYouTubeStreamRequest(request, response)) return;
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, 500, { error: "YouTube stream bridge failed" });
        return;
      }
      if (!response.writableEnded) response.end();
      return;
    }
    if (typeof listener === "function") {
      listener(request, response);
      return;
    }
    response.writeHead(404);
    response.end();
  };

  return hasOptions
    ? originalCreateServer(options, wrappedListener)
    : originalCreateServer(wrappedListener);
};

export { handleYouTubeStreamRequest };
