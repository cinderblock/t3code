import { describe, expect, it } from "vite-plus/test";

import { ENVIRONMENT_SETTLE_GRACE_MS, shouldWaitForEnvironments } from "./useEnvironmentsSettled";

describe("shouldWaitForEnvironments", () => {
  const wait = (bootstrapped: boolean, elapsedMs: number, graceMs = ENVIRONMENT_SETTLE_GRACE_MS) =>
    shouldWaitForEnvironments({ bootstrapped, elapsedMs, graceMs });

  it("does not wait once every environment has bootstrapped", () => {
    expect(wait(true, 0)).toBe(false);
  });

  it("waits briefly so a fast local backend still wins the race", () => {
    expect(wait(false, 0)).toBe(true);
    expect(wait(false, ENVIRONMENT_SETTLE_GRACE_MS - 1)).toBe(true);
  });

  // The failure this exists for: an outdated remote answers the socket but never delivers a
  // shell snapshot, so it is neither disconnected nor bootstrapped and the strict gate stays
  // false for the whole session. That blanked the chat landing and stopped new draft threads
  // from ever starting, on a machine whose local backend was perfectly healthy.
  it("stops waiting once the grace period expires with an environment still unsettled", () => {
    expect(wait(false, ENVIRONMENT_SETTLE_GRACE_MS)).toBe(false);
    expect(wait(false, 60 * 60 * 1000)).toBe(false);
  });

  it("prefers the bootstrapped signal over the deadline", () => {
    expect(wait(true, ENVIRONMENT_SETTLE_GRACE_MS - 1)).toBe(false);
  });
});
