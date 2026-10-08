import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";

const originalRequest = http.request.bind(http);
const inflightPlaylists = new Map();
const playlistCache = new Map();
const PLAYLIST_CACHE_MS = Math.max(1000, Number(process.env.NUVIO_HLS_PLAYLIST_CACHE_MS || 5000));
const LOCAL_MEDIA_PORTS = new Set([2710, 2711, 2712, 2713, 2714]);

function normalizeHost(options = {}) {
  return String(options.hostname || options.host || "").split(":")[0].toLowerCase();
}

function normalizePort(options = {}) {
  const raw = Number(options.port || 80);
  return Number.isFinite(raw) ? raw : 0;
}

function normalizePath(options = {}) {
  return String(options.path || options.pathname || "");
}

function isLocalHlsPlaylistRequest(options = {}) {
  const host = normalizeHost(options);
  const port = normalizePort(options);
  const requestPath = normalizePath(options);
  const method = String(options.method || "GET").toUpperCase();
  return (
    method === "GET" &&
    (host === "127.0.0.1" || host === "localhost") &&
    LOCAL_MEDIA_PORTS.has(port) &&
    requestPath.startsWith("/hlsv2/") &&
    /\.m3u8(?:\?|$)/i.test(requestPath)
  );
}

function playlistKey(options = {}) {
  return `${normalizePort(options)}:${normalizePath(options)}`;
}

function cloneResult(result) {
  return {
    statusCode: Number(result?.statusCode || 0),
    statusMessage: String(result?.statusMessage || ""),
    headers: { ...(result?.headers || {}) },
    rawHeaders: Array.isArray(result?.rawHeaders) ? [...result.rawHeaders] : [],
    body: Buffer.isBuffer(result?.body) ? Buffer.from(result.body) : Buffer.from(result?.body || "")
  };
}

function syntheticResponse(result) {
  const response = new PassThrough();
  response.statusCode = Number(result?.statusCode || 0);
  response.statusMessage = String(result?.statusMessage || "");
  response.headers = { ...(result?.headers || {}) };
  response.rawHeaders = Array.isArray(result?.rawHeaders) ? [...result.rawHeaders] : [];
  queueMicrotask(() => response.end(result?.body || Buffer.alloc(0)));
  return response;
}

function requestPlaylistOnce(options, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = originalRequest(options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("error", finishReject);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: response.statusCode || 0,
          statusMessage: response.statusMessage || "",
          headers: response.headers || {},
          rawHeaders: response.rawHeaders || [],
          body: Buffer.concat(chunks)
        });
      });
    });
    if (Number(timeoutMs) > 0) {
      request.setTimeout(Number(timeoutMs), () => {
        request.destroy(new Error(`Local HLS playlist request timed out after ${timeoutMs}ms`));
      });
    }
    request.on("error", finishReject);
    request.end();
  });
}

function getPlaylistResult(options, timeoutMs = 0) {
  const key = playlistKey(options);
  const cached = playlistCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cloneResult(cached.result));
  }
  if (cached) {
    playlistCache.delete(key);
  }

  const existing = inflightPlaylists.get(key);
  if (existing) {
    console.log(`[hls-singleflight] join ${normalizePath(options).split("?")[0]}`);
    return existing.then(cloneResult);
  }

  const requestPromise = requestPlaylistOnce(options, timeoutMs)
    .then((result) => {
      if (result.statusCode >= 200 && result.statusCode < 300) {
        playlistCache.set(key, {
          result: cloneResult(result),
          expiresAt: Date.now() + PLAYLIST_CACHE_MS
        });
      }
      return result;
    })
    .finally(() => {
      if (inflightPlaylists.get(key) === requestPromise) {
        inflightPlaylists.delete(key);
      }
    });

  inflightPlaylists.set(key, requestPromise);
  return requestPromise.then(cloneResult);
}

class DeferredPlaylistRequest extends EventEmitter {
  constructor(options, callback) {
    super();
    this.options = options;
    this.callback = typeof callback === "function" ? callback : null;
    this.timeoutMs = 0;
    this.ended = false;
    this.destroyed = false;
  }

  setTimeout(timeoutMs, callback) {
    this.timeoutMs = Number(timeoutMs) || 0;
    if (typeof callback === "function") {
      this.once("timeout", callback);
    }
    return this;
  }

  write() {
    return true;
  }

  end() {
    if (this.ended || this.destroyed) return this;
    this.ended = true;
    getPlaylistResult(this.options, this.timeoutMs)
      .then((result) => {
        if (this.destroyed) return;
        const response = syntheticResponse(result);
        this.callback?.(response);
        this.emit("response", response);
        this.emit("finish");
      })
      .catch((error) => {
        if (!this.destroyed) this.emit("error", error);
      });
    return this;
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit("error", error));
    return this;
  }

  abort() {
    return this.destroy();
  }
}

http.request = function patchedRequest(options, callback) {
  if (!isLocalHlsPlaylistRequest(options)) {
    return originalRequest(options, callback);
  }
  return new DeferredPlaylistRequest(options, callback);
};
