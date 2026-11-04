# AGENTS.md

Handoff notes for this working copy. **Read this first** before changing anything: it records
what the project is, how it is wired, what has already been done, and where the work stopped.

Last updated: 2026-11-05 (branch `feat/popup-ui`).

---

## 1. What this project is

Bili Pilot is a browser extension for Bilibili video pages. It samples the CDN hosts that serve
the current video, ranks them by measured throughput, can pin the player to the fastest host, and
can pre-cache upcoming segments.

This repository is a **fork** (`Godwin9527/bili-pilot`) of the upstream project, used as a local
working copy where small behaviour changes are made. `main` mirrors upstream; work happens on
feature branches.

- Manifest V3, `minimum_chrome_version` 111, also declares a Gecko id for Firefox.
- Zero build step, zero dependencies. Plain scripts loaded in a fixed order by `manifest.json`.

## 2. Architecture: two script worlds

The extension is split because the player's signed URLs only exist inside the page context.

| World | Files | Responsibility |
| --- | --- | --- |
| `MAIN` (page context) | `page-protocol.js`, `core.js`, `probe-core.js`, `prefetch-store.js`, `prefetch-policy.js`, `prefetch-runtime.js`, `cached-xhr.js`, `page-hook.js` | Hook the player's XHR, capture real playback URLs, probe CDN throughput, choose a host, prefetch segments |
| `ISOLATED` (content script) | `protocol.js`, `i18n.js`, `ui-model.js`, `auto-probe-policy.js`, `content.js` | Owns all state, schedules probing, drives the page over `postMessage`, serves snapshots to the popup |
| Extension page | `popup.html`, `popup.css`, `popup.js` | The whole user interface |

Two message buses, both defined in code so do not invent channel names:

| Bus | Channel constant | Where |
| --- | --- | --- |
| page <-> content | `BILI_CDN_PILOT_V1` | `protocol.js`, `page-protocol.js` via `window.postMessage` |
| content <-> popup | `BILI_CDN_PILOT_POPUP_V1` | `content.js` + `popup.js` via a `runtime` port opened with `chrome.tabs.connect(tabId, { name: "bili-pilot-popup" })` |

Popup port contract:

- content -> popup: `{ channel, type: "snapshot", snapshot }`, throttled (~60 ms). Plan entries are
  trimmed and never contain signed URLs; the activity log is only attached when its revision changes.
- popup -> content: `{ channel, type: "command", command: { type } }` where `type` is one of
  `ready`, `scan`, `select`, `set-prefetch`, `reload`.
- The popup is a pure view. Closing it must never stop probing, routing, or pre-caching; every piece
  of state lives in `content.js` so reopening restores the view.

## 3. File map

| File | ~LOC | Role |
| --- | --- | --- |
| `page-hook.js` | 1280 | Page-side hook: player interception, host switching, prefetch execution |
| `core.js` | 660 | Pure domain logic (candidate ranking, state transitions) |
| `content.js` | 620 | Controller and state hub; no longer touches the page DOM |
| `popup.js` | 545 | Renders snapshots, sends commands |
| `prefetch-runtime.js` | 560 | Segment queue, scheduling, retries |
| `prefetch-store.js` | 395 | Cache bookkeeping |
| `probe-core.js` | 390 | Throughput measurement primitives |
| `cached-xhr.js` | 260 | Cached request layer |
| `auto-probe-policy.js` | 110 | When to re-probe |
| `i18n.js` | 136 | `t()` wrapper plus fallback dictionary |
| `ui-model.js` | 73 | View-model helpers shared by popup and tests |
| `protocol.js` / `page-protocol.js` | 54 each | Message channel constants and envelopes |

Tests live in `tests/*.test.mjs` (node's built-in runner) plus `tests/smoke.mjs`, which is a
structural assertion script rather than a unit test. `tests/ui-preview.html` renders the popup
outside the browser extension for visual checks.

## 4. Commands

```bash
npm run check      # node --check on every script + smoke.mjs + no-han test
npm test           # node --test tests/*.test.mjs
npm run package:chrome   # builds dist/Bili-Pilot-Chrome-<version>.zip
npm run package:firefox  # builds dist/Bili-Pilot-Firefox-<version>.xpi
```

`scripts/package-release.sh` copies files from an explicit whitelist, so a newly added runtime file
must be added there or it will be missing from release archives.

## 5. What has been done

### 2026-11-04 / 05 - floating panel replaced by the toolbar popup

The original extension injected an always-visible floating widget into the bottom-right corner of
every video page. It covered page UI, so it was moved into the extension action popup.

- `content.js`: rewritten as controller/state hub. Removed shadow DOM, injected CSS, drag handling,
  the compact pill, panel positioning, the log overlay, and all `patch*` render functions. Kept
  scanning, host selection, automatic probing, playback monitoring. Added the runtime port, snapshot
  broadcast, and command handling.
- `popup.html` / `popup.css` / `popup.js`: new. Fixed 372 px wide popup, reuses the old visual style,
  queries the active tab, connects to the content script, renders snapshots, sends commands.
- `manifest.json`: `action.default_popup = "popup.html"`; added `https://www.bilibili.com/*` to
  `host_permissions` so the popup can read the active tab URL.
- `i18n.js` + all four locales: added `popupConnectFailed`.
- Tests: UI assertions retargeted from `content.js` to `popup.js` / `popup.css`; i18n key scan now
  covers `popup.js`; `check` runs `node --check popup.js`; packaging whitelist includes the popup files.
- Also fixed a pre-existing test bug: `tests/no-han.test.mjs` compared a path prefix with `/`, which
  never matched on Windows, so the test failed there for every file.

Commits: `09d6224` (the refactor), `a082e68` (ignore `.workbuddy/`).

Current git state:

| Ref | Commit | Notes |
| --- | --- | --- |
| `feat/popup-ui` | `a082e68` | pushed to `origin`, tracks upstream |
| `origin/main` | `395e017` | untouched, still upstream |

## 6. Conventions that will break the tests if ignored

- **No Han characters** in any `.js`, `.css`, `.html`, `.json`, `.md`, `.mjs` file except
  `_locales/zh_*/messages.json` and `README.zh-CN.md` (`tests/no-han.test.mjs`). That is why this file
  is written in English. User-facing text belongs in the locale files.
- Every UI string goes through `i18n.js` and must exist in all four locales (`en`, `zh_CN`, `zh_TW`,
  `ru`); `tests/i18n.test.mjs` checks that keys referenced by `content.js`, `popup.js`, and
  `ui-model.js` are present and consistent.
- `tests/smoke.mjs` asserts specific selectors, class names, and markers in `popup.html`,
  `popup.css`, and `popup.js`. Renaming a class or id means updating that script in the same commit.
- Keep the popup free of layout dependence on the page: no `position: fixed`, no injected elements.
- Do not add a build step or dependencies without a strong reason; the project ships raw scripts.

## 7. Environment gotchas

- **Windows + headless Chrome**: `--user-data-dir` and `--screenshot` must be absolute paths.
  A relative path makes Chrome pop a native dialog saying it cannot create the data directory
  instead of running headless.
- Do not put a throwaway Chrome profile inside the repository: the no-han test scans every file in
  the repo and a profile contains localized (Chinese) files. Use `%TEMP%` instead.
- Visual check of the popup without loading the extension:

  ```bash
  "<chrome>" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=380,600 --virtual-time-budget=2500 \
    --screenshot="<absolute path>.png" \
    --user-data-dir="<absolute temp dir>" \
    "file:///<repo>/tests/ui-preview.html"
  ```

  `tests/ui-preview.html` mocks `chrome.tabs` and `chrome.i18n`; the locale JSON is read with a
  synchronous XHR that fails on `file://`, so it falls back to English. Pass `?locale=zh_CN` to try
  another locale.
- After reloading the unpacked extension, every already-open Bilibili tab must be reloaded once,
  otherwise the new content script is not attached and the popup reports "not connected".

## 8. Known gaps / possible next steps

- No toolbar badge. Showing state on the icon needs a background service worker, which does not
  exist yet.
- Firefox is declared but the popup size and styling were only verified in Chromium.
- `feat/popup-ui` is not merged into `main`; merging is a fast-forward and has not been done.
- `panelPositionV1`-style legacy storage keys from the floating panel era may still be present in
  users' storage and are no longer read.

## 9. Working agreement with the repository owner

- Communicate in Chinese; code, comments, commits, and repository files stay in English.
- Discuss the plan and get explicit approval before executing a change.
- Back up before anything destructive or irreversible.
- When the work is done and the repo has a git remote, commit and push it, then report the branch
  and commit hash.
