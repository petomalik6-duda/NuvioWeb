import http from "node:http";

const originalRequest = http.request.bind(http);

function rewriteHlsPath(options) {
  if (!options || typeof options !== "object") return options;
  const host = String(options.hostname || options.host || "").toLowerCase();
  const pathname = String(options.path || "");
  if (!pathname.startsWith("/hlsv2/") || !["127.0.0.1", "localhost"].includes(host)) {
    return options;
  }

  try {
    const parsed = new URL(pathname, "http://127.0.0.1");
    if (parsed.searchParams.get("forceTranscoding") !== "1") return options;
    parsed.searchParams.delete("forceTranscoding");
    return {
      ...options,
      path: `${parsed.pathname}${parsed.search}`
    };
  } catch (_) {
    return options;
  }
}

http.request = function nuvioHlsRemuxRequest(options, callback) {
  return originalRequest(rewriteHlsPath(options), callback);
};
