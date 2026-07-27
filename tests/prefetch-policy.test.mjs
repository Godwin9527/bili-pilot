import assert from "node:assert/strict";
import test from "node:test";

await import("../prefetch-policy.js");

const policy = globalThis.BiliCdnPrefetchPolicy;

function playable(overrides = {}) {
  return {
    bufferedAhead: 50,
    ...overrides
  };
}

test("expands the prefetch window only when playback has more headroom", () => {
  assert.equal(policy.targetSegmentCount(14.9), 0);
  assert.equal(policy.targetSegmentCount(15), 3);
  assert.equal(policy.targetSegmentCount(30), 5);
  assert.equal(policy.targetSegmentCount(60), 8);
});

test("uses buffered headroom independently of playback state", () => {
  assert.equal(policy.evaluatePrefetchHeadroom(playable({ activePlaybackRequests: 5, paused: true, readyState: 0, underflow: true })).allowed, true);
  assert.equal(policy.evaluatePrefetchHeadroom(playable({ bufferedAhead: 8 })).reason, "buffer-low");
});
