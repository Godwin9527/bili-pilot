import assert from "node:assert/strict";
import test from "node:test";

await import("../core.js");
await import("../prefetch-store.js");
await import("../prefetch-policy.js");
await import("../prefetch-runtime.js");

function playableVideo(overrides = {}) {
  return {
    buffered: { length: 1, start: () => 0, end: () => 60 },
    currentTime: 10,
    paused: false,
    readyState: 4,
    ...overrides
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for runtime state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const multiCdnPlan = {
  candidates: [
    { host: "a.example", url: "https://a.example/video.m4s?sig=a" },
    { host: "b.example", url: "https://b.example/video.m4s?sig=b" },
    { host: "c.example", url: "https://c.example/video.m4s?sig=c" }
  ],
  currentPrimary: "a.example",
  segmentBase: { indexRange: "0-99" },
  signature: "multi-cdn-track"
};

test("prefetch runtime uses safe buffer even while player requests are active", () => {
  const published = [];
  const runtime = globalThis.BiliCdnPrefetchRuntime.createPrefetchRuntime({
    core: globalThis.BiliCdnCore,
    fetchImpl: async () => { throw new Error("not used"); },
    getActivePlan: () => null,
    getPreferredHost: () => null,
    isEnabled: () => false,
    policyCore: globalThis.BiliCdnPrefetchPolicy,
    postState: (state) => published.push(state),
    probeCore: { runProbe: async () => ({ segments: [] }) },
    storeCore: globalThis.BiliCdnPrefetchStore,
    traceEvent: () => {}
  });
  const video = playableVideo();

  assert.equal(runtime.headroom(video).allowed, true);
  runtime.beginPlaybackRequest("xhr", "bytes=0-99");
  assert.equal(runtime.headroom(video).allowed, true);
  runtime.endPlaybackRequest("xhr", "bytes=0-99");
  assert.equal(runtime.headroom(video).allowed, true);
  assert.equal(runtime.headroom(playableVideo({ paused: true, readyState: 0 })).allowed, true);

  runtime.publish({ reason: "test" });
  assert.equal(published.at(-1).strategy, "ranked-cdn-per-segment");
  assert.equal(published.at(-1).reason, "test");
});

test("a paused video with safe Bilibili buffer still plans a prefetch window", async () => {
  const originalDocument = globalThis.document;
  let probeRuns = 0;
  globalThis.document = {
    querySelector: () => playableVideo({ paused: true, readyState: 0 })
  };
  const runtime = globalThis.BiliCdnPrefetchRuntime.createPrefetchRuntime({
    core: globalThis.BiliCdnCore,
    fetchImpl: async () => { throw new Error("not used"); },
    getActivePlan: () => multiCdnPlan,
    getPreferredHost: () => null,
    isEnabled: () => true,
    policyCore: globalThis.BiliCdnPrefetchPolicy,
    postState: () => {},
    probeCore: {
      runProbe: async () => {
        probeRuns += 1;
        return { segments: [] };
      }
    },
    storeCore: globalThis.BiliCdnPrefetchStore,
    traceEvent: () => {}
  });
  try {
    runtime.scheduleWindow(0);
    await waitFor(() => probeRuns === 1);
    assert.equal(runtime.headroom().allowed, true);
  } finally {
    runtime.clear();
    globalThis.document = originalDocument;
  }
});

test("an active player request cannot starve safe-buffer prefetch planning", async () => {
  const originalDocument = globalThis.document;
  let probeRuns = 0;
  globalThis.document = { querySelector: () => playableVideo() };
  const runtime = globalThis.BiliCdnPrefetchRuntime.createPrefetchRuntime({
    core: globalThis.BiliCdnCore,
    fetchImpl: async () => { throw new Error("not used"); },
    getActivePlan: () => multiCdnPlan,
    getPreferredHost: () => null,
    isEnabled: () => true,
    policyCore: globalThis.BiliCdnPrefetchPolicy,
    postState: () => {},
    probeCore: {
      runProbe: async () => {
        probeRuns += 1;
        return { segments: [] };
      }
    },
    storeCore: globalThis.BiliCdnPrefetchStore,
    traceEvent: () => {}
  });
  try {
    runtime.beginPlaybackRequest("xhr", "bytes=0-99");
    runtime.scheduleWindow(0);
    await waitFor(() => probeRuns === 1);
    runtime.endPlaybackRequest("xhr", "bytes=0-99");
  } finally {
    runtime.clear();
    globalThis.document = originalDocument;
  }
});

test("full-segment download retries every ranked CDN until one completes", async () => {
  const originalDocument = globalThis.document;
  const published = [];
  const traces = [];
  const calls = [];
  globalThis.document = { querySelector: () => playableVideo() };
  const runtime = globalThis.BiliCdnPrefetchRuntime.createPrefetchRuntime({
    core: globalThis.BiliCdnCore,
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      calls.push(host);
      if (host === "a.example") throw new Error("first CDN failed");
      if (host === "b.example") return new Response(new Uint8Array(0), { status: 503 });
      return new Response(new Uint8Array(100).fill(3), {
        headers: { "content-range": "bytes 100-199/1000" },
        status: 206
      });
    },
    getActivePlan: () => multiCdnPlan,
    getPreferredHost: () => null,
    isEnabled: () => true,
    policyCore: globalThis.BiliCdnPrefetchPolicy,
    postState: (state) => published.push(state),
    probeCore: {
      runProbe: async () => ({
        segments: [{
          alternativeHosts: ["b.example", "c.example"],
          host: "a.example",
          index: 1,
          range: "bytes=100-199"
        }]
      })
    },
    storeCore: globalThis.BiliCdnPrefetchStore,
    traceEvent: (type, detail) => traces.push({ type, ...detail })
  });
  try {
    runtime.scheduleWindow(0);
    await waitFor(() => runtime.store.snapshot(multiCdnPlan.signature).ready === 1);

    assert.deepEqual(calls, ["a.example", "b.example", "c.example"]);
    assert.deepEqual(
      traces.filter((entry) => entry.type === "segment-prefetch-retry").map((entry) => entry.toHost),
      ["b.example", "c.example"]
    );
    const segment = runtime.store.snapshot(multiCdnPlan.signature).segments[0];
    assert.equal(segment.host, "c.example");
    assert.equal(segment.state, "ready");
    assert.equal(segment.totalCandidates, 3);
    assert.ok(published.some((state) => state.ready === 1));
  } finally {
    runtime.clear();
    globalThis.document = originalDocument;
  }
});

test("a player Range promotes and reuses the same in-flight segment", async () => {
  const originalDocument = globalThis.document;
  let finishDownload;
  const calls = [];
  globalThis.document = { querySelector: () => playableVideo() };
  const runtime = globalThis.BiliCdnPrefetchRuntime.createPrefetchRuntime({
    core: globalThis.BiliCdnCore,
    fetchImpl: async (url) => {
      calls.push(new URL(url).hostname);
      return new Promise((resolve) => { finishDownload = resolve; });
    },
    getActivePlan: () => multiCdnPlan,
    getPreferredHost: () => null,
    isEnabled: () => true,
    policyCore: globalThis.BiliCdnPrefetchPolicy,
    postState: () => {},
    probeCore: {
      runProbe: async () => ({
        segments: [
          { alternativeHosts: ["b.example", "c.example"], host: "a.example", index: 1, range: "bytes=100-199" },
          { alternativeHosts: ["a.example", "c.example"], host: "b.example", index: 2, range: "bytes=200-299" }
        ]
      })
    },
    storeCore: globalThis.BiliCdnPrefetchStore,
    traceEvent: () => {}
  });
  try {
    runtime.scheduleWindow(0);
    await waitFor(() => {
      const snapshot = runtime.store.snapshot(multiCdnPlan.signature);
      return snapshot.loading === 1 && snapshot.queued === 1;
    });
    const promoted = runtime.promotePlaybackRange("bytes=100-199");
    assert.ok(promoted);
    assert.equal(runtime.store.snapshot(multiCdnPlan.signature).foreground, 1);
    assert.equal(runtime.store.snapshot(multiCdnPlan.signature).segments.length, 1);

    finishDownload(new Response(new Uint8Array(100).fill(7), {
      headers: { "content-range": "bytes 100-199/1000" },
      status: 206
    }));
    const cached = await promoted;

    assert.equal(cached.status, 206);
    assert.equal(cached.buffer.byteLength, 100);
    assert.deepEqual(calls, ["a.example"]);
    assert.equal(runtime.store.snapshot(multiCdnPlan.signature).ready, 1);
  } finally {
    runtime.clear();
    globalThis.document = originalDocument;
  }
});

test("a promoted download has a short deadline before the player falls back", async () => {
  const originalDocument = globalThis.document;
  let aborts = 0;
  globalThis.document = { querySelector: () => playableVideo() };
  const runtime = globalThis.BiliCdnPrefetchRuntime.createPrefetchRuntime({
    core: globalThis.BiliCdnCore,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        aborts += 1;
        reject(new Error("aborted for player fallback"));
      }, { once: true });
    }),
    getActivePlan: () => multiCdnPlan,
    getPreferredHost: () => null,
    isEnabled: () => true,
    policyCore: globalThis.BiliCdnPrefetchPolicy,
    postState: () => {},
    probeCore: {
      runProbe: async () => ({
        segments: [{
          alternativeHosts: ["b.example", "c.example"],
          host: "a.example",
          index: 1,
          range: "bytes=100-199"
        }]
      })
    },
    promotionWaitMs: 10,
    storeCore: globalThis.BiliCdnPrefetchStore,
    traceEvent: () => {}
  });
  try {
    runtime.scheduleWindow(0);
    await waitFor(() => runtime.store.snapshot(multiCdnPlan.signature).loading === 1);
    const startedAt = Date.now();
    const promoted = await runtime.promotePlaybackRange("bytes=100-199");

    assert.equal(promoted, null);
    assert.ok(Date.now() - startedAt < 200);
    assert.equal(aborts, 1);
    assert.equal(runtime.store.snapshot(multiCdnPlan.signature).segments.length, 0);
  } finally {
    runtime.clear();
    globalThis.document = originalDocument;
  }
});

test("all-CDN failure backs off, re-probes, and can recover with a new ranking", async () => {
  const originalDocument = globalThis.document;
  let probeRuns = 0;
  const traces = [];
  globalThis.document = { querySelector: () => playableVideo() };
  const runtime = globalThis.BiliCdnPrefetchRuntime.createPrefetchRuntime({
    core: globalThis.BiliCdnCore,
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      if (probeRuns === 1) throw new Error(`${host} unavailable`);
      if (host !== "b.example") throw new Error(`${host} still unavailable`);
      return new Response(new Uint8Array(100).fill(9), {
        headers: { "content-range": "bytes 100-199/1000" },
        status: 206
      });
    },
    getActivePlan: () => multiCdnPlan,
    getPreferredHost: () => null,
    isEnabled: () => true,
    policyCore: globalThis.BiliCdnPrefetchPolicy,
    postState: () => {},
    probeCore: {
      runProbe: async () => {
        probeRuns += 1;
        return {
          segments: [{
            alternativeHosts: probeRuns === 1 ? ["b.example", "c.example"] : ["c.example", "a.example"],
            host: probeRuns === 1 ? "a.example" : "b.example",
            index: 1,
            range: "bytes=100-199"
          }]
        };
      }
    },
    reprobeBaseMs: 5,
    reprobeMaxMs: 10,
    storeCore: globalThis.BiliCdnPrefetchStore,
    traceEvent: (type, detail) => traces.push({ type, ...detail })
  });
  try {
    runtime.scheduleWindow(0);
    await waitFor(() => runtime.store.snapshot(multiCdnPlan.signature).ready === 1, 1000);

    assert.ok(probeRuns >= 2);
    const backoff = traces.find((entry) => entry.type === "segment-prefetch-backoff");
    assert.deepEqual(backoff.attemptedHosts, ["a.example", "b.example", "c.example"]);
    const segment = runtime.store.snapshot(multiCdnPlan.signature).segments[0];
    assert.equal(segment.host, "b.example");
    assert.equal(segment.state, "ready");
    assert.deepEqual(segment.candidateHosts, ["b.example", "c.example", "a.example"]);
  } finally {
    runtime.clear();
    globalThis.document = originalDocument;
  }
});

test("an unavailable segment tries every CDN twice and then stays quarantined", async () => {
  const originalDocument = globalThis.document;
  const calls = [];
  let probeRuns = 0;
  globalThis.document = { querySelector: () => playableVideo() };
  const runtime = globalThis.BiliCdnPrefetchRuntime.createPrefetchRuntime({
    circuitFailureThreshold: 99,
    core: globalThis.BiliCdnCore,
    fetchImpl: async (url) => {
      calls.push(new URL(url).hostname);
      throw new Error("CDN unavailable");
    },
    getActivePlan: () => multiCdnPlan,
    getPreferredHost: () => null,
    isEnabled: () => true,
    maxFailureCycles: 2,
    policyCore: globalThis.BiliCdnPrefetchPolicy,
    postState: () => {},
    probeCore: {
      runProbe: async () => {
        probeRuns += 1;
        return {
          segments: [{
            alternativeHosts: ["b.example", "c.example"],
            host: "a.example",
            index: 1,
            range: "bytes=100-199"
          }]
        };
      }
    },
    reprobeBaseMs: 5,
    reprobeMaxMs: 5,
    storeCore: globalThis.BiliCdnPrefetchStore,
    traceEvent: () => {}
  });
  try {
    runtime.scheduleWindow(0);
    await waitFor(() => runtime.store.snapshot(multiCdnPlan.signature).failed === 1);
    const callsAtQuarantine = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(probeRuns, 2);
    assert.deepEqual(calls, [
      "a.example", "b.example", "c.example",
      "a.example", "b.example", "c.example"
    ]);
    assert.equal(calls.length, callsAtQuarantine);
    assert.equal(runtime.store.snapshot(multiCdnPlan.signature).segments[0].state, "failed");
  } finally {
    runtime.clear();
    globalThis.document = originalDocument;
  }
});
