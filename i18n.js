(function installBiliCdnI18n(root) {
  "use strict";

  const extensionApi = root.browser ?? root.chrome;

  const english = Object.freeze({
    appName: "Bili Pilot",
    expandPanel: "Expand Bili Pilot",
    collapsePanel: "Collapse Bili Pilot",
    tagline: "Choose a stable route for this video",
    standby: "Standby",
    compactReadySegments: "$1 prefetched segments",
    compactCdnSelected: "Using · $1",
    compactCdnPinned: "Pinned · $1",
    compactSegmentCached: "Segment cached · $1",
    scanning: "Scanning",
    currentQuality: "Current quality / Real-segment protection",
    waitingForVideo: "Waiting for video",
    videoNotDetected: "Video not detected yet",
    waitingForRoutes: "Waiting for the player to provide CDN routes…",
    reloadPage: "Reload page",
    automaticRoutingTitle: "Automatic routing + pre-caching segments",
    activityLogs: "Bili Pilot activity",
    checkLogs: "Check logs",
    closeLogs: "Close logs",
    noLogsYet: "No Bili Pilot activity yet.",
    activityScanStarted: "Scan started",
    activityScanFinished: "Scan completed",
    activityScanFailed: "Scan failed",
    activityProbeStarted: "Testing $1",
    activityProbeFinished: "Tested $1",
    activityRouteSelected: "Playback route changed to $1",
    activityRouteAvoided: "Temporarily avoiding $1",
    activityRouteRescue: "Using $1 while $2 recovers",
    activityPrefetchEnabled: "Automatic routing and pre-cache enabled",
    activityPrefetchDisabled: "Automatic routing and pre-cache disabled",
    activitySegmentsPlanned: "$1 future segments queued",
    activityRetrying: "Retrying",
    activityCancelled: "Cancelled",
    activitySegmentPrioritized: "Prioritized a segment requested by the player",
    activityCacheDelivered: "Delivered a cached segment to the player",
    activityTransfer: "$1 MB in $2 ms",
    futureSegmentLifecycle: "Future segment lifecycle",
    candidateCdns: "Candidate CDNs",
    routeCount: "$1 routes",
    quickScan: "Quick scan",
    deepScan: "Deep scan",
    footer: "Choose a stable primary route; prefetch each future segment from its fastest CDN / v$1",
    reprobeSeconds: "Re-probe $1s",
    unavailable: "Unavailable",
    foreground: "Foreground",
    downloading: "Downloading",
    planned: "Planned",
    ready: "Ready",
    retryProgress: "Retry $1/$2",
    pending: "Pending",
    selected: "Selected",
    bilibiliDefault: "Bilibili default",
    leading: "Leading",
    mostStable: "Most stable",
    pinned: "Pinned",
    use: "Use",
    floorSpeed: "Floor $1",
    waitingForScan: "Waiting for scan",
    failureCount: "$1 failures",
    openVideo: "Open a Bilibili video to discover its available CDN routes.",
    ttfbTitle: "$1 ms TTFB",
    failureRangeUnavailable: "Range unavailable",
    failureNetwork: "Network error",
    failureSkipped: "Skipped",
    failureStoppedEarly: "Stopped early",
    failurePositionUnavailable: "Position unavailable",
    failureTimedOut: "Timed out",
    failureGeneric: "Failed",
    pageProbeTimedOut: "Page-side probe timed out",
    extensionUpdated: "The extension was updated. Reload this page before scanning again.",
    noRoutesToCompare: "No CDN routes are available for comparison",
    scanningDeep: "Sequentially checking the beginning and three later positions on each CDN…",
    scanningAutomatic: "Playback has enough buffer; automatically comparing primary routes…",
    scanningQuick: "Sequentially comparing the beginning and midpoint on each CDN…",
    activeTrackChanged: "The active track changed; results from the previous track were ignored",
    everyRouteFailed: "Every candidate route failed the scan",
    winnerHasFailures: "$1 is leading, but some sampled ranges still failed",
    bestRouteTooSlow: "The best route only sustained $1, which may not support $2. Consider lowering quality.",
    winnerStable: "$1 is the most stable with a $2 floor. Click Use to switch.",
    automaticallyPinned: "$1 was automatically pinned as the stable primary route; future segments will continue pre-caching",
    candidatesTooClose: "The candidates are too close; keeping the current route to avoid route flapping",
    scanFailed: "Scan failed: $1",
    automaticRouteQueued: "A clearly more stable route was selected automatically; switching on the next segment…",
    manualRouteQueued: "Route change queued; switching on the next segment…",
    prefetchEnabled: "Automatic routing is enabled: choose a stable primary route when buffered, then pre-cache segment by segment",
    prefetchDisabled: "Future-segment pre-cache is disabled; the player will continue using the selected CDN directly",
    pageProbeNoResult: "The page-side probe returned no result",
    playbackStalling: "Playback is stalling; re-checking the available CDN routes",
    pinnedTo: "Pinned to $1",
    foundRoutes: "Found $1 testable routes",
    discoveringNewVideo: "Discovering routes for the new video…",
    selectedNextSegment: "$1 selected; it will be used from the next video segment without interrupting the current request",
    playerRangeTimedOut: "The player's Range timed out on $1; the next retry will use another available route",
    playerRangeNetworkFailure: "$1 had a network failure on the current player Range; the next retry will use another available route",
    prefetchUnavailable: "Pre-cache is temporarily unavailable: $1",
    cacheHit: "The player hit the prefetch cache; $1 MB was delivered immediately",
    futureSegmentCached: "Future segment cached: $1 / $2 MB",
    currentRoute: "current route",
    allCdnsFailedTwice: "Every available CDN failed twice for this segment; it is quarantined so playback keeps the network",
    allCdnsFailedReprobe: "Every measured CDN failed for this segment; re-probing in $1s",
    stallDetected: "A stall was detected; re-checking the available CDN routes"
  });

  function interpolate(template, substitutions) {
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return String(template).replace(/\$(\d+)/g, (_match, index) => String(values[Number(index) - 1] ?? ""));
  }

  function t(key, substitutions = []) {
    const values = (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
    try {
      const localized = extensionApi?.i18n?.getMessage?.(key, values);
      if (localized) return localized;
    } catch {
      // Use the bundled English fallback in previews and tests.
    }
    return interpolate(english[key] || key, values);
  }

  const locale = (() => {
    try {
      return extensionApi?.i18n?.getUILanguage?.() || "en";
    } catch {
      return "en";
    }
  })();

  root.BiliCdnI18n = Object.freeze({ english, locale, t });
})(globalThis);
