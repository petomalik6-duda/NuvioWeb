const nativeFetch = globalThis.fetch.bind(globalThis);

const PROVIDER_ROOTS = ["streamstr.stream", "premiumcdn.net"];
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE = "cs-CZ,cs;q=0.9,en;q=0.8";

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

  return nativeFetch(input, {
    ...init,
    method,
    headers
  });
};
