import assert from "node:assert/strict";
import test from "node:test";

await import("../auto-probe-policy.js");

const policy = globalThis.BiliCdnAutoProbePolicy;

function safeMedia(overrides = {}) {
  return {
    bufferedAhead: 30,
    exists: true,
    paused: false,
    readyState: 4,
    ...overrides
  };
}

test("scheduled probes require a safe current player state", () => {
  const scheduler = policy.createScheduler();
  scheduler.reset("track-a");

  assert.equal(scheduler.takeNextProbe({ now: 1_000, media: safeMedia({ exists: false }) }), null);
  assert.equal(scheduler.takeNextProbe({ now: 1_000, media: safeMedia({ paused: true, readyState: 1 }) }), null);
  assert.equal(scheduler.takeNextProbe({ now: 1_000, media: safeMedia({ bufferedAhead: 23.9 }) }), null);
  assert.equal(scheduler.takeNextProbe({ now: 1_000, media: safeMedia({ readyState: 3 }) }), null);

  const pausedToken = scheduler.takeNextProbe({ now: 1_000, media: safeMedia({ paused: true, readyState: 2 }) });
  assert.equal(pausedToken.trigger, "initial");
});

test("runs an initial probe and then waits for the periodic interval", () => {
  const scheduler = policy.createScheduler({ periodicIntervalMs: 300_000 });
  scheduler.reset("track-a");

  const initial = scheduler.takeNextProbe({ now: 1_000, media: safeMedia() });
  scheduler.completeProbe(initial, {}, 1_000);
  assert.equal(scheduler.takeNextProbe({ now: 300_999, media: safeMedia() }), null);
  assert.equal(scheduler.takeNextProbe({ now: 301_000, media: safeMedia() }).trigger, "periodic");
});

test("playback problems trigger immediately and use exponential backoff", () => {
  const scheduler = policy.createScheduler({ periodicIntervalMs: 1_000 });
  scheduler.reset("track-a");
  const initial = scheduler.takeNextProbe({ now: 1_000, media: safeMedia() });
  scheduler.completeProbe(initial, {}, 1_000);

  assert.equal(scheduler.signalProblem("track-a"), true);
  const recovery = scheduler.takeNextProbe({ now: 2_000, media: safeMedia({ exists: false }) });
  assert.equal(recovery.trigger, "recovery");
  assert.equal(scheduler.takeNextProbe({ now: 2_000, media: safeMedia() }), null);
  assert.equal(scheduler.isRecovering(), true);
  assert.deepEqual(scheduler.completeProbe(recovery, { routeChanged: false }, 2_000), {
    recoveryAttempt: 1,
    retryAt: 12_000
  });
  assert.equal(scheduler.takeNextProbe({ now: 3_000, media: safeMedia() }), null);
  assert.equal(scheduler.takeNextProbe({ now: 11_999, media: safeMedia() }), null);
  assert.equal(scheduler.takeNextProbe({ now: 12_000, media: safeMedia() }).trigger, "recovery");
});

test("recovery backoff is capped and repeated problems are coalesced", () => {
  const scheduler = policy.createScheduler();
  scheduler.reset("track-a");
  scheduler.signalProblem("track-a");

  let now = 1_000;
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const token = scheduler.takeNextProbe({ now, media: safeMedia({ exists: false }) });
    assert.equal(token.trigger, "recovery");
    scheduler.signalProblem("track-a");
    const completion = scheduler.completeProbe(token, {}, now);
    const delay = Math.min(300_000, 10_000 * (2 ** (attempt - 1)));
    assert.equal(completion.retryAt, now + delay);
    assert.equal(scheduler.takeNextProbe({ now: now + delay - 1, media: safeMedia() }), null);
    now += delay;
  }
});

test("route and track changes clear or invalidate recovery work", () => {
  const scheduler = policy.createScheduler();
  scheduler.reset("track-a");
  scheduler.signalProblem("track-a");
  const recovery = scheduler.takeNextProbe({ now: 1_000, media: safeMedia() });

  scheduler.noteRouteChange("track-a");
  assert.equal(scheduler.isRecovering(), true);
  scheduler.completeProbe(recovery, { routeChanged: false }, 1_000);
  assert.equal(scheduler.isRecovering(), false);

  scheduler.signalProblem("track-a");
  const stale = scheduler.takeNextProbe({ now: 2_000, media: safeMedia() });
  scheduler.reset("track-b");
  assert.equal(scheduler.completeProbe(stale, {}, 2_000), null);
  assert.equal(scheduler.takeNextProbe({ now: 2_000, media: safeMedia() }).signature, "track-b");
});

test("a successful recovery route change resets backoff", () => {
  const scheduler = policy.createScheduler();
  scheduler.reset("track-a");
  scheduler.signalProblem("track-a");
  const recovery = scheduler.takeNextProbe({ now: 1_000, media: safeMedia() });

  assert.deepEqual(scheduler.completeProbe(recovery, { routeChanged: true }, 1_000), {
    recoveryAttempt: 0,
    retryAt: 0
  });
  assert.equal(scheduler.isRecovering(), false);
  assert.equal(scheduler.takeNextProbe({ now: 2_000, media: safeMedia() }), null);
});
