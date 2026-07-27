(function installBiliCdnPrefetchStore(root) {
  "use strict";

  function createDeferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve, settled: false };
  }

  function createPrefetchStore({ core, maxSegmentBytes, maxTotalBytes, ttlMs }) {
    if (!core?.parseByteRange || !core?.byteRangesOverlap) return null;
    const entries = new Map();
    const activeStates = new Set(["queued", "loading", "retrying"]);

    function settle(entry, value) {
      if (!entry?.completion || entry.completion.settled) return;
      entry.completion.settled = true;
      entry.completion.resolve(value);
    }

    function resetCompletion(entry) {
      settle(entry, null);
      entry.completion = createDeferred();
    }

    function deleteEntry(key, reason = "") {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.state !== "ready") {
        entry.cancelReason = reason || entry.cancelReason || "removed";
        try { entry.controller?.abort(entry.cancelReason); } catch {}
        settle(entry, null);
      }
      entries.delete(key);
      return entry;
    }

    function trim(now = Date.now()) {
      let totalBytes = 0;
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) {
          deleteEntry(key, "expired");
          continue;
        }
        if (entry.state === "ready") totalBytes += Number(entry.buffer?.byteLength || 0);
      }
      if (totalBytes <= maxTotalBytes) return;
      for (const [key, entry] of entries) {
        if (entry.state !== "ready") continue;
        totalBytes -= Number(entry.buffer?.byteLength || 0);
        entries.delete(key);
        if (totalBytes <= maxTotalBytes) break;
      }
    }

    function clear(reason = "cleared") {
      for (const key of [...entries.keys()]) deleteEntry(key, reason);
    }

    function cancelWhere(predicate, reason) {
      const removed = [];
      for (const [key, entry] of entries) {
        if (entry.state === "ready" || !predicate(entry)) continue;
        const deleted = deleteEntry(key, reason);
        if (deleted) removed.push(deleted);
      }
      return removed;
    }

    function cancelPending(reason = "playback-priority") {
      return cancelWhere(() => true, reason);
    }

    function cancelBackground(reason = "playback-priority") {
      return cancelWhere((entry) => activeStates.has(entry.state) && !entry.foreground, reason);
    }

    function cancelPendingExcept(signature, rangeText, reason = "player-range-priority") {
      const requested = core.parseByteRange(rangeText);
      return cancelWhere((entry) => activeStates.has(entry.state) && !(
        requested &&
        entry.signature === signature &&
        core.byteRangesOverlap(requested, entry.range)
      ), reason);
    }

    function cancelCoverage(signature, rangeText, reason = "player-promotion-deadline") {
      const requested = core.parseByteRange(rangeText);
      if (!requested) return [];
      return cancelWhere((entry) => (
        activeStates.has(entry.state) &&
        entry.signature === signature &&
        core.byteRangesOverlap(requested, entry.range)
      ), reason);
    }

    function coverageEntries(signature, rangeText, allowedStates) {
      trim();
      const requested = core.parseByteRange(rangeText);
      if (!signature || !requested) return null;
      const candidates = [...entries.values()]
        .filter((entry) => allowedStates.has(entry.state) && entry.signature === signature &&
          core.byteRangesOverlap(requested, entry.range))
        .sort((left, right) => left.range.start - right.range.start || right.range.end - left.range.end);
      if (!candidates.length) return null;

      const selected = [];
      let cursor = requested.start;
      while (cursor <= requested.end) {
        const covering = candidates
          .filter((entry) => entry.range.start <= cursor && entry.range.end >= cursor)
          .sort((left, right) => right.range.end - left.range.end)[0];
        if (!covering) return null;
        selected.push(covering);
        cursor = Math.min(requested.end, covering.range.end) + 1;
      }
      return [...new Map(selected.map((entry) => [entry.key, entry])).values()];
    }

    function assemble(signature, rangeText) {
      const requested = core.parseByteRange(rangeText);
      const candidates = coverageEntries(signature, rangeText, new Set(["ready"]));
      if (!requested || !candidates?.length) return null;

      const pieces = [];
      let cursor = requested.start;
      while (cursor <= requested.end) {
        const covering = candidates
          .filter((entry) => entry.range.start <= cursor && entry.range.end >= cursor)
          .sort((left, right) => right.range.end - left.range.end)[0];
        if (!covering) return null;
        const end = Math.min(requested.end, covering.range.end);
        pieces.push({ end, entry: covering, start: cursor });
        cursor = end + 1;
      }

      const totals = new Set(pieces.map(({ entry }) => Number(entry.totalBytes || 0)).filter(Boolean));
      if (totals.size > 1) return null;
      const expectedBytes = requested.end - requested.start + 1;
      const output = new Uint8Array(expectedBytes);
      let outputOffset = 0;
      for (const piece of pieces) {
        const inputOffset = piece.start - piece.entry.range.start;
        const length = piece.end - piece.start + 1;
        output.set(new Uint8Array(piece.entry.buffer, inputOffset, length), outputOffset);
        outputOffset += length;
      }
      if (outputOffset !== expectedBytes) return null;
      const totalBytes = [...totals][0] || 0;
      return {
        buffer: output.buffer,
        cacheHosts: [...new Set(pieces.map(({ entry }) => entry.host))],
        cacheKeys: [...new Set(pieces.map(({ entry }) => entry.key))],
        headers: {
          "content-length": String(expectedBytes),
          "content-range": totalBytes
            ? `bytes ${requested.start}-${requested.end}/${totalBytes}`
            : `bytes ${requested.start}-${requested.end}/*`,
          "content-type": pieces[0].entry.contentType || "video/mp4"
        },
        protectedRanges: [...new Set(pieces.map(({ entry }) => entry.rangeText))],
        responseURL: pieces[0].entry.url,
        status: 206,
        statusText: "Partial Content"
      };
    }

    function pendingCoverage(signature, rangeText) {
      const pendingStates = new Set(["queued", "loading", "retrying", "ready"]);
      const covered = coverageEntries(signature, rangeText, pendingStates);
      if (!covered?.some((entry) => entry.state !== "ready")) return null;
      return {
        entries: covered,
        promise: Promise.all(covered.map((entry) => entry.completion.promise))
          .then((results) => results.every(Boolean) ? assemble(signature, rangeText) : null)
      };
    }

    function consume(keys) {
      for (const key of Array.isArray(keys) ? keys : []) entries.delete(key);
    }

    function segmentSnapshot(entry, now) {
      return {
        attempt: Number(entry.attempt || 0),
        attemptedHosts: [...(entry.attemptedHosts || [])],
        bytes: Number(entry.buffer?.byteLength || 0),
        candidateHosts: [...(entry.hosts || [])],
        error: entry.error || "",
        foreground: Boolean(entry.foreground),
        host: entry.host,
        index: entry.index,
        nextProbeInMs: entry.state === "backoff" ? Math.max(0, Number(entry.nextProbeAt || 0) - now) : 0,
        probeMbps: Number(entry.probeMbps || 0),
        range: entry.rangeText,
        state: entry.state,
        totalCandidates: Number(entry.hosts?.length || 0)
      };
    }

    function snapshot(signature, now = Date.now()) {
      trim(now);
      const result = {
        backoff: 0,
        bytes: 0,
        failed: 0,
        foreground: 0,
        hosts: {},
        loading: 0,
        queued: 0,
        ready: 0,
        retrying: 0,
        segments: []
      };
      for (const entry of entries.values()) {
        if (entry.signature !== signature) continue;
        result.segments.push(segmentSnapshot(entry, now));
        if (entry.foreground && entry.state !== "ready") result.foreground += 1;
        if (entry.state === "ready") {
          result.ready += 1;
          result.bytes += Number(entry.buffer?.byteLength || 0);
          result.hosts[entry.host] = Number(result.hosts[entry.host] || 0) + 1;
        } else if (entry.state === "loading") result.loading += 1;
        else if (entry.state === "retrying") result.retrying += 1;
        else if (entry.state === "backoff") result.backoff += 1;
        else if (entry.state === "failed") result.failed += 1;
        else if (entry.state === "queued") result.queued += 1;
      }
      result.segments.sort((left, right) => {
        const leftRange = core.parseByteRange(left.range);
        const rightRange = core.parseByteRange(right.range);
        return Number(leftRange?.start || 0) - Number(rightRange?.start || 0);
      });
      return result;
    }

    function reconcile(signature, assignments) {
      const desired = new Map((Array.isArray(assignments) ? assignments : []).map((assignment) => [
        `${signature}|${String(assignment?.range || "")}`,
        new Set([assignment?.host, ...(Array.isArray(assignment?.alternativeHosts) ? assignment.alternativeHosts : [])].filter(Boolean))
      ]));
      for (const [key, entry] of entries) {
        if (entry.signature !== signature) continue;
        if (entry.state === "ready") continue;
        if (entry.foreground) continue;
        const allowed = desired.get(key);
        if (allowed?.has(entry.host)) continue;
        deleteEntry(key, "window-shifted");
      }
    }

    function rankedHosts(plan, assignment) {
      const allowedHosts = new Set((plan?.candidates || []).map((item) => item.host));
      return [assignment?.host, ...(Array.isArray(assignment?.alternativeHosts) ? assignment.alternativeHosts : [])]
        .filter((value, index, values) => value && values.indexOf(value) === index && allowedHosts.has(value));
    }

    function refreshAssignment(entry, plan, assignment, generation) {
      const hosts = rankedHosts(plan, assignment);
      entry.generation = generation;
      entry.hosts = hosts;
      entry.host = hosts[0];
      entry.index = assignment?.index;
      entry.probeMbps = Number(assignment?.probeMbps || 0);
      entry.urls = Object.fromEntries((plan?.candidates || []).map((item) => [item.host, item.url]));
      entry.url = entry.urls?.[entry.host] || "";
      entry.expiresAt = Date.now() + ttlMs;
    }

    function ensure(plan, assignment, generation) {
      const rangeText = String(assignment?.range || "");
      const range = core.parseByteRange(rangeText);
      const hosts = rankedHosts(plan, assignment);
      const size = range ? range.end - range.start + 1 : 0;
      if (!hosts.length || !range || size <= 0 || size > maxSegmentBytes) return null;
      const key = `${plan.signature}|${rangeText}`;
      const existing = entries.get(key);
      if (existing) {
        existing.expiresAt = Date.now() + ttlMs;
        if (existing.state === "backoff" && Date.now() >= Number(existing.nextProbeAt || 0)) {
          refreshAssignment(existing, plan, assignment, generation);
          existing.attempt = 0;
          existing.attemptedHosts = [];
          existing.cancelReason = "";
          existing.controller = null;
          existing.error = "";
          existing.foreground = false;
          existing.state = "queued";
          resetCompletion(existing);
          return { created: false, entry: existing, reactivated: true };
        }
        return { created: false, entry: existing, reactivated: false };
      }
      const completion = createDeferred();
      const entry = {
        attempt: 0,
        attemptedHosts: [],
        cancelReason: "",
        completion,
        controller: null,
        error: "",
        expiresAt: Date.now() + ttlMs,
        failureCycles: 0,
        foreground: false,
        generation,
        host: hosts[0],
        hosts,
        index: assignment?.index,
        key,
        nextProbeAt: 0,
        probeMbps: Number(assignment?.probeMbps || 0),
        range,
        rangeText,
        signature: plan.signature,
        state: "queued",
        url: plan.candidates.find((item) => item.host === hosts[0])?.url || "",
        urls: Object.fromEntries((plan.candidates || []).map((item) => [item.host, item.url]))
      };
      entries.set(key, entry);
      return { created: true, entry, reactivated: false };
    }

    function markAttempt(entry, host, attempt) {
      if (!entry || !entries.has(entry.key)) return false;
      entry.attempt = attempt;
      entry.attemptedHosts.push(host);
      entry.controller = null;
      entry.error = "";
      entry.host = host;
      entry.state = attempt > 1 ? "retrying" : "loading";
      entry.url = entry.urls?.[host] || "";
      return true;
    }

    function markReady(entry, detail = {}) {
      if (!entry || !entries.has(entry.key)) return false;
      Object.assign(entry, detail, {
        controller: null,
        error: "",
        foreground: false,
        nextProbeAt: 0,
        state: "ready"
      });
      settle(entry, entry);
      return true;
    }

    function markBackoff(entry, detail = {}) {
      if (!entry || !entries.has(entry.key)) return false;
      entry.controller = null;
      entry.error = String(detail.error || "all candidate CDNs failed");
      entry.failureCycles = Number(entry.failureCycles || 0) + 1;
      entry.foreground = false;
      entry.nextProbeAt = Number(detail.nextProbeAt || Date.now());
      entry.state = "backoff";
      settle(entry, null);
      return true;
    }

    function markFailed(entry, detail = {}) {
      if (!entry || !entries.has(entry.key)) return false;
      entry.controller = null;
      entry.error = String(detail.error || "all candidate CDNs failed");
      entry.failureCycles = Number(entry.failureCycles || 0) + 1;
      entry.foreground = false;
      entry.nextProbeAt = 0;
      entry.state = "failed";
      settle(entry, null);
      return true;
    }

    return Object.freeze({
      assemble,
      cancelBackground,
      cancelCoverage,
      cancelPending,
      cancelPendingExcept,
      clear,
      consume,
      delete: (key, reason) => deleteEntry(key, reason),
      ensure,
      get: (key) => entries.get(key),
      markAttempt,
      markBackoff,
      markFailed,
      markReady,
      pendingCoverage,
      reconcile,
      snapshot,
      trim
    });
  }

  root.BiliCdnPrefetchStore = Object.freeze({ createPrefetchStore });
})(globalThis);
