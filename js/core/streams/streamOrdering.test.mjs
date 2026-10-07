import assert from "node:assert/strict";
import test from "node:test";

import { orderSourceNames, orderStreamsByAddonOrder, rankCzSkStream } from "./streamOrdering.js";

function addon(id, name, order, streamId) {
  return {
    id: streamId,
    addonName: name,
    addonOrderIndex: order,
    streamOrigin: { kind: "addon", addonId: id, addonName: name, addonOrderIndex: order }
  };
}

test("ordering keeps managed groups first and preserves each source's stable internal order", () => {
  const streams = [
    addon("second", "Second", 1, "second-a"),
    addon("first", "First", 0, "first-a"),
    { ...addon("first", "First", 0, "first-b"), managed: true },
    addon("second", "Second", 1, "second-b"),
    { id: "plugin", addonName: "Plugin", streamOrigin: { kind: "plugin", sourceProviderId: "plugin" } }
  ];
  const ordered = orderStreamsByAddonOrder(
    streams,
    [
      { name: "First", orderIndex: 0 },
      { name: "Second", orderIndex: 1 }
    ],
    { isDirectDebrid: (stream) => stream.managed === true }
  );

  assert.deepEqual(ordered.map((stream) => stream.id), ["first-a", "first-b", "second-a", "second-b", "plugin"]);
});

test("source names and raw streams retain deterministic configured ordering when resolving is off", () => {
  const streams = [addon("second", "Second", 1, "raw-uncached"), addon("first", "First", 0, "raw-unknown")];
  const chips = [
    { name: "First", orderIndex: 0 },
    { name: "Second", orderIndex: 1 },
    { name: "Empty", orderIndex: 2 }
  ];
  assert.deepEqual(orderStreamsByAddonOrder(streams, chips).map((stream) => stream.id), ["raw-unknown", "raw-uncached"]);
  assert.deepEqual(orderSourceNames(streams, chips), ["First", "Second", "Empty"]);
});

test("CZ streams are globally preferred over SK and other languages", () => {
  const streams = [
    { ...addon("en", "English", 0, "en-4k"), title: "Movie 2160p English" },
    { ...addon("sk", "Slovak", 1, "sk-4k"), title: "Movie 2160p SK dabing" },
    { ...addon("cz", "Czech", 2, "cz-1080"), title: "Movie 1080p CZ dabing" }
  ];
  const ordered = orderStreamsByAddonOrder(streams, []);
  assert.deepEqual(ordered.map((stream) => stream.id), ["cz-1080", "sk-4k", "en-4k"]);
});

test("within one language quality wins, then larger file wins", () => {
  const streams = [
    { ...addon("a", "A", 0, "cz-1080"), title: "CZ dabing 1080p 20 GB" },
    { ...addon("b", "B", 1, "cz-4k-small"), title: "CZ dabing 4K 12 GB" },
    { ...addon("c", "C", 2, "cz-4k-large"), title: "CZ dabing 4K 25 GB" }
  ];
  const ordered = orderStreamsByAddonOrder(streams, []);
  assert.deepEqual(ordered.map((stream) => stream.id), ["cz-4k-large", "cz-4k-small", "cz-1080"]);
});

test("ranking recognizes explicit CZ/SK metadata and file size", () => {
  assert.deepEqual(rankCzSkStream({ language: "cs", qualityValue: 2160, fileSize: 10_000 }), {
    language: 0,
    quality: 2160,
    size: 10_000
  });
  assert.equal(rankCzSkStream({ title: "Slovenský dabing 1080p 8 GB" }).language, 1);
});
