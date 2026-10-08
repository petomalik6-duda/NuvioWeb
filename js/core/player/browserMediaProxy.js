const STREAMSTR_ROOT = "streamstr.stream";
const ALLOWED_STREAMSTR_HOSTS = new Set([
  "prehrajto.streamstr.stream",
  "cdn.streamstr.stream"
]);
const REGISTER_ENDPOINT = "/api/media-proxy/register";
const FASTSHARE3_REGISTER_ENDPOINT = "/api/fastshare3/register";

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

function isFastShareHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "fastshare.cz" ||
    host.endsWith(".fastshare.cz") ||
    host === "fastshare.cloud" ||
    host.endsWith(".fastshare.cloud")
  );
}

export function isFastShare3KodiPipeUrl(value = "") {
  const raw = String(value || "").trim();
  const pipe = raw.indexOf("|");
  if (pipe <= 0) return false;
  try {
    const parsed = new URL(raw.slice(0, pipe));
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && isFastShareHost(parsed.hostname);
  } catch (_) {
    return false;
  }
}

export function isStreamstrMediaUrl(value = "") {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && ALLOWED_STREAMSTR_HOSTS.has(parsed.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

async function prepareFastShare3KodiPipeStream(stream = {}, fetchImpl = globalThis.fetch) {
  const candidates = [stream?.url, stream?.externalUrl, stream?.directUrl]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const spec = candidates.find(isFastShare3KodiPipeUrl) || "";
  if (!spec || typeof fetchImpl !== "function") return stream;

  try {
    const response = await fetchImpl(FASTSHARE3_REGISTER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        spec,
        filename:
          stream?.behaviorHints?.filename ||
          stream?.raw?.behaviorHints?.filename ||
          stream?.filename ||
          "video"
      })
    });
    if (!response?.ok) return stream;
    const payload = await response.json().catch(() => null);
    const playbackUrl = String(payload?.playbackUrl || "").trim();
    if (!playbackUrl) return stream;
    return {
      ...stream,
      url: playbackUrl,
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        notWebReady: false,
        browserMediaProxy: true,
        browserMediaProxySource: "fastshare3-kodi-pipe"
      }
    };
  } catch (_) {
    return stream;
  }
}

export async function prepareBrowserMediaProxyStream(stream = {}, { fetchImpl = globalThis.fetch } = {}) {
  const fastSharePrepared = await prepareFastShare3KodiPipeStream(stream, fetchImpl);
  if (fastSharePrepared !== stream) return fastSharePrepared;

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
