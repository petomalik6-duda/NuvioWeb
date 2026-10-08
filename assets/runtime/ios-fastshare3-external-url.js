(() => {
  "use strict";

  const ua = String(navigator.userAgent || "");
  const platform = String(navigator.platform || "");
  const isTouchMac = platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1;
  const isIOS = /iPad|iPhone|iPod/i.test(ua) || isTouchMac;
  if (!isIOS || typeof globalThis.fetch !== "function") return;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  const EXTERNAL_PLAYERS = new Set(["lenna", "outplayer", "infuse", "vlc"]);

  function readStoredJson(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function getConfiguredExternalPlayer() {
    const activeProfileId = String(readStoredJson("activeProfileId", "1") || "1");
    const stored = readStoredJson("playerSettings", null);
    let configured = "";

    if (stored?.__profileScoped === true && stored?.profiles && typeof stored.profiles === "object") {
      configured = String(
        stored.profiles?.[activeProfileId]?.browserExternalPlayer ||
          stored.profiles?.["1"]?.browserExternalPlayer ||
          ""
      )
        .trim()
        .toLowerCase();
    } else if (stored && typeof stored === "object") {
      configured = String(stored.browserExternalPlayer || "").trim().toLowerCase();
    }

    if (configured === "disabled") return "disabled";
    if (EXTERNAL_PLAYERS.has(configured)) return configured;
    return "disabled";
  }

  function isFastShareDirectUrl(value = "") {
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

  function directFastShareUrl(stream = {}) {
    const candidates = [
      stream.externalUrl,
      stream.directUrl,
      stream.behaviorHints?.externalUrl,
      stream.behaviorHints?.directUrl
    ];
    return candidates.map((value) => String(value || "").trim()).find(isFastShareDirectUrl) || "";
  }

  function looksLikeFastShareStream(stream = {}, directUrl = "") {
    if (isFastShareDirectUrl(directUrl)) return true;
    const text = [
      stream.name,
      stream.title,
      stream.description,
      stream.behaviorHints?.filename
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return text.includes("fastshare");
  }

  function rewriteStream(stream) {
    if (!stream || typeof stream !== "object" || Array.isArray(stream)) return stream;
    const directUrl = directFastShareUrl(stream);
    if (!directUrl || !looksLikeFastShareStream(stream, directUrl)) return stream;

    return {
      ...stream,
      url: directUrl,
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        notWebReady: false,
        nuvioFastShare3DirectExternal: true,
        nuvioFastShare3OriginalUrl: String(stream.url || "")
      }
    };
  }

  function rewritePayload(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((entry) => rewritePayload(entry, seen));
    }

    const next = { ...value };
    if (Array.isArray(value.streams)) {
      next.streams = value.streams.map((stream) => rewriteStream(stream));
    }

    for (const [key, child] of Object.entries(next)) {
      if (key === "streams") continue;
      if (child && typeof child === "object") {
        next[key] = rewritePayload(child, seen);
      }
    }
    return next;
  }

  function requestUrl(input) {
    if (typeof input === "string" || input instanceof URL) return String(input);
    return String(input?.url || "");
  }

  function shouldInspect(response, url = "") {
    const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
    return contentType.includes("application/json") && /\/stream\//i.test(String(url || response?.url || ""));
  }

  globalThis.fetch = async function nuvioFastShare3ExternalFetch(input, init) {
    const response = await nativeFetch(input, init);
    if (getConfiguredExternalPlayer() === "disabled") return response;

    const url = requestUrl(input);
    if (!shouldInspect(response, url)) return response;

    try {
      const payload = await response.clone().json();
      const rewritten = rewritePayload(payload);
      const headers = new Headers(response.headers || {});
      headers.delete("content-length");
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(rewritten), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch (_) {
      return response;
    }
  };
})();
