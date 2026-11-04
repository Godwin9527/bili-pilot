(function installBiliCdnController() {
  "use strict";

  const protocol = globalThis.BiliCdnProtocol;
  const i18n = globalThis.BiliCdnI18n;
  const uiModel = globalThis.BiliCdnUiModel;
  const autoProbePolicy = globalThis.BiliCdnAutoProbePolicy;
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!protocol || !i18n || !uiModel || !autoProbePolicy || !extensionApi) return;
  const { EVENTS, STORAGE } = protocol;
  const { locale, t } = i18n;
  const { formatSpeed } = uiModel;
  const POPUP_PORT = "bili-pilot-popup";
  const POPUP_CHANNEL = "BILI_CDN_PILOT_POPUP_V1";
  const SNAPSHOT_INTERVAL_MS = 60;
  const activityEntries = [];
  const activityIds = new Set();
  const autoProbe = autoProbePolicy.createScheduler();
  const popupPorts = new Set();
  const portActivityVersion = new WeakMap();
  const extensionVersion = extensionApi.runtime.getManifest().version;
  const state = {
    contextInvalidated: false,
    mode: "quick",
    plan: null,
    prefetch: { backoff: 0, bytes: 0, circuitOpenInMs: 0, failed: 0, foreground: 0, hosts: {}, loading: 0, queued: 0, ready: 0, retrying: 0, segments: [] },
    prefetchEnabled: true,
    results: [],
    scanning: false,
    status: t("waitingForRoutes"),
    statusKind: "idle"
  };

  let monitoredVideo = null;
  let monitoredVideoProblemListener = null;
  let activitySequence = 0;
  let activityVersion = 0;
  let probeSequence = 0;
  let snapshotTimer = 0;
  const pendingProbeRequests = new Map();

  function post(type, detail = {}) {
    protocol.post(type, detail);
  }

  function addActivity(event = {}, source = "ui") {
    const view = activityView(event);
    if (!view) return false;
    const id = `${source}:${event.id ?? `${source}-${activitySequence += 1}`}`;
    if (activityIds.has(id)) return false;
    activityIds.add(id);
    activityEntries.push({ at: Number(event.at || Date.now()), id, ...view });
    while (activityEntries.length > 100) activityIds.delete(activityEntries.shift().id);
    activityVersion += 1;
    return true;
  }

  function appendLog(type, detail = {}) {
    if (addActivity({ detail, type })) scheduleSnapshot();
  }

  function candidateLabel(host, label = "") {
    return label || state.plan?.candidates?.find((candidate) => candidate.host === host)?.label || t("currentRoute");
  }

  function segmentLabel(index) {
    const value = Number(index);
    return Number.isFinite(value) ? `#${value + 1}` : t("pending");
  }

  function activityView(entry) {
    const detail = entry.detail || {};
    const host = candidateLabel(detail.host || detail.selectedHost || detail.toHost, detail.label || detail.selectedLabel || detail.toLabel);
    const segment = segmentLabel(detail.index);
    const bytes = (Number(detail.bytes || detail.size || 0) / 1024 / 1024).toFixed(1);
    switch (entry.type) {
      case "probe-scan-start":
        return { title: t("activityScanStarted"), detail: t("routeCount", [detail.routeCount || 0]) };
      case "probe-scan-result":
        return { title: t("activityScanFinished"), detail: t("routeCount", [detail.routeCount || 0]) };
      case "probe-scan-failed":
        return { title: t("activityScanFailed"), detail: "" };
      case "probe-candidate-start":
        return { title: t("activityProbeStarted", [candidateLabel(detail.host, detail.label)]), detail: "" };
      case "probe-candidate-result":
        return { title: t("activityProbeFinished", [candidateLabel(detail.host, detail.label)]), detail: `${t("floorSpeed", [formatSpeed(detail.minMbps)])} · ${t("failureCount", [detail.failures || 0])}` };
      case "route-activate":
        return { title: t("activityRouteSelected", [candidateLabel(detail.host, detail.label)]), detail: "" };
      case "route-cooldown":
        return { title: t("activityRouteAvoided", [candidateLabel(detail.host, detail.label)]), detail: "" };
      case "route-rescue":
        return { title: t("activityRouteRescue", [candidateLabel(detail.selectedHost, detail.selectedLabel), candidateLabel(detail.fromHost, detail.fromLabel)]), detail: "" };
      case "prefetch-toggle":
        return { title: detail.enabled ? t("activityPrefetchEnabled") : t("activityPrefetchDisabled"), detail: "" };
      case "prefetch-window-ready":
        return { title: t("activitySegmentsPlanned", [detail.accepted || detail.planned || 0]), detail: "" };
      case "segment-prefetch-start":
        return { title: `${host} · ${segment} · ${t("downloading")}`, detail: "" };
      case "segment-prefetch-retry":
        return { title: `${candidateLabel(detail.toHost, detail.toLabel)} · ${segment} · ${t("activityRetrying")}`, detail: "" };
      case "segment-prefetch-ready":
        return { title: `${host} · ${segment} · ${t("ready")}`, detail: t("activityTransfer", [bytes, Math.round(Number(detail.durationMs || 0))]) };
      case "segment-prefetch-backoff":
        return { title: `${segment} · ${t("activityRetrying")}`, detail: "" };
      case "segment-prefetch-failed":
        return { title: `${segment} · ${t("unavailable")}`, detail: "" };
      case "segment-prefetch-cancelled":
        return { title: `${segment} · ${t("activityCancelled")}`, detail: "" };
      case "segment-prefetch-promoted":
        return { title: t("activitySegmentPrioritized"), detail: "" };
      case "fetch-prefetch-hit":
      case "xhr-prefetch-hit":
        return { title: t("activityCacheDelivered"), detail: `${bytes} MB` };
      default:
        return null;
    }
  }

  function publishAutoState(stage, detail = {}) {
    document.documentElement?.setAttribute("data-bco-auto-state", JSON.stringify({
      at: Date.now(),
      stage,
      ...detail
    }));
  }

  function planSnapshot(plan) {
    if (!plan || typeof plan !== "object") return null;
    return {
      bandwidth: Number(plan.bandwidth || 0),
      candidates: (Array.isArray(plan.candidates) ? plan.candidates : []).map((candidate) => ({
        host: candidate.host,
        isPrimary: Boolean(candidate.isPrimary),
        label: candidate.label || ""
      })),
      codec: plan.codec || "",
      currentPrimary: plan.currentPrimary || "",
      features: Array.isArray(plan.features) ? plan.features : [],
      height: Number(plan.height || 0),
      preferredHost: plan.preferredHost || null,
      quality: plan.quality,
      qualityLabel: plan.qualityLabel || "",
      signature: plan.signature,
      videoKey: plan.videoKey || "",
      width: Number(plan.width || 0)
    };
  }

  function snapshot() {
    return {
      activityVersion,
      channel: POPUP_CHANNEL,
      contextInvalidated: state.contextInvalidated,
      locale,
      plan: planSnapshot(state.plan),
      prefetch: state.prefetch,
      prefetchEnabled: state.prefetchEnabled,
      results: state.results,
      scanning: state.scanning,
      status: state.status,
      statusKind: state.statusKind,
      type: "snapshot",
      version: extensionVersion
    };
  }

  function sendSnapshot(port) {
    const lastVersion = portActivityVersion.get(port);
    const includeActivity = lastVersion !== activityVersion;
    portActivityVersion.set(port, activityVersion);
    port.postMessage(includeActivity
      ? { ...snapshot(), activity: activityEntries.slice(-100) }
      : { ...snapshot(), activity: null });
  }

  function broadcastSnapshot() {
    for (const port of popupPorts) {
      try {
        sendSnapshot(port);
      } catch {
        popupPorts.delete(port);
      }
    }
  }

  function scheduleSnapshot() {
    if (!popupPorts.size || snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = 0;
      broadcastSnapshot();
    }, SNAPSHOT_INTERVAL_MS);
  }

  function requestPageProbe(message) {
    const requestId = `probe-${Date.now()}-${probeSequence += 1}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingProbeRequests.delete(requestId);
        reject(new Error(t("pageProbeTimedOut")));
      }, 60000);
      pendingProbeRequests.set(requestId, { resolve, timeout });
      post(EVENTS.PROBE_REQUEST, { ...message, requestId });
    });
  }

  function isContextInvalidated(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function markContextInvalidated() {
    state.contextInvalidated = true;
    state.statusKind = "warning";
    state.status = t("extensionUpdated");
  }

  async function scan(mode = "quick", options = {}) {
    if (!state.plan || state.scanning || state.contextInvalidated) {
      return { probeSucceeded: false, routeChanged: false };
    }
    const automatic = options.automatic === true;
    publishAutoState("scan-start", { automatic, mode });
    state.scanning = true;
    state.mode = mode === "deep" ? "deep" : "quick";
    state.statusKind = "idle";
    const scanPlan = state.plan;
    const scanSignature = scanPlan.signature;
    const scanCurrentHost = scanPlan.preferredHost || scanPlan.currentPrimary;
    const probeCandidates = scanPlan.candidates;
    appendLog("probe-scan-start", {
      automatic,
      mode: state.mode,
      routeCount: probeCandidates.length
    });
    if (!probeCandidates.length) {
      state.scanning = false;
      state.statusKind = "success";
      state.status = t("noRoutesToCompare");
      scheduleSnapshot();
      return { probeSucceeded: false, routeChanged: false };
    }
    state.status = state.mode === "deep"
      ? t("scanningDeep")
      : automatic
        ? t("scanningAutomatic")
        : t("scanningQuick");
    scheduleSnapshot();

    try {
      const response = await requestPageProbe({
        automatic,
        candidates: probeCandidates,
        currentHost: state.plan.currentPrimary,
        mode: state.mode,
        quality: state.plan.quality,
        signature: state.plan.signature,
        videoKey: state.plan.videoKey
      });
      if (response?.error) throw new Error(response.error);
      appendLog("probe-scan-result", {
        automatic,
        mode: state.mode,
        routeCount: response.results?.length || 0
      });
      if (state.plan?.signature !== scanSignature) {
        state.statusKind = "warning";
        state.status = t("activeTrackChanged");
        return { planChanged: true, probeSucceeded: false, routeChanged: false };
      }
      state.results = Array.isArray(response?.results) ? response.results : [];
      const winner = state.results[0];
      const usableWinner = Boolean(winner && winner.score > -10000 && winner.samples?.length);
      const requiredMbps = Math.max(0.5, Number(state.plan.bandwidth || 0) / 1_000_000);
      const safePlaybackMbps = requiredMbps * 1.2;
      if (!usableWinner) {
        state.statusKind = "error";
        state.status = t("everyRouteFailed");
      } else if (winner.failures > 0) {
        state.statusKind = "warning";
        state.status = t("winnerHasFailures", [winner.label]);
      } else if (winner.minMbps < safePlaybackMbps) {
        state.statusKind = "warning";
        state.status = t("bestRouteTooSlow", [formatSpeed(winner.minMbps), state.plan.qualityLabel]);
      } else {
        state.statusKind = "success";
        state.status = t("winnerStable", [winner.label, formatSpeed(winner.minMbps)]);
      }
      let decision = null;
      if (automatic) {
        decision = response?.automaticDecision || { host: null, reason: "missing-decision" };
        publishAutoState("decision", {
          currentHost: scanCurrentHost,
          decision,
          signature: scanSignature,
          winnerHost: winner?.host || ""
        });
        if (decision.applied) {
          state.statusKind = "success";
          state.status = t("automaticallyPinned", [winner.label]);
        } else {
          state.statusKind = "idle";
          state.status = t("candidatesTooClose");
        }
      }
      return {
        decision,
        probeSucceeded: usableWinner,
        routeChanged: Boolean(decision?.applied && decision.host && decision.host !== scanCurrentHost)
      };
    } catch (error) {
      appendLog("probe-scan-failed", { mode: state.mode });
      if (automatic) publishAutoState("scan-error", { error: String(error?.message || error) });
      if (isContextInvalidated(error)) {
        markContextInvalidated();
      } else {
        state.statusKind = "error";
        state.status = t("scanFailed", [error?.message || error]);
      }
      return { error, probeSucceeded: false, routeChanged: false };
    } finally {
      state.scanning = false;
      scheduleSnapshot();
    }
  }

  function selectHost(host, options = {}) {
    if (!state.plan?.candidates?.some((candidate) => candidate.host === host)) return;
    const automatic = options.automatic === true;
    state.statusKind = "success";
    state.status = automatic
      ? t("automaticRouteQueued")
      : t("manualRouteQueued");
    scheduleSnapshot();
    post(EVENTS.SELECT_HOST, {
      host,
      quality: state.plan.quality,
      reason: automatic
        ? `automatic-${options.decisionReason || "stability-selection"}`
        : "manual-live-selection",
      signature: state.plan.signature,
      videoKey: state.plan.videoKey
    });
  }

  function setPrefetchEnabled(enabled) {
    const next = enabled === true;
    if (next === state.prefetchEnabled) return;
    state.prefetchEnabled = next;
    state.prefetch = next ? state.prefetch : { ...state.prefetch, segments: [] };
    autoProbe.reset(next ? state.plan?.signature : "");
    appendLog("prefetch-toggle", { enabled: next });
    extensionApi.storage.local.set({ [STORAGE.UI_PREFETCH_ENABLED]: next });
    post(EVENTS.SET_PREFETCH, { enabled: next });
    state.statusKind = next ? "success" : "idle";
    state.status = next ? t("prefetchEnabled") : t("prefetchDisabled");
    scheduleSnapshot();
  }

  function handlePageMessage(event) {
    if (!protocol.isProtocolMessage(event)) return;
    const message = event.data;

    if (message.type === EVENTS.ACTIVITY) {
      let changed = false;
      for (const entry of message.entries || (message.entry ? [message.entry] : [])) {
        changed = addActivity(entry, "page") || changed;
      }
      if (changed) scheduleSnapshot();
      return;
    }

    if (message.type === EVENTS.PROBE_RESULT && typeof message.requestId === "string") {
      const pending = pendingProbeRequests.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingProbeRequests.delete(message.requestId);
        pending.resolve(message.result || { error: t("pageProbeNoResult"), results: [] });
      }
      return;
    }

    if (message.type === EVENTS.CANDIDATES && message.plan) {
      const isNew = state.plan?.signature !== message.plan.signature;
      state.plan = message.plan;
      if (isNew) autoProbe.reset(message.plan.signature);
      state.prefetchEnabled = message.plan.prefetchEnabled === true;
      state.results = isNew ? [] : state.results;
      if (state.scanning && !isNew) return;
      const recoveringFromStall = state.prefetchEnabled && autoProbe.isRecovering();
      state.statusKind = recoveringFromStall ? "warning" : message.plan.preferredHost ? "success" : "idle";
      state.status = recoveringFromStall
        ? t("playbackStalling")
        : message.plan.preferredHost
          ? t("pinnedTo", [message.plan.candidates.find((item) => item.host === message.plan.preferredHost)?.label || message.plan.preferredHost])
          : t("foundRoutes", [message.plan.candidates.length]);
      scheduleSnapshot();
      return;
    }

    if (message.type === EVENTS.PLAN_RESET) {
      autoProbe.reset();
      state.plan = null;
      state.results = [];
      state.prefetch = { backoff: 0, bytes: 0, circuitOpenInMs: 0, failed: 0, foreground: 0, hosts: {}, loading: 0, queued: 0, ready: 0, retrying: 0, segments: [] };
      state.scanning = false;
      state.statusKind = "idle";
      state.status = t("discoveringNewVideo");
      scheduleSnapshot();
      return;
    }

    if (message.type === EVENTS.APPLIED) {
      const selected = state.plan?.candidates?.find((item) => item.host === message.host);
      if (state.plan) {
        const previousHost = state.plan.preferredHost || state.plan.currentPrimary;
        state.plan.currentPrimary = message.host;
        state.plan.preferredHost = message.host;
        if (message.host !== previousHost) autoProbe.noteRouteChange(state.plan.signature);
      }
      state.statusKind = "success";
      state.status = t("selectedNextSegment", [selected?.label || message.host]);
      scheduleSnapshot();
      return;
    }

    if (message.type === EVENTS.ROUTE_COOLDOWN) {
      const failed = state.plan?.candidates?.find((item) => item.host === message.host);
      state.statusKind = "warning";
      state.status = message.cause === "player-timeout"
        ? t("playerRangeTimedOut", [failed?.label || message.host])
        : t("playerRangeNetworkFailure", [failed?.label || message.host]);
      scheduleSnapshot();
      requestRecoveryProbe("route-cooldown");
      return;
    }

    if (message.type === EVENTS.PREFETCH_STATE) {
      state.prefetchEnabled = message.enabled === true;
      state.prefetch = {
        backoff: Number(message.backoff || 0),
        bytes: Number(message.bytes || 0),
        circuitOpenInMs: Number(message.circuitOpenInMs || 0),
        failed: Number(message.failed || 0),
        foreground: Number(message.foreground || 0),
        hosts: message.hosts && typeof message.hosts === "object" ? message.hosts : {},
        loading: Number(message.loading || 0),
        queued: Number(message.queued || 0),
        ready: Number(message.ready || 0),
        retrying: Number(message.retrying || 0),
        segments: Array.isArray(message.segments) ? message.segments : []
      };
      if (message.error) {
        state.statusKind = "warning";
        state.status = t("prefetchUnavailable", [message.error]);
      } else if (message.lastHit) {
        state.statusKind = "success";
        state.status = t("cacheHit", [(Number(message.lastHit.bytes || 0) / 1024 / 1024).toFixed(1)]);
      } else if (message.lastResult) {
        const result = message.lastResult;
        const selected = state.plan?.candidates?.find((item) => item.host === result.host);
        state.statusKind = result.ok ? "success" : "warning";
        state.status = result.ok
          ? t("futureSegmentCached", [selected?.label || result.host || t("currentRoute"), (Number(result.bytes || 0) / 1024 / 1024).toFixed(1)])
          : result.retryExhausted
            ? t("allCdnsFailedTwice")
            : t("allCdnsFailedReprobe", [Math.max(1, Math.ceil(Number(result.reprobeInMs || 0) / 1000))]);
      }
      scheduleSnapshot();
    }
  }

  function monitorPlayback() {
    const video = document.querySelector("video");
    if (video !== monitoredVideo) {
      if (monitoredVideo && monitoredVideoProblemListener) {
        monitoredVideo.removeEventListener("waiting", monitoredVideoProblemListener);
        monitoredVideo.removeEventListener("stalled", monitoredVideoProblemListener);
      }
      monitoredVideo = video || null;
      monitoredVideoProblemListener = null;
      if (monitoredVideo) {
        monitoredVideoProblemListener = (event) => {
          if (!state.prefetchEnabled) return;
          state.statusKind = "warning";
          state.status = t("stallDetected");
          scheduleSnapshot();
          requestRecoveryProbe(event.type);
        };
        monitoredVideo.addEventListener("waiting", monitoredVideoProblemListener);
        monitoredVideo.addEventListener("stalled", monitoredVideoProblemListener);
      }
    }
    maybeAutoOptimize(video);
  }

  function requestRecoveryProbe(reason) {
    if (!state.prefetchEnabled || !state.plan) return;
    if (!autoProbe.signalProblem(state.plan.signature)) return;
    publishAutoState("recovery-requested", { reason, signature: state.plan.signature });
    maybeAutoOptimize();
  }

  function bufferedAhead(video) {
    if (!video?.buffered?.length) return 0;
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
        return Math.max(0, video.buffered.end(index) - video.currentTime);
      }
    }
    return 0;
  }

  function maybeAutoOptimize(video = document.querySelector("video")) {
    if (!state.prefetchEnabled || !state.plan || state.scanning || state.contextInvalidated) return;
    if (state.plan.candidates.length < 2) return;
    const ahead = bufferedAhead(video);
    const token = autoProbe.takeNextProbe({
      media: {
        bufferedAhead: ahead,
        exists: Boolean(video),
        paused: Boolean(video?.paused),
        readyState: Number(video?.readyState || 0)
      },
      now: Date.now()
    });
    if (!token) return;
    publishAutoState("trigger", {
      bufferedAhead: ahead,
      paused: Boolean(video?.paused),
      readyState: Number(video?.readyState || 0),
      signature: token.signature,
      trigger: token.trigger
    });
    runAutomaticProbe(token);
  }

  async function runAutomaticProbe(token) {
    const outcome = await scan("quick", { automatic: true });
    const completion = autoProbe.completeProbe(token, outcome, Date.now());
    publishAutoState("complete", {
      accepted: Boolean(completion),
      probeSucceeded: outcome.probeSucceeded,
      recoveryAttempt: completion?.recoveryAttempt || 0,
      retryAt: completion?.retryAt || 0,
      routeChanged: outcome.routeChanged,
      signature: token.signature,
      trigger: token.trigger
    });
    maybeAutoOptimize();
  }

  function handlePopupCommand(port, message) {
    if (!message || message.channel !== POPUP_CHANNEL) return;
    switch (message.command) {
      case "ready":
        post(EVENTS.UI_READY);
        try {
          portActivityVersion.delete(port);
          sendSnapshot(port);
        } catch {
          popupPorts.delete(port);
        }
        return;
      case "scan":
        scan(message.mode === "deep" ? "deep" : "quick");
        return;
      case "select":
        if (!state.contextInvalidated) selectHost(String(message.host || ""));
        return;
      case "set-prefetch":
        if (!state.contextInvalidated) setPrefetchEnabled(message.enabled === true);
        return;
      case "reload":
        location.reload();
        return;
      default:
        return;
    }
  }

  extensionApi.runtime.onConnect.addListener((port) => {
    if (port?.name !== POPUP_PORT) return;
    popupPorts.add(port);
    port.onDisconnect.addListener(() => {
      popupPorts.delete(port);
    });
    port.onMessage.addListener((message) => handlePopupCommand(port, message));
    try {
      portActivityVersion.delete(port);
      sendSnapshot(port);
    } catch {
      popupPorts.delete(port);
    }
  });

  window.addEventListener("message", handlePageMessage);

  function mount() {
    monitorPlayback();
    setInterval(monitorPlayback, 2000);
    post(EVENTS.UI_READY);
  }

  extensionApi.storage.local.get({
    [STORAGE.UI_PREFETCH_ENABLED]: true
  }).then((stored) => {
    state.prefetchEnabled = stored[STORAGE.UI_PREFETCH_ENABLED] === true;
    post(EVENTS.SET_PREFETCH, { enabled: state.prefetchEnabled });
    scheduleSnapshot();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
