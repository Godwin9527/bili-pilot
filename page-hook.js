(function installBiliCdnPageHook() {
  "use strict";

  const core = globalThis.BiliCdnCore;
  const probeCore = globalThis.BiliCdnProbeCore;
  const prefetchStoreCore = globalThis.BiliCdnPrefetchStore;
  const prefetchPolicyCore = globalThis.BiliCdnPrefetchPolicy;
  const prefetchRuntimeCore = globalThis.BiliCdnPrefetchRuntime;
  const cachedXhrCore = globalThis.BiliCdnCachedXHR;
  const protocol = globalThis.BiliCdnProtocol;
  if (!core || !probeCore || !prefetchStoreCore || !prefetchPolicyCore || !prefetchRuntimeCore || !cachedXhrCore || !protocol || globalThis.__BILI_CDN_PILOT_HOOKED__) return;
  globalThis.__BILI_CDN_PILOT_HOOKED__ = true;
  const nativePageFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;

  const { EVENTS, STORAGE } = protocol;
  const PREFETCH_KEY = STORAGE.PAGE_PREFETCH_ENABLED;
  const pageUrl = () => location.href;
  const latestRoutes = new Map();
  const recentMediaResources = [];
  const recoveredPlayurlUrls = new Set();
  const sessionPreferences = new Map();
  const routeFailureCooldowns = new Map();
  const ROUTE_FAILURE_COOLDOWN_MS = 15 * 1000;
  const TRACE_ENABLED = new URLSearchParams(location.search).get("qaTrace") === "1";
  const ACTIVITY_FIELDS = Object.freeze({
    "fetch-prefetch-hit": ["bytes"],
    "prefetch-window-ready": ["accepted", "planned"],
    "probe-candidate-result": ["failures", "label", "minMbps"],
    "probe-candidate-start": ["label"],
    "route-activate": ["label"],
    "route-cooldown": ["label"],
    "route-rescue": ["fromLabel", "selectedLabel"],
    "segment-prefetch-backoff": ["index"],
    "segment-prefetch-cancelled": ["index", "label"],
    "segment-prefetch-failed": ["index"],
    "segment-prefetch-promoted": [],
    "segment-prefetch-ready": ["bytes", "durationMs", "index", "label"],
    "segment-prefetch-retry": ["index", "toLabel"],
    "segment-prefetch-start": ["index", "label"],
    "xhr-prefetch-hit": ["bytes"]
  });
  const traceEvents = [];
  const activityEvents = [];
  const sourceBufferMeta = new WeakMap();
  let traceSequence = 0;
  let activitySequence = 0;
  let activePlan = null;
  let lastActiveRouteAt = 0;
  let lastEmission = "";
  let pendingRouteHits = 0;
  let pendingRouteSignature = "";
  let currentPageVideoKey = core.videoKeyFromUrl(pageUrl());
  let lastPlaybackGuardAt = 0;
  const feasibility = {
    activeRoute: null,
    fetch: 0,
    xhr: 0,
    planEmissions: 0,
    passThrough: 0,
    playurlRecoveries: 0,
    resources: 0,
    rewrites: 0,
    routeRecoveries: 0,
    unmatched: 0,
    outcomes: { causes: {}, failed: 0, ok: 0, statuses: {} },
    initiators: {},
    samples: []
  };

  function traceNow() {
    return typeof performance?.now === "function" ? performance.now() : Date.now();
  }

  function publishTrace() {
    if (!TRACE_ENABLED) return;
    const target = document.documentElement;
    if (!target) return;
    target.setAttribute("data-bco-trace", JSON.stringify({
      page: location.href,
      events: traceEvents
    }));
  }

  function traceEvent(type, detail = {}) {
    const fields = ACTIVITY_FIELDS[type];
    const meaningfulActivity = type !== "prefetch-window-ready" || Number(detail.accepted || detail.planned || 0) > 0;
    if (fields && meaningfulActivity) {
      const entry = {
        at: Date.now(),
        detail: Object.fromEntries(fields.filter((key) => detail[key] != null).map((key) => [key, detail[key]])),
        id: activitySequence += 1,
        type
      };
      activityEvents.push(entry);
      if (activityEvents.length > 100) activityEvents.shift();
      post(EVENTS.ACTIVITY, { entry });
    }
    if (!TRACE_ENABLED) return;
    traceEvents.push({
      id: traceSequence += 1,
      at: Math.round(traceNow() * 10) / 10,
      type,
      ...detail
    });
    if (traceEvents.length > 160) traceEvents.splice(0, traceEvents.length - 160);
    publishTrace();
  }

  const prefetchRuntime = prefetchRuntimeCore.createPrefetchRuntime({
    core,
    fetchImpl: nativePageFetch,
    getActivePlan: () => activePlan,
    getPreferredHost: (plan) => preferredHost(plan),
    isEnabled: () => prefetchEnabled(),
    now: traceNow,
    policyCore: prefetchPolicyCore,
    postState: (detail) => post(EVENTS.PREFETCH_STATE, detail),
    probeCore,
    storeCore: prefetchStoreCore,
    traceEvent
  });
  if (!prefetchRuntime) return;
  const prefetchStore = prefetchRuntime.store;

  function responseByteLength(xhr) {
    try {
      const value = xhr.response;
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (typeof Blob === "function" && value instanceof Blob) return value.size;
      if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
    } catch {
      // Some response types cannot be inspected before loadend.
    }
    return 0;
  }

  function visibleResponseHeader(xhr, name) {
    try {
      const target = String(name || "").toLowerCase();
      const line = String(xhr.getAllResponseHeaders?.() || "")
        .split(/\r?\n/)
        .find((entry) => entry.slice(0, entry.indexOf(":")).trim().toLowerCase() === target);
      return line ? line.slice(line.indexOf(":") + 1).trim() : "";
    } catch {
      return "";
    }
  }

  function bufferedRanges(buffer) {
    try {
      const ranges = [];
      for (let index = 0; index < buffer.buffered.length; index += 1) {
        ranges.push([
          Math.round(buffer.buffered.start(index) * 1000) / 1000,
          Math.round(buffer.buffered.end(index) * 1000) / 1000
        ]);
      }
      return ranges;
    } catch {
      return [];
    }
  }

  function videoTraceState() {
    const video = document.querySelector("video");
    if (!video) return {};
    const ranges = [];
    try {
      for (let index = 0; index < video.buffered.length; index += 1) {
        ranges.push([
          Math.round(video.buffered.start(index) * 1000) / 1000,
          Math.round(video.buffered.end(index) * 1000) / 1000
        ]);
      }
    } catch {
      // A detached media element can briefly reject buffered access.
    }
    return {
      buffered: ranges,
      currentTime: Math.round(Number(video.currentTime || 0) * 1000) / 1000,
      networkState: Number(video.networkState || 0),
      paused: Boolean(video.paused),
      readyState: Number(video.readyState || 0)
    };
  }

  function installMseTrace() {
    if (!TRACE_ENABLED) return;
    const MediaSourceCtor = globalThis.MediaSource;
    const SourceBufferCtor = globalThis.SourceBuffer;
    if (MediaSourceCtor?.prototype?.addSourceBuffer && SourceBufferCtor?.prototype?.appendBuffer) {
      const nativeAddSourceBuffer = MediaSourceCtor.prototype.addSourceBuffer;
      const nativeAppendBuffer = SourceBufferCtor.prototype.appendBuffer;
      MediaSourceCtor.prototype.addSourceBuffer = function tracedAddSourceBuffer(mimeType) {
        const buffer = nativeAddSourceBuffer.call(this, mimeType);
        sourceBufferMeta.set(buffer, { mimeType: String(mimeType || "") });
        traceEvent("mse-add-source-buffer", { mimeType: String(mimeType || "") });
        buffer.addEventListener("updateend", () => traceEvent("mse-updateend", {
          ...sourceBufferMeta.get(buffer),
          ranges: bufferedRanges(buffer),
          ...videoTraceState()
        }));
        buffer.addEventListener("error", () => traceEvent("mse-error", {
          ...sourceBufferMeta.get(buffer),
          ...videoTraceState()
        }));
        buffer.addEventListener("abort", () => traceEvent("mse-abort", {
          ...sourceBufferMeta.get(buffer),
          ...videoTraceState()
        }));
        return buffer;
      };
      SourceBufferCtor.prototype.appendBuffer = function tracedAppendBuffer(data) {
        const bytes = Number(data?.byteLength || data?.length || 0);
        traceEvent("mse-append", {
          bytes,
          ...sourceBufferMeta.get(this),
          rangesBefore: bufferedRanges(this),
          ...videoTraceState()
        });
        try {
          return nativeAppendBuffer.call(this, data);
        } catch (error) {
          traceEvent("mse-append-throw", {
            bytes,
            error: String(error?.message || error),
            name: String(error?.name || ""),
            ...sourceBufferMeta.get(this),
            ...videoTraceState()
          });
          throw error;
        }
      };
    }

    for (const eventName of ["waiting", "stalled", "playing", "progress", "seeking", "seeked", "canplay", "error"] ) {
      document.addEventListener(eventName, (event) => {
        if (event.target?.tagName !== "VIDEO") return;
        traceEvent(`video-${eventName}`, videoTraceState());
      }, true);
    }
  }

  function installPlaybackStateMonitor() {
    document.addEventListener("playing", (event) => {
      if (event.target?.tagName !== "VIDEO") return;
      prefetchRuntime.scheduleWindow(1500);
    }, true);
    for (const eventName of ["pause", "waiting", "stalled"]) {
      document.addEventListener(eventName, (event) => {
        if (event.target?.tagName !== "VIDEO") return;
        const decision = prefetchRuntime.headroom(event.target);
        if (decision.reason === "buffer-low") prefetchRuntime.cancelBackground(decision.reason);
        else prefetchRuntime.scheduleWindow(0);
      }, true);
    }
    document.addEventListener("seeking", (event) => {
      if (event.target?.tagName !== "VIDEO") return;
      prefetchRuntime.cancelPending("video-seeking");
    }, true);
    document.addEventListener("seeked", (event) => {
      if (event.target?.tagName !== "VIDEO") return;
      prefetchRuntime.scheduleWindow(1500);
    }, true);
    document.addEventListener("timeupdate", (event) => {
      if (event.target?.tagName !== "VIDEO") return;
      const now = traceNow();
      if (now - lastPlaybackGuardAt < 500) return;
      lastPlaybackGuardAt = now;
      const decision = prefetchRuntime.headroom(event.target);
      if (decision.reason === "buffer-low") prefetchRuntime.cancelBackground(decision.reason);
    }, true);
    document.addEventListener("progress", (event) => {
      if (event.target?.tagName === "VIDEO") prefetchRuntime.scheduleWindow(1000);
    }, true);
  }

  function isMediaCdnUrl(value) {
    try {
      const host = new URL(String(value || ""), location.href).hostname.toLowerCase();
      return /(?:bilivideo\.(?:com|cn)|akamaized\.net|gcdn\.co)$/i.test(host) || host.startsWith("upos-");
    } catch {
      return false;
    }
  }

  function publishFeasibility() {
    const target = document.documentElement;
    if (!target) return;
    target.setAttribute("data-bco-feasibility", JSON.stringify(feasibility));
  }

  function recordFeasibility(kind, rawUrl, range = "") {
    if (!isMediaCdnUrl(rawUrl)) return;
    feasibility[kind] = Number(feasibility[kind] || 0) + 1;
    if (kind === "resources") {
      const initiator = String(range || "unknown");
      feasibility.initiators[initiator] = Number(feasibility.initiators[initiator] || 0) + 1;
    }
    try {
      const parsed = new URL(String(rawUrl), location.href);
      feasibility.samples.push({ host: parsed.hostname, kind, path: parsed.pathname, range: String(range || "") });
      if (feasibility.samples.length > 16) feasibility.samples.splice(0, feasibility.samples.length - 16);
    } catch {
      // Ignore malformed diagnostic URLs.
    }
    publishFeasibility();
  }

  function post(type, detail = {}) {
    protocol.post(type, detail);
  }

  function publishProbeResult(result) {
    const target = document.documentElement;
    if (!target) return;
    const safeResult = {
      error: result?.error || null,
      mode: result?.mode || null,
      observedRange: result?.observedRange || "",
      results: (Array.isArray(result?.results) ? result.results : []).map((item) => ({
        failures: item.failures,
        host: item.host,
        samples: (Array.isArray(item.samples) ? item.samples : []).map((sample) => ({
          bytes: sample.bytes,
          error: sample.error || null,
          ok: sample.ok,
          position: sample.position,
          start: sample.start,
          status: sample.status || 0,
          totalBytes: sample.totalBytes,
          totalMs: sample.totalMs,
          ttfbMs: sample.ttfbMs
        }))
      }))
    };
    target.setAttribute("data-bco-last-probe", JSON.stringify(safeResult));
  }

  function preferenceKey(plan) {
    return `bco:v3:preferred:${plan.signature}`;
  }

  function prefetchEnabled() {
    return localStorage.getItem(PREFETCH_KEY) !== "false";
  }

  function routeMatchesDecodedVideo(route) {
    const video = document.querySelector("video");
    const width = Number(video?.videoWidth || 0);
    const height = Number(video?.videoHeight || 0);
    if (!width || !height) return false;
    return Math.abs(Number(route?.width || 0) - width) <= 2 &&
      Math.abs(Number(route?.height || 0) - height) <= 2;
  }

  function preferredHost(plan) {
    return sessionPreferences.get(preferenceKey(plan)) || null;
  }

  function routeFailureKey(plan, host) {
    return `${plan?.signature || "unknown-route"}|${host || "unknown-host"}`;
  }

  function coolingHosts(plan, now = Date.now()) {
    if (!plan) return [];
    const result = [];
    for (const candidate of plan.candidates || []) {
      const key = routeFailureKey(plan, candidate.host);
      const until = Number(routeFailureCooldowns.get(key) || 0);
      if (until > now) result.push(candidate.host);
      else if (until) routeFailureCooldowns.delete(key);
    }
    return result;
  }

  function coolDownFailedRoute(routed, range, transport, cause = "network-error") {
    if (routed?.route?.kind !== "video" || !routed?.plan?.signature || !routed.host) return;
    const until = Date.now() + ROUTE_FAILURE_COOLDOWN_MS;
    routeFailureCooldowns.set(routeFailureKey(routed.plan, routed.host), until);
    traceEvent("route-cooldown", {
      cause,
      host: routed.host,
      label: core.cdnLabel(routed.host),
      range: String(range || ""),
      signature: routed.plan.signature,
      transport,
      until
    });
    post(EVENTS.ROUTE_COOLDOWN, {
      cause,
      host: routed.host,
      range: String(range || ""),
      until
    });
  }

  function candidateIncludes(plan, host) {
    return Boolean(plan?.candidates?.some((candidate) => candidate.host === host));
  }

  function emitActivePlan(source = "stable-active-media-route") {
    if (!activePlan) return;
    const emission = [
      activePlan.signature,
      activePlan.currentPrimary,
      activePlan.preferredHost || "",
      ...activePlan.candidates.map((candidate) => candidate.url)
    ].join("|");
    if (emission === lastEmission) return;
    lastEmission = emission;
    feasibility.planEmissions += 1;
    feasibility.activeRoute = {
      codec: activePlan.codec,
      height: activePlan.height,
      mediaPath: activePlan.mediaPath,
      quality: activePlan.quality,
      videoKey: activePlan.videoKey,
      width: activePlan.width
    };
    publishFeasibility();
    post(EVENTS.CANDIDATES, {
      plan: {
        ...activePlan,
        prefetchEnabled: prefetchEnabled(),
        source
      }
    });
    prefetchRuntime.scheduleWindow(900);
  }

  function stabilizeActivePlan(routePlan, route, currentHost, options = {}) {
    const candidatePlan = core.createProbePlanFromRoute(routePlan, route, currentHost);
    if (!candidatePlan) return activePlan;
    const now = Date.now();
    const sameVideo = activePlan?.videoKey === candidatePlan.videoKey;
    const sameDimensions = sameVideo && activePlan.width === candidatePlan.width && activePlan.height === candidatePlan.height;
    const sameRoute = sameDimensions && activePlan.signature === candidatePlan.signature;
    const hardBoundary = options.hardBoundary === true && activePlan && !sameRoute;
    let shouldAdopt = hardBoundary || !activePlan || !sameVideo || !sameDimensions;

    if (sameRoute) {
      const savedHost = preferredHost(candidatePlan);
      const priorHost = activePlan.currentPrimary;
      activePlan = {
        ...candidatePlan,
        currentPrimary: savedHost && candidateIncludes(candidatePlan, savedHost)
          ? savedHost
          : candidateIncludes(candidatePlan, priorHost)
            ? priorHost
            : candidatePlan.currentPrimary,
        preferredHost: savedHost && candidateIncludes(candidatePlan, savedHost) ? savedHost : null
      };
      lastActiveRouteAt = now;
      pendingRouteHits = 0;
      pendingRouteSignature = "";
      emitActivePlan("signed-url-refresh");
      return activePlan;
    }

    if (!shouldAdopt) {
      if (pendingRouteSignature === candidatePlan.signature) pendingRouteHits += 1;
      else {
        pendingRouteSignature = candidatePlan.signature;
        pendingRouteHits = 1;
      }
      shouldAdopt = pendingRouteHits >= 3 && now - lastActiveRouteAt >= 5000;
    }

    if (!shouldAdopt) return activePlan;
    if (hardBoundary) {
      const previousSignature = activePlan.signature;
      prefetchRuntime.clear();
      feasibility.activeRoute = null;
      publishFeasibility();
      traceEvent("track-hard-reset", {
        fromSignature: previousSignature,
        range: String(options.range || ""),
        toSignature: candidatePlan.signature,
        ...videoTraceState()
      });
      post(EVENTS.PLAN_RESET, {
        signature: candidatePlan.signature,
        videoKey: candidatePlan.videoKey
      });
    }
    const savedHost = preferredHost(candidatePlan);
    if (savedHost && candidateIncludes(candidatePlan, savedHost)) {
      candidatePlan.currentPrimary = savedHost;
      candidatePlan.preferredHost = savedHost;
    }
    activePlan = candidatePlan;
    lastActiveRouteAt = now;
    pendingRouteHits = 0;
    pendingRouteSignature = "";
    emitActivePlan();
    return activePlan;
  }

  function processPayload(payload, _source) {
    if (!payload || typeof payload !== "object") return payload;
    const routePlan = core.extractMediaRoutes(payload, pageUrl());
    if (routePlan?.routes?.length) {
      const key = [
        routePlan.videoKey,
        routePlan.quality,
        ...routePlan.routes.map((route) => `${route.kind}:${route.id}:${route.codec}`)
      ].join("|");
      latestRoutes.delete(key);
      latestRoutes.set(key, routePlan);
      while (latestRoutes.size > 16) latestRoutes.delete(latestRoutes.keys().next().value);
      adoptObservedRoute(routePlan);
    }
    return payload;
  }

  function isPlayurlUrl(value) {
    const text = String(value || "");
    return /(?:\/x\/player\/(?:wbi\/)?playurl|\/pgc\/player\/web\/playurl|\/player\/playurl)/i.test(text);
  }

  function rememberMediaResource(rawUrl) {
    let href;
    try {
      href = new URL(String(rawUrl || ""), location.href).href;
    } catch {
      return;
    }
    const existing = recentMediaResources.indexOf(href);
    if (existing >= 0) recentMediaResources.splice(existing, 1);
    recentMediaResources.push(href);
    if (recentMediaResources.length > 64) {
      recentMediaResources.splice(0, recentMediaResources.length - 64);
    }
  }

  function adoptObservedRoute(routePlan) {
    const video = document.querySelector("video");
    const match = core.findObservedVideoRoute(
      routePlan,
      recentMediaResources,
      Number(video?.videoWidth || 0),
      Number(video?.videoHeight || 0)
    );
    if (!match) return false;
    const priorSignature = activePlan?.signature || "";
    stabilizeActivePlan(routePlan, match.route, match.currentHost);
    if (activePlan?.signature && activePlan.signature !== priorSignature) {
      feasibility.routeRecoveries += 1;
      publishFeasibility();
    }
    return true;
  }

  function adoptFromLatestRoutes() {
    for (const routePlan of [...latestRoutes.values()].reverse()) {
      if (adoptObservedRoute(routePlan)) return true;
    }
    return false;
  }

  function reconcilePageVideoKey() {
    const nextVideoKey = core.videoKeyFromUrl(pageUrl());
    if (!nextVideoKey || nextVideoKey === "unknown-video" || nextVideoKey === currentPageVideoKey) return false;
    currentPageVideoKey = nextVideoKey;
    activePlan = null;
    lastActiveRouteAt = 0;
    lastEmission = "";
    pendingRouteHits = 0;
    pendingRouteSignature = "";
    prefetchRuntime.clear();
    feasibility.activeRoute = null;
    publishFeasibility();
    post(EVENTS.PLAN_RESET, { videoKey: nextVideoKey });

    const video = document.querySelector("video");
    for (const routePlan of [...latestRoutes.values()].reverse()) {
      const match = core.findObservedVideoRoute(
        routePlan,
        recentMediaResources,
        Number(video?.videoWidth || 0),
        Number(video?.videoHeight || 0)
      );
      if (!match) continue;
      routePlan.videoKey = nextVideoKey;
      stabilizeActivePlan(routePlan, match.route, match.currentHost);
      break;
    }
    return true;
  }

  function recoverPlayurl(rawUrl) {
    if (typeof nativePageFetch !== "function" || !isPlayurlUrl(rawUrl)) return;
    let href;
    try {
      href = new URL(String(rawUrl), location.href).href;
    } catch {
      return;
    }
    if (recoveredPlayurlUrls.has(href)) return;
    recoveredPlayurlUrls.add(href);
    nativePageFetch(href, { credentials: "include" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (!payload) return;
        feasibility.playurlRecoveries += 1;
        publishFeasibility();
        processPayload(payload, "resource-timing-recovery");
      })
      .catch(() => {
        // Recovery is best-effort and must never affect Bilibili playback.
      });
  }

  function installPlayInfoTrap() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__playinfo__");
      if (descriptor && !descriptor.configurable) {
        if (globalThis.__playinfo__) processPayload(globalThis.__playinfo__, "existing-playinfo");
        return;
      }
      let currentValue = globalThis.__playinfo__;
      Object.defineProperty(globalThis, "__playinfo__", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() {
          return currentValue;
        },
        set(value) {
          currentValue = value;
          processPayload(value, "playinfo-assignment");
        }
      });
      if (currentValue) processPayload(currentValue, "existing-playinfo");
    } catch {
      // Fetch/XHR hooks remain available when the bootstrap value is inaccessible.
    }
  }

  function installFetchHook() {
    const nativeFetch = nativePageFetch;
    if (typeof nativeFetch !== "function") return;
    globalThis.fetch = async function biliCdnFetch(...args) {
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
      const range = args[1]?.headers?.Range || args[1]?.headers?.range ||
        (typeof args[0]?.headers?.get === "function" ? args[0].headers.get("Range") : "");
      const routed = resolveMediaRequest(requestUrl, range || "");
      const isMedia = Boolean(routed?.route);
      if (isMedia) {
        feasibility[routed.changed ? "rewrites" : "passThrough"] += 1;
        recordFeasibility("fetch", requestUrl, range || "");
        if (routed.changed) {
          if (typeof args[0] === "string" || args[0] instanceof URL) {
            args[0] = routed.url;
          } else if (typeof Request === "function" && args[0] instanceof Request) {
            args[0] = new Request(routed.url, args[0]);
          }
        }
        if (routed.route.kind === "video" && core.parseByteRange(range || "")) {
          prefetchRuntime.observeVideoRange(range, 700);
        }
      }
      let cachedResponse = isMedia && routed.route.kind === "video" && prefetchEnabled()
        ? prefetchStore.assemble(routed.plan?.signature, range || "")
        : null;
      if (!cachedResponse && isMedia && routed.route.kind === "video" && prefetchEnabled() &&
          core.parseByteRange(range || "")) {
        const promoted = prefetchRuntime.promotePlaybackRange(range || "");
        if (promoted) {
          traceEvent("fetch-prefetch-await", { range: range || "" });
          cachedResponse = await promoted;
        }
      }
      if (cachedResponse) {
        prefetchStore.consume(cachedResponse.cacheKeys);
        recordRouteOutcome(routed, true, 206, "fetch-prefetch-cache");
        traceEvent("fetch-prefetch-hit", {
          bytes: cachedResponse.buffer.byteLength,
          host: routed.host || "",
          range: range || ""
        });
        prefetchRuntime.publish({
          lastHit: {
            bytes: cachedResponse.buffer.byteLength,
            hosts: cachedResponse.cacheHosts,
            range: range || ""
          }
        });
        prefetchRuntime.scheduleWindow(500);
        return new Response(cachedResponse.buffer, {
          headers: cachedResponse.headers,
          status: cachedResponse.status,
          statusText: cachedResponse.statusText
        });
      }
      let response;
      const trackPlaybackRequest = Boolean(
        isMedia && routed.route.kind === "video" && core.parseByteRange(range || "")
      );
      if (trackPlaybackRequest) prefetchRuntime.beginPlaybackRequest("fetch", range);
      try {
        response = await nativeFetch.apply(this, args);
        if (isMedia) recordRouteOutcome(routed, response.ok, response.status, "fetch", range || "");
      } catch (error) {
        if (isMedia) recordRouteOutcome(routed, false, 0, "fetch", range || "", "network-error");
        throw error;
      } finally {
        if (trackPlaybackRequest) prefetchRuntime.endPlaybackRequest("fetch", range);
      }
      if (!isPlayurlUrl(requestUrl)) return response;

      response.clone().json().then((payload) => processPayload(payload, "fetch-observe")).catch(() => {});
      return response;
    };
  }

  function installXhrHook() {
    const XHR = globalThis.XMLHttpRequest;
    if (!XHR?.prototype) return;
    const metadata = new WeakMap();
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;
    const nativeAbort = XHR.prototype.abort;
    const nativeSetRequestHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function biliCdnOpen(method, url, ...rest) {
      const originalUrl = String(url || "");
      const routed = resolveMediaRequest(originalUrl);
      const meta = {
        id: TRACE_ENABLED ? `xhr-${traceSequence + 1}` : "",
        failureKind: "",
        firstByteAt: 0,
        lastProgressAt: 0,
        lastProgressBytes: 0,
        loaded: 0,
        method: String(method || "GET"),
        openRest: rest,
        originalUrl,
        playbackTracked: false,
        range: "",
        requestHeaders: [],
        routed,
        startedAt: 0,
        total: 0,
        url: routed?.changed ? routed.url : originalUrl
      };
      if (routed?.route) feasibility[routed.changed ? "rewrites" : "passThrough"] += 1;
      metadata.set(this, meta);
      if (routed?.route) traceEvent("xhr-open", {
        changed: Boolean(routed.changed),
        host: routed.host || "",
        method: meta.method,
        originalHost: routed.originalHost || "",
        originalUrl: meta.originalUrl,
        requestId: meta.id,
        routedUrl: meta.url
      });
      else if (isMediaCdnUrl(originalUrl)) {
        recordFeasibility("unmatched", originalUrl);
        try {
          const parsed = new URL(originalUrl, location.href);
          traceEvent("xhr-unmatched", {
            activeMediaPath: activePlan?.mediaPath || "",
            host: parsed.hostname,
            path: parsed.pathname,
            requestId: meta.id
          });
        } catch {
          // The feasibility counter is still sufficient for malformed URLs.
        }
      }
      this.addEventListener("loadend", () => {
        if (meta.playbackTracked) {
          meta.playbackTracked = false;
          prefetchRuntime.endPlaybackRequest("xhr", meta.range);
        }
        if (isPlayurlUrl(meta.originalUrl) && this.readyState === 4) {
          try {
            const value = this.response;
            if (value && typeof value === "object") processPayload(value, "xhr-json-observe");
            else if (typeof value === "string") processPayload(JSON.parse(value), "xhr-text-observe");
          } catch {
            // Observing a playurl response must never affect Bilibili's own XHR consumer.
          }
        }
        if (meta.routed?.route && !meta.aborted) {
          recordRouteOutcome(
            meta.routed,
            this.status >= 200 && this.status < 400,
            this.status,
            "xhr",
            meta.range,
            meta.failureKind || ""
          );
        }
        if (TRACE_ENABLED && meta.routed?.route) traceEvent("xhr-loadend", {
          aborted: Boolean(meta.aborted),
          bytes: responseByteLength(this),
          changed: Boolean(meta.routed.changed),
          contentLength: visibleResponseHeader(this, "content-length"),
          contentRange: visibleResponseHeader(this, "content-range"),
          durationMs: meta.startedAt ? Math.round((traceNow() - meta.startedAt) * 10) / 10 : 0,
          host: meta.routed.host || "",
          range: meta.range,
          requestId: meta.id,
          responseType: String(this.responseType || ""),
          responseUrl: String(this.responseURL || ""),
          status: Number(this.status || 0),
          ...videoTraceState()
        });
      }, { once: true });
      this.addEventListener("readystatechange", () => {
        if (!TRACE_ENABLED || !meta.routed?.route || this.readyState !== 2) return;
        traceEvent("xhr-headers", {
          contentLength: visibleResponseHeader(this, "content-length"),
          contentRange: visibleResponseHeader(this, "content-range"),
          durationMs: meta.startedAt ? Math.round((traceNow() - meta.startedAt) * 10) / 10 : 0,
          host: meta.routed.host || "",
          range: meta.range,
          requestId: meta.id,
          responseUrl: String(this.responseURL || ""),
          status: Number(this.status || 0),
          ...videoTraceState()
        });
      });
      this.addEventListener("progress", (event) => {
        if (!meta.routed?.route) return;
        const loaded = Number(event.loaded || 0);
        const total = Number(event.total || 0);
        if (loaded > meta.loaded) meta.lastProgressAt = traceNow();
        meta.loaded = Math.max(meta.loaded, loaded);
        meta.total = Math.max(meta.total, total);
        const shouldRecord = !meta.firstByteAt ||
          loaded - meta.lastProgressBytes >= 512 * 1024 ||
          (total > 0 && loaded >= total);
        if (!shouldRecord) return;
        if (!meta.firstByteAt && loaded > 0) meta.firstByteAt = traceNow();
        meta.lastProgressBytes = loaded;
        traceEvent("xhr-progress", {
          elapsedMs: meta.startedAt ? Math.round((traceNow() - meta.startedAt) * 10) / 10 : 0,
          firstByteMs: meta.firstByteAt && meta.startedAt
            ? Math.round((meta.firstByteAt - meta.startedAt) * 10) / 10
            : 0,
          host: meta.routed.host || "",
          lengthComputable: Boolean(event.lengthComputable),
          loaded,
          range: meta.range,
          requestId: meta.id,
          total,
          ...videoTraceState()
        });
      });
      this.addEventListener("abort", () => {
        meta.aborted = true;
        meta.failureKind = "extension-cancel";
        traceEvent("xhr-abort", {
          range: meta.range,
          requestId: meta.id,
          ...videoTraceState()
        });
      }, { once: true });
      this.addEventListener("error", () => {
        meta.failureKind = "network-error";
        traceEvent("xhr-error", {
          range: meta.range,
          requestId: meta.id,
          status: Number(this.status || 0),
          ...videoTraceState()
        });
      }, { once: true });
      this.addEventListener("timeout", () => {
        meta.failureKind = "player-timeout";
        traceEvent("xhr-timeout", {
          range: meta.range,
          requestId: meta.id,
          timeout: Number(this.timeout || 0),
          ...videoTraceState()
        });
      }, { once: true });
      return nativeOpen.call(this, method, meta.url, ...rest);
    };

    XHR.prototype.setRequestHeader = function biliCdnSetRequestHeader(name, value) {
      const meta = metadata.get(this);
      if (meta) {
        meta.requestHeaders.push([String(name), String(value)]);
        if (String(name).toLowerCase() === "range") meta.range = String(value || "");
      }
      return nativeSetRequestHeader.call(this, name, value);
    };

    XHR.prototype.send = function biliCdnSend(...args) {
      const meta = metadata.get(this);
      if (meta?.routed?.route) {
        const belongsToActiveVideo = meta.routed.route.kind === "video" && (
          meta.routed.plan?.signature === activePlan?.signature ||
          routeMatchesDecodedVideo(meta.routed.route)
        );
        if (belongsToActiveVideo && core.parseByteRange(meta.range)) {
          prefetchRuntime.observeVideoRange(meta.range, 700);
          meta.playbackTracked = true;
          prefetchRuntime.beginPlaybackRequest("xhr", meta.range);
        }
        meta.startedAt = traceNow();
        meta.lastProgressAt = meta.startedAt;
        recordFeasibility("xhr", meta.url, meta.range);
        traceEvent("xhr-send", {
          changed: Boolean(meta.routed.changed),
          host: meta.routed.host || "",
          range: meta.range,
          requestHeaders: [...meta.requestHeaders],
          requestId: meta.id,
          timeout: Number(this.timeout || 0)
        });
      }
      try {
        return nativeSend.apply(this, args);
      } catch (error) {
        if (meta?.playbackTracked) {
          meta.playbackTracked = false;
          prefetchRuntime.endPlaybackRequest("xhr", meta.range);
        }
        throw error;
      }
    };

    const CachedXHR = cachedXhrCore.createCachedXMLHttpRequest({
      NativeXHR: XHR,
      rawAbort: nativeAbort,
      resolveCachedRequest({ method, range, responseType, url }) {
        if (!prefetchEnabled() || String(method).toUpperCase() !== "GET") return null;
        const primary = resolveMediaRequest(url);
        if (!primary?.route) return null;
        const belongsToActiveVideo = primary.route.kind === "video" && (
          primary.plan?.signature === activePlan?.signature ||
          routeMatchesDecodedVideo(primary.route)
        );
        if (!belongsToActiveVideo) return null;
        prefetchRuntime.observeVideoRange(range);
        recordFeasibility("xhr-cache-lookup", url, range);
        const cachedResponse = responseType === "arraybuffer"
          ? prefetchStore.assemble(primary.plan?.signature, range)
          : null;
        const resolvedPlan = (response) => response ? {
          cachedResponse: response,
          context: {
            cacheHosts: response.cacheHosts,
            cacheKeys: response.cacheKeys,
            primary,
            protectedRanges: response.protectedRanges
          },
          primaryHost: primary.host,
          primaryUrl: primary.url
        } : null;
        if (cachedResponse) return resolvedPlan(cachedResponse);
        if (responseType !== "arraybuffer") return null;
        const promoted = prefetchRuntime.promotePlaybackRange(range);
        if (!promoted) return null;
        traceEvent("xhr-prefetch-await", { range });
        return { pendingResponse: promoted.then(resolvedPlan) };
      },
      onCacheHit(detail) {
        const context = detail.context || {};
        const common = {
          expectedBytes: Number(detail?.expectedBytes || 0),
          primaryHost: context.primary?.host || "",
          protectedRanges: context.protectedRanges || [],
          range: detail?.range || ""
        };
        const cachedRoute = context.primary;
        if (cachedRoute) recordRouteOutcome(cachedRoute, true, 206, "xhr-prefetch-cache");
        prefetchStore.consume(context.cacheKeys);
        traceEvent("xhr-prefetch-hit", {
          ...common,
          bytes: Number(detail.expectedBytes || 0),
          cacheHosts: detail.cacheHosts || context.cacheHosts || []
        });
        prefetchRuntime.publish({
          lastHit: {
            bytes: Number(detail.expectedBytes || 0),
            hosts: detail.cacheHosts || context.cacheHosts || [],
            range: detail.range || ""
          }
        });
        prefetchRuntime.scheduleWindow(500);
      }
    });
    if (CachedXHR) globalThis.XMLHttpRequest = CachedXHR;
  }

  function resolveMediaRequest(requestUrl, exactRange = "") {
    if (!isMediaCdnUrl(requestUrl)) return null;
    reconcilePageVideoKey();
    let requested;
    try {
      requested = new URL(String(requestUrl), location.href);
    } catch {
      return null;
    }

    const requestRange = core.parseByteRange(exactRange);
    for (const [_key, routePlan] of [...latestRoutes.entries()].reverse()) {
      for (const route of routePlan.routes || []) {
        const routeMatch = core.matchRouteUrl(route, requested.href);
        if (!routeMatch) continue;
        const { current, route: observedRoute } = routeMatch;

        if (observedRoute.kind === "video" && routeMatchesDecodedVideo(observedRoute)) {
          routePlan.videoKey = currentPageVideoKey;
        }

        let plan = activePlan?.videoKey === routePlan.videoKey &&
          activePlan.candidates?.some((candidate) => candidate.url === requested.href)
          ? activePlan
          : null;
        if (observedRoute.kind === "video") {
          const candidatePlan = core.createProbePlanFromRoute(routePlan, observedRoute, current.host);
          const hardBoundary = Boolean(
            requestRange?.start === 0 &&
            activePlan &&
            candidatePlan &&
            candidatePlan.signature !== activePlan.signature &&
            candidatePlan.mediaPath !== activePlan.mediaPath
          );
          const canStabilize = hardBoundary || routeMatchesDecodedVideo(observedRoute);
          if (!canStabilize) {
            const resolved = core.resolveRouteUrl(routePlan, requested.href, current.host);
            return {
              ...resolved,
              key: plan?.signature || `${routePlan.videoKey}:${observedRoute.id}`,
              plan,
              selectedHost: current.host
            };
          }
          const stabilized = stabilizeActivePlan(routePlan, observedRoute, current.host, {
            hardBoundary,
            range: exactRange
          });
          plan = stabilized?.candidates?.some((candidate) => candidate.url === requested.href)
            ? stabilized
            : null;
        }

        const explicitPreference = plan ? preferredHost(plan) : null;
        const cooled = coolingHosts(plan);
        const selectedHost = core.chooseRouteHostWithCooldown(
          current.host,
          explicitPreference,
          plan?.candidates,
          cooled
        );
        const resolved = core.resolveRouteUrl(routePlan, requested.href, selectedHost);
        if (explicitPreference && selectedHost !== explicitPreference) {
          traceEvent("route-rescue", {
            coolingHosts: cooled,
            fromHost: explicitPreference,
            fromLabel: core.cdnLabel(explicitPreference),
            originalHost: current.host,
            selectedHost,
            selectedLabel: core.cdnLabel(selectedHost),
            signature: plan?.signature || ""
          });
        }
        return {
          ...resolved,
          key: plan?.signature || `${routePlan.videoKey}:${observedRoute.id}`,
          plan,
          selectedHost
        };
      }
    }
    return null;
  }

  function activateLiveHost(plan, host, reason) {
    if (!candidateIncludes(plan, host)) return false;
    sessionPreferences.set(preferenceKey(plan), host);
    plan.currentPrimary = host;
    plan.preferredHost = host;
    document.documentElement?.setAttribute("data-bco-last-route-selection", JSON.stringify({
      at: Date.now(),
      host,
      reason: String(reason || ""),
      signature: plan.signature,
      type: "activated",
      videoKey: plan.videoKey
    }));
    traceEvent("route-activate", {
      host,
      label: core.cdnLabel(host),
      reason: String(reason || ""),
      signature: plan.signature,
      ...videoTraceState()
    });
    post(EVENTS.APPLIED, {
      host,
      live: true,
      reason,
      reloading: false,
      signature: plan.signature
    });
    prefetchRuntime.scheduleWindow(300);
    return true;
  }

  function recordRouteOutcome(routed, ok, status, transport, range = "", cause = "") {
    if (!routed?.route) return;
    feasibility.outcomes[ok ? "ok" : "failed"] += 1;
    const statusKey = String(status || 0);
    feasibility.outcomes.statuses[statusKey] = Number(feasibility.outcomes.statuses[statusKey] || 0) + 1;
    const outcomeCause = ok ? "success" : String(cause || (status ? "http-error" : "network-error"));
    feasibility.outcomes.causes[outcomeCause] = Number(feasibility.outcomes.causes[outcomeCause] || 0) + 1;
    publishFeasibility();
    const host = routed.host;
    if (!ok && Number(status || 0) === 0 && outcomeCause !== "extension-cancel") {
      coolDownFailedRoute(routed, range, transport, outcomeCause);
    }
    post(EVENTS.REQUEST_OUTCOME, { cause: outcomeCause, host, ok, status, transport });
  }

  function installResourceObserver() {
    const inspect = (entry) => {
      if (!entry) return;
      reconcilePageVideoKey();
      if (isPlayurlUrl(entry.name)) recoverPlayurl(entry.name);
      if (!isMediaCdnUrl(entry.name)) return;
      rememberMediaResource(entry.name);
      recordFeasibility("resources", entry.name, entry.initiatorType || "unknown");
      adoptFromLatestRoutes();
    };
    try {
      performance.getEntriesByType("resource").forEach(inspect);
      const observer = new PerformanceObserver((list) => list.getEntries().forEach(inspect));
      observer.observe({ type: "resource", buffered: true });
    } catch {
      // Fetch/XHR counters still establish feasibility on older player builds.
    }
    document.addEventListener("loadedmetadata", adoptFromLatestRoutes, true);
    document.addEventListener("playing", adoptFromLatestRoutes, true);
    publishFeasibility();
  }

  function findPlan(message) {
    if (!activePlan || activePlan.videoKey !== message.videoKey) return null;
    if (activePlan.quality !== message.quality || activePlan.signature !== message.signature) return null;
    return activePlan;
  }

  function applyAutomaticProbeResult(result, message) {
    const plan = findPlan(message);
    if (!plan) {
      const decision = { applied: false, host: null, reason: "plan-changed" };
      document.documentElement?.setAttribute("data-bco-last-route-selection", JSON.stringify({
        at: Date.now(),
        reason: decision.reason,
        type: "skipped",
        videoKey: activePlan?.videoKey || ""
      }));
      return decision;
    }
    const decision = core.chooseAutomaticRoute(
      result?.results,
      plan,
      message.currentHost,
      { pinCurrentBest: true }
    );
    if (!decision.host) {
      document.documentElement?.setAttribute("data-bco-last-route-selection", JSON.stringify({
        at: Date.now(),
        reason: decision.reason,
        type: "skipped",
        videoKey: plan.videoKey,
        winnerHost: decision.winnerHost || ""
      }));
      return { ...decision, applied: false };
    }
    const applied = activateLiveHost(plan, decision.host, `automatic-${decision.reason}`);
    return { ...decision, applied };
  }

  window.addEventListener("message", (event) => {
    if (!protocol.isProtocolMessage(event)) return;
    const message = event.data;

    if (message.type === EVENTS.PROBE_REQUEST && typeof message.requestId === "string") {
      probeCore.runProbe(message, nativePageFetch, traceEvent)
        .then((result) => {
          publishProbeResult(result);
          const automaticDecision = message.automatic === true
            ? applyAutomaticProbeResult(result, message)
            : null;
          post(EVENTS.PROBE_RESULT, {
            requestId: message.requestId,
            result: automaticDecision ? { ...result, automaticDecision } : result
          });
        })
        .catch((error) => post(EVENTS.PROBE_RESULT, {
          requestId: message.requestId,
          result: { error: String(error?.message || error), results: [] }
        }));
      return;
    }

    if (message.type === EVENTS.UI_READY) {
      post(EVENTS.ACTIVITY, { entries: activityEvents });
      if (activePlan) {
        const savedHost = preferredHost(activePlan);
        post(EVENTS.CANDIDATES, {
          plan: {
            ...activePlan,
            prefetchEnabled: prefetchEnabled(),
            preferredHost: savedHost || null,
            source: "ui-handshake"
          }
        });
      }
      return;
    }

    if (message.type === EVENTS.SET_PREFETCH) {
      localStorage.setItem(PREFETCH_KEY, message.enabled ? "true" : "false");
      if (message.enabled) prefetchRuntime.scheduleWindow(0);
      else prefetchRuntime.clear();
      prefetchRuntime.publish({ reason: message.enabled ? "enabled" : "disabled" });
      return;
    }

    if (message.type === EVENTS.SELECT_HOST) {
      const plan = findPlan(message);
      if (!plan || !candidateIncludes(plan, message.host)) {
        const rejectionReason = !activePlan
          ? "no-active-plan"
          : activePlan.videoKey !== message.videoKey
            ? "video-key-mismatch"
            : activePlan.quality !== message.quality
              ? "quality-mismatch"
              : activePlan.signature !== message.signature
                ? "signature-mismatch"
                : "candidate-missing";
        document.documentElement?.setAttribute("data-bco-last-route-selection", JSON.stringify({
          at: Date.now(),
          host: String(message.host || ""),
          reason: rejectionReason,
          requestedSignature: String(message.signature || ""),
          signature: activePlan?.signature || "",
          type: "rejected",
          videoKey: activePlan?.videoKey || ""
        }));
        traceEvent("route-select-rejected", {
          activeQuality: activePlan?.quality || 0,
          activeSignature: activePlan?.signature || "",
          activeVideoKey: activePlan?.videoKey || "",
          host: String(message.host || ""),
          reason: rejectionReason,
          requestedQuality: message.quality || 0,
          requestedSignature: String(message.signature || ""),
          requestedVideoKey: String(message.videoKey || ""),
          ...videoTraceState()
        });
        return;
      }
      activateLiveHost(plan, message.host, message.reason || "manual-selection");
    }
  });

  installPlayInfoTrap();
  installPlaybackStateMonitor();
  installMseTrace();
  installFetchHook();
  installXhrHook();
  installResourceObserver();
  window.addEventListener("popstate", reconcilePageVideoKey);
  window.setInterval(reconcilePageVideoKey, 250);
  post(EVENTS.HOOK_READY, { prefetchEnabled: prefetchEnabled() });
})();
