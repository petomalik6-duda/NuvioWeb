const STREAMSTR_ROOT = "streamstr.stream";
const ALLOWED_STREAMSTR_HOSTS = new Set([
  "prehrajto.streamstr.stream",
  "cdn.streamstr.stream"
]);
const REGISTER_ENDPOINT = "/api/media-proxy/register";

function cleanHeaders(headers = {}) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [String(name || "").trim(), String(value ?? "").trim()])
      .filter(([name, value]) => name && value)
  );
}

export function isStreamstrMediaUrl(value = "") {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && ALLOWED_STREAMSTR_HOSTS.has(parsed.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

export async function prepareBrowserMediaProxyStream(stream = {}, { fetchImpl = globalThis.fetch } = {}) {
  const targetUrl = String(stream?.url || "").trim();
  if (!targetUrl || !isStreamstrMediaUrl(targetUrl) || typeof fetchImpl !== "function") {
    return stream;
  }

  const requestHeaders = cleanHeaders(
    stream?.behaviorHints?.proxyHeaders?.request ||
      stream?.raw?.behaviorHints?.proxyHeaders?.request ||
      {}
  );

  try {
    const response = await fetchImpl(REGISTER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: targetUrl,
        requestHeaders,
        filename: stream?.behaviorHints?.filename || stream?.filename || ""
      })
    });
    if (!response?.ok) {
      return stream;
    }
    const payload = await response.json().catch(() => null);
    const playbackUrl = String(payload?.playbackUrl || "").trim();
    if (!playbackUrl) {
      return stream;
    }
    return {
      ...stream,
      url: playbackUrl,
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        notWebReady: false,
        browserMediaProxy: true,
        browserMediaProxySource: STREAMSTR_ROOT
      }
    };
  } catch (_) {
    // Keep the provider URL as a fallback if the app is running from a purely
    // static host or an older server that does not expose the proxy endpoint.
    return stream;
  }
}
