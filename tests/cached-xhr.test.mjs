import assert from "node:assert/strict";
import test from "node:test";

await import("../cached-xhr.js");

class FakeXHR extends EventTarget {
  static scenarios = new Map();
  static sends = [];

  constructor() {
    super();
    this.readyState = 0;
    this.response = null;
    this.responseText = "";
    this.responseType = "";
    this.responseURL = "";
    this.responseXML = null;
    this.status = 0;
    this.statusText = "";
    this.timeout = 0;
    this.withCredentials = false;
    this.headers = [];
  }

  open(method, url) {
    this.method = method;
    this.url = String(url);
    this.readyState = 1;
    this.dispatchEvent(new Event("readystatechange"));
  }

  setRequestHeader(name, value) {
    this.headers.push([name, value]);
  }

  overrideMimeType() {}

  getAllResponseHeaders() {
    return this.status ? `content-length: ${this.response?.byteLength || 0}\r\n` : "";
  }

  getResponseHeader(name) {
    if (String(name).toLowerCase() === "content-length" && this.status) {
      return String(this.response?.byteLength || 0);
    }
    return null;
  }

  send() {
    FakeXHR.sends.push(this.url);
    const scenario = FakeXHR.scenarios.get(this.url) || { bytes: 1, status: 206 };
    this.dispatchEvent(new Event("loadstart"));
    queueMicrotask(() => {
      this.status = scenario.status ?? 206;
      this.statusText = this.status === 206 ? "Partial Content" : "OK";
      this.response = new ArrayBuffer(scenario.bytes);
      this.responseURL = this.url;
      this.readyState = 4;
      const progress = new Event("progress");
      Object.defineProperties(progress, {
        lengthComputable: { value: true },
        loaded: { value: scenario.bytes },
        total: { value: scenario.bytes }
      });
      this.dispatchEvent(progress);
      this.dispatchEvent(new Event("load"));
      this.dispatchEvent(new Event("loadend"));
    });
  }

  abort() {
    this.dispatchEvent(new Event("abort"));
    this.dispatchEvent(new Event("loadend"));
  }
}

function makeConstructor(resolveCachedRequest = () => null, hits = []) {
  return globalThis.BiliCdnCachedXHR.createCachedXMLHttpRequest({
    NativeXHR: FakeXHR,
    onCacheHit: (detail) => hits.push(detail),
    rawAbort: FakeXHR.prototype.abort,
    resolveCachedRequest
  });
}

function completed(xhr) {
  return new Promise((resolve) => {
    xhr.onloadend = () => resolve();
  });
}

test("cache misses remain one ordinary network request", async () => {
  FakeXHR.sends = [];
  FakeXHR.scenarios = new Map([["https://api.example/data", { bytes: 7, status: 200 }]]);
  const XHR = makeConstructor();
  const xhr = new XHR();
  const done = completed(xhr);
  xhr.open("GET", "https://api.example/data");
  xhr.responseType = "arraybuffer";
  xhr.send();
  await done;

  assert.equal(xhr.status, 200);
  assert.equal(xhr.response.byteLength, 7);
  assert.deepEqual(FakeXHR.sends, ["https://api.example/data"]);
});

test("network requests preserve the host page request-header hook", async () => {
  FakeXHR.scenarios = new Map([["https://api.example/range", { bytes: 10, status: 206 }]]);
  const original = FakeXHR.prototype.setRequestHeader;
  let observed = 0;
  FakeXHR.prototype.setRequestHeader = function observedSetRequestHeader(name, value) {
    observed += 1;
    return original.call(this, name, value);
  };
  try {
    const XHR = makeConstructor();
    const xhr = new XHR();
    const done = completed(xhr);
    xhr.open("GET", "https://api.example/range");
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("Range", "bytes=0-9");
    xhr.send();
    await done;
    assert.equal(observed, 1);
  } finally {
    FakeXHR.prototype.setRequestHeader = original;
  }
});

test("a complete prefetched range is returned without network traffic", async () => {
  FakeXHR.sends = [];
  const hits = [];
  const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
  const XHR = makeConstructor(() => ({
    cachedResponse: {
      buffer,
      cacheHosts: ["cos.example"],
      headers: {
        "content-length": "4",
        "content-range": "bytes 10-13/100"
      },
      responseURL: "https://cos.example/video",
      status: 206,
      statusText: "Partial Content"
    },
    context: { cacheKeys: ["segment-1"] }
  }), hits);
  const xhr = new XHR();
  const done = completed(xhr);
  xhr.open("GET", "https://akamai.example/video");
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("Range", "bytes=10-13");
  xhr.send();
  await done;

  assert.equal(xhr.status, 206);
  assert.equal(xhr.response.byteLength, 4);
  assert.equal(xhr.getResponseHeader("content-range"), "bytes 10-13/100");
  assert.deepEqual(FakeXHR.sends, []);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].cacheHosts, ["cos.example"]);
  assert.equal(hits[0].range, "bytes=10-13");
});

test("an in-flight prefetched range is promoted and reused without a duplicate request", async () => {
  FakeXHR.sends = [];
  const hits = [];
  let finishPrefetch;
  const pendingResponse = new Promise((resolve) => { finishPrefetch = resolve; });
  const XHR = makeConstructor(() => ({ pendingResponse }), hits);
  const xhr = new XHR();
  const done = completed(xhr);
  xhr.open("GET", "https://primary.example/video");
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("Range", "bytes=20-23");
  xhr.send();

  await Promise.resolve();
  assert.deepEqual(FakeXHR.sends, []);
  finishPrefetch({
    cachedResponse: {
      buffer: new Uint8Array([5, 6, 7, 8]).buffer,
      cacheHosts: ["third.example"],
      headers: {
        "content-length": "4",
        "content-range": "bytes 20-23/100"
      },
      responseURL: "https://third.example/video",
      status: 206,
      statusText: "Partial Content"
    },
    context: { cacheKeys: ["segment-2"] }
  });
  await done;

  assert.equal(xhr.status, 206);
  assert.deepEqual([...new Uint8Array(xhr.response)], [5, 6, 7, 8]);
  assert.deepEqual(FakeXHR.sends, []);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].cacheHosts, ["third.example"]);
});

test("a failed promoted prefetch falls back to exactly one ordinary request", async () => {
  FakeXHR.sends = [];
  FakeXHR.scenarios = new Map([["https://primary.example/video", { bytes: 4, status: 206 }]]);
  const XHR = makeConstructor(() => ({ pendingResponse: Promise.resolve(null) }));
  const xhr = new XHR();
  const done = completed(xhr);
  xhr.open("GET", "https://primary.example/video");
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("Range", "bytes=20-23");
  xhr.send();
  await done;

  assert.equal(xhr.status, 206);
  assert.deepEqual(FakeXHR.sends, ["https://primary.example/video"]);
});

test("only async GET arraybuffer Range requests can consume the cache", async () => {
  FakeXHR.sends = [];
  FakeXHR.scenarios = new Map([["https://api.example/text", { bytes: 3, status: 200 }]]);
  let resolutions = 0;
  const XHR = makeConstructor(() => {
    resolutions += 1;
    return null;
  });
  const xhr = new XHR();
  const done = completed(xhr);
  xhr.open("GET", "https://api.example/text");
  xhr.setRequestHeader("Range", "bytes=0-2");
  xhr.send();
  await done;

  assert.equal(resolutions, 0);
  assert.deepEqual(FakeXHR.sends, ["https://api.example/text"]);
});
