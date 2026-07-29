(function installBiliCdnPanel() {
  "use strict";

  const protocol = globalThis.BiliCdnProtocol;
  const i18n = globalThis.BiliCdnI18n;
  const uiModel = globalThis.BiliCdnUiModel;
  const autoProbePolicy = globalThis.BiliCdnAutoProbePolicy;
  if (!protocol || !i18n || !uiModel || !autoProbePolicy) return;
  const { EVENTS, STORAGE } = protocol;
  const { locale, t } = i18n;
  const {
    formatFailure,
    formatPosition: formatSamplePoint,
    formatSpeed,
    qualitySummary,
    resultViewModels
  } = uiModel;
  const activityEntries = [];
  const activityIds = new Set();
  const autoProbe = autoProbePolicy.createScheduler();
  const COMPACT_NOTICE_MS = 5000;
  const PANEL_CLOSE_MS = 220;
  const extensionVersion = chrome.runtime.getManifest().version;
  const state = {
    compactNotice: "",
    contextInvalidated: false,
    expanded: false,
    mode: "quick",
    plan: null,
    prefetch: { backoff: 0, bytes: 0, circuitOpenInMs: 0, failed: 0, foreground: 0, hosts: {}, loading: 0, queued: 0, ready: 0, retrying: 0, segments: [] },
    prefetchEnabled: true,
    results: [],
    renderCount: 0,
    scanning: false,
    logsOpen: false,
    panelClosing: false,
    status: t("waitingForRoutes"),
    statusKind: "idle"
  };

  let shadow;
  let monitoredVideo = null;
  let monitoredVideoProblemListener = null;
  let activitySequence = 0;
  let compactNoticeTimer = 0;
  let lastCompactNoticeKey = "";
  let panelCloseTimer = 0;
  let probeSequence = 0;
  let renderFrame = 0;
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
    return true;
  }

  function appendLog(type, detail = {}) {
    if (addActivity({ detail, type }) && state.logsOpen) render();
  }

  function clearCompactNotice() {
    clearTimeout(compactNoticeTimer);
    compactNoticeTimer = 0;
    state.compactNotice = "";
  }

  function showCompactNotice(message, key, replaceActive = false) {
    const text = String(message || "").trim();
    if (!text || state.expanded || (key && key === lastCompactNoticeKey)) return;
    if (state.compactNotice && !replaceActive) return;
    clearTimeout(compactNoticeTimer);
    lastCompactNoticeKey = String(key || "");
    state.compactNotice = text;
    compactNoticeTimer = setTimeout(() => {
      compactNoticeTimer = 0;
      state.compactNotice = "";
      render();
    }, COMPACT_NOTICE_MS);
    render();
  }

  function openPanel() {
    clearTimeout(panelCloseTimer);
    panelCloseTimer = 0;
    state.panelClosing = false;
    state.expanded = true;
    clearCompactNotice();
    render();
  }

  function closePanel() {
    if (!state.expanded || state.panelClosing) return;
    state.panelClosing = true;
    render();
    const delay = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? 0 : PANEL_CLOSE_MS;
    panelCloseTimer = setTimeout(() => {
      panelCloseTimer = 0;
      state.panelClosing = false;
      state.expanded = false;
      render();
    }, delay);
  }

  function formatLogTime(value) {
    try {
      return new Date(value).toLocaleTimeString(locale.replaceAll("_", "-"), {
        fractionalSecondDigits: 3,
        hour: "2-digit",
        hour12: false,
        minute: "2-digit",
        second: "2-digit"
      });
    } catch {
      return new Date(value).toLocaleTimeString();
    }
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
    const host = shadow?.host || document.getElementById("bili-cdn-pilot-root");
    host?.setAttribute("data-bco-auto-state", JSON.stringify({
      at: Date.now(),
      stage,
      ...detail
    }));
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

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setText(node, value) {
    if (!node) return;
    const next = String(value ?? "");
    if (node.textContent !== next) node.textContent = next;
  }

  function setClass(node, value) {
    if (node && node.className !== value) node.className = value;
  }

  function placeChild(parent, child, index) {
    const current = parent.children[index];
    if (current !== child) parent.insertBefore(child, current || null);
  }

  function mountShellMarkup(shell) {
    if (shell.dataset.mounted === "true") return;
    shell.lang = locale.replaceAll("_", "-");
    shell.innerHTML = `
      <button class="compact" data-action="expand" aria-label="${escapeHtml(t("expandPanel"))}" aria-expanded="false">
        <span class="compact-mark">↯</span>
        <span class="compact-copy" aria-live="polite">
          <strong data-bind="compact-title">${escapeHtml(t("appName"))}</strong>
          <small data-bind="compact-status">${escapeHtml(t("standby"))}</small>
        </span>
        <span class="compact-dots" data-bind="compact-dots" role="img">
          ${Array.from({ length: 8 }, () => "<i></i>").join("")}
        </span>
      </button>

      <section class="panel" aria-label="${escapeHtml(t("appName"))}">
        <header class="panel-header">
          <div class="brand">
            <span class="brand-mark">↯</span>
            <div><strong>${escapeHtml(t("appName"))}</strong><span>${escapeHtml(t("tagline"))}</span></div>
          </div>
          <button class="icon-button" data-action="collapse" aria-label="${escapeHtml(t("collapsePanel"))}"><span class="collapse-chevron" aria-hidden="true"></span></button>
        </header>

        <div class="panel-scroll">

        <div class="hero">
          <div class="hero-copy">
            <span class="eyebrow">${escapeHtml(t("currentQuality"))}</span>
            <h2 data-bind="quality-label">${escapeHtml(t("waitingForVideo"))}</h2>
            <p data-bind="quality-summary">${escapeHtml(t("videoNotDetected"))}</p>
          </div>
          <div class="pulse-orbit" aria-hidden="true">
            <span></span><i></i>
          </div>
        </div>

        <div class="status-line idle" role="status" aria-live="polite">
          <span class="status-icon status-glyph idle" aria-hidden="true">•</span>
          <span data-bind="status-text">${escapeHtml(t("waitingForRoutes"))}</span>
          <button class="refresh-button" data-action="reload-page" hidden>${escapeHtml(t("reloadPage"))}</button>
        </div>

        <div class="control-card">
          <strong id="bili-pilot-prefetch-label">${escapeHtml(t("automaticRoutingTitle"))}</strong>
          <button class="switch" data-action="toggle-prefetch" role="switch" aria-checked="false" aria-labelledby="bili-pilot-prefetch-label">
            <span></span>
          </button>
        </div>

        <div class="route-map" hidden><span>${escapeHtml(t("futureSegmentLifecycle"))}</span><div class="route-map-chips"></div></div>

        <div class="section-heading">
          <div><span>${escapeHtml(t("candidateCdns"))}</span><small data-bind="candidate-count">${escapeHtml(t("routeCount", [0]))}</small></div>
          <div class="scan-actions">
            <button data-action="scan-quick" disabled>${escapeHtml(t("quickScan"))}</button>
            <button data-action="scan-deep" disabled>${escapeHtml(t("deepScan"))}</button>
          </div>
        </div>

        <div class="results"></div>
        <div class="footer-actions">
          <button class="log-button" data-action="open-logs">${escapeHtml(t("checkLogs"))}</button>
        </div>
        <footer>${escapeHtml(t("footer", [extensionVersion]))}</footer>
        </div>
      </section>

      <div class="log-overlay" data-bind="log-overlay" hidden>
        <section class="log-dialog" role="dialog" aria-modal="true" aria-labelledby="bili-pilot-log-title">
          <header class="log-header">
            <strong id="bili-pilot-log-title">${escapeHtml(t("activityLogs"))}</strong>
            <button class="icon-button" data-action="close-logs" aria-label="${escapeHtml(t("closeLogs"))}"><span class="close-glyph" aria-hidden="true"></span></button>
          </header>
          <div class="log-list" data-bind="log-list"></div>
        </section>
      </div>
    `;
    shell.dataset.mounted = "true";
  }

  function patchRouteMap(shell) {
    const routeMap = shell.querySelector(".route-map");
    const container = shell.querySelector(".route-map-chips");
    const segments = state.prefetchEnabled && Array.isArray(state.prefetch.segments)
      ? state.prefetch.segments.slice(0, 8)
      : [];
    routeMap.hidden = !state.prefetchEnabled;
    if (!segments.length) {
      container.replaceChildren();
      const empty = document.createElement("span");
      empty.className = "route-map-empty";
      setText(empty, t("pending"));
      container.appendChild(empty);
      return;
    }
    const existing = new Map([...container.children].map((node) => [node.dataset.key, node]));
    const keep = new Set();
    const stateLabel = (segment) => ({
      backoff: t("reprobeSeconds", [Math.max(1, Math.ceil(Number(segment.nextProbeInMs || 0) / 1000))]),
      failed: t("unavailable"),
      loading: segment.foreground ? t("foreground") : t("downloading"),
      queued: t("planned"),
      ready: t("ready"),
      retrying: t("retryProgress", [segment.attempt, segment.totalCandidates])
    })[segment.state] || t("pending");
    segments.forEach((segment, index) => {
      const key = String(segment.range || `${index}:${segment.host || ""}`);
      keep.add(key);
      let chip = existing.get(key);
      if (!chip) {
        chip = document.createElement("span");
        chip.dataset.key = key;
        const number = document.createElement("b");
        const label = document.createElement("span");
        label.className = "route-label";
        const lifecycle = document.createElement("small");
        lifecycle.className = "route-state";
        chip.append(number, label, lifecycle);
      }
      const candidate = state.plan?.candidates?.find((item) => item.host === segment.host);
      const speed = Number(segment.probeMbps || 0);
      const ranking = (segment.candidateHosts || []).map((host) =>
        state.plan?.candidates?.find((item) => item.host === host)?.label || host).join(" > ");
      chip.className = `route-chip ${segment.state || "queued"}${segment.foreground ? " foreground" : ""}`;
      chip.title = `${segment.range || ""}${speed > 0 ? ` / ${speed.toFixed(1)} Mbps` : ""}${ranking ? ` / ${ranking}` : ""}`;
      setText(chip.querySelector("b"), index + 1);
      setText(chip.querySelector(".route-label"), candidate?.label || segment.host || t("pending"));
      setText(chip.querySelector(".route-state"), stateLabel(segment));
      placeChild(container, chip, index);
    });
    [...container.children].forEach((node) => {
      if (!keep.has(node.dataset.key)) node.remove();
    });
  }

  function patchLogDialog(shell) {
    const overlay = shell.querySelector('[data-bind="log-overlay"]');
    overlay.hidden = !state.logsOpen;
    if (!state.logsOpen) return;
    const entries = activityEntries;
    const list = shell.querySelector('[data-bind="log-list"]');
    const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    const existing = new Map([...list.children].map((node) => [node.dataset.key, node]));
    const keep = new Set();
    entries.forEach((entry, index) => {
      const key = entry.id;
      keep.add(key);
      let row = existing.get(key);
      if (!row) {
        row = document.createElement("article");
        row.className = "log-entry";
        row.dataset.key = key;
        row.innerHTML = `
          <time></time><div><strong></strong><span></span></div>
        `;
      }
      setText(row.querySelector("time"), formatLogTime(entry.at));
      setText(row.querySelector("strong"), entry.title);
      const description = row.querySelector("div span");
      setText(description, entry.detail);
      description.hidden = !entry.detail;
      placeChild(list, row, index);
    });
    [...list.children].forEach((node) => {
      if (!keep.has(node.dataset.key)) node.remove();
    });
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "log-empty";
      setText(empty, t("noLogsYet"));
      list.appendChild(empty);
    }
    if (wasNearBottom) list.scrollTop = list.scrollHeight;
  }

  function createResultRow(host) {
    const row = document.createElement("article");
    row.className = "cdn-row";
    row.dataset.host = host;
    row.innerHTML = `
      <div class="cdn-topline">
        <div class="cdn-identity">
          <span class="rank-dot"></span>
          <div>
            <div class="cdn-name"><span class="cdn-label"></span><span class="cdn-badges"></span></div>
            <div class="cdn-host"></div>
          </div>
        </div>
        <button class="use-button" data-action="select"></button>
      </div>
      <div class="cdn-meta"><span class="cdn-measure"></span><span class="cdn-failures"></span></div>
      <div class="samples"></div>
    `;
    return row;
  }

  function patchBadges(container, badges) {
    const existing = new Map([...container.children].map((node) => [node.dataset.kind, node]));
    const keep = new Set();
    badges.forEach((badge, index) => {
      keep.add(badge.kind);
      let node = existing.get(badge.kind);
      if (!node) {
        node = document.createElement("span");
        node.dataset.kind = badge.kind;
      }
      setClass(node, `badge ${badge.className}`);
      setText(node, badge.label);
      placeChild(container, node, index);
    });
    [...container.children].forEach((node) => {
      if (!keep.has(node.dataset.kind)) node.remove();
    });
  }

  function patchSamples(container, samples) {
    const values = Array.isArray(samples) ? samples : [];
    container.hidden = values.length === 0;
    values.forEach((sample, index) => {
      let node = container.children[index];
      if (!node) {
        node = document.createElement("span");
        node.innerHTML = '<b></b><span class="sample-value"></span>';
        container.appendChild(node);
      }
      setClass(node, `sample ${sample.ok ? "ok" : "failed"}`);
      node.title = sample.ok ? t("ttfbTitle", [Math.round(sample.ttfbMs || 0)]) : String(sample.error || t("failureGeneric"));
      setText(node.querySelector("b"), formatSamplePoint(sample?.position));
      setText(node.querySelector(".sample-value"), sample.ok ? formatSpeed(sample.mbps) : formatFailure(sample.error));
    });
    while (container.children.length > values.length) container.lastElementChild.remove();
  }

  function patchResultRows(shell) {
    const container = shell.querySelector(".results");
    const models = resultViewModels(state.plan, state.results);
    let empty = container.querySelector(":scope > .empty");
    if (!models.length) {
      [...container.children].forEach((node) => {
        if (!node.classList.contains("empty")) node.remove();
      });
      if (!empty) {
        empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = t("openVideo");
        container.appendChild(empty);
      }
      return;
    }
    empty?.remove();
    const existing = new Map([...container.querySelectorAll(":scope > .cdn-row")].map((node) => [node.dataset.host, node]));
    const keep = new Set();
    models.forEach((model, index) => {
      const { candidate, isWinner, measured, nativeDefault, preferred, result } = model;
      keep.add(result.host);
      const row = existing.get(result.host) || createResultRow(result.host);
      setClass(row, `cdn-row${isWinner ? " winner" : ""}`);
      setText(row.querySelector(".cdn-label"), result.label || candidate?.label || "CDN");
      const host = row.querySelector(".cdn-host");
      host.title = result.host;
      setText(host, result.host);
      patchBadges(row.querySelector(".cdn-badges"), [
        preferred ? { kind: "active", className: "active", label: t("selected") } : null,
        nativeDefault ? { kind: "preferred", className: "preferred", label: t("bilibiliDefault") } : null,
        isWinner ? { kind: "best", className: "best", label: result.failures > 0 ? t("leading") : t("mostStable") } : null
      ].filter(Boolean));
      const button = row.querySelector(".use-button");
      button.dataset.host = result.host;
      button.disabled = preferred || state.contextInvalidated;
      setText(button, preferred ? t("pinned") : t("use"));
      setText(row.querySelector(".cdn-measure"), measured ? t("floorSpeed", [formatSpeed(result.minMbps)]) : t("waitingForScan"));
      const failures = row.querySelector(".cdn-failures");
      failures.hidden = !measured;
      setText(failures, measured ? t("failureCount", [result.failures || 0]) : "");
      patchSamples(row.querySelector(".samples"), result.samples);
      placeChild(container, row, index);
    });
    [...container.querySelectorAll(":scope > .cdn-row")].forEach((node) => {
      if (!keep.has(node.dataset.host)) node.remove();
    });
  }

  function patchRender() {
    if (!shadow) return;
    const shell = shadow.querySelector(".shell");
    if (!shell) return;
    mountShellMarkup(shell);
    state.renderCount += 1;
    shell.dataset.renderCount = String(state.renderCount);
    shell.dataset.expanded = String(state.expanded);
    shell.dataset.closing = String(state.panelClosing);
    const compact = shell.querySelector(".compact");
    setClass(compact, `compact${state.compactNotice ? " has-notice" : ""}`);
    compact.setAttribute("aria-expanded", String(state.expanded));
    const compactHost = state.plan?.preferredHost || state.plan?.currentPrimary || "";
    setText(shell.querySelector('[data-bind="compact-title"]'), state.compactNotice || t("appName"));
    const compactStatus = shell.querySelector('[data-bind="compact-status"]');
    setText(
      compactStatus,
      state.scanning ? t("scanning") : compactHost ? candidateLabel(compactHost) : t("standby")
    );
    compactStatus.hidden = Boolean(state.compactNotice);
    const readyCount = state.prefetchEnabled
      ? Math.min(8, state.prefetch.segments.filter((segment) => segment.state === "ready").length)
      : 0;
    const dots = shell.querySelector('[data-bind="compact-dots"]');
    dots.setAttribute("aria-label", t("compactReadySegments", [readyCount]));
    [...dots.children].forEach((dot, index) => setClass(dot, index < readyCount ? "ready" : ""));
    setText(shell.querySelector('[data-bind="quality-label"]'), state.plan?.qualityLabel || t("waitingForVideo"));
    setText(shell.querySelector('[data-bind="quality-summary"]'), qualitySummary(state.plan));
    setClass(shell.querySelector(".pulse-orbit"), `pulse-orbit${state.scanning ? " is-scanning" : ""}`);
    const statusLine = shell.querySelector(".status-line");
    setClass(statusLine, `status-line ${state.statusKind}`);
    const statusIcon = shell.querySelector(".status-icon");
    if (state.scanning) {
      setClass(statusIcon, "status-icon spinner");
      setText(statusIcon, "");
    } else {
      const glyph = { success: "✓", warning: "!", error: "×", idle: "•" }[state.statusKind] || "•";
      setClass(statusIcon, `status-icon status-glyph ${state.statusKind}`);
      setText(statusIcon, glyph);
    }
    setText(shell.querySelector('[data-bind="status-text"]'), state.status);
    shell.querySelector(".refresh-button").hidden = !state.contextInvalidated;
    const toggle = shell.querySelector('[data-action="toggle-prefetch"]');
    setClass(toggle, `switch${state.prefetchEnabled ? " on" : ""}`);
    toggle.setAttribute("aria-checked", String(state.prefetchEnabled));
    toggle.disabled = state.contextInvalidated;
    patchRouteMap(shell);
    setText(shell.querySelector('[data-bind="candidate-count"]'), t("routeCount", [state.plan?.candidates?.length || 0]));
    const scansDisabled = state.scanning || !state.plan || state.contextInvalidated;
    shell.querySelector('[data-action="scan-quick"]').disabled = scansDisabled;
    shell.querySelector('[data-action="scan-deep"]').disabled = scansDisabled;
    patchResultRows(shell);
    patchLogDialog(shell);
  }

  function render() {
    if (!shadow || renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      patchRender();
    });
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
      render();
      return { probeSucceeded: false, routeChanged: false };
    }
    state.status = state.mode === "deep"
      ? t("scanningDeep")
      : automatic
        ? t("scanningAutomatic")
        : t("scanningQuick");
    render();

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
      render();
    }
  }

  function selectHost(host, options = {}) {
    if (!state.plan?.candidates?.some((candidate) => candidate.host === host)) return;
    const automatic = options.automatic === true;
    state.statusKind = "success";
    state.status = automatic
      ? t("automaticRouteQueued")
      : t("manualRouteQueued");
    render();
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

  function handleClick(event) {
    if (event.target?.matches?.('[data-bind="log-overlay"]')) {
      state.logsOpen = false;
      render();
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === "open-logs") {
      state.logsOpen = true;
      render();
      requestAnimationFrame(() => shadow?.querySelector('[data-action="close-logs"]')?.focus());
      return;
    }
    if (action === "close-logs") {
      state.logsOpen = false;
      render();
      requestAnimationFrame(() => shadow?.querySelector('[data-action="open-logs"]')?.focus());
      return;
    }
    if (action === "reload-page") {
      location.reload();
      return;
    }
    if (action === "expand") {
      openPanel();
      return;
    }
    if (action === "collapse") {
      closePanel();
      return;
    }
    if (state.contextInvalidated) {
      render();
      return;
    }
    if (action === "scan-quick") scan("quick");
    if (action === "scan-deep") scan("deep");
    if (action === "select") selectHost(button.dataset.host);
    if (action === "toggle-prefetch") {
      state.prefetchEnabled = !state.prefetchEnabled;
      autoProbe.reset(state.prefetchEnabled ? state.plan?.signature : "");
      appendLog("prefetch-toggle", { enabled: state.prefetchEnabled });
      chrome.storage.local.set({ [STORAGE.UI_PREFETCH_ENABLED]: state.prefetchEnabled });
      post(EVENTS.SET_PREFETCH, { enabled: state.prefetchEnabled });
      state.statusKind = state.prefetchEnabled ? "success" : "idle";
      state.status = state.prefetchEnabled
        ? t("prefetchEnabled")
        : t("prefetchDisabled");
    }
    render();
  }

  function handlePageMessage(event) {
    if (!protocol.isProtocolMessage(event)) return;
    const message = event.data;

    if (message.type === EVENTS.ACTIVITY) {
      let changed = false;
      for (const entry of message.entries || (message.entry ? [message.entry] : [])) {
        changed = addActivity(entry, "page") || changed;
      }
      if (changed && state.logsOpen) render();
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
      render();

    }

    if (message.type === EVENTS.PLAN_RESET) {
      autoProbe.reset();
      clearCompactNotice();
      lastCompactNoticeKey = "";
      state.plan = null;
      state.results = [];
      state.prefetch = { backoff: 0, bytes: 0, circuitOpenInMs: 0, failed: 0, foreground: 0, hosts: {}, loading: 0, queued: 0, ready: 0, retrying: 0, segments: [] };
      state.scanning = false;
      state.statusKind = "idle";
      state.status = t("discoveringNewVideo");
      render();
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
      const automaticallyPinned = String(message.reason || "").startsWith("automatic-");
      showCompactNotice(
        t(automaticallyPinned ? "compactCdnPinned" : "compactCdnSelected", [selected?.label || message.host]),
        `route:${message.signature || state.plan?.signature || ""}:${message.host}:${automaticallyPinned ? "auto" : "manual"}`,
        true
      );
      render();
    }

    if (message.type === EVENTS.ROUTE_COOLDOWN) {
      const failed = state.plan?.candidates?.find((item) => item.host === message.host);
      state.statusKind = "warning";
      state.status = message.cause === "player-timeout"
        ? t("playerRangeTimedOut", [failed?.label || message.host])
        : t("playerRangeNetworkFailure", [failed?.label || message.host]);
      render();
      requestRecoveryProbe("route-cooldown");
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
        if (result.ok) {
          showCompactNotice(
            t("compactSegmentCached", [selected?.label || result.host || t("currentRoute")]),
            `segment:${result.range || ""}:${result.host || ""}:${result.bytes || 0}`
          );
        }
      }
      render();
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
          render();
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

  function styles() {
    return `
      :host { all: initial; color-scheme: light dark; }
      * { box-sizing: border-box; }
      button { font: inherit; }
      .shell {
        --pink: #fb7299;
        --pink-deep: #e85b87;
        --blue: #00aeec;
        --ink: #16171a;
        --muted: rgba(22, 23, 26, .58);
        position: fixed;
        right: 22px;
        bottom: 22px;
        z-index: 2147483000;
        width: min(372px, calc(100vw - 28px));
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif;
        font-optical-sizing: auto;
        color: var(--ink);
        letter-spacing: 0;
      }
      .compact {
        display: grid;
        grid-template-columns: 38px minmax(0, 1fr) 34px;
        grid-template-areas: "mark copy dots";
        align-items: center;
        column-gap: 10px;
        row-gap: 0;
        margin-left: auto;
        width: 176px;
        height: 54px;
        padding: 7px 12px 7px 8px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.56);
        border-radius: 18px;
        color: white;
        background: linear-gradient(135deg, rgba(251,114,153,.96), rgba(232,91,135,.94));
        box-shadow: 0 16px 38px rgba(115, 27, 66, .28), inset 0 1px 0 rgba(255,255,255,.38);
        backdrop-filter: blur(22px) saturate(180%);
        -webkit-backdrop-filter: blur(22px) saturate(180%);
        cursor: pointer;
        transform-origin: 100% 100%;
        transition:
          width 380ms cubic-bezier(.2,.8,.2,1),
          height 380ms cubic-bezier(.2,.8,.2,1),
          transform 160ms ease,
          opacity 220ms ease,
          filter 220ms ease;
        will-change: width, height;
      }
      .compact.has-notice { width: 314px; height: 62px; }
      .compact:hover { filter: brightness(1.035); transform: translateY(-1px); }
      .compact:active { transform: scale(.97); transition-duration: 90ms; }
      .compact-mark, .brand-mark {
        display: grid;
        place-items: center;
        flex: none;
        width: 38px;
        height: 38px;
        border-radius: 13px;
        background: rgba(255,255,255,.18);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.32);
        font-size: 21px;
        font-weight: 750;
      }
      .compact .compact-mark { grid-area: mark; }
      .compact-copy { grid-area: copy; display: grid; min-width: 0; text-align: left; }
      .compact-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; letter-spacing: -.01em; }
      .compact-copy small { opacity: .76; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .compact-dots {
        grid-area: dots;
        display: grid;
        grid-template-columns: repeat(4, 5px);
        grid-auto-rows: 5px;
        gap: 4px;
        justify-content: end;
      }
      .compact-dots i {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: rgba(255,255,255,.22);
        transform: scale(.72);
        transition: background 260ms ease, box-shadow 260ms ease, transform 260ms cubic-bezier(.2,.8,.2,1);
      }
      .compact-dots i.ready {
        background: #d6ffe9;
        box-shadow: 0 0 0 2px rgba(214,255,233,.12), 0 0 8px rgba(214,255,233,.45);
        transform: scale(1);
      }
      .panel {
        display: none;
        flex-direction: column;
        max-height: calc(100dvh - 24px);
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.62);
        border-radius: 26px;
        background: rgba(250,250,252,.88);
        box-shadow: 0 26px 70px rgba(38, 24, 32, .24), 0 3px 12px rgba(38,24,32,.10), inset 0 1px 0 rgba(255,255,255,.85);
        backdrop-filter: blur(28px) saturate(170%);
        -webkit-backdrop-filter: blur(28px) saturate(170%);
        transform-origin: 88% 100%;
        animation: materialize 320ms cubic-bezier(.2,.8,.2,1) both;
      }
      .shell[data-expanded="false"] .compact { animation: compact-materialize 180ms cubic-bezier(.2,.8,.2,1) both; }
      .shell[data-expanded="true"] .compact { display: none; }
      .shell[data-expanded="true"] .panel { display: flex; }
      .shell[data-closing="true"] .panel { pointer-events: none; animation: dematerialize ${PANEL_CLOSE_MS}ms cubic-bezier(.4,0,1,1) both; }
      @keyframes compact-materialize {
        from { opacity: 0; transform: scale(.94) translateY(5px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes materialize {
        from { opacity: 0; transform: scale(.94) translateY(10px); filter: blur(5px); }
        to { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
      }
      @keyframes dematerialize {
        from { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
        to { opacity: 0; transform: scale(.96) translateY(8px); filter: blur(4px); }
      }
      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex: none;
        padding: 14px 14px 10px 16px;
      }
      .panel-scroll {
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        scrollbar-width: thin;
        scrollbar-color: rgba(120,120,128,.28) transparent;
      }
      .panel-scroll::-webkit-scrollbar { width: 8px; }
      .panel-scroll::-webkit-scrollbar-track { background: transparent; }
      .panel-scroll::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: rgba(120,120,128,.28); background-clip: padding-box; }
      .brand { display: flex; align-items: center; gap: 10px; }
      .brand-mark { width: 42px; height: 42px; border-radius: 13px; color: white; background: linear-gradient(145deg, var(--pink), var(--pink-deep)); box-shadow: 0 8px 18px rgba(251,114,153,.28), inset 0 1px 0 rgba(255,255,255,.4); font-size: 24px; }
      .brand div { display: grid; }
      .brand strong { font-size: 14px; line-height: 1.2; letter-spacing: -.015em; }
      .brand > div > span { margin-top: 2px; color: var(--muted); font-size: 11px; }
      .icon-button {
        display: grid; place-items: center;
        width: 34px; height: 34px; padding: 0; border: 0; border-radius: 11px;
        color: rgba(22,23,26,.68); background: rgba(120,120,128,.10); cursor: pointer;
        line-height: 1; transition: transform 120ms ease, background 160ms ease;
      }
      .collapse-chevron { width: 9px; height: 9px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(45deg); }
      .icon-button:hover { background: rgba(120,120,128,.16); }
      .icon-button:active { transform: scale(.92); }
      .hero {
        position: relative;
        display: flex;
        min-height: 116px;
        margin: 0 10px;
        padding: 20px;
        overflow: hidden;
        border-radius: 20px;
        color: white;
        background:
          radial-gradient(circle at 88% 20%, rgba(255,255,255,.25), transparent 29%),
          linear-gradient(135deg, #ff8ab0 0%, var(--pink) 48%, #ea5d8a 100%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.32), 0 13px 28px rgba(251,114,153,.22);
      }
      .hero-copy { position: relative; z-index: 1; min-width: 0; }
      .eyebrow { display: block; margin-bottom: 6px; font-size: 10px; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; opacity: .74; }
      .hero h2 { margin: 0; font-size: 29px; line-height: 1.03; letter-spacing: -.045em; font-weight: 760; }
      .hero p { margin: 8px 0 0; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; opacity: .78; }
      .pulse-orbit { position: absolute; right: 12px; top: 14px; width: 86px; height: 86px; border: 1px solid rgba(255,255,255,.22); border-radius: 50%; }
      .pulse-orbit::before, .pulse-orbit::after { content: ""; position: absolute; inset: 14px; border: 1px solid rgba(255,255,255,.2); border-radius: 50%; }
      .pulse-orbit::after { inset: 29px; background: rgba(255,255,255,.20); border: 0; box-shadow: 0 0 22px rgba(255,255,255,.28); }
      .pulse-orbit span { position: absolute; left: 50%; top: -3px; width: 7px; height: 7px; border-radius: 50%; background: white; box-shadow: 0 0 10px white; }
      .pulse-orbit.is-scanning { animation: orbit 1.4s linear infinite; }
      @keyframes orbit { to { transform: rotate(360deg); } }
      .status-line { display: flex; align-items: center; gap: 9px; min-height: 43px; margin: 8px 10px 0; padding: 9px 12px; border-radius: 14px; background: rgba(118,118,128,.08); color: var(--muted); }
      .status-line.success { color: #17764a; background: rgba(52,199,89,.10); }
      .status-line.warning { color: #925c00; background: rgba(255,159,10,.12); }
      .status-line.error { color: #b3261e; background: rgba(255,69,58,.10); }
      .status-line > span:nth-child(2) { min-width: 0; flex: 1; }
      .refresh-button { flex: none; min-height: 28px; padding: 0 10px; border: 0; border-radius: 9px; color: white; background: #ff9f0a; cursor: pointer; font-size: 10px; font-weight: 700; }
      .refresh-button:hover { background: #e68b00; }
      .refresh-button:active { transform: scale(.95); }
      .status-glyph { display: grid; place-items: center; flex: none; width: 18px; height: 18px; border-radius: 50%; font-weight: 750; background: rgba(120,120,128,.13); }
      .status-glyph.success { color: white; background: #34c759; }
      .status-glyph.warning { color: white; background: #ff9f0a; }
      .status-glyph.error { color: white; background: #ff453a; }
      .spinner { width: 16px; height: 16px; flex: none; border: 2px solid rgba(251,114,153,.2); border-top-color: var(--pink); border-radius: 50%; animation: orbit .75s linear infinite; }
      .control-card { display: flex; align-items: center; justify-content: space-between; margin: 8px 10px 0; padding: 12px; border-radius: 15px; background: rgba(255,255,255,.56); box-shadow: inset 0 0 0 1px rgba(120,120,128,.08); }
      .control-card > strong { padding-right: 12px; font-size: 13px; }
      .switch { position: relative; width: 42px; height: 25px; flex: none; padding: 0; border: 0; border-radius: 999px; background: rgba(120,120,128,.24); cursor: pointer; transition: background 180ms ease; }
      .switch span { position: absolute; top: 3px; left: 3px; width: 19px; height: 19px; border-radius: 50%; background: white; box-shadow: 0 2px 5px rgba(0,0,0,.22); transition: transform 240ms cubic-bezier(.2,.8,.2,1); }
      .switch.on { background: var(--pink); }
      .switch.on span { transform: translateX(17px); }
      .switch:active span { width: 22px; }
      .switch.on:active span { transform: translateX(14px); }
      .route-map { margin: 7px 10px 0; padding: 9px 10px; border-radius: 13px; background: rgba(251,114,153,.07); box-shadow: inset 0 0 0 1px rgba(251,114,153,.10); }
      .route-map > span { display: block; margin-bottom: 6px; color: var(--muted); font-size: 9px; font-weight: 650; }
      .route-map > div { display: flex; flex-wrap: wrap; gap: 5px; }
      .route-map-empty { padding: 4px 2px; color: var(--muted); font-size: 9px; }
      .route-chip { display: inline-grid; grid-template-columns: 15px auto; align-items: center; gap: 1px 5px; min-width: 0; padding: 4px 8px 4px 4px; border-radius: 11px; color: var(--pink-deep); background: rgba(251,114,153,.11); font-size: 9px; font-weight: 650; }
      .route-chip b { display: grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; color: white; background: var(--pink); font-size: 8px; }
      .route-chip .route-state { grid-column: 2; color: var(--muted); font-size: 7px; font-weight: 600; }
      .route-chip.loading, .route-chip.retrying, .route-chip.foreground { background: rgba(255,166,0,.12); }
      .route-chip.ready { color: #168653; background: rgba(31,190,112,.12); }
      .route-chip.ready b { background: #1fbe70; }
      .route-chip.backoff { color: #b45f06; background: rgba(255,145,0,.12); }
      .route-chip.failed { color: #b42318; background: rgba(211,47,47,.10); }
      .route-chip.failed b { background: #d32f2f; }
      .section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; padding: 16px 12px 8px; }
      .section-heading > div:first-child { display: grid; }
      .section-heading span { font-weight: 700; font-size: 13px; }
      .section-heading small { color: var(--muted); font-size: 10px; }
      .scan-actions { display: flex; gap: 6px; }
      .scan-actions button, .use-button { min-height: 28px; border: 0; border-radius: 9px; padding: 0 10px; color: var(--pink-deep); background: rgba(251,114,153,.10); cursor: pointer; font-size: 10px; font-weight: 650; transition: transform 110ms ease, background 160ms ease; }
      .scan-actions button.primary { color: white; background: var(--pink); }
      .scan-actions button:hover, .use-button:hover { background: rgba(251,114,153,.17); }
      .scan-actions button.primary:hover { background: var(--pink-deep); }
      .scan-actions button:active, .use-button:active { transform: scale(.95); }
      button:disabled { opacity: .46; cursor: default; transform: none !important; }
      .results { display: grid; gap: 7px; padding: 0 10px 4px; }
      .cdn-row { padding: 11px; border: 1px solid rgba(120,120,128,.10); border-radius: 16px; background: rgba(255,255,255,.48); }
      .cdn-row.winner { border-color: rgba(251,114,153,.28); background: linear-gradient(135deg, rgba(251,114,153,.09), rgba(255,255,255,.52)); }
      .cdn-topline { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .cdn-identity { display: flex; align-items: center; min-width: 0; gap: 9px; }
      .rank-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: rgba(120,120,128,.28); box-shadow: 0 0 0 4px rgba(120,120,128,.08); }
      .winner .rank-dot { background: var(--pink); box-shadow: 0 0 0 4px rgba(251,114,153,.12); }
      .cdn-identity > div { min-width: 0; }
      .cdn-name, .cdn-badges { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; font-weight: 700; }
      .cdn-host { max-width: 232px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 9px; }
      .badge { padding: 2px 5px; border-radius: 999px; font-size: 8px; font-weight: 700; line-height: 1.2; }
      .badge.active { color: #1677a0; background: rgba(0,174,236,.11); }
      .badge.preferred { color: #6d4bb6; background: rgba(125,87,194,.11); }
      .badge.best { color: #b33c66; background: rgba(251,114,153,.13); }
      .use-button { flex: none; }
      .cdn-meta { display: flex; gap: 10px; margin: 8px 0 0 17px; color: var(--muted); font-size: 9px; }
      .samples { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin-top: 8px; }
      .sample { display: grid; min-width: 0; padding: 5px 3px; border-radius: 8px; color: var(--muted); background: rgba(120,120,128,.07); text-align: center; font-size: 8px; }
      .sample b { color: var(--ink); font-size: 8px; }
      .sample.failed { color: #b3261e; background: rgba(255,69,58,.08); }
      .empty { padding: 25px 18px; border-radius: 16px; color: var(--muted); background: rgba(120,120,128,.07); text-align: center; font-size: 11px; }
      .footer-actions { display: flex; justify-content: center; padding: 7px 14px 0; }
      .log-button { min-height: 30px; padding: 0 14px; border: 1px solid rgba(120,120,128,.12); border-radius: 10px; color: var(--muted); background: rgba(120,120,128,.07); cursor: pointer; font-size: 10px; font-weight: 650; }
      .log-button:hover { color: var(--ink); background: rgba(120,120,128,.12); }
      .log-overlay { position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; padding: 16px; background: rgba(15,15,18,.38); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
      .log-overlay[hidden] { display: none !important; }
      .log-dialog { display: flex; flex-direction: column; width: min(440px, calc(100vw - 32px)); max-height: min(560px, calc(100dvh - 32px)); overflow: hidden; border: 0; border-radius: 22px; color: var(--ink); background: rgba(250,250,252,.97); box-shadow: 0 28px 80px rgba(0,0,0,.32); }
      .log-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 14px 10px 18px; }
      .log-header strong { font-size: 17px; letter-spacing: -.02em; }
      .log-header .icon-button { position: relative; }
      .close-glyph, .close-glyph::after { position: absolute; width: 13px; height: 2px; border-radius: 1px; background: currentColor; content: ""; transform: rotate(45deg); }
      .close-glyph::after { inset: 0; transform: rotate(90deg); }
      .log-list { display: grid; flex: 1; min-height: 72px; max-height: 470px; gap: 6px; padding: 0 10px 12px; overflow: auto; overscroll-behavior: contain; }
      .log-entry { display: grid; grid-template-columns: 58px minmax(0,1fr); gap: 9px; padding: 9px 10px; border-radius: 12px; background: rgba(120,120,128,.07); }
      .log-entry time { padding-top: 1px; color: var(--muted); font: 8px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .log-entry div { display: grid; min-width: 0; }
      .log-entry strong { font-size: 10px; font-weight: 700; }
      .log-entry div span { margin-top: 2px; color: var(--muted); font-size: 9px; }
      .log-empty { display: grid; min-height: 72px; place-items: center; padding: 24px; color: var(--muted); text-align: center; }
      footer { padding: 10px 14px 13px; color: rgba(22,23,26,.42); text-align: center; font-size: 9px; }
      button:focus-visible { outline: 3px solid rgba(0,174,236,.35); outline-offset: 2px; }
      @media (prefers-color-scheme: dark) {
        .shell { --ink: #f7f7f8; --muted: rgba(247,247,248,.58); }
        .panel { border-color: rgba(255,255,255,.12); background: rgba(31,31,34,.88); box-shadow: 0 28px 74px rgba(0,0,0,.46), inset 0 1px 0 rgba(255,255,255,.10); }
        .control-card, .cdn-row { background: rgba(255,255,255,.055); border-color: rgba(255,255,255,.07); }
        .route-map { background: rgba(251,114,153,.10); }
        .cdn-row.winner { background: linear-gradient(135deg, rgba(251,114,153,.14), rgba(255,255,255,.045)); }
        .icon-button { color: rgba(255,255,255,.72); background: rgba(255,255,255,.08); }
        .sample { background: rgba(255,255,255,.06); }
        .log-dialog { background: rgba(31,31,34,.98); }
        .log-button, .log-entry { background: rgba(255,255,255,.06); }
        footer { color: rgba(255,255,255,.36); }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
        .panel { transform: none; filter: none; }
      }
      @media (prefers-reduced-transparency: reduce) {
        .panel { background: #f8f8fa; backdrop-filter: none; -webkit-backdrop-filter: none; }
        .compact { background: var(--pink); backdrop-filter: none; -webkit-backdrop-filter: none; }
        @media (prefers-color-scheme: dark) { .panel { background: #202024; } }
      }
      @media (prefers-contrast: more) {
        .panel, .cdn-row, .control-card { border: 1px solid currentColor; }
        .panel { background: Canvas; color: CanvasText; }
      }
      @media (max-width: 520px) {
        .shell { right: 14px; bottom: 14px; }
        .panel { max-height: calc(100dvh - 16px); }
      }
    `;
  }

  function mount() {
    if (document.getElementById("bili-cdn-pilot-root")) return;
    const root = document.createElement("div");
    root.id = "bili-cdn-pilot-root";
    root.style.cssText = "all:initial;position:fixed;z-index:2147483000;";
    document.documentElement.appendChild(root);
    shadow = root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles();
    const shell = document.createElement("div");
    shell.className = "shell";
    shell.addEventListener("click", handleClick);
    shell.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !state.logsOpen) return;
      state.logsOpen = false;
      render();
      requestAnimationFrame(() => shadow?.querySelector('[data-action="open-logs"]')?.focus());
    });
    shadow.append(style, shell);
    mountShellMarkup(shell);
    render();
    monitorPlayback();
    setInterval(monitorPlayback, 2000);
    post(EVENTS.UI_READY);
  }

  window.addEventListener("message", handlePageMessage);
  chrome.storage.local.get({ [STORAGE.UI_PREFETCH_ENABLED]: true }).then((stored) => {
    state.prefetchEnabled = stored[STORAGE.UI_PREFETCH_ENABLED] === true;
    post(EVENTS.SET_PREFETCH, { enabled: state.prefetchEnabled });
    render();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
