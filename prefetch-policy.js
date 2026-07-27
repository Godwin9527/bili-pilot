(function installBiliCdnPrefetchPolicy(root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    highBufferSeconds: 60,
    lowBufferSeconds: 15,
    warmBufferSeconds: 30
  });

  function targetSegmentCount(bufferedAhead, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const ahead = Math.max(0, Number(bufferedAhead || 0));
    if (ahead < config.lowBufferSeconds) return 0;
    if (ahead < config.warmBufferSeconds) return 3;
    if (ahead < config.highBufferSeconds) return 5;
    return 8;
  }

  function evaluatePrefetchHeadroom(state = {}, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const bufferedAhead = Math.max(0, Number(state.bufferedAhead || 0));
    const count = targetSegmentCount(bufferedAhead, config);
    if (!count) return { allowed: false, count: 0, reason: "buffer-low" };
    return { allowed: true, count, reason: "headroom-available" };
  }

  root.BiliCdnPrefetchPolicy = Object.freeze({
    DEFAULTS,
    evaluatePrefetchHeadroom,
    targetSegmentCount
  });
})(globalThis);
