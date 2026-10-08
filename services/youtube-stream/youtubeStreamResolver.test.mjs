import test from "node:test";
import assert from "node:assert/strict";
import { normalizeYouTubeVideoId } from "./youtubeStreamResolver.mjs";

test("accepts a plain 11-character ytId", () => {
  assert.equal(normalizeYouTubeVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("extracts ids from common YouTube URLs", () => {
  assert.equal(
    normalizeYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "dQw4w9WgXcQ"
  );
  assert.equal(normalizeYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(
    normalizeYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
    "dQw4w9WgXcQ"
  );
});

test("rejects malformed ids", () => {
  assert.equal(normalizeYouTubeVideoId(""), "");
  assert.equal(normalizeYouTubeVideoId("too-short"), "");
  assert.equal(normalizeYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), "");
});
