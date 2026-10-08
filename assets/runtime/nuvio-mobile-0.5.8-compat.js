(() => {
  "use strict";

  const VERSION = "0.5.8-web-compat.1";
  const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
  const youtubeOnlyStreams = new Map();
  const nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  let overlay = null;
  let activeYoutubeId = "";

  function normalizeText(value = "") {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function normalizeYoutubeId(value = "") {
    const id = String(value || "").trim();
    return YOUTUBE_ID_RE.test(id) ? id : "";
  }

  function rememberYoutubeOnlyStream(stream = {}) {
    const ytId = normalizeYoutubeId(stream.ytId);
    if (!ytId) return;

    const hasDirectUrl = Boolean(String(stream.url || stream.externalUrl || "").trim());
    if (hasDirectUrl) return;

    const rawId = String(stream.id || "").trim();
    const title = String(stream.title || stream.name || stream.description || "").trim();
    youtubeOnlyStreams.set(ytId, {
      ytId,
      rawId,
      title,
      titleKey: normalizeText(title)
    });
  }

  function scanStreamPayload(value, depth = 0) {
    if (!value || depth > 8) return;

    if (Array.isArray(value)) {
      for (const entry of value) scanStreamPayload(entry, depth + 1);
      return;
    }

    if (typeof value !== "object") return;

    if (Array.isArray(value.streams)) {
      for (const stream of value.streams) {
        if (stream && typeof stream === "object") rememberYoutubeOnlyStream(stream);
      }
    }

    for (const [key, nested] of Object.entries(value)) {
      if (key === "streams") continue;
      if (nested && (Array.isArray(nested) || typeof nested === "object")) {
        scanStreamPayload(nested, depth + 1);
      }
    }
  }

  function installStreamDiscovery() {
    if (!nativeFetch || window.__nuvio058FetchDiscoveryInstalled) return;
    window.__nuvio058FetchDiscoveryInstalled = true;

    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      try {
        const clone = response.clone();
        void clone
          .json()
          .then((payload) => scanStreamPayload(payload))
          .catch(() => {});
      } catch (_) {}
      return response;
    };
  }

  function youtubeEmbedUrl(ytId) {
    const params = new URLSearchParams({
      autoplay: "1",
      playsinline: "1",
      rel: "0",
      enablejsapi: "1"
    });
    if (/^https?:$/.test(location.protocol)) {
      params.set("origin", location.origin);
    }
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}?${params.toString()}`;
  }

  function ensureOverlay() {
    if (overlay?.isConnected) return overlay;

    const root = document.createElement("div");
    root.className = "nuvio-youtube-stream-overlay";
    root.hidden = true;
    root.innerHTML = `
      <div class="nuvio-youtube-stream-toolbar">
        <button type="button" class="nuvio-youtube-stream-close" aria-label="Close YouTube stream">←</button>
        <div class="nuvio-youtube-stream-title">YouTube</div>
        <button type="button" class="nuvio-youtube-stream-open" aria-label="Open in YouTube">Open</button>
      </div>
      <div class="nuvio-youtube-stream-frame-wrap">
        <iframe
          class="nuvio-youtube-stream-frame"
          title="YouTube stream"
          allow="autoplay; encrypted-media; picture-in-picture; web-share"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
      </div>
    `;

    const style = document.createElement("style");
    style.id = "nuvio-youtube-stream-overlay-style";
    style.textContent = `
      .nuvio-youtube-stream-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: flex;
        flex-direction: column;
        background: #000;
        color: #fff;
        padding-top: env(safe-area-inset-top, 0px);
        padding-right: env(safe-area-inset-right, 0px);
        padding-bottom: env(safe-area-inset-bottom, 0px);
        padding-left: env(safe-area-inset-left, 0px);
        overscroll-behavior: none;
      }
      .nuvio-youtube-stream-overlay[hidden] { display: none !important; }
      .nuvio-youtube-stream-toolbar {
        flex: 0 0 auto;
        min-height: 54px;
        display: grid;
        grid-template-columns: 54px minmax(0, 1fr) 72px;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        background: rgba(8, 8, 10, .96);
        border-bottom: 1px solid rgba(255, 255, 255, .12);
      }
      .nuvio-youtube-stream-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: center;
        font: 600 15px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      }
      .nuvio-youtube-stream-close,
      .nuvio-youtube-stream-open {
        appearance: none;
        -webkit-appearance: none;
        min-width: 44px;
        min-height: 44px;
        border: 0;
        border-radius: 12px;
        background: rgba(255, 255, 255, .10);
        color: #fff;
        font: 600 15px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        touch-action: manipulation;
      }
      .nuvio-youtube-stream-close { font-size: 24px; }
      .nuvio-youtube-stream-frame-wrap {
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        background: #000;
      }
      .nuvio-youtube-stream-frame {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border: 0;
        background: #000;
      }
      @media (orientation: landscape) and (max-height: 620px) {
        .nuvio-youtube-stream-toolbar {
          position: absolute;
          z-index: 2;
          top: env(safe-area-inset-top, 0px);
          left: env(safe-area-inset-left, 0px);
          right: env(safe-area-inset-right, 0px);
          min-height: 48px;
          background: linear-gradient(180deg, rgba(0,0,0,.78), rgba(0,0,0,0));
          border-bottom: 0;
        }
        .nuvio-youtube-stream-frame-wrap { flex-basis: 100%; }
      }
    `;

    if (!document.getElementById(style.id)) document.head.appendChild(style);
    document.body.appendChild(root);

    root.querySelector(".nuvio-youtube-stream-close")?.addEventListener("click", closeYoutubeOverlay);
    root.querySelector(".nuvio-youtube-stream-open")?.addEventListener("click", () => {
      if (!activeYoutubeId) return;
      window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(activeYoutubeId)}`, "_blank", "noopener,noreferrer");
    });

    overlay = root;
    return root;
  }

  function openYoutubeOverlay(record) {
    const ytId = normalizeYoutubeId(record?.ytId);
    if (!ytId) return false;

    document.querySelectorAll("video").forEach((video) => {
      try {
        video.pause();
      } catch (_) {}
    });

    const root = ensureOverlay();
    const frame = root.querySelector(".nuvio-youtube-stream-frame");
    const title = root.querySelector(".nuvio-youtube-stream-title");
    activeYoutubeId = ytId;
    if (title) title.textContent = record?.title || "YouTube";
    if (frame) frame.src = youtubeEmbedUrl(ytId);
    root.hidden = false;
    document.documentElement.classList.add("nuvio-youtube-stream-open");

    try {
      root.querySelector(".nuvio-youtube-stream-close")?.focus({ preventScroll: true });
    } catch (_) {}

    window.dispatchEvent(
      new CustomEvent("nuvio:youtube-stream-open", {
        detail: { ytId, version: VERSION }
      })
    );
    return true;
  }

  function closeYoutubeOverlay() {
    if (!overlay) return;
    const frame = overlay.querySelector(".nuvio-youtube-stream-frame");
    if (frame) frame.src = "about:blank";
    overlay.hidden = true;
    activeYoutubeId = "";
    document.documentElement.classList.remove("nuvio-youtube-stream-open");
  }

  function matchYoutubeStreamCard(card) {
    const streamId = String(card?.dataset?.streamId || "").trim();
    const cardText = normalizeText(card?.textContent || "");
    if (!streamId && !cardText) return null;

    const records = [...youtubeOnlyStreams.values()];

    const exactId = records.find((record) => record.rawId && record.rawId === streamId);
    if (exactId) return exactId;

    const idContainsYoutube = records.find((record) => streamId && streamId.includes(record.ytId));
    if (idContainsYoutube) return idContainsYoutube;

    const textMatches = records.filter(
      (record) => record.titleKey && record.titleKey.length >= 4 && cardText.includes(record.titleKey)
    );
    return textMatches.length === 1 ? textMatches[0] : null;
  }

  function onStreamCardActivation(event) {
    if (event.defaultPrevented) return;
    if ("button" in event && Number(event.button || 0) !== 0) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const card = target.closest(
      ".stream-route-card[data-action='playStream'][data-stream-id], .stream-route-card-action[data-stream-id]"
    );
    if (!card) return;

    const record = matchYoutubeStreamCard(card);
    if (!record) return;

    if (openYoutubeOverlay(record)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }
  }

  function installActivationBridge() {
    document.addEventListener("click", onStreamCardActivation, true);
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        onStreamCardActivation(event);
      },
      true
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && overlay && !overlay.hidden) {
          event.preventDefault();
          closeYoutubeOverlay();
        }
      },
      true
    );
  }

  installStreamDiscovery();
  installActivationBridge();

  window.NuvioMobileCompat = Object.freeze({
    version: VERSION,
    get youtubeOnlyStreamCount() {
      return youtubeOnlyStreams.size;
    },
    closeYoutubeOverlay
  });
})();
