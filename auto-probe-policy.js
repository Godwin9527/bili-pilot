(function installBiliCdnAutoProbePolicy(root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    periodicIntervalMs: 5 * 60 * 1000,
    recoveryBaseDelayMs: 10 * 1000,
    recoveryMaxDelayMs: 5 * 60 * 1000,
    scheduledProbeBufferSeconds: 24
  });

  function createScheduler(options = {}) {
    const config = { ...DEFAULTS, ...options };
    let activeToken = null;
    let lastCompletedAt = 0;
    let recoveryAttempt = 0;
    let recoveryRequested = false;
    let routeChangedDuringProbe = false;
    let retryAt = 0;
    let signature = "";

    function clearRecovery() {
      recoveryAttempt = 0;
      recoveryRequested = false;
      retryAt = 0;
    }

    function reset(nextSignature = "") {
      activeToken = null;
      lastCompletedAt = 0;
      routeChangedDuringProbe = false;
      signature = String(nextSignature || "");
      clearRecovery();
    }

    function signalProblem(activeSignature) {
      if (!signature || activeSignature !== signature) return false;
      recoveryRequested = true;
      return true;
    }

    function scheduledProbeIsSafe(media = {}) {
      if (!media.exists) return false;
      const readyState = Number(media.readyState || 0);
      if (media.paused) return readyState >= 2;
      return readyState >= 4 && Number(media.bufferedAhead || 0) >= config.scheduledProbeBufferSeconds;
    }

    function takeNextProbe(context = {}) {
      const now = Number(context.now ?? Date.now());
      if (!signature || activeToken) return null;

      let trigger = null;
      if (recoveryRequested) {
        if (now < retryAt) return null;
        trigger = "recovery";
      } else if (!lastCompletedAt) {
        trigger = "initial";
      } else if (now - lastCompletedAt >= config.periodicIntervalMs) {
        trigger = "periodic";
      }
      if (!trigger || (trigger !== "recovery" && !scheduledProbeIsSafe(context.media))) return null;

      const token = Object.freeze({ signature, trigger });
      activeToken = token;
      routeChangedDuringProbe = false;
      if (trigger === "recovery") recoveryRequested = false;
      return token;
    }

    function completeProbe(token, outcome = {}, now = Date.now()) {
      if (!token || token !== activeToken || token.signature !== signature) return null;
      const routeChanged = routeChangedDuringProbe || outcome.routeChanged === true;
      activeToken = null;
      routeChangedDuringProbe = false;
      lastCompletedAt = Number(now);
      if (routeChanged) {
        clearRecovery();
      } else if (token.trigger === "recovery") {
        recoveryAttempt += 1;
        recoveryRequested = true;
        const exponent = Math.max(0, recoveryAttempt - 1);
        const delay = Math.min(config.recoveryMaxDelayMs, config.recoveryBaseDelayMs * (2 ** exponent));
        retryAt = lastCompletedAt + delay;
      }
      return Object.freeze({ recoveryAttempt, retryAt });
    }

    function noteRouteChange(activeSignature) {
      if (!signature || activeSignature !== signature) return false;
      if (activeToken) routeChangedDuringProbe = true;
      clearRecovery();
      return true;
    }

    function isRecovering() {
      return recoveryRequested || activeToken?.trigger === "recovery";
    }

    return Object.freeze({
      completeProbe,
      isRecovering,
      noteRouteChange,
      reset,
      signalProblem,
      takeNextProbe
    });
  }

  root.BiliCdnAutoProbePolicy = Object.freeze({ createScheduler });
})(globalThis);
