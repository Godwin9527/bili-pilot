import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

await import("../protocol.js");

const protocol = globalThis.BiliCdnProtocol;

test("protocol centralizes cross-world event and storage contracts", () => {
  const message = protocol.createMessage(protocol.EVENTS.SELECT_HOST, { host: "cdn.example" });
  assert.deepEqual(message, {
    channel: protocol.CHANNEL,
    host: "cdn.example",
    type: "BCO_SELECT_HOST"
  });
  assert.equal(protocol.STORAGE.PAGE_PREFETCH_ENABLED, "bco:v4:prefetch-enabled");
  assert.equal(protocol.STORAGE.UI_PREFETCH_ENABLED, "prefetchEnabledV1");
  assert.equal(protocol.EVENTS.ACTIVITY, "BCO_ACTIVITY");
  assert.throws(() => protocol.createMessage("BCO_UNKNOWN"), /Unknown Bili Pilot event/);
});

test("page and isolated-world protocol adapters stay identical", async () => {
  async function loadAdapter(file) {
    const context = vm.createContext({
      location: { origin: "https://www.bilibili.com" },
      postMessage() {}
    });
    vm.runInContext(await readFile(new URL(file, import.meta.url), "utf8"), context);
    return context.BiliCdnProtocol;
  }

  const isolated = await loadAdapter("../protocol.js");
  const page = await loadAdapter("../page-protocol.js");
  assert.equal(page.CHANNEL, isolated.CHANNEL);
  assert.deepEqual({ ...page.EVENTS }, { ...isolated.EVENTS });
  assert.deepEqual({ ...page.STORAGE }, { ...isolated.STORAGE });
});
