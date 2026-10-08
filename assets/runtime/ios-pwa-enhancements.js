(() => {
  "use strict";

  const ua = String(navigator.userAgent || "");
  const platform = String(navigator.platform || "");
  const isTouchMac = platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1;
  const isIOS = /iPad|iPhone|iPod/i.test(ua) || isTouchMac;
  if (!isIOS) return;

  const STREAMSTR_HOSTS = new Set(["prehrajto.streamstr.stream", "cdn.streamstr.stream"]);
  const MEDIA_PROXY_REGISTER_ENDPOINT = "/api/media-proxy/register";
  const nativeMediaPlay = HTMLMediaElement.prototype.play;
  const proxyRegistrationByVideo = new WeakMap();
  const deferredResumeByVideo = new WeakMap();
  const applyingDeferredResume = new WeakSet();

  const root = document.documentElement;
  root.classList.add("nuvio-ios-webkit");
  if (window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone === true) {
    root.classList.add("nuvio-ios-standalone");
  }

  let activeVideo = null;
  let controls = null;
  let airplayButton = null;
  let pipButton = null;

  function isStreamstrUrl(value = "") {
    try {
      const url = new URL(String(value || ""), location.href);
      return url.protocol === "https:" && STREAMSTR_HOSTS.has(url.hostname.toLowerCase());
    } catch (_) {
      return false;
    }
  }

  function isNuvioMediaHlsUrl(value = "") {
    try {
      const url = new URL(String(value || ""), location.href);
      return (
        url.origin === location.origin &&
        /^\/api\/media-hls\/[^/]+\/master\.m3u8$/i.test(url.pathname)
      );
    } catch (_) {
      return false;
    }
  }

  function currentVideoSource(video) {
    return String(video?.currentSrc || video?.src || video?.getAttribute?.("src") || "").trim();
  }

  function installDeferredHlsResumeHook() {
    if (HTMLMediaElement.prototype.__nuvioDeferredHlsResumeInstalled) return;

    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
    if (!descriptor?.get || !descriptor?.set || descriptor.configurable === false) return;

    Object.defineProperty(HTMLMediaElement.prototype, "__nuvioDeferredHlsResumeInstalled", {
      value: true,
      configurable: true
    });

    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        const target = Number(value);
        const sourceUrl = currentVideoSource(this);
        const shouldDefer =
          this instanceof HTMLVideoElement &&
          isNuvioMediaHlsUrl(sourceUrl) &&
          !applyingDeferredResume.has(this) &&
          Number.isFinite(target) &&
          target > 5 &&
          Number(this.readyState || 0) < 2;

        if (shouldDefer) {
          deferredResumeByVideo.set(this, target);
          this.dataset.nuvioDeferredResume = String(target);
          return descriptor.set.call(this, 0);
        }

        return descriptor.set.call(this, value);
      }
    });
  }

  function applyDeferredResumeIfReady(video) {
    if (!(video instanceof HTMLVideoElement)) return false;
    const target = Number(deferredResumeByVideo.get(video));
    if (!Number.isFinite(target) || target <= 5 || Number(video.readyState || 0) < 2) return false;

    deferredResumeByVideo.delete(video);
    delete video.dataset.nuvioDeferredResume;
    applyingDeferredResume.add(video);
    try {
      video.currentTime = target;
      console.info(`[Nuvio iOS] Applied deferred HLS resume at ${Math.round(target)}s`);
      return true;
    } catch (_) {
      return false;
    } finally {
      applyingDeferredResume.delete(video);
    }
  }

  async function registerStreamstrProxy(video, sourceUrl) {
    const current = proxyRegistrationByVideo.get(video);
    if (current?.sourceUrl === sourceUrl && current?.promise) {
      return current.promise;
    }

    const promise = (async () => {
      const response = await fetch(MEDIA_PROXY_REGISTER_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          url: sourceUrl,
          filename: (() => {
            try {
              return decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || "media");
            } catch (_) {
              return "media";
            }
          })()
        })
      });
      if (!response.ok) {
        throw new Error(`Prehrajto proxy registration failed (${response.status})`);
      }
      const payload = await response.json();
      const playbackUrl = String(payload?.playbackUrl || "").trim();
      if (!playbackUrl) {
        throw new Error("Prehrajto proxy registration returned no playback URL");
      }

      if (currentVideoSource(video) !== sourceUrl) {
        return false;
      }

      video.dataset.nuvioPrehrajtoProxy = "1";
      video.dataset.nuvioPrehrajtoOriginalHost = "prehrajto.streamstr.stream";
      deferredResumeByVideo.delete(video);
      delete video.dataset.nuvioDeferredResume;
      video.src = playbackUrl;
      try {
        video.load();
      } catch (_) {}
      console.info("[Nuvio iOS] Prehrajto media routed through same-origin proxy");
      return true;
    })()
      .catch((error) => {
        console.warn("[Nuvio iOS] Prehrajto proxy preparation failed", error);
        return false;
      })
      .finally(() => {
        const active = proxyRegistrationByVideo.get(video);
        if (active?.promise === promise) {
          proxyRegistrationByVideo.delete(video);
        }
      });

    proxyRegistrationByVideo.set(video, { sourceUrl, promise });
    return promise;
  }

  function installFinalPlayProxyHook() {
    if (HTMLMediaElement.prototype.__nuvioPrehrajtoPlayHookInstalled) return;

    Object.defineProperty(HTMLMediaElement.prototype, "__nuvioPrehrajtoPlayHookInstalled", {
      value: true,
      configurable: true
    });

    HTMLMediaElement.prototype.play = function nuvioIosPlayWithPrehrajtoProxy(...args) {
      if (!(this instanceof HTMLVideoElement)) {
        return nativeMediaPlay.apply(this, args);
      }

      const sourceUrl = currentVideoSource(this);
      if (!isStreamstrUrl(sourceUrl)) {
        return nativeMediaPlay.apply(this, args);
      }

      return registerStreamstrProxy(this, sourceUrl).then(() => nativeMediaPlay.apply(this, args));
    };
  }

  function visibleVideoCandidates() {
    return [...document.querySelectorAll("video")].filter((video) => {
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      return rect.width > 80 && rect.height > 45 && style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function pickActiveVideo() {
    const videos = visibleVideoCandidates();
    if (!videos.length) return null;
    const playing = videos.find((video) => !video.paused && !video.ended && video.readyState >= 2);
    return playing || videos[0];
  }

  function enhanceVideo(video) {
    if (!(video instanceof HTMLVideoElement) || video.dataset.nuvioIosEnhanced === "1") return;
    video.dataset.nuvioIosEnhanced = "1";
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("x-webkit-airplay", "allow");
    try {
      video.disableRemotePlayback = false;
    } catch (_) {}

    video.addEventListener("play", refreshControls, { passive: true });
    video.addEventListener("loadedmetadata", refreshControls, { passive: true });
    video.addEventListener("loadeddata", () => applyDeferredResumeIfReady(video), { passive: true });
    video.addEventListener("canplay", () => applyDeferredResumeIfReady(video), { passive: true });
    video.addEventListener("emptied", () => {
      deferredResumeByVideo.delete(video);
      delete video.dataset.nuvioDeferredResume;
      refreshControls();
    }, { passive: true });
    video.addEventListener("webkitplaybacktargetavailabilitychanged", refreshControls, {
      passive: true
    });
  }

  function supportsAirPlay(video) {
    return Boolean(video && typeof video.webkitShowPlaybackTargetPicker === "function");
  }

  function supportsPiP(video) {
    if (!video) return false;
    if (typeof video.webkitSetPresentationMode === "function") return true;
    return Boolean(document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function");
  }

  function ensureControls() {
    if (controls) return;
    controls = document.createElement("div");
    controls.className = "nuvio-ios-media-tools";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "iOS playback controls");

    airplayButton = document.createElement("button");
    airplayButton.type = "button";
    airplayButton.className = "nuvio-ios-media-tool nuvio-ios-airplay";
    airplayButton.setAttribute("aria-label", "AirPlay");
    airplayButton.title = "AirPlay";
    airplayButton.innerHTML = '<span aria-hidden="true" class="nuvio-airplay-glyph">▰</span><span>AirPlay</span>';
    airplayButton.addEventListener("click", () => {
      const video = activeVideo || pickActiveVideo();
      if (!supportsAirPlay(video)) return;
      try {
        video.webkitShowPlaybackTargetPicker();
      } catch (error) {
        console.warn("AirPlay picker could not be opened", error);
      }
    });

    pipButton = document.createElement("button");
    pipButton.type = "button";
    pipButton.className = "nuvio-ios-media-tool nuvio-ios-pip";
    pipButton.setAttribute("aria-label", "Picture in Picture");
    pipButton.title = "Picture in Picture";
    pipButton.innerHTML = '<span aria-hidden="true">▣</span><span>PiP</span>';
    pipButton.addEventListener("click", async () => {
      const video = activeVideo || pickActiveVideo();
      if (!supportsPiP(video)) return;
      try {
        if (typeof video.webkitSetPresentationMode === "function") {
          const nextMode = video.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture";
          video.webkitSetPresentationMode(nextMode);
          return;
        }
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (error) {
        console.warn("Picture in Picture could not be changed", error);
      }
    });

    controls.append(airplayButton, pipButton);
    document.body.appendChild(controls);
  }

  function refreshControls() {
    document.querySelectorAll("video").forEach(enhanceVideo);
    activeVideo = pickActiveVideo();
    ensureControls();

    const airplay = supportsAirPlay(activeVideo);
    const pip = supportsPiP(activeVideo);
    airplayButton.hidden = !airplay;
    pipButton.hidden = !pip;
    controls.hidden = !activeVideo || (!airplay && !pip);
    controls.classList.toggle("is-playing", Boolean(activeVideo && !activeVideo.paused && !activeVideo.ended));
  }

  const observer = new MutationObserver((records) => {
    let needsRefresh = false;
    for (const record of records) {
      for (const node of record.addedNodes || []) {
        if (node instanceof HTMLVideoElement) {
          enhanceVideo(node);
          needsRefresh = true;
        } else if (node instanceof Element && node.querySelector?.("video")) {
          node.querySelectorAll("video").forEach(enhanceVideo);
          needsRefresh = true;
        }
      }
      if (record.removedNodes?.length) needsRefresh = true;
    }
    if (needsRefresh) queueMicrotask(refreshControls);
  });

  function start() {
    installDeferredHlsResumeHook();
    installFinalPlayProxyHook();
    ensureControls();
    document.querySelectorAll("video").forEach(enhanceVideo);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    refreshControls();
    window.addEventListener("orientationchange", refreshControls, { passive: true });
    window.addEventListener("pageshow", refreshControls, { passive: true });
    document.addEventListener("visibilitychange", refreshControls, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
