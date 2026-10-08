import crypto from "node:crypto";
import { Readable } from "node:stream";

const ALLOWED_MEDIA_ROOT = "streamstr.stream";
const TOKEN_TTL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.NUVIO_MEDIA_PROXY_TOKEN_TTL_MS || 2 * 60 * 60 * 1000)
);
const TOKEN_MAX = Math.max(100, Number(process.env.NUVIO_MEDIA_PROXY_TOKEN_MAX || 4000));
const BODY_LIMIT_BYTES = 32 * 1024;

const forbiddenForwardHeaders = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "upgrade",
  "te",
  "trailer"
]);

export function isAllowedBrowserMediaUrl(value = "") {
  try {
    const parsed = new URL(String(value || ""));
    const hostname = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === "https:" &&
      (hostname === ALLOWED_MEDIA_ROOT || hostname.endsWith(`.${ALLOWED_MEDIA_ROOT}`))
    );
  } catch (_) {
    return false;
  }
}

export function sanitizeBrowserMediaHeaders(headers = {}) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }
  const entries = Object.entries(headers)
    .map(([name, value]) => [String(name || "").trim(), String(value ?? "").trim()])
    .filter(([name, value]) => name && value)
    .filter(([name]) => {
      const lower = name.toLowerCase();
      return !forbiddenForwardHeaders.has(lower) && !lower.startsWith("sec-");
    });
  return Object.fromEntries(entries.slice(0, 40));
}

export function sanitizeBrowserMediaFilename(value = "") {
  const raw = String(value || "").split(/[\\/]/).pop() || "";
  const basename = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-zA-Z0-9._()\[\] -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-180);
  return basename || "media";
}

function isGenericMediaContentType(value = "") {
  const normalized = String(value || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized === "application/octet-stream" ||
    normalized === "binary/octet-stream" ||
    normalized === "application/binary" ||
    normalized === "application/download"
  );
}

function mimeFromFilename(filename = "") {
  const clean = String(filename || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".mp4") || clean.endsWith(".m4v")) return "video/mp4";
  if (clean.endsWith(".mov")) return "video/quicktime";
  if (clean.endsWith(".mkv")) return "video/x-matroska";
  if (clean.endsWith(".webm")) return "video/webm";
  if (clean.endsWith(".ts") || clean.endsWith(".m2ts")) return "video/mp2t";
  return "";
}

export function sniffMediaMime(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
  if (!bytes.length) return "";

  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return "video/mp4";
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096)))
      .toString("latin1")
      .toLowerCase();
    return prefix.includes("webm") ? "video/webm" : "video/x-matroska";
  }

  if (bytes[0] === 0x47) {
    if (bytes.length < 189 || bytes[188] === 0x47) {
      return "video/mp2t";
    }
  }

  const textPrefix = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024)))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (
    textPrefix.startsWith("<!doctype html") ||
    textPrefix.startsWith("<html") ||
    textPrefix.includes("<html")
  ) {
    return "text/html";
  }

  return "";
}

async function sniffReadableBody(body) {
  if (!body || typeof body.tee !== "function") {
    return { body, detectedMime: "" };
  }
  const [sniffBranch, playbackBranch] = body.tee();
  const reader = sniffBranch.getReader();
  try {
    const first = await reader.read();
    return {
      body: playbackBranch,
      detectedMime: first?.value ? sniffMediaMime(first.value) : ""
    };
  } finally {
    try {
      await reader.cancel();
    } catch (_) {
      // Best effort. The playback branch remains untouched.
    }
  }
}

function isHlsResponse(url = "", contentType = "") {
  const normalizedType = String(contentType || "").toLowerCase();
  if (
    normalizedType.includes("application/vnd.apple.mpegurl") ||
    normalizedType.includes("application/x-mpegurl") ||
    normalizedType.includes("audio/mpegurl") ||
    normalizedType.includes("audio/x-mpegurl")
  ) {
    return true;
  }
  try {
    return new URL(String(url || "")).pathname.toLowerCase().endsWith(".m3u8");
  } catch (_) {
    return false;
  }
}

export function rewriteBrowserMediaHlsPlaylist(text, manifestUrl, registerUrl) {
  const resolveProxyUrl = (value) => {
    try {
      const resolved = new URL(String(value || ""), manifestUrl).toString();
      if (!isAllowedBrowserMediaUrl(resolved)) {
        return value;
      }
      return registerUrl(resolved);
    } catch (_) {
      return value;
    }
  };

  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return line;
      }
      if (!trimmed.startsWith("#")) {
        return resolveProxyUrl(trimmed);
      }
      return line.replace(/URI=("([^"]+)"|'([^']+)')/gi, (match, quoted, doubleValue, singleValue) => {
        const value = doubleValue ?? singleValue ?? "";
        const proxied = resolveProxyUrl(value);
        const quote = quoted.startsWith("'") ? "'" : '"';
        return `URI=${quote}${proxied}${quote}`;
      });
    })
    .join("\n");
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function copyResponseHeader(upstream, responseHeaders, name) {
  const value = upstream.headers.get(name);
  if (value) {
    responseHeaders[name] = value;
  }
}

function redirectLocation(upstream, currentUrl) {
  const location = upstream.headers.get("location");
  if (!location) {
    return "";
  }
  try {
    return new URL(location, currentUrl).toString();
  } catch (_) {
    return "";
  }
}

async function fetchWithAllowedRedirects(fetchImpl, initialUrl, options, maxRedirects = 5) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (!isAllowedBrowserMediaUrl(currentUrl)) {
      throw new Error("Media redirect left the allowed provider domain");
    }
    const upstream = await fetchImpl(currentUrl, {
      ...options,
      redirect: "manual"
    });
    if (![301, 302, 303, 307, 308].includes(Number(upstream.status || 0))) {
      return { upstream, finalUrl: currentUrl };
    }
    const nextUrl = redirectLocation(upstream, currentUrl);
    if (!nextUrl) {
      return { upstream, finalUrl: currentUrl };
    }
    currentUrl = nextUrl;
  }
  throw new Error("Too many media redirects");
}

export function createBrowserMediaProxyHandler({ fetchImpl = globalThis.fetch } = {}) {
  const targets = new Map();

  const cleanup = (now = Date.now()) => {
    for (const [token, entry] of targets.entries()) {
      if (!entry || entry.expiresAt <= now) {
        targets.delete(token);
      }
    }
    while (targets.size > TOKEN_MAX) {
      targets.delete(targets.keys().next().value);
    }
  };

  const rememberTarget = (url, requestHeaders = {}, filename = "") => {
    if (!isAllowedBrowserMediaUrl(url)) {
      return null;
    }
    cleanup();
    const token = crypto.randomBytes(18).toString("base64url");
    targets.set(token, {
      url: String(url),
      requestHeaders: sanitizeBrowserMediaHeaders(requestHeaders),
      filename: sanitizeBrowserMediaFilename(filename),
      expiresAt: Date.now() + TOKEN_TTL_MS
    });
    return token;
  };

  const playbackPath = (token, filename = "media", { raw = false } = {}) => {
    const base = `/api/media-proxy/play/${encodeURIComponent(token)}/${encodeURIComponent(
      sanitizeBrowserMediaFilename(filename)
    )}`;
    return raw ? `${base}?__nuvio_raw=1` : base;
  };

  const hlsPlaybackPath = (token) => `/api/media-hls/${encodeURIComponent(token)}/master.m3u8`;

  const registerResolvedUrl = (url, parentEntry, { raw = false } = {}) => {
    const filename = (() => {
      try {
        return decodeURIComponent(new URL(url).pathname.split("/").pop() || "media");
      } catch (_) {
        return "media";
      }
    })();
    const token = rememberTarget(url, parentEntry.requestHeaders, filename);
    return token ? playbackPath(token, filename, { raw }) : url;
  };

  return async function browserMediaProxyHandler(request, response) {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const rawPlaybackRequest = requestUrl.searchParams.get("__nuvio_raw") === "1";

    if (request.method === "OPTIONS") {
      // Same-origin browser requests do not need CORS. Omitting ACAO here keeps
      // third-party sites from turning this endpoint into a public bandwidth proxy.
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return true;
    }

    if (requestUrl.pathname === "/api/media-proxy/register") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "Method not allowed" });
        return true;
      }
      const contentType = String(request.headers["content-type"] || "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        writeJson(response, 415, { error: "JSON request required" });
        return true;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (_) {
        writeJson(response, 400, { error: "Invalid media proxy request" });
        return true;
      }
      const targetUrl = String(body?.url || "").trim();
      if (!isAllowedBrowserMediaUrl(targetUrl)) {
        writeJson(response, 403, { error: "Unsupported media provider" });
        return true;
      }
      const filename = sanitizeBrowserMediaFilename(body?.filename || "media");
      const token = rememberTarget(targetUrl, body?.requestHeaders || {}, filename);
      if (!token) {
        writeJson(response, 403, { error: "Unsupported media provider" });
        return true;
      }
      writeJson(response, 200, {
        ok: true,
        playbackUrl: hlsPlaybackPath(token),
        nativePlaybackUrl: playbackPath(token, filename)
      });
      return true;
    }

    const playMatch = requestUrl.pathname.match(/^\/api\/media-proxy\/play\/([^/]+)(?:\/.*)?$/);
    if (!playMatch) {
      return false;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      writeJson(response, 405, { error: "Method not allowed" });
      return true;
    }

    cleanup();
    const token = decodeURIComponent(playMatch[1] || "");
    const entry = targets.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) targets.delete(token);
      writeJson(response, 404, { error: "Playback link expired. Reload the source list." });
      return true;
    }

    const upstreamHeaders = { ...entry.requestHeaders };
    const incomingHeaderMap = {
      range: "Range",
      "if-range": "If-Range",
      "if-none-match": "If-None-Match",
      "if-modified-since": "If-Modified-Since",
      accept: "Accept"
    };
    for (const [incomingName, outgoingName] of Object.entries(incomingHeaderMap)) {
      const value = request.headers[incomingName];
      if (value) {
        upstreamHeaders[outgoingName] = String(value);
      }
    }
    if (!Object.keys(upstreamHeaders).some((name) => name.toLowerCase() === "user-agent")) {
      upstreamHeaders["User-Agent"] =
        String(request.headers["user-agent"] || "").trim() || "NuvioWeb Media Proxy";
    }

    let initialProviderHost = "unknown";
    try {
      initialProviderHost = new URL(entry.url).hostname;
    } catch (_) {}

    let result;
    try {
      result = await fetchWithAllowedRedirects(fetchImpl, entry.url, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: upstreamHeaders
      });
    } catch (error) {
      console.warn(
        `[media-proxy] provider-request-failed host=${initialProviderHost} reason=${
          String(error?.message || "request-failed").replace(/\s+/g, " ").slice(0, 120)
        }`
      );
      writeJson(response, 502, {
        error: "Media provider request failed",
        detail: String(error?.message || error || "")
      });
      return true;
    }

    const { upstream, finalUrl } = result;
    const contentType = String(upstream.headers.get("content-type") || "");
    if (contentType.toLowerCase().includes("text/html")) {
      let providerHost = initialProviderHost;
      try {
        providerHost = new URL(finalUrl).hostname;
      } catch (_) {}
      console.warn(
        `[media-proxy] provider-html host=${providerHost} status=${Number(upstream.status || 0)}`
      );
      upstream.body?.cancel?.().catch?.(() => {});
      writeJson(response, 502, {
        error: "Media provider returned a browser verification page instead of video",
        upstreamStatus: Number(upstream.status || 0)
      });
      return true;
    }

    const baseHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers":
        "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified, X-Nuvio-Detected-Mime",
      "Cache-Control": "private, no-store"
    };
    copyResponseHeader(upstream, baseHeaders, "content-type");
    copyResponseHeader(upstream, baseHeaders, "content-range");
    copyResponseHeader(upstream, baseHeaders, "content-length");
    copyResponseHeader(upstream, baseHeaders, "accept-ranges");
    copyResponseHeader(upstream, baseHeaders, "etag");
    copyResponseHeader(upstream, baseHeaders, "last-modified");
    if (!baseHeaders["accept-ranges"]) {
      baseHeaders["Accept-Ranges"] = "bytes";
    }

    if (request.method === "HEAD") {
      if (isGenericMediaContentType(contentType)) {
        const filenameMime = mimeFromFilename(entry.filename);
        if (filenameMime) {
          baseHeaders["Content-Type"] = filenameMime;
          baseHeaders["X-Nuvio-Detected-Mime"] = filenameMime;
        }
      }
      response.writeHead(upstream.status || 200, baseHeaders);
      upstream.body?.cancel?.().catch?.(() => {});
      response.end();
      return true;
    }

    if (isHlsResponse(finalUrl, contentType)) {
      const playlistText = await upstream.text();
      const rewritten = rewriteBrowserMediaHlsPlaylist(playlistText, finalUrl, (url) =>
        registerResolvedUrl(url, entry, { raw: rawPlaybackRequest })
      );
      const playlistHeaders = {
        ...baseHeaders,
        "Content-Type": contentType || "application/vnd.apple.mpegurl",
        "Content-Length": Buffer.byteLength(rewritten)
      };
      delete playlistHeaders["content-length"];
      delete playlistHeaders["content-range"];
      response.writeHead(upstream.status || 200, playlistHeaders);
      response.end(rewritten);
      return true;
    }

    let playbackBody = upstream.body;
    let detectedMime = "";
    if (playbackBody && isGenericMediaContentType(contentType)) {
      const sniffed = await sniffReadableBody(playbackBody);
      playbackBody = sniffed.body;
      detectedMime = sniffed.detectedMime || mimeFromFilename(entry.filename);
      if (detectedMime === "text/html") {
        playbackBody?.cancel?.().catch?.(() => {});
        writeJson(response, 502, {
          error: "Media provider returned a browser verification page instead of video",
          upstreamStatus: Number(upstream.status || 0)
        });
        return true;
      }
      if (detectedMime) {
        baseHeaders["Content-Type"] = detectedMime;
        baseHeaders["X-Nuvio-Detected-Mime"] = detectedMime;
      }
    }

    let providerHost = "unknown";
    try {
      providerHost = new URL(finalUrl).hostname;
    } catch (_) {}
    console.info(
      `[media-proxy] host=${providerHost} status=${Number(upstream.status || 0)} upstreamType=${
        contentType || "none"
      } detected=${detectedMime || "none"}`
    );

    response.writeHead(upstream.status || 200, baseHeaders);
    if (!playbackBody) {
      response.end();
      return true;
    }
    Readable.fromWeb(playbackBody)
      .on("error", () => {
        if (!response.writableEnded) response.end();
      })
      .pipe(response);
    response.on("close", () => {
      if (!response.writableEnded) {
        try {
          playbackBody?.cancel?.();
        } catch (_) {
          // Best effort when the browser cancels a Range request.
        }
      }
    });
    return true;
  };
}
