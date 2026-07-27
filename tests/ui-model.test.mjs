import assert from "node:assert/strict";
import test from "node:test";

await import("../ui-model.js");

const model = globalThis.BiliCdnUiModel;

test("UI model derives stable keyed CDN rows without DOM state", () => {
  const plan = {
    candidates: [
      { host: "cos.example", label: "COSOV", isPrimary: true },
      { host: "akam.example", label: "Akamai", isPrimary: false }
    ],
    currentPrimary: "cos.example",
    preferredHost: null
  };
  const rows = model.resultViewModels(plan, []);
  assert.deepEqual(rows.map((row) => row.result.host), ["akam.example", "cos.example"]);
  assert.equal(rows.find((row) => row.result.host === "cos.example").nativeDefault, true);

  const measured = model.resultViewModels(plan, [{
    failures: 0,
    host: "akam.example",
    label: "Akamai",
    minMbps: 50,
    samples: [],
    score: 10
  }]);
  assert.equal(measured[0].isWinner, true);
  assert.equal(measured[0].measured, true);
  assert.equal(measured[1].measured, false);
});

test("UI model formats playback diagnostics consistently", () => {
  assert.equal(model.formatSpeed(120.4), "120 Mbps");
  assert.equal(model.formatFailure("timeout"), "Timed out");
  assert.equal(model.qualitySummary({ codec: "avc1", height: 2160, width: 3840 }), "3840×2160 / avc1");
});
