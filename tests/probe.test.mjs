import assert from "node:assert/strict";
import test from "node:test";

await import("../core.js");
await import("../probe-core.js");

test("page probes run every position and CDN sequentially", async () => {
  let active = 0;
  let calls = 0;
  let maxActive = 0;
  const events = [];
  const fetchImpl = async (_url, options) => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const match = String(options?.headers?.Range || "").match(/bytes=(\d+)-(\d+)/);
    const start = Number(match?.[1] || 0);
    const end = Number(match?.[2] || start + 1023);
    const bytes = Math.max(1, end - start + 1);
    return new Response(new Uint8Array(bytes), {
      headers: { "content-range": `bytes ${start}-${end}/10000000` },
      status: 206
    });
  };

  const result = await globalThis.BiliCdnProbeCore.runProbe({
    candidates: [
      { host: "a.bilivideo.com", label: "A", url: "https://a.bilivideo.com/video.m4s?sig=a" },
      { host: "b.akamaized.net", label: "B", url: "https://b.akamaized.net/video.m4s?sig=b" }
    ],
    mode: "quick"
  }, fetchImpl, (type, detail) => events.push({ type, ...detail }));

  assert.equal(calls, 4);
  assert.equal(maxActive, 1);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((candidate) => candidate.failures === 0));
  assert.ok(result.results.every((candidate) => candidate.samples.length === 2));
  assert.ok(result.results.every((candidate) => candidate.samples[0].bytes === 1536 * 1024));
  assert.deepEqual(events.filter((event) => event.type === "probe-candidate-start").map((event) => event.host), ["a.bilivideo.com", "b.akamaized.net"]);
  assert.deepEqual(events.filter((event) => event.type === "probe-candidate-result").map((event) => event.host).sort(), ["a.bilivideo.com", "b.akamaized.net"]);
});

test("a fully consumed 206 range is not cancelled before the next probe", async () => {
  let cancellations = 0;
  const fetchImpl = async (_url, options) => {
    const match = String(options?.headers?.Range || "").match(/bytes=(\d+)-(\d+)/);
    const start = Number(match?.[1] || 0);
    const end = Number(match?.[2] || start + 1023);
    const bytes = end - start + 1;
    let delivered = false;
    return {
      body: {
        getReader() {
          return {
            cancel: async () => { cancellations += 1; },
            read: async () => {
              if (delivered) return { done: true };
              delivered = true;
              return { done: false, value: new Uint8Array(bytes) };
            },
            releaseLock() {}
          };
        }
      },
      headers: new Headers({
        "content-length": String(bytes),
        "content-range": `bytes ${start}-${end}/10000000`
      }),
      ok: true,
      status: 206
    };
  };

  const result = await globalThis.BiliCdnProbeCore.runProbe({
    candidates: [{ host: "a.bilivideo.com", label: "A", url: "https://a.bilivideo.com/video.m4s?sig=a" }],
    mode: "quick"
  }, fetchImpl);

  assert.equal(result.results[0].failures, 0);
  assert.equal(cancellations, 0);
});

test("deep scan stops spending bandwidth after two consecutive range failures", async () => {
  let calls = 0;
  const sampleBytes = 2 * 1024 * 1024;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const match = String(options?.headers?.Range || "").match(/bytes=(\d+)-(\d+)/);
    const start = Number(match?.[1] || 0);
    const end = Number(match?.[2] || start + sampleBytes - 1);
    if (start > 0) throw new Error("sparse range unavailable");
    return new Response(new Uint8Array(end - start + 1), {
      headers: { "content-range": `bytes ${start}-${end}/10000000` },
      status: 206
    });
  };

  const result = await globalThis.BiliCdnProbeCore.runProbe({
    candidates: [{ host: "a.bilivideo.com", label: "A", url: "https://a.bilivideo.com/video.m4s?sig=a" }],
    mode: "deep"
  }, fetchImpl);

  assert.equal(calls, 3);
  assert.equal(result.results[0].samples.length, 4);
  assert.equal(result.results[0].samples[3].error, "consecutive-failures-skipped");
});

function makeSidx(sizes) {
  const length = 32 + sizes.length * 12;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  view.setUint32(0, length);
  for (const [index, value] of [..."sidx"].entries()) view.setUint8(4 + index, value.charCodeAt(0));
  view.setUint32(12, 1);
  view.setUint32(16, 1000);
  view.setUint16(30, sizes.length);
  sizes.forEach((size, index) => {
    const offset = 32 + index * 12;
    view.setUint32(offset, size);
    view.setUint32(offset + 4, 5000);
    view.setUint32(offset + 8, 0x90000000);
  });
  return new Uint8Array(buffer);
}

test("prefetch planning independently selects the fastest CDN for every future segment", async () => {
  const sidx = makeSidx([40_000, 50_000, 60_000, 70_000, 80_000, 90_000]);
  const indexStart = 2000;
  const indexEnd = indexStart + sidx.byteLength - 1;
  const firstSegmentStart = indexEnd + 1;
  const firstSegmentEnd = firstSegmentStart + 40_000 - 1;
  const calls = [];
  const fetchImpl = async (url, options) => {
    const host = new URL(url).hostname;
    const range = String(options?.headers?.Range || "");
    calls.push({ host, range });
    if (range === `bytes=${indexStart}-${indexEnd}`) {
      return new Response(sidx, {
        headers: { "content-range": `bytes ${indexStart}-${indexEnd}/999999` },
        status: 206
      });
    }

    const match = range.match(/bytes=(\d+)-(\d+)/);
    const start = Number(match?.[1] || 0);
    const end = Number(match?.[2] || start);
    const segmentIndex = start < firstSegmentStart + 40_000
      ? 0
      : start < firstSegmentStart + 90_000
        ? 1
        : start < firstSegmentStart + 150_000
          ? 2
          : 3;
    const selectedWins = segmentIndex === 1 || segmentIndex === 3;
    const isSelected = host === "selected.bilivideo.com";
    await new Promise((resolve) => setTimeout(resolve, selectedWins === isSelected ? 3 : 24));
    return new Response(new Uint8Array(end - start + 1), {
      headers: { "content-range": `bytes ${start}-${end}/999999` },
      status: 206
    });
  };

  const result = await globalThis.BiliCdnProbeCore.runProbe({
    bufferedEnd: 0,
    candidates: [
      { host: "selected.bilivideo.com", label: "Selected", url: "https://selected.bilivideo.com/prefetch.m4s?sig=a" },
      { host: "alternate.akamaized.net", label: "Alternate", url: "https://alternate.akamaized.net/prefetch.m4s?sig=b" }
    ],
    count: 3,
    currentHost: "selected.bilivideo.com",
    currentTime: 0,
    mode: "prefetch",
    observedRange: `bytes=${firstSegmentStart}-${firstSegmentEnd}`,
    segmentBase: { initialization: "0-1999", indexRange: `${indexStart}-${indexEnd}` }
  }, fetchImpl);

  assert.equal(result.error, undefined);
  assert.equal(result.selectedHost, "selected.bilivideo.com");
  assert.equal(result.indexHost, "selected.bilivideo.com");
  assert.equal(result.segments.length, 3);
  assert.deepEqual(result.segments.map((segment) => segment.index), [1, 2, 3]);
  assert.deepEqual(result.segments.map((segment) => segment.host), [
    "selected.bilivideo.com",
    "alternate.akamaized.net",
    "selected.bilivideo.com"
  ]);
  assert.ok(result.segments.every((segment) => segment.alternativeHosts.length === 1));
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[0], {
    host: "selected.bilivideo.com",
    range: `bytes=${indexStart}-${indexEnd}`
  });
  assert.ok(calls.slice(1).every((call) => {
    const match = call.range.match(/bytes=(\d+)-(\d+)/);
    return Number(match?.[2]) - Number(match?.[1]) + 1 === 32 * 1024;
  }));
});

test("prefetch planning ranks every supplied CDN instead of assuming a primary and one backup", async () => {
  const sidx = makeSidx([40_000, 50_000]);
  const indexStart = 2000;
  const indexEnd = indexStart + sidx.byteLength - 1;
  const firstSegmentStart = indexEnd + 1;
  const firstSegmentEnd = firstSegmentStart + 40_000 - 1;
  const candidates = [1, 2, 3, 4, 5].map((value) => ({
    host: `cdn-${value}.bilivideo.com`,
    label: `CDN ${value}`,
    url: `https://cdn-${value}.bilivideo.com/video.m4s?sig=${value}`
  }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    const host = new URL(url).hostname;
    const range = String(options?.headers?.Range || "");
    calls.push({ host, range });
    if (range === `bytes=${indexStart}-${indexEnd}`) {
      return new Response(sidx, {
        headers: { "content-range": `bytes ${indexStart}-${indexEnd}/999999` },
        status: 206
      });
    }
    const order = Number(host.match(/cdn-(\d+)/)?.[1] || 9);
    await new Promise((resolve) => setTimeout(resolve, order));
    const match = range.match(/bytes=(\d+)-(\d+)/);
    const start = Number(match?.[1] || 0);
    const end = Number(match?.[2] || start);
    return new Response(new Uint8Array(end - start + 1), {
      headers: { "content-range": `bytes ${start}-${end}/999999` },
      status: 206
    });
  };

  const result = await globalThis.BiliCdnProbeCore.runProbe({
    candidates,
    count: 1,
    currentHost: candidates[0].host,
    currentTime: 0,
    mode: "prefetch",
    observedRange: `bytes=${firstSegmentStart}-${firstSegmentEnd}`,
    segmentBase: { initialization: "0-1999", indexRange: `${indexStart}-${indexEnd}` }
  }, fetchImpl);

  assert.equal(result.results.length, 5);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].alternativeHosts.length, 4);
  assert.deepEqual(new Set([
    result.segments[0].host,
    ...result.segments[0].alternativeHosts
  ]), new Set(candidates.map((candidate) => candidate.host)));
  assert.equal(calls.length, 6);
});

test("prefetch skips risky route probes while an official CDN succeeds and keeps risk as last fallback", async () => {
  const sidx = makeSidx([40_000, 50_000]);
  const indexStart = 2000;
  const indexEnd = indexStart + sidx.byteLength - 1;
  const firstSegmentStart = indexEnd + 1;
  const firstSegmentEnd = firstSegmentStart + 40_000 - 1;
  const calls = [];
  const fetchImpl = async (url, options) => {
    const host = new URL(url).hostname;
    const range = String(options?.headers?.Range || "");
    calls.push({ host, range });
    if (range === `bytes=${indexStart}-${indexEnd}`) {
      return new Response(sidx, {
        headers: { "content-range": `bytes ${indexStart}-${indexEnd}/999999` },
        status: 206
      });
    }
    const match = range.match(/bytes=(\d+)-(\d+)/);
    const start = Number(match?.[1] || 0);
    const end = Number(match?.[2] || start);
    return new Response(new Uint8Array(end - start + 1), {
      headers: { "content-range": `bytes ${start}-${end}/999999` },
      status: 206
    });
  };

  const result = await globalThis.BiliCdnProbeCore.runProbe({
    candidates: [
      {
        host: "xy1x2x3x4xy.mcdn.bilivideo.cn",
        label: "MCDN",
        url: "https://xy1x2x3x4xy.mcdn.bilivideo.cn:486/video.m4s?os=mcdn"
      },
      {
        host: "official.bilivideo.com",
        label: "Official",
        url: "https://official.bilivideo.com/video.m4s?sig=official-success"
      }
    ],
    count: 1,
    currentHost: "xy1x2x3x4xy.mcdn.bilivideo.cn",
    currentTime: 0,
    mode: "prefetch",
    observedRange: `bytes=${firstSegmentStart}-${firstSegmentEnd}`,
    segmentBase: { initialization: "0-1999", indexRange: `${indexStart}-${indexEnd}` }
  }, fetchImpl);

  assert.equal(result.indexHost, "official.bilivideo.com");
  assert.equal(result.segments[0].host, "official.bilivideo.com");
  assert.deepEqual(result.segments[0].alternativeHosts, ["xy1x2x3x4xy.mcdn.bilivideo.cn"]);
  assert.equal(calls.some((call) => call.host.includes("mcdn")), false);
});

test("prefetch probes a risky route only after every official candidate fails", async () => {
  const sidx = makeSidx([40_000, 50_000]);
  const indexStart = 2000;
  const indexEnd = indexStart + sidx.byteLength - 1;
  const firstSegmentStart = indexEnd + 1;
  const firstSegmentEnd = firstSegmentStart + 40_000 - 1;
  const calls = [];
  const fetchImpl = async (url, options) => {
    const host = new URL(url).hostname;
    const range = String(options?.headers?.Range || "");
    calls.push({ host, range });
    if (range === `bytes=${indexStart}-${indexEnd}`) {
      return new Response(sidx, {
        headers: { "content-range": `bytes ${indexStart}-${indexEnd}/999999` },
        status: 206
      });
    }
    if (host === "official.bilivideo.com") throw new Error("official route unavailable");
    const match = range.match(/bytes=(\d+)-(\d+)/);
    const start = Number(match?.[1] || 0);
    const end = Number(match?.[2] || start);
    return new Response(new Uint8Array(end - start + 1), {
      headers: { "content-range": `bytes ${start}-${end}/999999` },
      status: 206
    });
  };

  const result = await globalThis.BiliCdnProbeCore.runProbe({
    candidates: [
      {
        host: "official.bilivideo.com",
        label: "Official",
        url: "https://official.bilivideo.com/video.m4s?sig=official-failure"
      },
      {
        host: "xy1x2x3x4xy.mcdn.bilivideo.cn",
        label: "MCDN",
        url: "https://xy1x2x3x4xy.mcdn.bilivideo.cn:486/video.m4s?os=mcdn&case=last-resort"
      }
    ],
    count: 1,
    currentHost: "official.bilivideo.com",
    currentTime: 0,
    mode: "prefetch",
    observedRange: `bytes=${firstSegmentStart}-${firstSegmentEnd}`,
    segmentBase: { initialization: "0-1999", indexRange: `${indexStart}-${indexEnd}` }
  }, fetchImpl);

  assert.equal(result.segments[0].host, "xy1x2x3x4xy.mcdn.bilivideo.cn");
  assert.equal(calls.filter((call) => call.host.includes("mcdn")).length, 1);
});
