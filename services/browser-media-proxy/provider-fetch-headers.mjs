const nativeFetch = globalThis.fetch.bind(globalThis);

const PROVIDER_ROOTS = ["streamstr.stream", "premiumcdn.net"];
const STREAMSTR_ROOT = "streamstr.stream";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE = "cs-CZ,cs;q=0.9,en;q=0.8";
const GENERIC_CONTENT_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/download"
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RESOLVED_PROVIDER_URL_TTL_MS = 15 * 60 * 1000;
const RESOLVED_PROVIDER_URL_MAX = 2000;
const resolvedProviderUrls = new Map();

function hostnameMatchesRoot(hostname, root) {
  return hostname === root || hostname.endsWith(`.${root}`);
}

function isProviderUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return PROVIDER_ROOTS.some((root) => hostnameMatchesRoot(hostname, root));
  } catch (_) {
    return false;
  }
}

function isControlledHttpStreamstrUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    return (
      url.protocol === "http:" &&
      hostnameMatchesRoot(url.hostname.toLowerCase(), STREAMSTR_ROOT)
    );
  } catch (_) {
    return false;
  }
}

function isAllowedResolvedProviderUrl(value = "") {
  return isProviderUrl(value) || isControlledHttpStreamstrUrl(value);
}

function resolveRedirectUrl(response, currentUrl) {
  const location = String(response?.headers?.get?.("location") || "").trim();
  if (!location) return "";
  try {
    return new URL(location, currentUrl).toString();
  } catch (_) {
    return "";
  }
}

function inputUrl(input) {
  if (typeof input === "string" || input instanceof URL) return String(input);
  return String(input?.url || "");
}

function normalizedContentType(response) {
  return String(response?.headers?.get?.("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function withImmediateStreamingMime(response) {
  if (!response || response.status < 200 || response.status >= 300) return response;
  if (!GENERIC_CONTENT_TYPES.has(normalizedContentType(response))) return response;

  const headers = new Headers(response.headers || {});
  // This is an internal proxy MIME marker. The media bridge treats generic
  // octet-stream responses as needing first-chunk sniffing; ffprobe does not
  // need that sniffing and can detect the actual container from the bytes.
  // Marking the internal response non-generic lets bytes flow immediately.
  headers.set("Content-Type", "application/vnd.nuvio.raw-media");
  headers.set("X-Nuvio-Original-Content-Type", normalizedContentType(response) || "none");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function cleanupResolvedProviderUrls(now = Date.now()) {
  for (const [key, entry] of resolvedProviderUrls.entries()) {
    if (!entry || entry.expiresAt <= now) resolvedProviderUrls.delete(key);
  }
  while (resolvedProviderUrls.size > RESOLVED_PROVIDER_URL_MAX) {
    resolvedProviderUrls.delete(resolvedProviderUrls.keys().next().value);
  }
}

function getResolvedProviderUrl(originalUrl) {
  cleanupResolvedProviderUrls();
  const entry = resolvedProviderUrls.get(String(originalUrl || ""));
  if (!entry || entry.expiresAt <= Date.now()) return "";
  return isAllowedResolvedProviderUrl(entry.url) ? entry.url : "";
}

function rememberResolvedProviderUrl(originalUrl, resolvedUrl) {
  const original = String(originalUrl || "");
  const resolved = String(resolvedUrl || "");
  if (!original || !resolved || original === resolved || !isAllowedResolvedProviderUrl(resolved)) return;
  cleanupResolvedProviderUrls();
  resolvedProviderUrls.set(original, {
    url: resolved,
    expiresAt: Date.now() + RESOLVED_PROVIDER_URL_TTL_MS
  });
}

function forgetResolvedProviderUrl(originalUrl) {
  resolvedProviderUrls.delete(String(originalUrl || ""));
}

async function fetchProviderWithStickyRedirects(originalUrl, init, method, headers, { useCache = true } = {}) {
  const cachedUrl = useCache ? getResolvedProviderUrl(originalUrl) : "";
  let currentUrl = cachedUrl || originalUrl;
  const startedFromCache = Boolean(cachedUrl);

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (!isAllowedResolvedProviderUrl(currentUrl)) {
      throw new Error("Provider redirect left the allowed domains");
    }

    const response = await nativeFetch(currentUrl, {
      ...init,
      method,
      headers,
      redirect: "manual"
    });

    if (!REDIRECT_STATUSES.has(Number(response.status || 0))) {
      // A cached signed CDN URL can expire independently from the Nuvio proxy
      // token. Retry the provider entry once so a new redirect chain can be
      // learned without sending VLC back to a stale CDN URL forever.
      if (startedFromCache && [401, 403, 404, 410].includes(Number(response.status || 0))) {
        forgetResolvedProviderUrl(originalUrl);
        response.body?.cancel?.().catch?.(() => {});
        return fetchProviderWithStickyRedirects(originalUrl, init, method, headers, { useCache: false });
      }

      if (response.status >= 200 && response.status < 400 && currentUrl !== originalUrl) {
        rememberResolvedProviderUrl(originalUrl, currentUrl);
      }
      return response;
    }

    const nextUrl = resolveRedirectUrl(response, currentUrl);
    if (!nextUrl || !isAllowedResolvedProviderUrl(nextUrl)) {
      return response;
    }

    let nextHost = "unknown";
    try {
      nextHost = new URL(nextUrl).hostname;
    } catch (_) {}
    if (isControlledHttpStreamstrUrl(nextUrl)) {
      console.info(`[provider-fetch] controlled streamstr http redirect host=${nextHost}`);
    } else {
      console.info(`[provider-fetch] resolved provider redirect host=${nextHost}`);
    }
    response.body?.cancel?.().catch?.(() => {});
    currentUrl = nextUrl;
  }

  throw new Error("Too many provider redirects");
}

// Node throws ERR_INVALID_STATE when code calls ReadableStream.cancel() after
// Readable.fromWeb() has locked that stream. The media proxy only does this as
// best-effort cleanup after the HTTP response closes, so a no-op is correct for
// an already locked stream and prevents the whole Render process from exiting.
if (typeof ReadableStream !== "undefined" && ReadableStream.prototype?.cancel) {
  const nativeCancel = ReadableStream.prototype.cancel;
  ReadableStream.prototype.cancel = function safeCancel(reason) {
    if (this.locked) return Promise.resolve();
    try {
      const result = nativeCancel.call(this, reason);
      return Promise.resolve(result).catch((error) => {
        if (error?.code === "ERR_INVALID_STATE") return undefined;
        throw error;
      });
    } catch (error) {
      if (error?.code === "ERR_INVALID_STATE") return Promise.resolve();
      throw error;
    }
  };
}

globalThis.fetch = async function providerCompatibleFetch(input, init = {}) {
  const url = inputUrl(input);
  if (!isProviderUrl(url)) return nativeFetch(input, init);

  const originalHeaders =
    init?.headers ||
    (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  const headers = new Headers(originalHeaders || {});
  const method = String(
    init?.method ||
      (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET") ||
      "GET"
  ).toUpperCase();

  // Prehraj.to's public client intentionally uses a browser UA and Czech
  // Accept-Language. ffprobe/ffmpeg otherwise inject Lavf as the UA when they
  // call our internal media proxy, which some provider/CDN paths do not serve
  // like a normal browser stream.
  headers.set("User-Agent", BROWSER_USER_AGENT);
  if (!headers.has("Accept-Language")) headers.set("Accept-Language", ACCEPT_LANGUAGE);
  if (!headers.has("Accept")) headers.set("Accept", "*/*");
  if (!headers.has("Accept-Encoding")) headers.set("Accept-Encoding", "identity");

  // PremiumCDN is much more reliable when media is requested as a byte-range.
  // ffprobe sometimes opens the URL without Range first, which can leave the
  // proxy waiting for the first body chunk and stall HLS startup indefinitely.
  if (method === "GET" && !headers.has("Range")) {
    headers.set("Range", "bytes=0-");
  }

  const response =
    method === "GET" || method === "HEAD"
      ? await fetchProviderWithStickyRedirects(url, init, method, headers)
      : await nativeFetch(input, {
          ...init,
          method,
          headers
        });

  return withImmediateStreamingMime(response);
};
