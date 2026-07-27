import assert from "node:assert/strict";
import test from "node:test";

await import("../core.js");
await import("../prefetch-store.js");

function createStore(options = {}) {
  return globalThis.BiliCdnPrefetchStore.createPrefetchStore({
    core: globalThis.BiliCdnCore,
    maxSegmentBytes: options.maxSegmentBytes || 1024,
    maxTotalBytes: options.maxTotalBytes || 4096,
    ttlMs: 60_000
  });
}

const plan = {
  candidates: [
    { host: "a.bilivideo.com", url: "https://a.bilivideo.com/video.m4s?sig=a" },
    { host: "b.akamaized.net", url: "https://b.akamaized.net/video.m4s?sig=b" }
  ],
  signature: "video-track"
};

const multiPlan = {
  candidates: [
    { host: "a.example", url: "https://a.example/video.m4s?sig=a" },
    { host: "b.example", url: "https://b.example/video.m4s?sig=b" },
    { host: "c.example", url: "https://c.example/video.m4s?sig=c" }
  ],
  signature: "multi-cdn-track"
};

test("assembles one player Range from ready segments on different CDNs", () => {
  const store = createStore();
  const first = store.ensure(plan, { host: "a.bilivideo.com", range: "bytes=100-199" }, 1).entry;
  const second = store.ensure(plan, { host: "b.akamaized.net", range: "bytes=200-299" }, 1).entry;
  Object.assign(first, {
    buffer: new Uint8Array(100).fill(1).buffer,
    contentType: "video/mp4",
    state: "ready",
    totalBytes: 1000
  });
  Object.assign(second, {
    buffer: new Uint8Array(100).fill(2).buffer,
    contentType: "video/mp4",
    state: "ready",
    totalBytes: 1000
  });

  const assembled = store.assemble(plan.signature, "bytes=150-249");
  assert.equal(assembled.status, 206);
  assert.equal(assembled.headers["content-range"], "bytes 150-249/1000");
  assert.deepEqual(assembled.cacheHosts, ["a.bilivideo.com", "b.akamaized.net"]);
  assert.deepEqual([...new Uint8Array(assembled.buffer).slice(0, 50)], new Array(50).fill(1));
  assert.deepEqual([...new Uint8Array(assembled.buffer).slice(50)], new Array(50).fill(2));
  assert.equal(store.assemble(plan.signature, "bytes=50-149"), null);

  store.consume(assembled.cacheKeys);
  assert.equal(store.snapshot(plan.signature).ready, 0);
});

test("reconcile preserves ready cache and removes obsolete unfinished work", () => {
  const store = createStore();
  const retained = store.ensure(plan, {
    alternativeHosts: ["a.bilivideo.com"],
    host: "b.akamaized.net",
    range: "bytes=100-199"
  }, 1).entry;
  retained.host = "a.bilivideo.com";
  retained.state = "ready";
  retained.buffer = new ArrayBuffer(100);

  store.reconcile(plan.signature, [{
    alternativeHosts: ["a.bilivideo.com"],
    host: "b.akamaized.net",
    range: "bytes=100-199"
  }]);
  assert.equal(store.get(retained.key), retained);

  store.reconcile(plan.signature, [{ host: "b.akamaized.net", range: "bytes=200-299" }]);
  assert.equal(store.get(retained.key), retained);

  const obsolete = store.ensure(plan, {
    host: "b.akamaized.net",
    range: "bytes=300-399"
  }, 1).entry;
  store.reconcile(plan.signature, [{ host: "b.akamaized.net", range: "bytes=200-299" }]);
  assert.equal(store.get(obsolete.key), undefined);
});

test("tracks an arbitrary ranked CDN list and resolves pending complete coverage", async () => {
  const store = createStore();
  const first = store.ensure(multiPlan, {
    alternativeHosts: ["b.example", "c.example"],
    host: "a.example",
    index: 1,
    range: "bytes=100-199"
  }, 1).entry;
  const second = store.ensure(multiPlan, {
    alternativeHosts: ["a.example", "b.example"],
    host: "c.example",
    index: 2,
    range: "bytes=200-299"
  }, 1).entry;
  store.markAttempt(first, "a.example", 1);
  store.markAttempt(first, "b.example", 2);
  store.markAttempt(second, "c.example", 1);

  const pending = store.pendingCoverage(multiPlan.signature, "bytes=150-249");
  assert.ok(pending);
  assert.deepEqual(first.hosts, ["a.example", "b.example", "c.example"]);
  assert.equal(store.snapshot(multiPlan.signature).retrying, 1);

  store.markReady(first, {
    buffer: new Uint8Array(100).fill(1).buffer,
    contentType: "video/mp4",
    totalBytes: 1000,
    url: multiPlan.candidates[1].url
  });
  store.markReady(second, {
    buffer: new Uint8Array(100).fill(2).buffer,
    contentType: "video/mp4",
    totalBytes: 1000,
    url: multiPlan.candidates[2].url
  });

  const assembled = await pending.promise;
  assert.equal(assembled.status, 206);
  assert.deepEqual(assembled.cacheHosts, ["b.example", "c.example"]);
  assert.equal(assembled.buffer.byteLength, 100);
});

test("keeps the player-overlapping task and cancels unrelated pending segments", () => {
  const store = createStore();
  const requested = store.ensure(multiPlan, {
    alternativeHosts: ["b.example", "c.example"],
    host: "a.example",
    range: "bytes=100-199"
  }, 1).entry;
  const unrelated = store.ensure(multiPlan, {
    alternativeHosts: ["b.example", "c.example"],
    host: "a.example",
    range: "bytes=200-299"
  }, 1).entry;

  const removed = store.cancelPendingExcept(multiPlan.signature, "bytes=100-199", "player-range-priority");
  assert.deepEqual(removed, [unrelated]);
  assert.equal(store.get(requested.key), requested);
  assert.equal(store.get(unrelated.key), undefined);
});

test("reactivates a backed-off segment with a freshly ranked multi-CDN plan", () => {
  const store = createStore();
  const entry = store.ensure(multiPlan, {
    alternativeHosts: ["b.example", "c.example"],
    host: "a.example",
    range: "bytes=100-199"
  }, 1).entry;
  store.markBackoff(entry, { error: "all failed", nextProbeAt: Date.now() - 1 });

  const refreshed = store.ensure(multiPlan, {
    alternativeHosts: ["b.example", "a.example"],
    host: "c.example",
    range: "bytes=100-199"
  }, 2);
  assert.equal(refreshed.reactivated, true);
  assert.equal(entry.state, "queued");
  assert.deepEqual(entry.hosts, ["c.example", "b.example", "a.example"]);
});

test("playback cancellation preserves backoff and failed history", () => {
  const store = createStore();
  const active = store.ensure(multiPlan, {
    alternativeHosts: ["b.example", "c.example"],
    host: "a.example",
    range: "bytes=100-199"
  }, 1).entry;
  const backoff = store.ensure(multiPlan, {
    alternativeHosts: ["b.example", "c.example"],
    host: "a.example",
    range: "bytes=200-299"
  }, 1).entry;
  const failed = store.ensure(multiPlan, {
    alternativeHosts: ["b.example", "c.example"],
    host: "a.example",
    range: "bytes=300-399"
  }, 1).entry;
  store.markAttempt(active, "a.example", 1);
  store.markBackoff(backoff, { error: "temporary", nextProbeAt: Date.now() + 1000 });
  store.markFailed(failed, { error: "exhausted" });

  const removed = store.cancelBackground("player-request-active");

  assert.deepEqual(removed, [active]);
  assert.equal(store.get(backoff.key), backoff);
  assert.equal(store.get(failed.key), failed);
  assert.equal(store.snapshot(multiPlan.signature).backoff, 1);
  assert.equal(store.snapshot(multiPlan.signature).failed, 1);
});
