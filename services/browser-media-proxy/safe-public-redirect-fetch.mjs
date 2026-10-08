import dns from "node:dns/promises";
import net from "node:net";

const STREAMSTR_ROOT = "streamstr.stream";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const nativeFetch = globalThis.fetch.bind(globalThis);

function isStreamstrHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  return host === STREAMSTR_ROOT || host.endsWith(`.${STREAMSTR_ROOT}`);
}

function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function isPrivateIpv6(address) {
  const value = String(address || "").toLowerCase();
  if (!value) return true;
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith("ff")) return true;
  if (value.startsWith("2001:db8:")) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

export function isPublicIp(address = "") {
  const family = net.isIP(String(address || ""));
  if (family === 4) return !isPrivateIpv4(address);
  if (family === 6) return !isPrivateIpv6(address);
  return false;
}

async function isSafePublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (_) {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return false;
  }
  if (net.isIP(hostname)) return isPublicIp(hostname);

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (_) {
    return false;
  }
  return addresses.length > 0 && addresses.every((entry) => isPublicIp(entry.address));
}

function redirectLocation(response, currentUrl) {
  const location = response.headers.get("location");
  if (!location) return "";
  try {
    return new URL(location, currentUrl).toString();
  } catch (_) {
    return "";
  }
}

async function fetchStreamstrFollowingSafePublicRedirects(input, init = {}) {
  const initialUrl = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
  let parsedInitial;
  try {
    parsedInitial = new URL(initialUrl);
  } catch (_) {
    return nativeFetch(input, init);
  }

  if (init?.redirect !== "manual" || !isStreamstrHost(parsedInitial.hostname)) {
    return nativeFetch(input, init);
  }

  let currentUrl = initialUrl;
  let currentMethod = String(init?.method || "GET").toUpperCase();
  for (let index = 0; index < 6; index += 1) {
    const response = await nativeFetch(currentUrl, {
      ...init,
      method: currentMethod,
      redirect: "manual"
    });
    if (!REDIRECT_STATUSES.has(Number(response.status || 0))) return response;

    const nextUrl = redirectLocation(response, currentUrl);
    if (!nextUrl) return response;
    if (!(await isSafePublicHttpsUrl(nextUrl))) {
      let targetHost = "invalid";
      try { targetHost = new URL(nextUrl).hostname; } catch (_) {}
      console.warn(`[media-proxy] blocked-unsafe-redirect targetHost=${targetHost}`);
      return response;
    }

    let fromHost = "unknown";
    let toHost = "unknown";
    try { fromHost = new URL(currentUrl).hostname; } catch (_) {}
    try { toHost = new URL(nextUrl).hostname; } catch (_) {}
    console.info(`[media-proxy] following-public-redirect from=${fromHost} to=${toHost}`);

    if (response.body) {
      try { await response.body.cancel(); } catch (_) {}
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
      currentMethod = "GET";
    }
    currentUrl = nextUrl;
  }
  throw new Error("Too many public media redirects");
}

globalThis.fetch = fetchStreamstrFollowingSafePublicRedirects;
