import assert from "node:assert/strict";
import test from "node:test";

await import("../core.js");
const core = globalThis.BiliCdnCore;

function fixture() {
  const cos = "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s?upsig=cos-signature";
  const akamai = "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=akamai-signature";
  const audioCos = "https://upos-sz-mirrorcosov.bilivideo.com/path/audio.m4s?upsig=audio-cos";
  const audioAkamai = "https://upos-hz-mirrorakam.akamaized.net/path/audio.m4s?hdnts=audio-akamai";
  return {
    cos,
    akamai,
    payload: {
      code: 0,
      data: {
        quality: 120,
        dash: {
          audio: [{ baseUrl: audioCos, backupUrl: [audioAkamai] }],
          video: [{
            id: 120,
            bandwidth: 10_354_649,
            baseUrl: cos,
            backupUrl: [akamai],
            codecs: "avc1.640033",
            height: 2160,
            segment_base: { initialization: "0-999", index_range: "1000-1099" },
            width: 3840
          }]
        }
      }
    }
  };
}

test("routing is pass-through until the user explicitly selects an allowed CDN", () => {
  const candidates = [{ host: "cos.example" }, { host: "akamai.example" }];
  assert.equal(core.chooseRouteHost("cos.example", null, candidates), "cos.example");
  assert.equal(core.chooseRouteHost("akamai.example", null, candidates), "akamai.example");
  assert.equal(core.chooseRouteHost("cos.example", "akamai.example", candidates), "akamai.example");
  assert.equal(core.chooseRouteHost("cos.example", "evil.example", candidates), "cos.example");
});

test("temporarily rescues a failed preferred CDN without changing the saved preference", () => {
  const candidates = [{ host: "cos.example" }, { host: "akamai.example" }];
  assert.equal(
    core.chooseRouteHostWithCooldown("cos.example", "cos.example", candidates, ["cos.example"]),
    "akamai.example"
  );
  assert.equal(
    core.chooseRouteHostWithCooldown("akamai.example", "cos.example", candidates, ["cos.example"]),
    "akamai.example"
  );
  assert.equal(
    core.chooseRouteHostWithCooldown("akamai.example", "cos.example", candidates, ["cos.example", "akamai.example"]),
    "akamai.example"
  );
  assert.equal(
    core.chooseRouteHostWithCooldown("akamai.example", null, candidates, ["akamai.example"]),
    "akamai.example"
  );
});

test("route cooldown selects the first healthy candidate from an arbitrary CDN list", () => {
  const candidates = [
    { host: "a.example" },
    { host: "b.example" },
    { host: "c.example" },
    { host: "d.example" }
  ];
  assert.equal(
    core.chooseRouteHostWithCooldown(
      "a.example",
      "a.example",
      candidates,
      ["a.example", "b.example", "c.example"]
    ),
    "d.example"
  );
});

test("classifies PCDN and MCDN signals without treating ordinary official routes as risky", () => {
  const official = core.classifyCdnRoute("https://upos-hz-mirrorakam.akamaized.net/video.m4s?hdnts=signed");
  assert.deepEqual(official, { deprioritized: false, kind: "official", reasons: [] });

  const mcdn = core.classifyCdnRoute("https://xy1x2x3x4xy.mcdn.bilivideo.cn:486/video.m4s?os=mcdn");
  assert.equal(mcdn.deprioritized, true);
  assert.equal(mcdn.kind, "mcdn");
  assert.ok(mcdn.reasons.includes("mcdn-host"));
  assert.ok(mcdn.reasons.includes("mcdn-query"));
  assert.ok(mcdn.reasons.includes("non-standard-port"));

  const renamedPcdn = core.classifyCdnRoute("https://node-7.edge.mountaintoys.cn/video.m4s");
  assert.equal(renamedPcdn.deprioritized, true);
  assert.equal(renamedPcdn.kind, "pcdn");
  assert.ok(renamedPcdn.reasons.includes("known-pcdn-suffix"));

  const redirectPcdn = core.classifyCdnRoute("https://upos-sz-302kodo.bilivideo.com/video.m4s");
  assert.equal(redirectPcdn.deprioritized, true);
  assert.ok(redirectPcdn.reasons.includes("redirect-pcdn-host"));
});

test("keeps risky routes last for automatic work while preserving an all-risky fallback", () => {
  const candidates = [
    { host: "xy1x2x3x4xy.mcdn.bilivideo.cn", url: "https://xy1x2x3x4xy.mcdn.bilivideo.cn/video.m4s?os=mcdn" },
    { host: "cos.bilivideo.com", url: "https://cos.bilivideo.com/video.m4s" },
    { host: "akamai.akamaized.net", url: "https://akamai.akamaized.net/video.m4s" }
  ];
  assert.deepEqual(
    core.prioritizeCdnCandidates(candidates, candidates[0].host).map((candidate) => candidate.host),
    ["cos.bilivideo.com", "akamai.akamaized.net", "xy1x2x3x4xy.mcdn.bilivideo.cn"]
  );

  const riskyOnly = [
    candidates[0],
    { host: "upos-sz-mirror14b.bilivideo.com", url: "https://upos-sz-mirror14b.bilivideo.com/video.m4s" }
  ];
  assert.deepEqual(
    core.prioritizeCdnCandidates(riskyOnly, riskyOnly[1].host).map((candidate) => candidate.host),
    ["upos-sz-mirror14b.bilivideo.com", "xy1x2x3x4xy.mcdn.bilivideo.cn"]
  );
});

test("extracts full signed CDN candidates for the active quality", () => {
  const { payload } = fixture();
  const plan = core.extractProbePlan(payload, "https://www.bilibili.com/video/BV1Example/");
  assert.equal(plan.videoKey, "BV1Example");
  assert.equal(plan.qualityLabel, "4K");
  assert.equal(plan.width, 3840);
  assert.equal(plan.height, 2160);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.label), ["COSOV", "Akamai"]);
  assert.match(plan.candidates[0].url, /upsig=cos-signature/);
  assert.match(plan.candidates[1].url, /hdnts=akamai-signature/);
});

test("preserves Bilibili's native primary while moving a risky candidate behind official routes", () => {
  const { payload } = fixture();
  payload.data.dash.video[0].baseUrl = "https://xy1x2x3x4xy.mcdn.bilivideo.cn:486/path/video.m4s?os=mcdn";
  payload.data.dash.video[0].backupUrl = [
    "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s?upsig=cos-signature",
    "https://upos-hz-mirrorakam.akamaized.net/path/video.m4s?hdnts=akamai-signature"
  ];

  const plan = core.extractProbePlan(payload, "https://www.bilibili.com/video/BV1RiskyPrimary/");
  assert.equal(plan.currentPrimary, "xy1x2x3x4xy.mcdn.bilivideo.cn");
  assert.deepEqual(plan.candidates.map((candidate) => candidate.host), [
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-hz-mirrorakam.akamaized.net",
    "xy1x2x3x4xy.mcdn.bilivideo.cn"
  ]);
  assert.equal(plan.candidates[2].isPrimary, true);
  assert.equal(plan.candidates[2].routeRisk.deprioritized, true);
});

test("ranks a successful official route ahead of a faster PCDN but still allows last-resort recovery", () => {
  const successfulSample = (mbps) => ({ mbps, ok: true, ttfbMs: 10 });
  const failedSample = { error: "timeout", mbps: 0, ok: false, ttfbMs: 1000 };
  const pcdn = {
    host: "xy1x2x3x4xy.mcdn.bilivideo.cn",
    routeRisk: core.classifyCdnRoute("https://xy1x2x3x4xy.mcdn.bilivideo.cn/video.m4s?os=mcdn"),
    samples: [successfulSample(500)]
  };
  const official = {
    host: "upos-sz-mirrorcosov.bilivideo.com",
    routeRisk: core.classifyCdnRoute("https://upos-sz-mirrorcosov.bilivideo.com/video.m4s"),
    samples: [successfulSample(20)]
  };

  assert.deepEqual(core.rankProbeResults([pcdn, official]).map((result) => result.host), [official.host, pcdn.host]);
  assert.deepEqual(
    core.rankProbeResults([pcdn, { ...official, samples: [failedSample] }]).map((result) => result.host),
    [pcdn.host, official.host]
  );
});

test("uses the actual 4K dimensions as the primary label and keeps HDR as a feature", () => {
  const { payload } = fixture();
  payload.data.quality = 125;
  payload.data.dash.video[0].id = 125;
  payload.data.dash.video[0].codecs = "hvc1.2.4.L153.90";

  const plan = core.extractProbePlan(payload, "https://www.bilibili.com/video/BV1Hdr4k/");
  assert.equal(plan.qualityLabel, "4K");
  assert.deepEqual(plan.features, ["HDR"]);
  assert.equal(plan.width, 3840);
  assert.equal(plan.height, 2160);
});

test("builds the displayed plan from the media route that is actually playing", () => {
  const { payload } = fixture();
  payload.data.quality = 32;
  payload.data.dash.video.push({
    id: 116,
    bandwidth: 6_500_000,
    baseUrl: "https://upos-sz-mirrorcosov.bilivideo.com/path/1080p60.m4s?sig=high",
    backupUrl: ["https://upos-hz-mirrorakam.akamaized.net/path/1080p60.m4s?sig=high-alt"],
    codecs: "avc1.640033",
    height: 1080,
    width: 1920
  });
  payload.data.dash.video.push({
    id: 32,
    bandwidth: 900_000,
    baseUrl: "https://upos-sz-mirrorcosov.bilivideo.com/path/480.m4s?sig=low",
    backupUrl: ["https://upos-hz-mirrorakam.akamaized.net/path/480.m4s?sig=low-alt"],
    codecs: "avc1.64001f",
    height: 480,
    width: 854
  });

  const routes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1ActiveRoute/");
  const playing1080p60 = routes.routes.find((route) => route.kind === "video" && route.id === 116);
  const plan = core.createProbePlanFromRoute(routes, playing1080p60, "upos-sz-mirrorcosov.bilivideo.com");

  assert.equal(plan.quality, 116);
  assert.equal(plan.qualityLabel, "1080P60");
  assert.equal(plan.height, 1080);
  assert.equal(plan.currentPrimary, "upos-sz-mirrorcosov.bilivideo.com");
  assert.deepEqual(plan.segmentBase, null);
});

function makeSidx({ absoluteStart = 1000, firstOffset = 0, sizes = [100, 120, 80], durations = [5000, 5000, 5000] } = {}) {
  const byteLength = 32 + sizes.length * 12;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, byteLength);
  for (const [index, value] of [..."sidx"].entries()) view.setUint8(4 + index, value.charCodeAt(0));
  view.setUint8(8, 0);
  view.setUint32(12, 1);
  view.setUint32(16, 1000);
  view.setUint32(20, 0);
  view.setUint32(24, firstOffset);
  view.setUint16(30, sizes.length);
  sizes.forEach((size, index) => {
    const offset = 32 + index * 12;
    view.setUint32(offset, size);
    view.setUint32(offset + 4, durations[index]);
    view.setUint32(offset + 8, 0x90000000);
  });
  return { absoluteStart, buffer };
}

test("parses exact DASH sidx ranges and selects the five segments after the buffer frontier", () => {
  const { absoluteStart, buffer } = makeSidx({
    absoluteStart: 948,
    sizes: [100, 120, 80, 140, 160, 180, 200],
    durations: [5000, 5000, 5000, 5000, 5000, 5000, 5000]
  });
  const index = core.parseSidx(buffer, absoluteStart);
  assert.equal(index.referenceCount, 7);
  assert.deepEqual(index.segments[0], {
    duration: 5,
    end: 1163,
    endTime: 5,
    index: 0,
    start: 1064,
    startTime: 0
  });
  assert.equal(index.segments[1].start, 1164);
  assert.deepEqual(core.upcomingSegments(index, 5, 5).map((segment) => segment.index), [1, 2, 3, 4, 5]);
  assert.deepEqual(core.upcomingSegmentsAfterRange(index, "bytes=1064-1200", 5).map((segment) => segment.index), [2, 3, 4, 5, 6]);
  assert.deepEqual(
    core.upcomingSegmentsBeyond(index, 15, "bytes=1064-1200", 5).map((segment) => segment.index),
    [3, 4, 5, 6]
  );
});

test("drops prefetch assignments already reached by either player frontier while a probe window was running", () => {
  const assignments = [
    { range: "bytes=100-199", start: 100, startTime: 0 },
    { range: "bytes=200-299", start: 200, startTime: 5 },
    { range: "bytes=300-399", start: 300, startTime: 10 },
    { range: "bytes=400-499", start: 400, startTime: 15 }
  ];
  assert.deepEqual(
    core.filterSegmentsBeyond(assignments, 10, "bytes=200-349"),
    [{ range: "bytes=400-499", start: 400, startTime: 15 }]
  );
});

test("keeps SegmentBase on the active route and displayed plan", () => {
  const { payload } = fixture();
  const routes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Segmented/");
  const route = routes.routes.find((item) => item.kind === "video");
  const plan = core.createProbePlanFromRoute(routes, route, route.urls[0].host);
  assert.deepEqual(route.segmentBase, { initialization: "0-999", indexRange: "1000-1099" });
  assert.deepEqual(plan.segmentBase, route.segmentBase);
});

test("recovers the active video route from an already observed media resource", () => {
  const { payload, akamai } = fixture();
  payload.data.dash.audio = [{
    id: 30280,
    baseUrl: "https://upos-sz-mirrorcosov.bilivideo.com/path/audio.m4s?sig=audio"
  }];
  payload.data.dash.video.push({
    id: 80,
    baseUrl: "https://upos-sz-mirrorcosov.bilivideo.com/path/1080.m4s?sig=low",
    backupUrl: [],
    height: 1080,
    width: 1920
  });
  const routes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Buffered/");
  const match = core.findObservedVideoRoute(routes, [
    "https://upos-sz-mirrorcosov.bilivideo.com/path/audio.m4s?sig=audio",
    akamai
  ], 3840, 2160);

  assert.equal(match.route.kind, "video");
  assert.equal(match.route.id, 120);
  assert.equal(match.currentHost, "upos-hz-mirrorakam.akamaized.net");
  assert.equal(core.findObservedVideoRoute(routes, [akamai], 1920, 1080), null);
});

test("recovers a route when only the signed query changed on the same CDN resource", () => {
  const { payload } = fixture();
  const routes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Signed/");
  const refreshed = "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s?upsig=refreshed-signature";
  const match = core.findObservedVideoRoute(routes, [refreshed], 3840, 2160);

  assert.equal(match.currentHost, "upos-sz-mirrorcosov.bilivideo.com");
  assert.equal(match.route.urls[0].url, refreshed);
});

test("uses the exact media path to separate otherwise identical track plans", () => {
  const { payload } = fixture();
  const firstRoutes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Race/");
  const firstVideo = firstRoutes.routes.find((route) => route.kind === "video");
  const firstPlan = core.createProbePlanFromRoute(firstRoutes, firstVideo, firstVideo.urls[0].host);

  payload.data.dash.video[0].baseUrl = "https://upos-sz-mirrorcosov.bilivideo.com/other/video.m4s?upsig=new";
  payload.data.dash.video[0].backupUrl = ["https://upos-hz-mirrorakam.akamaized.net/other/video.m4s?hdnts=new"];
  const secondRoutes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Race/");
  const secondVideo = secondRoutes.routes.find((route) => route.kind === "video");
  const secondPlan = core.createProbePlanFromRoute(secondRoutes, secondVideo, secondVideo.urls[0].host);

  assert.notEqual(firstPlan.mediaPath, secondPlan.mediaPath);
  assert.notEqual(firstPlan.signature, secondPlan.signature);
});

test("keeps a track signature stable when Bilibili reverses base and backup CDN order", () => {
  const { payload } = fixture();
  const firstRoutes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Stable/");
  const firstVideo = firstRoutes.routes.find((route) => route.kind === "video");
  const firstPlan = core.createProbePlanFromRoute(firstRoutes, firstVideo, firstVideo.urls[0].host);

  const baseUrl = payload.data.dash.video[0].baseUrl;
  payload.data.dash.video[0].baseUrl = payload.data.dash.video[0].backupUrl[0];
  payload.data.dash.video[0].backupUrl = [baseUrl];
  const reversedRoutes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Stable/");
  const reversedVideo = reversedRoutes.routes.find((route) => route.kind === "video");
  const reversedPlan = core.createProbePlanFromRoute(reversedRoutes, reversedVideo, reversedVideo.urls[0].host);

  assert.equal(firstPlan.signature, reversedPlan.signature);
  assert.notEqual(firstPlan.currentPrimary, reversedPlan.currentPrimary);
});

test("ranks consistency above a misleading peak", () => {
  const ranked = core.rankProbeResults([
    {
      host: "bursty.example",
      label: "Bursty",
      samples: [
        { ok: true, mbps: 200, ttfbMs: 80 },
        { ok: true, mbps: 1.3, ttfbMs: 500 },
        { ok: false, mbps: 0, ttfbMs: 4500 }
      ]
    },
    {
      host: "steady.example",
      label: "Steady",
      samples: [
        { ok: true, mbps: 70, ttfbMs: 120 },
        { ok: true, mbps: 55, ttfbMs: 130 },
        { ok: true, mbps: 48, ttfbMs: 140 }
      ]
    }
  ]);

  assert.equal(ranked[0].host, "steady.example");
  assert.equal(ranked[0].failures, 0);
  assert.equal(ranked[1].failures, 1);
  assert.equal(ranked[1].minMbps, 1.3);
});

test("automatically selects only a clearly safer route", () => {
  const results = [
    { host: "akamai.example", label: "Akamai", failures: 1, minMbps: 120, score: 40, samples: [{ ok: true }] },
    { host: "cosov.example", label: "COSOV", failures: 1, minMbps: 33.5, score: -20, samples: [{ ok: true }] }
  ];
  const decision = core.chooseAutomaticRoute(results, { bandwidth: 20_000_000 }, "cosov.example");
  assert.equal(decision.host, "akamai.example");
  assert.equal(decision.reason, "clear-speed-advantage");
});

test("pins a safe current winner so later requests cannot drift between CDNs", () => {
  const results = [
    { host: "akamai.example", failures: 0, minMbps: 125, score: 125, samples: [{ ok: true }] },
    { host: "cosov.example", failures: 2, minMbps: 0, score: -10000, samples: [{ ok: false }] }
  ];
  const decision = core.chooseAutomaticRoute(
    results,
    { bandwidth: 20_000_000 },
    "akamai.example",
    { pinCurrentBest: true }
  );
  assert.equal(decision.host, "akamai.example");
  assert.equal(decision.reason, "pin-current-best");
});

test("does not pin an unsafe current winner", () => {
  const results = [
    { host: "akamai.example", failures: 2, minMbps: 8, score: 8, samples: [{ ok: true }] }
  ];
  assert.equal(core.chooseAutomaticRoute(
    results,
    { bandwidth: 20_000_000 },
    "akamai.example",
    { pinCurrentBest: true }
  ).host, null);
});

test("keeps the current route when the automatic advantage is too small or unsafe", () => {
  const close = [
    { host: "akamai.example", failures: 0, minMbps: 70, score: 70, samples: [{ ok: true }] },
    { host: "cosov.example", failures: 0, minMbps: 60, score: 60, samples: [{ ok: true }] }
  ];
  assert.equal(core.chooseAutomaticRoute(close, { bandwidth: 20_000_000 }, "cosov.example").host, null);

  const unsafe = [
    { host: "akamai.example", failures: 2, minMbps: 120, score: 20, samples: [{ ok: true }] },
    { host: "cosov.example", failures: 3, minMbps: 10, score: -100, samples: [{ ok: true }] }
  ];
  assert.equal(core.chooseAutomaticRoute(unsafe, { bandwidth: 20_000_000 }, "cosov.example").host, null);
});

test("supports snake_case playurl fields", () => {
  const payload = {
    result: {
      quality: 80,
      dash: {
        video: [{
          id: 80,
          base_url: "https://a.bilivideo.com/v.m4s?sig=a",
          backup_url: ["https://b.bilivideo.com/v.m4s?sig=b"]
        }]
      }
    }
  };
  const extracted = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Snake/");
  const video = extracted.routes.find((route) => route.kind === "video");
  assert.deepEqual(video.urls.map((item) => item.host), ["a.bilivideo.com", "b.bilivideo.com"]);
});

test("routes a live media request to the complete signed alternate URL", () => {
  const { payload, cos, akamai } = fixture();
  const routes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Example/");
  const resolved = core.resolveRouteUrl(routes, cos, "upos-hz-mirrorakam.akamaized.net");
  assert.equal(resolved.changed, true);
  assert.equal(resolved.url, akamai);
  assert.match(resolved.url, /hdnts=akamai-signature/);
});

test("keeps the observed current URL but routes to the complete signed alternate after signature refresh", () => {
  const { payload, akamai } = fixture();
  const routes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Refreshed/");
  const refreshed = "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s?upsig=refreshed-signature";
  const resolved = core.resolveRouteUrl(routes, refreshed, "upos-hz-mirrorakam.akamaized.net");

  assert.equal(resolved.changed, true);
  assert.equal(resolved.originalUrl, refreshed);
  assert.equal(resolved.route.urls[0].url, refreshed);
  assert.equal(resolved.url, akamai);
});

test("does not associate an unlisted CDN host even when the media path matches", () => {
  const { payload } = fixture();
  const routes = core.extractMediaRoutes(payload, "https://www.bilibili.com/video/BV1Foreign/");
  const foreign = "https://unlisted.example/path/video.m4s?upsig=foreign";

  assert.equal(core.findObservedVideoRoute(routes, [foreign], 3840, 2160), null);
  assert.equal(core.resolveRouteUrl(routes, foreign, "upos-hz-mirrorakam.akamaized.net").changed, false);
});

test("matches a risky sidx segment when the player merges or splits its Range request", () => {
  assert.equal(core.byteRangesOverlap("bytes=100-199", "bytes=150-260"), true);
  assert.equal(core.byteRangesOverlap("bytes=100-199", "bytes=0-120"), true);
  assert.equal(core.byteRangesOverlap("bytes=100-199", "bytes=200-260"), false);
  assert.equal(core.byteRangesOverlap("invalid", "bytes=100-199"), false);
});
