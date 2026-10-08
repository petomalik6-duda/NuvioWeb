const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const API_KEY_PATTERN = /"INNERTUBE_API_KEY":"([^"]+)"/;
const VISITOR_DATA_PATTERN = /"VISITOR_DATA":"([^"]+)"/;
const REQUEST_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 5 * 60_000;

const CLIENTS = [
  {
    key: "visionos",
    id: "101",
    version: "1.02",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    context: {
      clientName: "VISIONOS",
      clientVersion: "1.02",
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      osName: "visionOS",
      osVersion: "26.5.23O471",
      hl: "en",
      gl: "US"
    }
  },
  {
    key: "ios",
    id: "5",
    version: "20.10.1",
    userAgent: "com.google.ios.youtube/20.10.1 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)",
    context: {
      clientName: "IOS",
      clientVersion: "20.10.1",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "17.4.0.21E219",
      platform: "MOBILE",
      hl: "en",
      gl: "US"
    }
  },
  {
    key: "android",
    id: "3",
    version: "20.10.35",
    userAgent: "com.google.android.youtube/20.10.35 (Linux; U; Android 14; en_US) gzip",
    context: {
      clientName: "ANDROID",
      clientVersion: "20.10.35",
      osName: "Android",
      osVersion: "14",
      platform: "MOBILE",
      androidSdkVersion: 34,
      hl: "en",
      gl: "US"
    }
  }
];

const resolutionCache = new Map();

export function normalizeYouTubeVideoId(value = "") {
  const input = String(value || "").trim();
  if (VIDEO_ID_PATTERN.test(input)) return input;
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      const candidate = url.pathname.split("/").filter(Boolean)[0] || "";
      return VIDEO_ID_PATTERN.test(candidate) ? candidate : "";
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const queryId = url.searchParams.get("v") || "";
      if (VIDEO_ID_PATTERN.test(queryId)) return queryId;
      const parts = url.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((part) => ["embed", "shorts", "live"].includes(part));
      const candidate = marker >= 0 ? parts[marker + 1] || "" : "";
      return VIDEO_ID_PATTERN.test(candidate) ? candidate : "";
    }
  } catch (_) {
    // Not a URL; the plain-id check above already failed.
  }
  return "";
}

function unescapeWatchValue(value = "") {
  return String(value || "")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\\u003d/g, "=");
}

function watchConfig(html = "") {
  const text = String(html || "");
  return {
    apiKey: unescapeWatchValue(text.match(API_KEY_PATTERN)?.[1] || ""),
    visitorData: unescapeWatchValue(text.match(VISITOR_DATA_PATTERN)?.[1] || "")
  };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWatchConfig(videoId) {
  const response = await fetchWithTimeout(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": CLIENTS[0].userAgent
    },
    redirect: "follow"
  });
  if (!response.ok) {
    throw new Error(`YouTube watch page returned HTTP ${response.status}`);
  }
  const config = watchConfig(await response.text());
  if (!config.apiKey) {
    throw new Error("YouTube INNERTUBE_API_KEY was not found");
  }
  return config;
}

async function resolveWithClient(videoId, apiKey, visitorData, client) {
  const response = await fetchWithTimeout(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://www.youtube.com",
        "User-Agent": client.userAgent,
        "X-YouTube-Client-Name": client.id,
        "X-YouTube-Client-Version": client.version,
        ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {})
      },
      body: JSON.stringify({
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        context: { client: client.context },
        playbackContext: {
          contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" }
        }
      })
    }
  );
  if (!response.ok) {
    throw new Error(`YouTube player ${client.key} returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  const hlsManifestUrl = String(payload?.streamingData?.hlsManifestUrl || "").trim();
  if (hlsManifestUrl) {
    return { url: hlsManifestUrl, client: client.key, kind: "hls" };
  }
  const progressive = Array.isArray(payload?.streamingData?.formats)
    ? payload.streamingData.formats
        .filter((entry) => entry?.url && String(entry?.mimeType || "").includes("video/mp4"))
        .sort((left, right) => Number(right?.height || 0) - Number(left?.height || 0))
    : [];
  const fallbackUrl = String(progressive[0]?.url || "").trim();
  return fallbackUrl ? { url: fallbackUrl, client: client.key, kind: "progressive" } : null;
}

export async function resolveYouTubeStream(value) {
  const videoId = normalizeYouTubeVideoId(value);
  if (!videoId) return null;

  const cached = resolutionCache.get(videoId);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...cached.result };
  }

  const config = await fetchWatchConfig(videoId);
  let lastError = null;
  for (const client of CLIENTS) {
    try {
      const result = await resolveWithClient(videoId, config.apiKey, config.visitorData, client);
      if (result?.url) {
        resolutionCache.set(videoId, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          result: { ...result, videoId }
        });
        return { ...result, videoId };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}
