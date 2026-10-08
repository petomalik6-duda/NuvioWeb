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
  const launchByVideo = new WeakMap();

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

    // NuvioWeb's iOS default is Lenna. For this provider-specific bridge we
    // intentionally keep Prehraj.to external even when no preference has been
    // persisted yet; an explicit supported player preference always wins.
    return EXTERNAL_PLAYERS.has(configured) ? configured : DEFAULT_EXTERNAL_PLAYER;
  }

  function filenameFromUrl(value = "") {
    try {
      return decodeURIComponent(new URL(String(value)).pathname.split("/").pop() || "media");
    } catch (_) {
      return "media";
    }
  }

  async function registerPrehrajtoProxy(sourceUrl) {
    const response = await fetch(MEDIA_PROXY_REGISTER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        url: sourceUrl,
        filename: filenameFromUrl(sourceUrl)
      })
    });
    if (!response.ok) {
      throw new Error(`Prehrajto external proxy registration failed (${response.status})`);
    }
    const payload = await response.json();
    const playbackUrl = String(payload?.playbackUrl || "").trim();
    if (!playbackUrl) {
      throw new Error("Prehrajto external proxy registration returned no playback URL");
    }
    return new URL(playbackUrl, location.origin).href;
  }

  function buildExternalLaunchUrl(player, mediaUrl, video) {
    const resumeSeconds = Math.max(0, Math.floor(Number(video?.currentTime || 0)));
    const title = String(document.title || "Nuvio").trim();
    const query = new URLSearchParams({ url: mediaUrl });

    if (player === "lenna") {
      if (resumeSeconds > 0) query.set("position", String(resumeSeconds));
      return `lenna://x-callback-url/play?${query.toString()}`;
    }
    if (player === "infuse") {
      query.set("position", String(resumeSeconds));
      if (title) query.set("filename", title);
      return `infuse://x-callback-url/play?${query.toString()}`;
    }
    if (player === "outplayer") {
      if (resumeSeconds > 0) query.set("position", String(resumeSeconds));
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

  function installExternalPrehrajtoPlayHook() {
    if (HTMLMediaElement.prototype.__nuvioPrehrajtoExternalPlayerInstalled) return;

    const previousPlay = HTMLMediaElement.prototype.play;
    Object.defineProperty(HTMLMediaElement.prototype, "__nuvioPrehrajtoExternalPlayerInstalled", {
      value: true,
      configurable: true
    });

    HTMLMediaElement.prototype.play = function nuvioIosPrehrajtoExternalPlay(...args) {
      if (!(this instanceof HTMLVideoElement)) {
        return previousPlay.apply(this, args);
      }

      const sourceUrl = currentVideoSource(this);
      if (!isPrehrajtoEntryUrl(sourceUrl)) {
        return previousPlay.apply(this, args);
      }

      const existing = launchByVideo.get(this);
      if (existing?.sourceUrl === sourceUrl && existing?.promise) {
        return existing.promise;
      }

      const player = getConfiguredExternalPlayer();
      const promise = registerPrehrajtoProxy(sourceUrl)
        .then((proxyUrl) => {
          // The source may have changed while registration was in flight.
          if (currentVideoSource(this) !== sourceUrl) return false;
          const href = buildExternalLaunchUrl(player, proxyUrl, this);
          if (!href || !launchExternal(href)) {
            return previousPlay.apply(this, args);
          }
          try {
            this.pause();
          } catch (_) {}
          this.dataset.nuvioPrehrajtoExternal = player;
          this.dataset.nuvioPrehrajtoProxyUrl = proxyUrl;
          console.info(`[Nuvio iOS] Prehrajto routed to external player: ${player}`);
          return true;
        })
        .catch((error) => {
          console.warn("[Nuvio iOS] Prehrajto external routing failed; falling back internally", error);
          return previousPlay.apply(this, args);
        })
        .finally(() => {
          const active = launchByVideo.get(this);
          if (active?.promise === promise) {
            launchByVideo.delete(this);
          }
        });

      launchByVideo.set(this, { sourceUrl, promise });
      return promise;
    };
  }

  function start() {
    installExternalPrehrajtoPlayHook();
  }

  // ios-pwa-enhancements installs its own final play hook at DOMContentLoaded.
  // Register after it so this provider-specific wrapper stays outermost.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
