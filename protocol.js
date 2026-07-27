(function installBiliCdnProtocol(root) {
  "use strict";

  if (root.BiliCdnProtocol) return;

  const CHANNEL = "BILI_CDN_PILOT_V1";
  const EVENTS = Object.freeze({
    APPLIED: "BCO_APPLIED",
    CANDIDATES: "BCO_CANDIDATES",
    HOOK_READY: "BCO_HOOK_READY",
    ACTIVITY: "BCO_ACTIVITY",
    PLAN_RESET: "BCO_PLAN_RESET",
    PREFETCH_STATE: "BCO_PREFETCH_STATE",
    PROBE_REQUEST: "BCO_PROBE_REQUEST",
    PROBE_RESULT: "BCO_PROBE_RESULT",
    REQUEST_OUTCOME: "BCO_REQUEST_OUTCOME",
    ROUTE_COOLDOWN: "BCO_ROUTE_COOLDOWN",
    SELECT_HOST: "BCO_SELECT_HOST",
    SET_PREFETCH: "BCO_SET_PREFETCH",
    UI_READY: "BCO_UI_READY"
  });
  const STORAGE = Object.freeze({
    PAGE_PREFETCH_ENABLED: "bco:v4:prefetch-enabled",
    UI_PREFETCH_ENABLED: "prefetchEnabledV1"
  });

  function createMessage(type, detail = {}) {
    if (!Object.values(EVENTS).includes(type)) {
      throw new Error(`Unknown Bili Pilot event: ${String(type)}`);
    }
    return { channel: CHANNEL, ...detail, type };
  }

  function isProtocolMessage(event) {
    return Boolean(
      event?.source === root &&
      event?.origin === root.location?.origin &&
      event?.data?.channel === CHANNEL
    );
  }

  function post(type, detail = {}) {
    root.postMessage(createMessage(type, detail), root.location.origin);
  }

  root.BiliCdnProtocol = Object.freeze({
    CHANNEL,
    EVENTS,
    STORAGE,
    createMessage,
    isProtocolMessage,
    post
  });
})(globalThis);
