const nativeFetch = globalThis.fetch.bind(globalThis);

const PROVIDER_ROOTS = ["streamstr.stream", "premiumcdn.net"];
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

function isProviderUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return PROVIDER_ROOTS.some(
      (root) => hostname === root || hostname.endsWith(`.${root}`)
    );
  } catch (_) {
    return false;
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

globalThis.fetch = async function providerCompatibleFetch(input, init = {}) {
  const url = inputUrl(input);
  if (!isProviderUrl(url)) return nativeFetch(input, init);

  const originalHeaders =
    init?.headers || (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  const headers = new Headers(originalHeaders || {});
  const method = String(init?.method || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET") || "GET").toUpperCase();

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

  const response = await nativeFetch(input, {
    ...init,
    method,
    headers
  });

  return withImmediateStreamingMime(response);
};
