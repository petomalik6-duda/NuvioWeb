import http from "node:http";

const originalRequest = http.request.bind(http);

const SAFARI_VIDEO_CODECS = ["h264", "h265", "hevc"];
const SAFARI_AUDIO_CODECS = ["aac", "ac3", "eac3", "mp3", "opus"];

function rewriteHlsPath(options) {
  if (!options || typeof options !== "object") return options;
  const host = String(options.hostname || options.host || "").toLowerCase();
  const pathname = String(options.path || "");
  if (!pathname.startsWith("/hlsv2/") || !["127.0.0.1", "localhost"].includes(host)) {
    return options;
  }

  try {
    const parsed = new URL(pathname, "http://127.0.0.1");

    // Let EngineFS decide between stream-copy and transcoding from the real
    // browser capabilities. Forcing transcoding made 4K HEVC unusable on the
    // small Render instance even though iOS Safari can decode HEVC natively.
    parsed.searchParams.delete("forceTranscoding");

    // EngineFS accepts repeated videoCodecs/audioCodecs parameters. Without
    // them it assumes a conservative compatibility set and transcodes HEVC +
    // E-AC3 to H.264/AAC. Modern iOS Safari supports these codecs in HLS/fMP4,
    // so advertise them explicitly and allow a zero-copy remux when possible.
    parsed.searchParams.delete("videoCodecs");
    parsed.searchParams.delete("audioCodecs");
    for (const codec of SAFARI_VIDEO_CODECS) {
      parsed.searchParams.append("videoCodecs", codec);
    }
    for (const codec of SAFARI_AUDIO_CODECS) {
      parsed.searchParams.append("audioCodecs", codec);
    }

    return {
      ...options,
      path: `${parsed.pathname}${parsed.search}`
    };
  } catch (_) {
    return options;
  }
}

function isLocalHlsPlaylistRequest(options) {
  if (!options || typeof options !== "object") return false;
  const host = String(options.hostname || options.host || "").toLowerCase();
  if (!["127.0.0.1", "localhost"].includes(host)) return false;
  try {
    const parsed = new URL(String(options.path || ""), "http://127.0.0.1");
    return parsed.pathname.startsWith("/hlsv2/") && parsed.pathname.endsWith(".m3u8");
  } catch (_) {
    return false;
  }
}

function playlistLabel(options) {
  try {
    const parsed = new URL(String(options?.path || ""), "http://127.0.0.1");
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || parsed.pathname;
  } catch (_) {
    return "unknown";
  }
}

function sanitizePlaylistPreview(text = "") {
  return String(text || "")
    .replace(/mediaURL=[^&\s\"']+/gi, "mediaURL=[redacted]")
    .replace(/\/api\/media-proxy\/play\/[^/\s\"']+/g, "/api/media-proxy/play/[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

http.request = function nuvioHlsRemuxRequest(options, callback) {
  const rewritten = rewriteHlsPath(options);
  const shouldTrace = isLocalHlsPlaylistRequest(rewritten);
  if (!shouldTrace || typeof callback !== "function") {
    return originalRequest(rewritten, callback);
  }

  const startedAt = Date.now();
  const label = playlistLabel(rewritten);
  return originalRequest(rewritten, (response) => {
    let bytes = 0;
    const previewChunks = [];
    let previewBytes = 0;
    const maxPreviewBytes = 2048;

    response.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (previewBytes < maxPreviewBytes) {
        const remaining = maxPreviewBytes - previewBytes;
        previewChunks.push(buffer.subarray(0, remaining));
        previewBytes += Math.min(buffer.length, remaining);
      }
    });
    response.on("end", () => {
      const preview = sanitizePlaylistPreview(Buffer.concat(previewChunks).toString("utf8"));
      console.log(
        `[hls-local] playlist=${label} status=${response.statusCode || 0} type=${String(response.headers?.["content-type"] || "unknown")} bytes=${bytes} elapsedMs=${Date.now() - startedAt} preview=${JSON.stringify(preview)}`
      );
    });
    response.on("aborted", () => {
      console.warn(
        `[hls-local] playlist=${label} aborted status=${response.statusCode || 0} bytes=${bytes} elapsedMs=${Date.now() - startedAt}`
      );
    });
    response.on("error", (error) => {
      console.warn(
        `[hls-local] playlist=${label} error=${String(error?.message || error || "unknown")} bytes=${bytes} elapsedMs=${Date.now() - startedAt}`
      );
    });

    callback(response);
  });
};
