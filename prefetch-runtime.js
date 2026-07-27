(function installBiliCdnPrefetchRuntime(root) {
  "use strict";

  const PREFETCH_CACHE_TTL_MS = 5 * 60 * 1000;
  const PREFETCH_TIMEOUT_MS = 60 * 1000;
  const PREFETCH_REPROBE_BASE_MS = 2 * 1000;
  const PREFETCH_REPROBE_MAX_MS = 15 * 1000;
  const PREFETCH_CIRCUIT_BREAK_MS = 60 * 1000;
  const PREFETCH_PROMOTION_WAIT_MS = 1200;
  const PREFETCH_MAX_FAILURE_CYCLES = 2;
  const PREFETCH_CIRCUIT_FAILURE_THRESHOLD = 2;
  const MAX_PREFETCH_SEGMENT_BYTES = 32 * 1024 * 1024;
  const MAX_PREFETCH_TOTAL_BYTES = 96 * 1024 * 1024;
  const PREFETCH_CONCURRENCY = 1;
  const PREFETCH_MAX_WINDOW_SIZE = 8;
  const PREFETCH_PUMP_RETRY_MS = 750;

  function createPrefetchRuntime(options = {}) {
    const {
      core,
      fetchImpl,
      getActivePlan,
      getPreferredHost,
      isEnabled,
      policyCore,
      postState,
      probeCore,
      storeCore,
      traceEvent
    } = options;
    if (!core || !fetchImpl || !policyCore || !probeCore || !storeCore) return null;

    const now = typeof options.now === "function"
      ? options.now
      : () => typeof performance?.now === "function" ? performance.now() : Date.now();
    const prefetchTimeoutMs = Number.isFinite(options.prefetchTimeoutMs)
      ? Math.max(1, Number(options.prefetchTimeoutMs))
      : PREFETCH_TIMEOUT_MS;
    const reprobeBaseMs = Number.isFinite(options.reprobeBaseMs)
      ? Math.max(1, Number(options.reprobeBaseMs))
      : PREFETCH_REPROBE_BASE_MS;
    const reprobeMaxMs = Number.isFinite(options.reprobeMaxMs)
      ? Math.max(reprobeBaseMs, Number(options.reprobeMaxMs))
      : PREFETCH_REPROBE_MAX_MS;
    const circuitBreakMs = Number.isFinite(options.circuitBreakMs)
      ? Math.max(1, Number(options.circuitBreakMs))
      : PREFETCH_CIRCUIT_BREAK_MS;
    const circuitFailureThreshold = Number.isFinite(options.circuitFailureThreshold)
      ? Math.max(1, Math.floor(Number(options.circuitFailureThreshold)))
      : PREFETCH_CIRCUIT_FAILURE_THRESHOLD;
    const maxFailureCycles = Number.isFinite(options.maxFailureCycles)
      ? Math.max(1, Math.floor(Number(options.maxFailureCycles)))
      : PREFETCH_MAX_FAILURE_CYCLES;
    const promotionWaitMs = Number.isFinite(options.promotionWaitMs)
      ? Math.max(1, Number(options.promotionWaitMs))
      : PREFETCH_PROMOTION_WAIT_MS;
    const wallNow = typeof options.wallNow === "function" ? options.wallNow : Date.now;
    const prefetchStore = storeCore.createPrefetchStore({
      core,
      maxSegmentBytes: MAX_PREFETCH_SEGMENT_BYTES,
      maxTotalBytes: MAX_PREFETCH_TOTAL_BYTES,
      ttlMs: PREFETCH_CACHE_TTL_MS
    });
    if (!prefetchStore) return null;

    const queue = [];
    let activePlaybackRequests = 0;
    let activePrefetches = 0;
    let circuitOpenUntil = 0;
    let consecutiveFullFailures = 0;
    let generation = 0;
    let lastObservedVideoRange = "";
    let lastYieldReason = "";
    let pumpTimer = 0;
    let windowRunning = false;
    let windowTimer = 0;

    function activePlan() {
      return typeof getActivePlan === "function" ? getActivePlan() : null;
    }

    function enabled() {
      return typeof isEnabled === "function" && isEnabled();
    }

    function preferredHost(plan) {
      return typeof getPreferredHost === "function" ? getPreferredHost(plan) : null;
    }

    function trace(type, detail = {}) {
      if (typeof traceEvent === "function") traceEvent(type, detail);
    }

    function parseResponseTotal(response) {
      const contentRange = response?.headers?.get?.("content-range") || "";
      const match = contentRange.match(/\/(\d+)$/);
      return match ? Number(match[1]) : 0;
    }

    function publish(detail = {}) {
      if (typeof postState !== "function") return;
      const plan = activePlan();
      postState({
        enabled: enabled(),
        playbackHost: plan ? (preferredHost(plan) || plan.currentPrimary || "") : "",
        strategy: "ranked-cdn-per-segment",
        circuitOpenInMs: Math.max(0, circuitOpenUntil - wallNow()),
        ...prefetchStore.snapshot(plan?.signature),
        ...detail
      });
    }

    function clear() {
      clearTimeout(windowTimer);
      clearTimeout(pumpTimer);
      generation += 1;
      circuitOpenUntil = 0;
      consecutiveFullFailures = 0;
      queue.splice(0);
      prefetchStore.clear("track-changed");
      lastObservedVideoRange = "";
      publish({ reason: "cleared" });
    }

    function traceRemoved(entries, reason) {
      for (const entry of entries) {
        trace("segment-prefetch-cancelled", {
          host: entry.host,
          index: entry.index,
          label: core.cdnLabel(entry.host),
          range: entry.rangeText,
          reason
        });
      }
    }

    function removeDeletedFromQueue() {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const entry = queue[index];
        if (!entry || prefetchStore.get(entry.key) !== entry) queue.splice(index, 1);
      }
    }

    function cancelPending(reason) {
      clearTimeout(windowTimer);
      clearTimeout(pumpTimer);
      const removed = prefetchStore.cancelPending(String(reason || "playback-priority"));
      removeDeletedFromQueue();
      traceRemoved(removed, reason);
      if (removed.length) publish({ reason: String(reason || "playback-priority") });
      return removed.length > 0;
    }

    function cancelBackground(reason) {
      clearTimeout(pumpTimer);
      const removed = prefetchStore.cancelBackground(String(reason || "playback-priority"));
      removeDeletedFromQueue();
      traceRemoved(removed, reason);
      if (removed.length) publish({ reason: String(reason || "playback-priority") });
      return removed.length > 0;
    }

    function pageBufferedAhead(video) {
      if (!video || !video.buffered?.length) return 0;
      const currentTime = Number(video.currentTime || 0);
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.buffered.start(index) <= currentTime && video.buffered.end(index) >= currentTime) {
          return Math.max(0, video.buffered.end(index) - currentTime);
        }
      }
      return 0;
    }

    function pageBufferedEnd(video) {
      if (!video || !video.buffered?.length) return Number(video?.currentTime || 0);
      const currentTime = Number(video.currentTime || 0);
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.buffered.start(index) <= currentTime && video.buffered.end(index) >= currentTime) {
          return Number(video.buffered.end(index) || currentTime);
        }
      }
      return currentTime;
    }

    function headroom(video = document.querySelector("video")) {
      return policyCore.evaluatePrefetchHeadroom({
        bufferedAhead: pageBufferedAhead(video)
      });
    }

    function schedulePump(delayMs = PREFETCH_PUMP_RETRY_MS) {
      clearTimeout(pumpTimer);
      if (!enabled() || !queue.length) return;
      pumpTimer = setTimeout(pumpQueue, Math.max(0, Number(delayMs) || 0));
    }

    function nextQueueIndex() {
      const foregroundIndex = queue.findIndex((entry) => entry?.foreground);
      return foregroundIndex >= 0 ? foregroundIndex : 0;
    }

    async function runSegment(entry) {
      const entryGeneration = entry.generation;
      try {
        let lastError = null;
        const hosts = Array.isArray(entry.hosts) ? [...entry.hosts] : [];
        for (let attempt = 0; attempt < hosts.length; attempt += 1) {
          const host = hosts[attempt];
          const url = entry.urls?.[host];
          if (!url || entryGeneration !== generation || entry.cancelReason || prefetchStore.get(entry.key) !== entry) return;
          if (!prefetchStore.markAttempt(entry, host, attempt + 1)) return;
          const controller = new AbortController();
          entry.controller = controller;
          const timeout = setTimeout(() => controller.abort("prefetch-timeout"), prefetchTimeoutMs);
          const startedAt = now();
          const lifecycle = attempt === 0 ? "segment-prefetch-start" : "segment-prefetch-retry-start";
          trace(lifecycle, {
            attempt: attempt + 1,
            candidateCount: hosts.length,
            foreground: Boolean(entry.foreground),
            host,
            index: entry.index,
            label: core.cdnLabel(host),
            range: entry.rangeText,
            size: entry.range.end - entry.range.start + 1
          });
          publish({ reason: attempt === 0 ? "segment-downloading" : "segment-retrying" });
          try {
            const response = await fetchImpl(url, {
              cache: "no-store",
              credentials: "omit",
              headers: { Range: entry.rangeText },
              priority: entry.foreground ? "high" : "low",
              signal: controller.signal
            });
            if (response.status !== 206) throw new Error(`HTTP ${response.status}`);
            const buffer = await response.arrayBuffer();
            const expectedBytes = entry.range.end - entry.range.start + 1;
            if (buffer.byteLength !== expectedBytes) {
              throw new Error(`truncated ${buffer.byteLength}/${expectedBytes}`);
            }
            if (entryGeneration !== generation || entry.expiresAt <= Date.now() ||
                prefetchStore.get(entry.key) !== entry) return;
            prefetchStore.markReady(entry, {
              buffer,
              contentType: response.headers.get("content-type") || "video/mp4",
              totalBytes: parseResponseTotal(response),
              url
            });
            consecutiveFullFailures = 0;
            circuitOpenUntil = 0;
            trace("segment-prefetch-ready", {
              attempt: attempt + 1,
              bytes: buffer.byteLength,
              candidateCount: hosts.length,
              durationMs: Math.round((now() - startedAt) * 10) / 10,
              host,
              index: entry.index,
              label: core.cdnLabel(host),
              range: entry.rangeText
            });
            prefetchStore.trim();
            publish({ lastResult: { bytes: buffer.byteLength, host, ok: true, range: entry.rangeText } });
            return;
          } catch (error) {
            lastError = error;
            entry.error = String(error?.message || error);
            probeCore.invalidateSegmentProbe?.(url, entry.rangeText);
            if (entryGeneration !== generation || entry.cancelReason || prefetchStore.get(entry.key) !== entry) return;
            if (attempt + 1 < hosts.length) {
              trace("segment-prefetch-retry", {
                attempt: attempt + 1,
                candidateCount: hosts.length,
                error: entry.error,
                fromHost: host,
                fromLabel: core.cdnLabel(host),
                index: entry.index,
                range: entry.rangeText,
                toHost: hosts[attempt + 1],
                toLabel: core.cdnLabel(hosts[attempt + 1])
              });
            }
          } finally {
            clearTimeout(timeout);
            if (entry.controller === controller) entry.controller = null;
          }
        }

        if (entryGeneration !== generation || entry.cancelReason || prefetchStore.get(entry.key) !== entry) return;
        const failureCycles = Number(entry.failureCycles || 0);
        const nextFailureCycle = failureCycles + 1;
        const retryExhausted = nextFailureCycle >= maxFailureCycles;
        const backoffMs = Math.min(reprobeMaxMs, reprobeBaseMs * (2 ** failureCycles));
        const error = String(lastError?.message || lastError || "all candidate CDNs failed");
        consecutiveFullFailures += 1;
        if (consecutiveFullFailures >= circuitFailureThreshold) {
          circuitOpenUntil = Math.max(circuitOpenUntil, wallNow() + circuitBreakMs);
        }
        if (retryExhausted) prefetchStore.markFailed(entry, { error });
        else prefetchStore.markBackoff(entry, { error, nextProbeAt: wallNow() + backoffMs });
        trace(retryExhausted ? "segment-prefetch-failed" : "segment-prefetch-backoff", {
          attemptedHosts: [...entry.attemptedHosts],
          backoffMs,
          failureCycle: nextFailureCycle,
          error,
          index: entry.index,
          range: entry.rangeText,
          retryExhausted
        });
        publish({
          lastResult: {
            attemptedHosts: [...entry.attemptedHosts],
            error,
            ok: false,
            range: entry.rangeText,
            reprobeInMs: retryExhausted ? 0 : backoffMs,
            retryExhausted
          },
          reason: retryExhausted ? "segment-failed" : "segment-backoff"
        });
        if (!retryExhausted) scheduleWindow(Math.max(backoffMs, circuitOpenUntil - wallNow()) + 10);
      } finally {
        activePrefetches = Math.max(0, activePrefetches - 1);
        pumpQueue();
      }
    }

    function pumpQueue() {
      removeDeletedFromQueue();
      if (!queue.length || activePrefetches >= PREFETCH_CONCURRENCY) return;
      const index = nextQueueIndex();
      const entry = queue[index];
      const foreground = Boolean(entry?.foreground);
      if (!foreground) {
        const circuitRemaining = circuitOpenUntil - wallNow();
        if (circuitRemaining > 0) {
          publish({ reason: "prefetch-circuit-open" });
          schedulePump(circuitRemaining + 10);
          return;
        }
        const decision = headroom();
        if (!decision.allowed) {
          if (lastYieldReason !== decision.reason) {
            lastYieldReason = decision.reason;
            publish({ reason: decision.reason });
          }
          schedulePump();
          return;
        }
      }
      lastYieldReason = "";
      queue.splice(index, 1);
      if (!entry || prefetchStore.get(entry.key) !== entry ||
          entry.generation !== generation || entry.expiresAt <= Date.now()) {
        pumpQueue();
        return;
      }
      activePrefetches += 1;
      runSegment(entry);
    }

    function reconcileWindow(plan, segments) {
      prefetchStore.reconcile(plan.signature, segments);
      removeDeletedFromQueue();
    }

    function enqueue(plan, assignment) {
      if (!enabled()) return false;
      const ensured = prefetchStore.ensure(plan, assignment, generation);
      if (!ensured) return false;
      if (ensured.created || ensured.reactivated) queue.push(ensured.entry);
      return ensured.created || ensured.reactivated;
    }

    function scheduleWindow(delayMs = 800) {
      clearTimeout(windowTimer);
      if (!enabled() || !activePlan()) return;
      windowTimer = setTimeout(runWindow, Math.max(0, Number(delayMs) || 0));
    }

    async function runWindow() {
      const plan = activePlan();
      if (windowRunning || !enabled() || !plan) return;
      const video = document.querySelector("video");
      const circuitRemaining = circuitOpenUntil - wallNow();
      if (circuitRemaining > 0) {
        publish({ reason: "prefetch-circuit-open" });
        scheduleWindow(circuitRemaining + 10);
        return;
      }
      const decision = headroom(video);
      if (!decision.allowed) {
        publish({ reason: decision.reason });
        scheduleWindow(2000);
        return;
      }
      const ahead = pageBufferedAhead(video);
      if (!plan.segmentBase) {
        publish({ reason: "sidx-unavailable" });
        return;
      }

      windowRunning = true;
      const playbackHost = preferredHost(plan) || plan.currentPrimary;
      trace("prefetch-window-plan", {
        bufferedAhead: Math.round(ahead * 10) / 10,
        candidateCount: Number(plan.candidates?.length || 0),
        playbackHost,
        observedRange: lastObservedVideoRange
      });
      try {
        const result = await probeCore.runProbe({
          bufferedEnd: pageBufferedEnd(video),
          candidates: plan.candidates,
          count: Math.min(PREFETCH_MAX_WINDOW_SIZE, decision.count),
          currentHost: playbackHost,
          currentTime: Number(video.currentTime || 0),
          mode: "prefetch",
          observedRange: lastObservedVideoRange,
          segmentBase: plan.segmentBase
        }, fetchImpl);
        if (activePlan()?.signature !== plan.signature || !enabled()) return;
        if (result?.error) {
          publish({ error: result.error, reason: "index-failed" });
          scheduleWindow(reprobeMaxMs);
          return;
        }
        const plannedSegments = Array.isArray(result?.segments)
          ? result.segments.slice(0, Math.min(PREFETCH_MAX_WINDOW_SIZE, decision.count))
          : [];
        const observedAfterPlanning = lastObservedVideoRange;
        const bufferedEndAfterPlanning = pageBufferedEnd(video);
        const segments = core.filterSegmentsBeyond(
          plannedSegments,
          bufferedEndAfterPlanning,
          observedAfterPlanning
        );
        const staleCount = plannedSegments.length - segments.length;
        if (staleCount > 0) {
          trace("prefetch-window-stale", {
            bufferedEndAfterPlanning,
            dropped: staleCount,
            observedAfterPlanning,
            observedAtStart: result?.observedRange || ""
          });
        }
        reconcileWindow(plan, segments);
        let accepted = 0;
        for (const segment of segments) {
          if (enqueue(plan, segment)) accepted += 1;
        }
        const assignments = segments.map(({ alternativeHosts, host, index, probeMbps, probeMs, range }) => ({
          alternativeHosts: Array.isArray(alternativeHosts) ? [...alternativeHosts] : [],
          host,
          index,
          probeMbps,
          probeMs,
          range
        }));
        const unresolved = Array.isArray(result?.unresolved) ? result.unresolved.length : 0;
        publish({
          assignments,
          planned: segments.length,
          reason: segments.length ? "window-planned" : "video-end",
          unresolved
        });
        pumpQueue();
        trace("prefetch-window-ready", {
          accepted,
          assignments,
          candidateCount: Number(plan.candidates?.length || 0),
          playbackHost,
          planned: segments.length,
          unresolved
        });
        if (staleCount > 0) scheduleWindow(250);
        else if (unresolved > 0) scheduleWindow(reprobeBaseMs);
      } catch (error) {
        publish({ error: String(error?.message || error), reason: "plan-failed" });
        scheduleWindow(reprobeMaxMs);
      } finally {
        windowRunning = false;
      }
    }

    function promotePlaybackRange(range) {
      const plan = activePlan();
      if (!enabled() || !plan?.signature) return null;
      const pending = prefetchStore.pendingCoverage(plan.signature, range);
      if (!pending) return null;
      for (const entry of pending.entries) entry.foreground = true;
      const removed = prefetchStore.cancelPendingExcept(plan.signature, range, "player-range-priority");
      removeDeletedFromQueue();
      traceRemoved(removed, "player-range-priority");
      trace("segment-prefetch-promoted", {
        entries: pending.entries.map((entry) => ({ host: entry.host, range: entry.rangeText, state: entry.state })),
        range: String(range || "")
      });
      publish({ promotedRange: String(range || ""), reason: "player-range-promoted" });
      pumpQueue();
      return new Promise((resolve) => {
        let settled = false;
        let deadline = 0;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve(value || null);
        };
        deadline = setTimeout(() => {
          const timedOut = prefetchStore.cancelCoverage(
            plan.signature,
            range,
            "player-promotion-deadline"
          );
          removeDeletedFromQueue();
          traceRemoved(timedOut, "player-promotion-deadline");
          trace("segment-prefetch-promotion-deadline", {
            range: String(range || ""),
            waitMs: promotionWaitMs
          });
          publish({ reason: "player-promotion-deadline" });
          finish(null);
        }, promotionWaitMs);
        pending.promise.then(finish, () => finish(null));
      });
    }

    function beginPlaybackRequest(transport, range) {
      activePlaybackRequests += 1;
      trace("playback-request-start", { activePlaybackRequests, range: String(range || ""), transport });
    }

    function endPlaybackRequest(transport, range) {
      activePlaybackRequests = Math.max(0, activePlaybackRequests - 1);
      trace("playback-request-end", { activePlaybackRequests, range: String(range || ""), transport });
      scheduleWindow(0);
    }

    function observeVideoRange(range, delayMs = null) {
      lastObservedVideoRange = String(range || "");
      if (Number.isFinite(delayMs)) scheduleWindow(delayMs);
    }

    return Object.freeze({
      beginPlaybackRequest,
      cancelBackground,
      cancelPending,
      clear,
      endPlaybackRequest,
      headroom,
      observeVideoRange,
      promotePlaybackRange,
      publish,
      scheduleWindow,
      store: prefetchStore
    });
  }

  root.BiliCdnPrefetchRuntime = Object.freeze({ createPrefetchRuntime });
})(globalThis);
