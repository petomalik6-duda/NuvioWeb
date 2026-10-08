import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";

const originalCreateServer = http.createServer.bind(http);
const registrations = new Map();
const TOKEN_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.FASTSHARE3_TOKEN_TTL_MS || 2 * 60 * 60 * 1000));
const TOKEN_MAX = Math.max(100, Number(process.env.FASTSHARE3_TOKEN_MAX || 2000));
const REGISTER_PATH = "/api/fastshare3/register";
const PLAY_PATTERN = /^\/api\/fastshare3\/play\/([A-Za-z0-9_-]+)(?:\/([^/?#]+))?$/;
const ALLOWED_KODI_HEADERS = new Set(["accept", "cookie", "origin", "referer", "user-agent"]);

function isAllowedFastShareUrl(value = "") {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "fastshare.cz" ||
      host.endsWith(".fastshare.cz") ||
      host === "fastshare.cloud" ||
      host.endsWith(".fastshare.cloud")
    );
  } catch (_) {
    return false;
  }
}

function safeDecode(value = "") {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
  } catch (_) {
    return String(value || "");
  }
}

function parseKodiPipeSpec(value = "") {
  const raw = String(value || "").trim();
  const pipe = raw.indexOf("|");
  if (pipe <= 0) return null;
  const url = raw.slice(0, pipe).trim();
  if (!isAllowedFastShareUrl(url)) return null;

  const headers = {};
  const encodedHeaders = raw.slice(pipe + 1);
  for (const entry of encodedHeaders.split("&")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    const rawName = separator >= 0 ? entry.slice(0, separator) : entry;
    const rawValue = separator >= 0 ? entry.slice(separator + 1) : "";
    const name = safeDecode(rawName).trim().toLowerCase();
    if (!ALLOWED_KODI_HEADERS.has(name)) continue;
    const valueText = safeDecode(rawValue).trim();
    if (!valueText) continue;
    headers[name] = valueText;
  }
  return { url, headers };
}

function playbackFilename(value = "") {
  const raw = String(value || "").split(/[\\/]/).pop() || "video";
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-zA-Z0-9._()\[\] -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-180);
  return cleaned || "video";
}

function cleanup(now = Date.now()) {
  for (const [token, entry] of registrations) {
    if (!entry || entry.expiresAt <= now) registrations.delete(token);
  }
  while (registrations.size > TOKEN_MAX) {
    registrations.delete(registrations.keys().next().value);
  }
}

function remember(spec, filename = "") {
  cleanup();
  const token = crypto.randomBytes(18).toString("base64url");
  registrations.set(token, {
    ...spec,
    filename: playbackFilename(filename),
    expiresAt: Date.now() + TOKEN_TTL_MS
  });
  cleanup();
  return token;
}

function getRegistration(token) {
  cleanup();
  const entry = registrations.get(String(token || ""));
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) registrations.delete(String(token || ""));
    return null;
  }
  return entry;
}

function publicBaseUrl(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const host = forwardedHost || String(request.headers.host || "").trim();
  const protocol = forwardedProto || "https";
  return host ? `${protocol}://${host}` : "";
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request, maxBytes = 16 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function fetchWithSafeRedirects(url, options, maxRedirects = 5) {
  let current = String(url || "");
  for (let index = 0; index <= maxRedirects; index += 1) {
    if (!isAllowedFastShareUrl(current)) {
      throw new Error("unsupported FastShare redirect host");
    }
    const response = await fetch(current, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    current = new URL(location, current).href;
  }
  throw new Error("too many FastShare redirects");
}

function copyHeader(upstream, response, name) {
  const value = upstream.headers.get(name);
  if (value) response.setHeader(name, value);
}

async function handleRegister(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    });
    response.end();
    return true;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (_) {
    writeJson(response, 400, { error: "Invalid request" });
    return true;
  }
  const spec = parseKodiPipeSpec(payload?.spec || payload?.url || "");
  if (!spec) {
    writeJson(response, 400, { error: "Unsupported FastShare3 Kodi URL" });
    return true;
  }
  const token = remember(spec, payload?.filename || "video");
  const base = publicBaseUrl(request);
  const filename = encodeURIComponent(playbackFilename(payload?.filename || "video"));
  const playbackUrl = `${base}/api/fastshare3/play/${token}/${filename}`;
  writeJson(response, 200, { playbackUrl });
  return true;
}

async function handlePlayback(request, response, match) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Accept, Range, If-Range, If-None-Match, If-Modified-Since",
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

  const entry = getRegistration(match[1]);
  if (!entry) {
    writeJson(response, 404, { error: "FastShare3 playback link expired. Reload sources." });
    return true;
  }

  const headers = { ...entry.headers };
  if (!headers.accept) headers.accept = String(request.headers.accept || "*/*");
  if (!headers["user-agent"]) {
    headers["user-agent"] = String(request.headers["user-agent"] || "NuvioWeb FastShare3");
  }
  for (const name of ["range", "if-range", "if-none-match", "if-modified-since"]) {
    const value = request.headers[name];
    if (value) headers[name] = String(value);
  }

  let upstream;
  try {
    upstream = await fetchWithSafeRedirects(entry.url, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers
    });
  } catch (error) {
    console.warn(`[fastshare3] playback failed: ${String(error?.message || error)}`);
    writeJson(response, 502, { error: "FastShare3 playback connection failed" });
    return true;
  }

  response.statusCode = upstream.status;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified"
  );
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "etag",
    "last-modified",
    "content-disposition"
  ]) {
    copyHeader(upstream, response, name);
  }

  if (request.method === "HEAD" || !upstream.body) {
    response.end();
    return true;
  }

  const body = Readable.fromWeb(upstream.body);
  body.on("error", () => {
    if (!response.writableEnded) response.end();
  });
  response.on("close", () => {
    if (!response.writableEnded) body.destroy();
  });
  body.pipe(response);
  return true;
}

async function handleFastShare3Request(request, response) {
  let parsed;
  try {
    parsed = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  } catch (_) {
    return false;
  }
  if (parsed.pathname === REGISTER_PATH) {
    return handleRegister(request, response);
  }
  const match = parsed.pathname.match(PLAY_PATTERN);
  if (match) {
    return handlePlayback(request, response, match);
  }
  return false;
}

http.createServer = function nuvioFastShare3CreateServer(options, requestListener) {
  const hasOptions = typeof options !== "function";
  const listener = hasOptions ? requestListener : options;
  const wrappedListener = async (request, response) => {
    try {
      if (await handleFastShare3Request(request, response)) return;
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, 500, { error: "FastShare3 bridge failed" });
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

export { handleFastShare3Request, isAllowedFastShareUrl, parseKodiPipeSpec };
