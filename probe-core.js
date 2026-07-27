(function installBiliCdnProbeCore(root) {
  "use strict";

  const core = root.BiliCdnCore;
  if (!core) return;

  const ALLOWED_SUFFIXES = [
    ".bilivideo.com",
    ".bilivideo.cn",
    ".akamaized.net",
    ".gcdn.co",
    ".hdslb.com"
  ];
  const MODES = Object.freeze({
    prefetch: { count: 5, indexTimeoutMs: 3500, sampleBytes: 32 * 1024, timeoutMs: 2500 },
    quick: { positions: [0, 0.5], sampleBytes: 1536 * 1024, timeoutMs: 6000 },
    deep: { positions: [0, 0.25, 0.5, 0.75], sampleBytes: 2 * 1024 * 1024, timeoutMs: 5000 }
  });
  const indexCache = new Map();
  const segmentProbeCache = new Map();

  function now() {
    return typeof root.performance?.now === "function" ? root.performance.now() : Date.now();
  }

  function gap(delayMs = 120) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  function validateCandidate(candidate) {
    try {
      const parsed = new URL(candidate.url);
      const allowed = parsed.protocol === "https:" && ALLOWED_SUFFIXES.some(
        (suffix) => parsed.hostname === suffix.slice(1) || parsed.hostname.endsWith(suffix)
      );
      if (!allowed || parsed.hostname !== candidate.host) return null;
      return {
        ...candidate,
        host: parsed.hostname,
        routeRisk: core.classifyCdnRoute(parsed),
        url: parsed.href
      };
    } catch {
      return null;
    }
  }

  function parseTotalBytes(response) {
    const contentRange = response.headers.get("content-range") || "";
    const rangeMatch = contentRange.match(/\/(\d+)$/);
    if (rangeMatch) return Number(rangeMatch[1]);
    const contentLength = Number(response.headers.get("content-length") || 0);
    return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
  }

  async function readLimitedBody(response, byteLimit) {
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      return Math.min(buffer.byteLength, byteLimit);
    }
    const reader = response.body.getReader();
    let received = 0;
    let completed = false;
    try {
      while (received < byteLimit) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          break;
        }
        received += value?.byteLength || 0;
      }
      const contentLength = Number(response.headers.get("content-length") || 0);
      if ((response.status === 206 && received >= byteLimit) ||
          (contentLength > 0 && received >= contentLength)) {
        completed = true;
      }
    } finally {
      if (!completed) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be closed.
        }
      }
      try { reader.releaseLock?.(); } catch {}
    }
    return received;
  }

  async function probeRange(fetchImpl, url, start, sampleBytes, timeoutMs, position) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("range-timeout"), timeoutMs);
    const startedAt = now();
    try {
      const end = Math.max(start, start + sampleBytes - 1);
      const response = await fetchImpl(url, {
        cache: "no-store",
        credentials: "omit",
        headers: { Range: `bytes=${start}-${end}` },
        priority: "low",
        signal: controller.signal
      });
      const headersAt = now();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const totalBytes = parseTotalBytes(response);
      const bytes = await readLimitedBody(response, sampleBytes);
      const endedAt = now();
      const totalMs = Math.max(1, endedAt - startedAt);
      return {
        bytes,
        mbps: (bytes * 8) / (totalMs / 1000) / 1_000_000,
        ok: bytes > 0,
        position,
        range: `bytes=${start}-${end}`,
        start,
        status: response.status,
        ttfbMs: headersAt - startedAt,
        totalBytes,
        totalMs
      };
    } catch (error) {
      return {
        bytes: 0,
        error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
        mbps: 0,
        ok: false,
        position,
        start,
        ttfbMs: timeoutMs,
        totalBytes: 0,
        totalMs: now() - startedAt
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchIndex(fetchImpl, candidate, segmentBase, timeoutMs) {
    const range = core.parseByteRange(segmentBase?.indexRange);
    if (!range || range.end - range.start + 1 > 256 * 1024) return null;
    const cacheKey = `${candidate.url}|${range.start}-${range.end}`;
    const cached = indexCache.get(cacheKey);
    if (cached) return cached;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("index-timeout"), timeoutMs);
    try {
      const response = await fetchImpl(candidate.url, {
        cache: "no-store",
        credentials: "omit",
        headers: { Range: `bytes=${range.start}-${range.end}` },
        priority: "low",
        signal: controller.signal
      });
      if (response.status !== 206) return null;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== range.end - range.start + 1) return null;
      const index = core.parseSidx(buffer, range.start);
      if (!index?.segments?.length) return null;
      indexCache.set(cacheKey, index);
      return index;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function cachedSegmentProbe(fetchImpl, candidate, segment, config) {
    const range = `bytes=${segment.start}-${segment.end}`;
    const cacheKey = `${candidate.url}|${range}`;
    const cached = segmentProbeCache.get(cacheKey);
    if (cached && Date.now() - cached.testedAt < 60000) return { ...cached.sample, cached: true };
    const sample = {
      ...(await probeRange(
        fetchImpl,
        candidate.url,
        segment.start,
        Math.min(config.sampleBytes, segment.end - segment.start + 1),
        config.timeoutMs,
        segment.startTime
      )),
      endTime: segment.endTime,
      fullRange: range,
      segmentIndex: segment.index,
      startTime: segment.startTime
    };
    if (sample.ok) segmentProbeCache.set(cacheKey, { sample, testedAt: Date.now() });
    while (segmentProbeCache.size > 512) segmentProbeCache.delete(segmentProbeCache.keys().next().value);
    return sample;
  }

  function invalidateSegmentProbe(url, range) {
    segmentProbeCache.delete(`${String(url || "")}|${String(range || "")}`);
  }

  async function planPrefetch(fetchImpl, candidates, message) {
    const config = MODES.prefetch;
    const selectedHost = candidates.some((candidate) => candidate.host === message.currentHost)
      ? message.currentHost
      : candidates[0].host;
    const ordered = core.prioritizeCdnCandidates(candidates, selectedHost);
    let index = null;
    let indexHost = null;
    for (const candidate of ordered) {
      index = await fetchIndex(fetchImpl, candidate, message.segmentBase, config.indexTimeoutMs);
      if (index) {
        indexHost = candidate.host;
        break;
      }
    }
    if (!index) {
      return { error: "Could not read the sidx segment index for the current video", mode: "prefetch", results: [] };
    }

    const count = Math.max(1, Math.min(8, Number(message.count || config.count)));
    const anchorTime = Math.max(Number(message.currentTime || 0), Number(message.bufferedEnd || 0));
    const segments = core.upcomingSegmentsBeyond(index, anchorTime, message.observedRange, count);
    const resultMap = new Map(ordered.map((candidate) => [candidate.host, {
      host: candidate.host,
      isPrimary: Boolean(candidate.isPrimary),
      label: candidate.label || core.cdnLabel(candidate.host),
      mode: "prefetch",
      routeRisk: candidate.routeRisk,
      samples: [],
      testedAt: Date.now()
    }]));
    const assignments = [];
    const unresolved = [];
    const regularCandidates = ordered.filter((candidate) => !core.isDeprioritizedCandidate(candidate));
    const deprioritizedCandidates = ordered.filter(core.isDeprioritizedCandidate);
    for (const segment of segments) {
      const measured = [];
      const measure = async (group) => {
        for (const candidate of group) {
          if (measured.length) await gap(40);
          const sample = await cachedSegmentProbe(fetchImpl, candidate, segment, config);
          resultMap.get(candidate.host).samples.push(sample);
          measured.push({ candidate, sample });
        }
      };
      await measure(regularCandidates.length ? regularCandidates : deprioritizedCandidates);
      if (regularCandidates.length && !measured.some(({ sample }) => sample.ok)) {
        await measure(deprioritizedCandidates);
      }
      const ranked = measured
        .filter(({ sample }) => sample.ok)
        .sort((left, right) =>
          Number(left.sample.totalMs || Infinity) - Number(right.sample.totalMs || Infinity) ||
          Number(left.sample.ttfbMs || Infinity) - Number(right.sample.ttfbMs || Infinity));
      const winner = ranked[0];
      if (!winner) {
        unresolved.push({
          range: `bytes=${segment.start}-${segment.end}`,
          segmentIndex: segment.index,
          startTime: segment.startTime
        });
        continue;
      }
      assignments.push({
        alternativeHosts: [
          ...ranked.slice(1).map(({ candidate }) => candidate.host),
          ...deprioritizedCandidates
            .filter((candidate) => !measured.some((item) => item.candidate.host === candidate.host))
            .map((candidate) => candidate.host)
        ],
        endTime: segment.endTime,
        host: winner.candidate.host,
        index: segment.index,
        label: winner.candidate.label || core.cdnLabel(winner.candidate.host),
        probeMbps: Number(winner.sample.mbps || 0),
        probeMs: Number(winner.sample.totalMs || 0),
        range: `bytes=${segment.start}-${segment.end}`,
        startTime: segment.startTime
      });
    }
    return {
      indexHost,
      mode: "prefetch",
      observedRange: String(message.observedRange || ""),
      results: [...resultMap.values()].map(core.scoreProbeResult),
      selectedHost,
      segments: assignments,
      unresolved
    };
  }

  function failedSample(first, error, position, totalBytes, extra = {}) {
    return {
      bytes: 0,
      error,
      mbps: 0,
      ok: false,
      position,
      start: 0,
      ttfbMs: 0,
      totalBytes,
      ...extra
    };
  }

  async function probeCandidate(fetchImpl, candidate, mode) {
    const config = MODES[mode] || MODES.quick;
    const first = await probeRange(fetchImpl, candidate.url, 0, config.sampleBytes, config.timeoutMs, 0);
    const totalBytes = first.totalBytes || 0;
    const samples = [first];
    let consecutiveFailures = first.ok ? 0 : 1;
    for (const position of config.positions.slice(1)) {
      if (!(totalBytes > config.sampleBytes && first.ok)) {
        samples.push(failedSample(first, first.ok ? "size-unavailable" : "initial-probe-failed", position, totalBytes));
        continue;
      }
      if (mode === "deep" && consecutiveFailures >= 2) {
        samples.push(failedSample(first, "consecutive-failures-skipped", position, totalBytes));
        continue;
      }
      await gap();
      const rawStart = Math.floor(totalBytes * position);
      const start = Math.min(rawStart, Math.max(0, totalBytes - config.sampleBytes));
      const sample = await probeRange(fetchImpl, candidate.url, start, config.sampleBytes, config.timeoutMs, position);
      samples.push(sample);
      consecutiveFailures = sample.ok ? 0 : consecutiveFailures + 1;
    }
    return {
      host: candidate.host,
      isPrimary: Boolean(candidate.isPrimary),
      label: candidate.label || core.cdnLabel(candidate.host),
      mode,
      routeRisk: candidate.routeRisk,
      samples,
      testedAt: Date.now(),
      totalBytes
    };
  }

  async function runProbe(message, fetchImpl = root.fetch?.bind(root), onEvent) {
    const emit = (type, detail) => {
      try { onEvent?.(type, detail); } catch {}
    };
    const mode = message.mode === "deep"
      ? "deep"
      : message.mode === "prefetch"
        ? "prefetch"
        : "quick";
    const candidates = core.prioritizeCdnCandidates(
      (Array.isArray(message.candidates) ? message.candidates : [])
      .map(validateCandidate)
      .filter(Boolean)
      .filter((candidate, index, values) => values.findIndex((item) => item.host === candidate.host) === index),
      message.currentHost
    );
    if (typeof fetchImpl !== "function") return { error: "Page fetch is unavailable.", mode, results: [] };
    if (!candidates.length) return { error: "No supported CDN candidates were found.", mode, results: [] };

    if (mode === "prefetch") return planPrefetch(fetchImpl, candidates, message);

    const rawResults = [];
    for (const candidate of candidates) {
      if (rawResults.length) await gap(200);
      emit("probe-candidate-start", {
        host: candidate.host,
        label: candidate.label || core.cdnLabel(candidate.host),
        mode,
        positions: MODES[mode]?.positions || []
      });
      rawResults.push(await probeCandidate(fetchImpl, candidate, mode));
    }
    const results = core.rankProbeResults(rawResults);
    for (const result of results) {
      emit("probe-candidate-result", {
        failures: result.failures,
        host: result.host,
        label: result.label,
        minMbps: result.minMbps,
        mode,
        samples: result.samples.map((sample) => ({
          error: sample.error || "",
          mbps: sample.mbps,
          ok: sample.ok,
          position: sample.position,
          status: sample.status || 0,
          totalMs: sample.totalMs
        }))
      });
    }
    return { mode, results };
  }

  root.BiliCdnProbeCore = Object.freeze({ MODES, invalidateSegmentProbe, runProbe });
})(globalThis);
