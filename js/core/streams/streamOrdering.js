const UNKNOWN_SOURCE_RANK = Number.MAX_SAFE_INTEGER;

function finiteSourceRank(value) {
  const rank = Number(value);
  return Number.isFinite(rank) && rank >= 0 && rank < UNKNOWN_SOURCE_RANK ? rank : null;
}

function normalizedName(value) {
  return String(value || "").trim();
}

function streamAddonOrderIndex(stream = {}) {
  return finiteSourceRank(stream?.addonOrderIndex) ?? finiteSourceRank(stream?.streamOrigin?.addonOrderIndex);
}

function streamSourceKind(stream = {}) {
  const originKind = normalizedName(stream?.streamOrigin?.kind).toLowerCase();
  if (originKind) return originKind;
  return streamAddonOrderIndex(stream) != null ? "addon" : "plugin";
}

function streamSourceGroupKey(stream = {}, index = 0) {
  const origin = stream?.streamOrigin || {};
  const kind = streamSourceKind(stream);
  const identity =
    kind === "plugin"
      ? origin.sourceProviderId || stream.sourceProviderId || origin.addonName || stream.addonName
      : origin.addonId ||
        stream.addonId ||
        origin.addonBaseUrl ||
        stream.addonBaseUrl ||
        origin.addonName ||
        stream.addonName;
  return `${kind}:${normalizedName(identity) || `index-${index}`}`;
}

function buildAddonRanks(streams, sourceChips) {
  const ranks = new Map();
  const pluginNames = new Set(
    (Array.isArray(streams) ? streams : [])
      .filter((stream) => streamSourceKind(stream) === "plugin")
      .map((stream) => normalizedName(stream?.addonName))
      .filter(Boolean)
  );
  (Array.isArray(sourceChips) ? sourceChips : []).forEach((chip, index) => {
    const name = normalizedName(chip?.name);
    if (!name || pluginNames.has(name)) return;
    const rank = finiteSourceRank(chip?.orderIndex) ?? index;
    if (!ranks.has(name) || rank < ranks.get(name)) ranks.set(name, rank);
  });
  (Array.isArray(streams) ? streams : []).forEach((stream) => {
    if (streamSourceKind(stream) === "plugin") return;
    const name = normalizedName(stream?.addonName);
    const rank = streamAddonOrderIndex(stream);
    if (name && rank != null && !ranks.has(name)) ranks.set(name, rank);
  });
  return ranks;
}

function czSkSortingEnabled() {
  if (globalThis?.NUVIO_CZSK_SORT === false) return false;
  try {
    const value = globalThis?.localStorage?.getItem?.("nuvio.czskSort");
    if (value && ["0", "false", "off", "disabled"].includes(String(value).toLowerCase())) {
      return false;
    }
  } catch (_) {
    // Storage can be unavailable in private/restricted browser contexts.
  }
  return true;
}

function streamSearchText(stream = {}) {
  const hints = stream?.behaviorHints || {};
  const raw = stream?.raw || {};
  const values = [
    stream?.name,
    stream?.title,
    stream?.description,
    stream?.quality,
    stream?.language,
    stream?.languages,
    stream?.audioLanguage,
    stream?.audioLanguages,
    hints?.filename,
    hints?.videoFilename,
    hints?.language,
    hints?.audioLanguage,
    hints?.audioLanguages,
    raw?.name,
    raw?.title,
    raw?.description,
    raw?.language,
    raw?.languages,
    raw?.audioLanguage,
    raw?.audioLanguages
  ];
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value != null)
    .map((value) => String(value))
    .join(" ")
    .toLowerCase();
}

function languageRank(stream = {}) {
  const text = streamSearchText(stream)
    .normalize?.("NFD")
    ?.replace(/[\u0300-\u036f]/g, "") || streamSearchText(stream);

  const cz = /(^|[^a-z0-9])(cz|cs|cze|czech|cesky|cestina)([^a-z0-9]|$)/i.test(text) ||
    /czech\s*(audio|dub|dubbed|dabing)/i.test(text) ||
    /(audio|dub|dubbed|dabing)\s*(cz|cs|czech|cesky)/i.test(text);
  if (cz) return 0;

  const sk = /(^|[^a-z0-9])(sk|svk|slovak|slovensky|slovencina)([^a-z0-9]|$)/i.test(text) ||
    /slovak\s*(audio|dub|dubbed|dabing)/i.test(text) ||
    /(audio|dub|dubbed|dabing)\s*(sk|svk|slovak|slovensky)/i.test(text);
  if (sk) return 1;

  return 2;
}

function qualityRank(stream = {}) {
  const explicit = Number(stream?.qualityValue);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const text = streamSearchText(stream);
  if (/\b(2160p?|4k|uhd)\b/i.test(text)) return 2160;
  if (/\b1440p?\b/i.test(text)) return 1440;
  if (/\b1080p?\b/i.test(text)) return 1080;
  if (/\b720p?\b/i.test(text)) return 720;
  if (/\b576p?\b/i.test(text)) return 576;
  if (/\b480p?\b/i.test(text)) return 480;
  return -1;
}

function normalizeByteSize(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parsedSizeFromText(text = "") {
  const matches = [...String(text).matchAll(/(\d+(?:[.,]\d+)?)\s*(tb|gb|mb|kb)\b/gi)];
  if (!matches.length) return 0;
  const multipliers = {
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4
  };
  return Math.max(
    ...matches.map((match) => {
      const amount = Number(String(match[1]).replace(",", "."));
      return Number.isFinite(amount) ? amount * multipliers[String(match[2]).toLowerCase()] : 0;
    })
  );
}

function sizeRank(stream = {}) {
  const hints = stream?.behaviorHints || {};
  const raw = stream?.raw || {};
  const candidates = [
    stream?.size,
    stream?.fileSize,
    stream?.videoSize,
    hints?.size,
    hints?.fileSize,
    hints?.videoSize,
    raw?.size,
    raw?.fileSize,
    raw?.videoSize,
    raw?.behaviorHints?.size,
    raw?.behaviorHints?.fileSize,
    raw?.behaviorHints?.videoSize
  ];
  const numeric = Math.max(0, ...candidates.map(normalizeByteSize));
  return numeric || parsedSizeFromText(streamSearchText(stream));
}

export function rankCzSkStream(stream = {}) {
  return {
    language: languageRank(stream),
    quality: qualityRank(stream),
    size: sizeRank(stream)
  };
}

function compareCzSkStreams(left, right) {
  const a = rankCzSkStream(left);
  const b = rankCzSkStream(right);
  if (a.language !== b.language) return a.language - b.language;
  if (a.quality !== b.quality) return b.quality - a.quality;
  if (a.size !== b.size) return b.size - a.size;
  return 0;
}

function bestGroupStream(group) {
  return group.items.slice().sort(compareCzSkStreams)[0] || {};
}

/**
 * Orders all streams globally for CZ/SK-first playback while retaining direct-debrid and configured
 * addon ordering as deterministic tie-breakers. Disable with localStorage `nuvio.czskSort=off` or
 * globalThis.NUVIO_CZSK_SORT=false.
 */
export function orderStreamsByAddonOrder(
  streams = [],
  sourceChips = [],
  { isDirectDebrid = () => false } = {}
) {
  const list = (Array.isArray(streams) ? streams : []).filter(Boolean);
  if (list.length <= 1) return list.slice();
  const addonRanks = buildAddonRanks(list, sourceChips);
  const groups = [];
  const groupsByKey = new Map();
  list.forEach((stream, index) => {
    const key = streamSourceGroupKey(stream, index);
    let group = groupsByKey.get(key);
    if (!group) {
      group = { firstIndex: index, items: [], isDirectDebrid: false };
      groupsByKey.set(key, group);
      groups.push(group);
    }
    group.items.push(stream);
    try {
      group.isDirectDebrid = group.isDirectDebrid || Boolean(isDirectDebrid(stream));
    } catch (_) {
      // A malformed resolver marker must not prevent the source list loading.
    }
  });

  const useCzSk = czSkSortingEnabled();
  if (useCzSk) {
    groups.forEach((group) => {
      group.items = group.items
        .map((item, index) => ({ item, index }))
        .sort((left, right) => compareCzSkStreams(left.item, right.item) || left.index - right.index)
        .map(({ item }) => item);
      group.bestStream = bestGroupStream(group);
    });
  }

  const groupRank = (group) => {
    const addonName = normalizedName(group.items[0]?.addonName);
    return {
      directDebrid: group.isDirectDebrid ? 0 : 1,
      configured: addonRanks.has(addonName) ? 0 : 1,
      addonRank: addonRanks.get(addonName) ?? UNKNOWN_SOURCE_RANK
    };
  };

  groups.sort((left, right) => {
    if (useCzSk) {
      const streamPriority = compareCzSkStreams(left.bestStream || {}, right.bestStream || {});
      if (streamPriority !== 0) return streamPriority;
    }
    const leftRank = groupRank(left);
    const rightRank = groupRank(right);
    if (leftRank.directDebrid !== rightRank.directDebrid) {
      return leftRank.directDebrid - rightRank.directDebrid;
    }
    if (leftRank.configured !== rightRank.configured) {
      return leftRank.configured - rightRank.configured;
    }
    if (leftRank.addonRank !== rightRank.addonRank) {
      return leftRank.addonRank - rightRank.addonRank;
    }
    return left.firstIndex - right.firstIndex;
  });
  return groups.flatMap((group) => group.items);
}

export function orderSourceNames(streams = [], sourceChips = [], { isDirectDebrid = () => false } = {}) {
  const ordered = [];
  orderStreamsByAddonOrder(streams, sourceChips, { isDirectDebrid }).forEach((stream) => {
    const name = normalizedName(stream?.addonName);
    if (name && !ordered.includes(name)) ordered.push(name);
  });
  (Array.isArray(sourceChips) ? sourceChips : [])
    .slice()
    .sort(
      (left, right) =>
        (finiteSourceRank(left?.orderIndex) ?? UNKNOWN_SOURCE_RANK) -
        (finiteSourceRank(right?.orderIndex) ?? UNKNOWN_SOURCE_RANK)
    )
    .forEach((chip) => {
      const name = normalizedName(chip?.name);
      if (name && !ordered.includes(name)) ordered.push(name);
    });
  return ordered;
}
