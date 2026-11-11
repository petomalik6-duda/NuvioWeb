// Each upstream keeps its own last successful value. Concurrent refreshes share
// one request, and an outage is retried soon without dropping healthy sources.
export function createSourceCache({ ttl, retryMs = 60_000, now = Date.now, warn = console.warn }) {
  const entries = new Map();
  const pending = new Map();
  const degraded = new Set();

  async function one(source, loader) {
    const key = source.url;
    const old = entries.get(key);
    if (old && now() < old.retryAt) return old.value;
    if (pending.has(key)) return pending.get(key);
    const request = Promise.resolve().then(() => loader(source)).then(value => {
      entries.set(key, { value, retryAt: now() + ttl });
      degraded.delete(key);
      return value;
    }).catch(error => {
      degraded.add(key);
      entries.set(key, { value: old?.value, retryAt: now() + retryMs });
      warn('[IPTV source unavailable]', new URL(key).hostname, error.message);
      return old?.value;
    });
    pending.set(key, request);
    try { return await request; } finally { pending.delete(key); }
  }

  async function load(sources, loader) {
    const values = await Promise.all(sources.map(s => one(s, loader)));
    const available = values.filter(v => v !== undefined);
    if (!available.length) throw new Error('No IPTV source is available and no previous data is cached');
    return available;
  }

  return { load, ttl: () => degraded.size ? retryMs : ttl };
}

export function coalesce(loader) {
  let pending;
  return (...args) => {
    if (!pending) pending = Promise.resolve().then(() => loader(...args)).finally(() => { pending = undefined; });
    return pending;
  };
}
