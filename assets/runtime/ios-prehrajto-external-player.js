(() => {
  "use strict";

  const ua = String(navigator.userAgent || "");
  const platform = String(navigator.platform || "");
  const isTouchMac = platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1;
  const isIOS = /iPad|iPhone|iPod/i.test(ua) || isTouchMac;
  if (!isIOS) return;

  const MEDIA_PROXY_REGISTER_ENDPOINT = "/api/media-proxy/register";
  const DEFAULT_EXTERNAL_PLAYER = "lenna";
  const EXTERNAL_PLAYERS = new Set(["lenna", "outplayer", "infuse", "vlc"]);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const prehrajtoStreamsById = new Map();
  const prehrajtoStreamsByUrl = new Map();
  const proxyPreparationByUrl = new Map();
  let launchOverlay = null;

  function isPrehrajtoEntryUrl(value = "") {
    try {
      const url = new URL(String(value || ""), location.href);
      const host = url.hostname.toLowerCase();
      return (
        url.protocol === "https:" &&
        (host === "streamstr.stream" || host.endsWith(".streamstr.stream"))
      );
    } catch (_) {
      return false;
    }
  }

  function currentVideoSource(video) {
    return String(video?.currentSrc || video?.src || video?.getAttribute?.("src") || "").trim();
  }

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

    return EXTERNAL_PLAYERS.has(configured) ? configured : DEFAULT_EXTERNAL_PLAYER;
  }

  function filenameFromUrl(value = "") {
    try {
      return decodeURIComponent(new URL(String(value)).pathname.split("/").pop() || "media");
    } catch (_) {
      return "media";
    }
  }

  function buildExternalLaunchUrl(player, mediaUrl, { resumeSeconds = 0, title = "" } = {}) {
    const safeResume = Math.max(0, Math.floor(Number(resumeSeconds || 0)));
    const query = new URLSearchParams({ url: mediaUrl });

    if (player === "lenna") {
      if (safeResume > 0) query.set("position", String(safeResume));
      return `lenna://x-callback-url/play?${query.toString()}`;
    }
    if (player === "infuse") {
      query.set("position", String(safeResume));
      if (title) query.set("filename", title);
      return `infuse://x-callback-url/play?${query.toString()}`;
    }
    if (player === "outplayer") {
      if (safeResume > 0) query.set("position", String(safeResume));
      return `outplayer://x-callback-url/play?${query.toString()}`;
    }
    if (player === "vlc") {
      return `vlc-x-callback://x-callback-url/stream?${query.toString()}`;
    }
    return "";
  }

  function launchExternal(href) {
    if (!href) return false;
    try {
      location.assign(href);
      return true;
    } catch (error) {
      console.warn("[Nuvio iOS] Could not launch external Prehrajto player", error);
      return false;
    }
  }

  function prewarmPrehrajtoProxy(sourceUrl) {
    const normalized = String(sourceUrl || "").trim();
    if (!isPrehrajtoEntryUrl(normalized)) return Promise.resolve("");
    const existing = proxyPreparationByUrl.get(normalized);
    if (existing?.promise) return existing.promise;

    const state = { proxyUrl: "", error: null, promise: null };
    state.promise = nativeFetch(MEDIA_PROXY_REGISTER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        url: normalized,
        filename: filenameFromUrl(normalized)
      })
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Prehrajto proxy registration failed (${response.status})`);
        }
        const payload = await response.json();
        const playbackUrl = String(payload?.playbackUrl || "").trim();
        if (!playbackUrl) {
          throw new Error("Prehrajto proxy registration returned no playback URL");
        }
        state.proxyUrl = new URL(playbackUrl, location.origin).href;
        return state.proxyUrl;
      })
      .catch((error) => {
        state.error = error;
        console.warn("[Nuvio iOS] Prehrajto proxy prewarm failed", error);
        return "";
      });

    proxyPreparationByUrl.set(normalized, state);
    return state.promise;
  }

  function rememberPrehrajtoStream(stream, groupName = "Addon", index = 0) {
    if (!stream || typeof stream !== "object") return;
    const sourceUrl = String(stream.url || stream.externalUrl || "").trim();
    if (!isPrehrajtoEntryUrl(sourceUrl)) return;

    const streamId = String(
      stream.id || `${groupName}-${index}-${stream.url || stream.externalUrl || stream.ytId || ""}`
    );
    const entry = {
      id: streamId,
      url: sourceUrl,
      label: [stream.name, stream.title, stream.description, stream.behaviorHints?.filename]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
    };
    prehrajtoStreamsById.set(streamId, entry);
    prehrajtoStreamsByUrl.set(sourceUrl, entry);
    void prewarmPrehrajtoProxy(sourceUrl);
  }

  function scanStreamPayload(value, inheritedGroupName = "Addon", seen = new WeakSet()) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry) => scanStreamPayload(entry, inheritedGroupName, seen));
      return;
    }

    const groupName = String(value.addonName || inheritedGroupName || "Addon");
    if (Array.isArray(value.streams)) {
      value.streams.forEach((stream, index) => rememberPrehrajtoStream(stream, groupName, index));
    }
    if (isPrehrajtoEntryUrl(value.url || value.externalUrl || "")) {
      rememberPrehrajtoStream(value, groupName, 0);
    }

    Object.values(value).forEach((entry) => scanStreamPayload(entry, groupName, seen));
  }

  function responseLooksLikeJson(response, requestUrl = "") {
    const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
    return contentType.includes("application/json") || /\/stream\//i.test(String(requestUrl || response?.url || ""));
  }

  function installStreamCaptureFetch() {
    if (globalThis.__nuvioPrehrajtoFetchCaptureInstalled) return;
    globalThis.__nuvioPrehrajtoFetchCaptureInstalled = true;

    globalThis.fetch = async function nuvioPrehrajtoCaptureFetch(input, init) {
      const response = await nativeFetch(input, init);
      const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
      if (responseLooksLikeJson(response, requestUrl)) {
        try {
          const clone = response.clone();
          void clone
            .json()
            .then((payload) => scanStreamPayload(payload))
            .catch(() => {});
        } catch (_) {}
      }
      return response;
    };
  }

  function findRememberedPrehrajto(card) {
    const streamId = String(card?.dataset?.streamId || "");
    if (streamId && prehrajtoStreamsById.has(streamId)) {
      return prehrajtoStreamsById.get(streamId);
    }

    for (const entry of prehrajtoStreamsByUrl.values()) {
      if (streamId && streamId.includes(entry.url)) return entry;
    }

    const cardText = String(card?.textContent || "").toLowerCase();
    const candidates = [...prehrajtoStreamsByUrl.values()];
    const scored = candidates
      .map((entry) => {
        let score = 0;
        if (/prehraj|streamstr/i.test(cardText)) score += 5;
        if (entry.label && cardText.includes(entry.label)) score += 8;
        const tokens = entry.label.split(/\s+/).filter((token) => token.length >= 5);
        score += tokens.filter((token) => cardText.includes(token)).length;
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);
    return scored[0]?.entry || null;
  }

  function destroyLaunchOverlay() {
    launchOverlay?.remove?.();
    launchOverlay = null;
  }

  function showLaunchOverlay(entry, { returnOnCancel = false } = {}) {
    destroyLaunchOverlay();
    const player = getConfiguredExternalPlayer();
    const state = proxyPreparationByUrl.get(entry.url);

    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,sans-serif;";
    const panel = document.createElement("div");
    panel.style.cssText =
      "width:min(92vw,420px);background:#171717;color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:20px;box-sizing:border-box;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.45);";
    const title = document.createElement("div");
    title.textContent = "Prehraj.to";
    title.style.cssText = "font-size:20px;font-weight:700;margin-bottom:8px;";
    const status = document.createElement("div");
    status.textContent = state?.proxyUrl ? `Otvoriť v ${player}` : "Pripravujem externé prehrávanie…";
    status.style.cssText = "font-size:14px;opacity:.78;margin-bottom:18px;line-height:1.4;";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = `Otvoriť v ${player}`;
    openButton.disabled = !state?.proxyUrl;
    openButton.style.cssText =
      "width:100%;border:0;border-radius:12px;padding:14px 16px;font-size:16px;font-weight:700;cursor:pointer;margin-bottom:10px;";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Späť";
    cancelButton.style.cssText =
      "width:100%;border:1px solid rgba(255,255,255,.2);border-radius:12px;padding:12px 16px;font-size:15px;background:transparent;color:#fff;cursor:pointer;";

    const activate = (proxyUrl) => {
      if (!proxyUrl) return;
      openButton.disabled = false;
      status.textContent = `Otvoriť v ${player}`;
      openButton.onclick = () => {
        const href = buildExternalLaunchUrl(player, proxyUrl, { title: document.title || "Nuvio" });
        launchExternal(href);
      };
    };

    if (state?.proxyUrl) activate(state.proxyUrl);
    else {
      void prewarmPrehrajtoProxy(entry.url).then((proxyUrl) => {
        if (!overlay.isConnected) return;
        if (proxyUrl) activate(proxyUrl);
        else status.textContent = "Prehraj.to link sa nepodarilo pripraviť. Skús zdroj znova.";
      });
    }

    cancelButton.onclick = () => {
      destroyLaunchOverlay();
      if (returnOnCancel && history.length > 1) history.back();
    };
    panel.append(title, status, openButton, cancelButton);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    launchOverlay = overlay;
  }

  function tryLaunchRememberedStream(entry) {
    if (!entry) return false;
    const state = proxyPreparationByUrl.get(entry.url);
    const proxyUrl = String(state?.proxyUrl || "").trim();
    if (!proxyUrl) {
      showLaunchOverlay(entry);
      return true;
    }
    const player = getConfiguredExternalPlayer();
    const href = buildExternalLaunchUrl(player, proxyUrl, { title: document.title || "Nuvio" });
    if (!href) {
      showLaunchOverlay(entry);
      return true;
    }
    return launchExternal(href);
  }

  function installStreamCardInterceptor() {
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const card = target.closest(".stream-route-card[data-action='playStream'][data-stream-id]");
        if (!card) return;
        const entry = findRememberedPrehrajto(card);
        if (!entry) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        tryLaunchRememberedStream(entry);
      },
      true
    );
  }

  function installLatePlayerFallback() {
    if (HTMLMediaElement.prototype.__nuvioPrehrajtoExternalFallbackInstalled) return;
    const previousPlay = HTMLMediaElement.prototype.play;
    Object.defineProperty(HTMLMediaElement.prototype, "__nuvioPrehrajtoExternalFallbackInstalled", {
      value: true,
      configurable: true
    });

    HTMLMediaElement.prototype.play = function nuvioPrehrajtoExternalFallback(...args) {
      if (!(this instanceof HTMLVideoElement)) return previousPlay.apply(this, args);
      const sourceUrl = currentVideoSource(this);
      if (!isPrehrajtoEntryUrl(sourceUrl)) return previousPlay.apply(this, args);

      const entry = prehrajtoStreamsByUrl.get(sourceUrl) || { id: sourceUrl, url: sourceUrl, label: "" };
      void prewarmPrehrajtoProxy(sourceUrl);
      queueMicrotask(() => showLaunchOverlay(entry, { returnOnCancel: true }));
      console.info("[Nuvio iOS] Blocked internal Prehrajto playback; external player required");
      return Promise.resolve(false);
    };
  }

  installStreamCaptureFetch();
  installStreamCardInterceptor();

  const installFallbackAfterIosEnhancements = () => setTimeout(installLatePlayerFallback, 0);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installFallbackAfterIosEnhancements, { once: true });
  } else {
    installFallbackAfterIosEnhancements();
  }
})();
