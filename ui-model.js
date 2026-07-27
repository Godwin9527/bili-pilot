(function installBiliCdnUiModel(root) {
  "use strict";

  function localize(key, fallback) {
    return root.BiliCdnI18n?.t?.(key) || fallback;
  }

  function formatSpeed(value) {
    if (!Number.isFinite(value) || value <= 0) return "—";
    if (value >= 100) return `${Math.round(value)} Mbps`;
    if (value >= 10) return `${value.toFixed(1)} Mbps`;
    return `${value.toFixed(2)} Mbps`;
  }

  function formatPosition(position) {
    return `${Math.round(Number(position || 0) * 100)}%`;
  }

  function formatFailure(error) {
    const value = String(error || "").toLowerCase();
    if (value.includes("http 416")) return localize("failureRangeUnavailable", "Range unavailable");
    if (value.includes("network")) return localize("failureNetwork", "Network error");
    if (value.includes("initial-probe-failed")) return localize("failureSkipped", "Skipped");
    if (value.includes("consecutive-failures-skipped")) return localize("failureStoppedEarly", "Stopped early");
    if (value.includes("size-unavailable")) return localize("failurePositionUnavailable", "Position unavailable");
    if (value.includes("timeout")) return localize("failureTimedOut", "Timed out");
    return localize("failureGeneric", "Failed");
  }

  function qualitySummary(plan) {
    if (!plan) return localize("videoNotDetected", "Video not detected yet");
    const dimensions = plan.width && plan.height ? `${plan.width}×${plan.height}` : "";
    const features = Array.isArray(plan.features) ? plan.features.join(" / ") : "";
    return [features, dimensions, plan.codec].filter(Boolean).join(" / ");
  }

  function resultViewModels(plan, results) {
    const measuredResults = Array.isArray(results) ? results : [];
    const pendingRows = [...(plan?.candidates || [])]
      .sort((left, right) => String(left.label || left.host).localeCompare(String(right.label || right.host)))
      .filter((candidate) => !measuredResults.some((result) => result.host === candidate.host))
      .map((candidate) => ({
        ...candidate,
        failures: 0,
        minMbps: null,
        samples: [],
        score: candidate.isPrimary ? 1 : 0
      }));
    const rows = measuredResults.length ? [...measuredResults, ...pendingRows] : pendingRows;
    const winner = measuredResults[0]?.score > -10000 ? measuredResults[0].host : null;
    return rows.map((result, index) => {
      const candidate = plan?.candidates?.find((item) => item.host === result.host);
      const preferred = plan?.preferredHost === result.host;
      return {
        candidate,
        index,
        isWinner: Boolean(winner && winner === result.host),
        measured: measuredResults.some((item) => item.host === result.host),
        nativeDefault: !plan?.preferredHost && plan?.currentPrimary === result.host,
        preferred,
        result
      };
    });
  }

  root.BiliCdnUiModel = Object.freeze({
    formatFailure,
    formatPosition,
    formatSpeed,
    qualitySummary,
    resultViewModels
  });
})(globalThis);
