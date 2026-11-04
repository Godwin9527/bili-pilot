(function installBiliCdnPopup() {
  "use strict";

  const i18n = globalThis.BiliCdnI18n;
  const uiModel = globalThis.BiliCdnUiModel;
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!i18n || !uiModel || !extensionApi) return;
  const { locale, t } = i18n;
  const {
    formatFailure,
    formatPosition: formatSamplePoint,
    formatSpeed,
    qualitySummary,
    resultViewModels
  } = uiModel;
  const POPUP_PORT = "bili-pilot-popup";
  const POPUP_CHANNEL = "BILI_CDN_PILOT_POPUP_V1";
  const VIDEO_URL_PATTERN = /^https:\/\/www\.bilibili\.com\/video\//;
  const EMPTY_PREFETCH = { backoff: 0, bytes: 0, circuitOpenInMs: 0, failed: 0, foreground: 0, hosts: {}, loading: 0, queued: 0, ready: 0, retrying: 0, segments: [] };
  const view = {
    activity: [],
    activityVersion: -1,
    connected: false,
    contextInvalidated: false,
    disconnectedReason: "",
    locale,
    logsOpen: false,
    plan: null,
    prefetch: EMPTY_PREFETCH,
    prefetchEnabled: true,
    results: [],
    renderCount: 0,
    scanning: false,
    status: t("waitingForRoutes"),
    statusKind: "idle",
    version: ""
  };

  let shell = null;
  let port = null;
  let activeTabId = null;
  let renderFrame = 0;

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

  function candidateLabel(host) {
    return view.plan?.candidates?.find((candidate) => candidate.host === host)?.label || host || t("currentRoute");
  }

  function formatLogTime(value) {
    try {
      return new Date(value).toLocaleTimeString(view.locale.replaceAll("_", "-"), {
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

  function mountShellMarkup(target) {
    if (target.dataset.mounted === "true") return;
    target.lang = view.locale.replaceAll("_", "-");
    target.innerHTML = `
      <section class="panel" aria-label="${escapeHtml(t("appName"))}">
        <header class="panel-header">
          <div class="brand">
            <span class="brand-mark">↯</span>
            <div><strong>${escapeHtml(t("appName"))}</strong><span>${escapeHtml(t("tagline"))}</span></div>
          </div>
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
        <footer data-bind="footer">${escapeHtml(t("footer", [view.version || "—"]))}</footer>
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
    target.dataset.mounted = "true";
  }

  function patchRouteMap(root) {
    const routeMap = root.querySelector(".route-map");
    const container = root.querySelector(".route-map-chips");
    const segments = view.prefetchEnabled && Array.isArray(view.prefetch.segments)
      ? view.prefetch.segments.slice(0, 8)
      : [];
    routeMap.hidden = !view.prefetchEnabled;
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
      const candidate = view.plan?.candidates?.find((item) => item.host === segment.host);
      const speed = Number(segment.probeMbps || 0);
      const ranking = (segment.candidateHosts || []).map((host) =>
        view.plan?.candidates?.find((item) => item.host === host)?.label || host).join(" > ");
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

  function patchLogDialog(root) {
    const overlay = root.querySelector('[data-bind="log-overlay"]');
    overlay.hidden = !view.logsOpen;
    if (!view.logsOpen) return;
    const entries = view.activity;
    const list = root.querySelector('[data-bind="log-list"]');
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
    const empty = list.querySelector(":scope > .log-empty");
    if (!entries.length) {
      if (!empty) {
        const node = document.createElement("div");
        node.className = "log-empty";
        setText(node, t("noLogsYet"));
        list.appendChild(node);
      }
    } else {
      empty?.remove();
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

  function patchResultRows(root) {
    const container = root.querySelector(".results");
    const models = resultViewModels(view.plan, view.results);
    let empty = container.querySelector(":scope > .empty");
    if (!models.length) {
      [...container.children].forEach((node) => {
        if (!node.classList.contains("empty")) node.remove();
      });
      if (!empty) {
        empty = document.createElement("div");
        empty.className = "empty";
        container.appendChild(empty);
      }
      setText(empty, t("openVideo"));
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
      button.disabled = preferred || view.contextInvalidated || !view.connected;
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
    if (!shell) return;
    mountShellMarkup(shell);
    view.renderCount += 1;
    shell.dataset.renderCount = String(view.renderCount);
    shell.dataset.connected = String(view.connected);
    setText(shell.querySelector('[data-bind="quality-label"]'), view.plan?.qualityLabel || t("waitingForVideo"));
    setText(shell.querySelector('[data-bind="quality-summary"]'), qualitySummary(view.plan));
    setText(shell.querySelector('[data-bind="footer"]'), t("footer", [view.version || "—"]));
    setClass(shell.querySelector(".pulse-orbit"), `pulse-orbit${view.scanning ? " is-scanning" : ""}`);
    const statusLine = shell.querySelector(".status-line");
    setClass(statusLine, `status-line ${view.statusKind}`);
    const statusIcon = shell.querySelector(".status-icon");
    if (view.scanning) {
      setClass(statusIcon, "status-icon spinner");
      setText(statusIcon, "");
    } else {
      const glyph = { success: "✓", warning: "!", error: "×", idle: "•" }[view.statusKind] || "•";
      setClass(statusIcon, `status-icon status-glyph ${view.statusKind}`);
      setText(statusIcon, glyph);
    }
    setText(shell.querySelector('[data-bind="status-text"]'), view.status);
    shell.querySelector(".refresh-button").hidden = !view.contextInvalidated && view.connected;
    const toggle = shell.querySelector('[data-action="toggle-prefetch"]');
    setClass(toggle, `switch${view.prefetchEnabled ? " on" : ""}`);
    toggle.setAttribute("aria-checked", String(view.prefetchEnabled));
    toggle.disabled = view.contextInvalidated || !view.connected;
    patchRouteMap(shell);
    setText(shell.querySelector('[data-bind="candidate-count"]'), t("routeCount", [view.plan?.candidates?.length || 0]));
    const scansDisabled = view.scanning || !view.plan || view.contextInvalidated || !view.connected;
    shell.querySelector('[data-action="scan-quick"]').disabled = scansDisabled;
    shell.querySelector('[data-action="scan-deep"]').disabled = scansDisabled;
    patchResultRows(shell);
    patchLogDialog(shell);
  }

  function render() {
    if (!shell || renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      patchRender();
    });
  }

  function postCommand(command, detail = {}) {
    if (!port) return false;
    try {
      port.postMessage({ channel: POPUP_CHANNEL, command, ...detail });
      return true;
    } catch {
      port = null;
      view.connected = false;
      view.disconnectedReason = "lost";
      view.status = t("popupConnectFailed");
      view.statusKind = "warning";
      render();
      return false;
    }
  }

  function setDisconnected(reason) {
    view.connected = false;
    view.disconnectedReason = reason;
    view.plan = null;
    view.results = [];
    view.prefetch = EMPTY_PREFETCH;
    view.scanning = false;
    view.statusKind = reason === "no-video" ? "idle" : "warning";
    view.status = reason === "no-video" ? t("openVideo") : t("popupConnectFailed");
    render();
  }

  function handleSnapshot(message) {
    if (!message || message.type !== "snapshot") return;
    view.connected = true;
    view.disconnectedReason = "";
    view.contextInvalidated = message.contextInvalidated === true;
    view.locale = String(message.locale || view.locale);
    view.plan = message.plan || null;
    view.prefetch = { ...EMPTY_PREFETCH, ...(message.prefetch || {}) };
    view.prefetchEnabled = message.prefetchEnabled === true;
    view.results = Array.isArray(message.results) ? message.results : [];
    view.scanning = message.scanning === true;
    view.status = String(message.status || "");
    view.statusKind = message.statusKind || "idle";
    view.version = String(message.version || "");
    if (Array.isArray(message.activity)) {
      view.activity = message.activity;
      view.activityVersion = Number(message.activityVersion ?? view.activityVersion);
    }
    render();
  }

  function reloadTarget() {
    if (port && postCommand("reload")) return;
    if (Number.isFinite(activeTabId)) {
      Promise.resolve(extensionApi.tabs.reload(activeTabId)).catch(() => {});
    }
  }

  function handleClick(event) {
    if (event.target?.matches?.('[data-bind="log-overlay"]')) {
      view.logsOpen = false;
      render();
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === "open-logs") {
      view.logsOpen = true;
      render();
      requestAnimationFrame(() => shell?.querySelector('[data-action="close-logs"]')?.focus());
      return;
    }
    if (action === "close-logs") {
      view.logsOpen = false;
      render();
      requestAnimationFrame(() => shell?.querySelector('[data-action="open-logs"]')?.focus());
      return;
    }
    if (action === "reload-page") {
      reloadTarget();
      return;
    }
    if (!view.connected || view.contextInvalidated) return;
    if (action === "scan-quick") postCommand("scan", { mode: "quick" });
    if (action === "scan-deep") postCommand("scan", { mode: "deep" });
    if (action === "select") postCommand("select", { host: button.dataset.host });
    if (action === "toggle-prefetch") postCommand("set-prefetch", { enabled: !view.prefetchEnabled });
  }

  function handleKeydown(event) {
    if (event.key !== "Escape" || !view.logsOpen) return;
    view.logsOpen = false;
    render();
    requestAnimationFrame(() => shell?.querySelector('[data-action="open-logs"]')?.focus());
  }

  async function connect() {
    try {
      const tabs = await extensionApi.tabs.query({ active: true, currentWindow: true });
      const tab = Array.isArray(tabs) ? tabs[0] : null;
      activeTabId = Number.isFinite(tab?.id) ? tab.id : null;
      const url = String(tab?.url || "");
      if (url && !VIDEO_URL_PATTERN.test(url)) {
        setDisconnected("no-video");
        return;
      }
      if (!Number.isFinite(activeTabId)) {
        setDisconnected("no-video");
        return;
      }
      port = extensionApi.tabs.connect(activeTabId, { name: POPUP_PORT });
      port.onMessage.addListener(handleSnapshot);
      port.onDisconnect.addListener(() => {
        port = null;
        setDisconnected("lost");
      });
      view.connected = true;
      postCommand("ready");
      render();
    } catch {
      setDisconnected("no-video");
    }
  }

  function mount() {
    shell = document.getElementById("shell");
    if (!shell) return;
    document.documentElement.lang = view.locale.replaceAll("_", "-");
    shell.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeydown);
    mountShellMarkup(shell);
    render();
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
