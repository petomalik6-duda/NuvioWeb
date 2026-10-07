import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRuntimeEnvScript, readEnvProperties } from "./envProperties.mjs";
import { createDebridApiBridgeHandler } from "../services/debrid-api-bridge/bridge.mjs";
import { createExternalReturnHandler } from "../services/external-return-bridge/bridge.mjs";
import { createBrowserMediaProxyHandler } from "../services/browser-media-proxy/bridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 4173);
const mediaRuntimePath = path.join(rootDir, "services", "webos", "runtime", "media-http.cjs");
const mediaServerPorts = [2710, 2711, 2712, 2713, 2714];
const mediaProbeTimeoutMs = 1200;
const mediaHlsTimeoutMs = Math.max(15000, Number(process.env.NUVIO_MEDIA_HLS_TIMEOUT_MS || 60000));
let mediaRuntimeProcess = null;
let cachedMediaServerPort = mediaServerPorts[0];
const debridApiBridgeHandler = createDebridApiBridgeHandler();
const externalReturnHandler = createExternalReturnHandler();
const browserMediaProxyHandler = createBrowserMediaProxyHandler();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m4s": "video/mp4",
  ".vtt": "text/vtt; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8"
};

function getContentType(filePath) {
  return mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function getLanUrls() {
  const interfaces = os.networkInterfaces();
  const urls = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      urls.push(`http://${entry.address}:${port}/`);
    }
  }
  return Array.from(new Set(urls)).sort();
}

function resolveRequestPath(urlPathname) {
  let pathname = decodeURIComponent(String(urlPathname || "/"));
  if (pathname === "/") {
    pathname = "/index.html";
  }
  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  return path.join(rootDir, normalized);
}

function resolveDistPathForRootFile(rootFilePath) {
  const relativePath = path.relative(rootDir, rootFilePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "";
  }
  return path.join(distDir, relativePath);
}

async function resolveRequestFile(pathname) {
  const rootPath = resolveRequestPath(pathname);
  const rootStat = await stat(rootPath).catch(() => null);
  const distPath = resolveDistPathForRootFile(rootPath);
  const distStat = distPath ? await stat(distPath).catch(() => null) : null;
  if (distStat?.isFile()) {
    return { filePath: distPath, fileStat: distStat };
  }

  return { filePath: rootPath, fileStat: rootStat };
}

function requestLocalMediaPath(
  portNumber,
  requestPath,
  { method = "GET", timeoutMs = mediaProbeTimeoutMs } = {}
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: portNumber,
        path: requestPath,
        method
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            port: portNumber,
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Local media request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function findLocalMediaServerPort() {
  const candidates = Array.from(new Set([cachedMediaServerPort, ...mediaServerPorts]));
  for (const candidatePort of candidates) {
    try {
      const result = await requestLocalMediaPath(candidatePort, "/settings", {
        timeoutMs: mediaProbeTimeoutMs
      });
      if (result.statusCode >= 200 && result.statusCode < 500) {
        cachedMediaServerPort = candidatePort;
        return candidatePort;
      }
    } catch (_) {
      // Try the next local media server port.
    }
  }
  return null;
}

async function ensureLocalMediaRuntime() {
  if (process.env.NUVIO_DISABLE_MEDIA_RUNTIME === "1") {
    return null;
  }
  const existingPort = await findLocalMediaServerPort();
  if (existingPort) {
    return existingPort;
  }
  mediaRuntimeProcess = spawn(process.execPath, [mediaRuntimePath], {
    cwd: rootDir,
    stdio: ["ignore", "inherit", "inherit"]
  });
  mediaRuntimeProcess.on("exit", (code, signal) => {
    mediaRuntimeProcess = null;
    if (code || signal) {
      console.warn(`Local media runtime exited (${signal || code}).`);
    }
  });

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const portNumber = await findLocalMediaServerPort();
    if (portNumber) {
      return portNumber;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function proxyLocalMediaRequest(request, response, pathname) {
  const mediaPort = await findLocalMediaServerPort();
  if (!mediaPort) {
    response.writeHead(503, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify({ error: "Local media server unavailable" }));
    return true;
  }

  const proxied = await requestLocalMediaPath(mediaPort, pathname, {
    method: request.method || "GET",
    timeoutMs: 6000
  });
  response.writeHead(proxied.statusCode || 502, {
    "Cache-Control": "no-store",
    "Content-Type": proxied.headers["content-type"] || "application/json; charset=utf-8"
  });
  response.end(proxied.body);
  return true;
}

function getMediaProxyPlaybackToken(pathname) {
  const match = String(pathname || "").match(/^\/api\/media-proxy\/play\/([^/]+)(?:\/.*)?$/);
  if (!match) {
    return "";
  }
  try {
    return decodeURIComponent(match[1] || "");
  } catch (_) {
    return "";
  }
}

function isAllowedMediaHlsTail(value) {
  const tail = String(value || "");
  return (
    tail === "master.m3u8" ||
    /^(?:video|audio|subtitle)\d+\.m3u8$/.test(tail) ||
    /^(?:video|audio)\d+\/init\.mp4$/.test(tail) ||
    /^(?:video|audio|subtitle)\d+\/segment\d+\.(?:m4s|vtt)$/.test(tail)
  );
}

function mediaHlsPublicPath(token, tail = "master.m3u8") {
  return `/api/media-hls/${encodeURIComponent(token)}/${tail}`;
}

function mediaHlsRuntimeId(token) {
  return crypto.createHash("sha256").update(`browser-prehrajto:${token}`).digest("hex").slice(0, 24);
}

function buildMediaHlsRuntimePath(token, tail) {
  const rawSourceUrl = new URL(
    `/api/media-proxy/play/${encodeURIComponent(token)}/media`,
    `http://127.0.0.1:${port}`
  );
  rawSourceUrl.searchParams.set("__nuvio_raw", "1");

  const query = new URLSearchParams({
    mediaURL: rawSourceUrl.toString(),
    forceTranscoding: "1",
    maxAudioChannels: "2"
  });
  return `/hlsv2/${mediaHlsRuntimeId(token)}/${tail}?${query.toString()}`;
}

function writeMediaHlsUnavailable(response, statusCode, detail = "") {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(
    JSON.stringify({
      error: "Prehrajto HLS playback unavailable",
      ...(detail ? { detail } : {})
    })
  );
}

async function proxyMediaHlsRequest(request, response, token, tail) {
  if (!token || !isAllowedMediaHlsTail(tail)) {
    writeMediaHlsUnavailable(response, 404);
    return true;
  }

  const mediaPort = (await findLocalMediaServerPort()) || (await ensureLocalMediaRuntime());
  if (!mediaPort) {
    writeMediaHlsUnavailable(response, 503, "Local media runtime is not available");
    return true;
  }

  const runtimePath = buildMediaHlsRuntimePath(token, tail);
  const isPlaylist = tail.endsWith(".m3u8");

  if (isPlaylist) {
    try {
      const proxied = await requestLocalMediaPath(mediaPort, runtimePath, {
        method: "GET",
        timeoutMs: mediaHlsTimeoutMs
      });
      let body = proxied.body;
      const contentType = String(
        proxied.headers["content-type"] || "application/vnd.apple.mpegurl"
      );

      if (proxied.statusCode >= 200 && proxied.statusCode < 300) {
        const publicBase = mediaHlsPublicPath(token, "");
        const runtimeId = mediaHlsRuntimeId(token);
        const text = body
          .toString("utf8")
          .replaceAll(`http://127.0.0.1:${mediaPort}/hlsv2/${runtimeId}/`, publicBase)
          .replaceAll(`http://localhost:${mediaPort}/hlsv2/${runtimeId}/`, publicBase);
        body = Buffer.from(text, "utf8");
      }

      response.writeHead(proxied.statusCode || 502, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "private, no-store",
        "Content-Length": body.length,
        "Content-Type": contentType
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        response.end(body);
      }
      return true;
    } catch (error) {
      writeMediaHlsUnavailable(response, 502, String(error?.message || error || ""));
      return true;
    }
  }

  await new Promise((resolve) => {
    let responded = false;
    const upstreamRequest = http.request(
      {
        host: "127.0.0.1",
        port: mediaPort,
        path: runtimePath,
        method: "GET",
        headers: {
          Accept: String(request.headers.accept || "*/*")
        }
      },
      (upstreamResponse) => {
        responded = true;
        const headers = {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "private, no-store",
          "Content-Type":
            upstreamResponse.headers["content-type"] || getContentType(tail)
        };
        if (upstreamResponse.headers["content-length"]) {
          headers["Content-Length"] = upstreamResponse.headers["content-length"];
        }
        response.writeHead(upstreamResponse.statusCode || 502, headers);
        if (request.method === "HEAD") {
          upstreamResponse.resume();
          response.end();
          resolve();
          return;
        }
        upstreamResponse.pipe(response);
        upstreamResponse.on("end", resolve);
        upstreamResponse.on("error", () => {
          if (!response.writableEnded) response.end();
          resolve();
        });
      }
    );

    upstreamRequest.setTimeout(mediaHlsTimeoutMs, () => {
      upstreamRequest.destroy(new Error(`HLS media request timed out after ${mediaHlsTimeoutMs}ms`));
    });
    upstreamRequest.on("error", (error) => {
      if (!responded && !response.headersSent) {
        writeMediaHlsUnavailable(response, 502, String(error?.message || error || ""));
      } else if (!response.writableEnded) {
        response.end();
      }
      resolve();
    });
    request.on("close", () => {
      if (!response.writableEnded) {
        upstreamRequest.destroy();
      }
    });
    upstreamRequest.end();
  });
  return true;
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (requestUrl.pathname.startsWith("/api/debrid/")) {
      await debridApiBridgeHandler(request, response);
      return;
    }
    if (requestUrl.pathname.startsWith("/api/external-return/")) {
      externalReturnHandler(request, response);
      return;
    }

    const hlsMatch = requestUrl.pathname.match(/^\/api\/media-hls\/([^/]+)\/(.+)$/);
    if (hlsMatch) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8"
        });
        response.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      let token = "";
      let tail = "";
      try {
        token = decodeURIComponent(hlsMatch[1] || "");
        tail = decodeURIComponent(hlsMatch[2] || "");
      } catch (_) {
        writeMediaHlsUnavailable(response, 400, "Invalid HLS path");
        return;
      }
      await proxyMediaHlsRequest(request, response, token, tail);
      return;
    }

    if (requestUrl.pathname.startsWith("/api/media-proxy/")) {
      const playbackToken = getMediaProxyPlaybackToken(requestUrl.pathname);
      const rawPlayback = requestUrl.searchParams.get("__nuvio_raw") === "1";
      if (playbackToken && !rawPlayback) {
        response.writeHead(307, {
          "Cache-Control": "no-store",
          Location: mediaHlsPublicPath(playbackToken)
        });
        response.end();
        return;
      }
      const handled = await browserMediaProxyHandler(request, response);
      if (handled) {
        return;
      }
    }
    if (requestUrl.pathname === "/nuvio.env.js") {
      const { env } = await readEnvProperties({ rootDir });
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/javascript; charset=utf-8"
      });
      response.end(buildRuntimeEnvScript(env));
      return;
    }

    if (requestUrl.pathname === "/settings" || requestUrl.pathname.startsWith("/tracks/")) {
      await proxyLocalMediaRequest(
        request,
        response,
        `${requestUrl.pathname}${requestUrl.search || ""}`
      );
      return;
    }

    let { filePath, fileStat } = await resolveRequestFile(requestUrl.pathname);

    if (fileStat?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      fileStat = await stat(filePath).catch(() => null);
    }

    if (!fileStat?.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const fileContents = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": getContentType(filePath)
    });
    response.end(fileContents);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Server error: ${error?.message || error}`);
  }
});

await ensureLocalMediaRuntime();

server.listen(port, host, async () => {
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const mediaPort = await findLocalMediaServerPort();
  console.log(`Serving Nuvio from ${rootDir}`);
  console.log(`Local URL: http://${localHost}:${port}/`);
  for (const lanUrl of getLanUrls()) {
    console.log(`LAN URL: ${lanUrl}`);
  }
  console.log(
    mediaPort
      ? `Local media tracks endpoint: http://${localHost}:${port}/tracks/<media-url> -> 127.0.0.1:${mediaPort}`
      : "Local media tracks endpoint unavailable. Install/enable the media runtime to inspect internal tracks."
  );
  console.log(
    "Use one of the URLs above if you want to test the app over http(s) during development."
  );
});

function stopMediaRuntime() {
  if (!mediaRuntimeProcess) {
    return;
  }
  mediaRuntimeProcess.kill("SIGTERM");
  mediaRuntimeProcess = null;
}

process.on("SIGINT", () => {
  stopMediaRuntime();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopMediaRuntime();
  process.exit(0);
});