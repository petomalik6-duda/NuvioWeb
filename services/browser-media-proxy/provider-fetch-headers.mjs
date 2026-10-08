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

  let response = await nativeFetch(input, {
    ...init,
    method,
    headers
  });

  // Some large/4K Prehraj.to objects intentionally redirect from their HTTPS
  // entry URL to an HTTP URL on another *.streamstr.stream host. The media
  // bridge rejects HTTP URLs before issuing a request, while forcing HTTPS on
  // those storage hosts can fail certificate validation. Follow exactly one
  // such provider-owned downgrade here, with manual redirects preserved, so a
  // later redirect still returns to the bridge's normal domain allow-list.
  if ((method === "GET" || method === "HEAD") && REDIRECT_STATUSES.has(Number(response.status))) {
    const downgradeUrl = resolveRedirectUrl(response, url);
    if (isControlledHttpStreamstrUrl(downgradeUrl)) {
      let downgradeHost = "unknown";
      try {
        downgradeHost = new URL(downgradeUrl).hostname;
      } catch (_) {}
      console.info(`[provider-fetch] controlled streamstr http redirect host=${downgradeHost}`);
      response = await nativeFetch(downgradeUrl, {
        ...init,
        method,
        headers,
        redirect: "manual"
      });
    }
  }

  return withImmediateStreamingMime(response);
};
