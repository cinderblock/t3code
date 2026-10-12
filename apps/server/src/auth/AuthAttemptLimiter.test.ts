import { describe, expect, it } from "vite-plus/test";

import { makeWindowCounter } from "./AuthAttemptLimiter.ts";

describe("makeWindowCounter", () => {
  it("blocks an address once it reaches the limit, until its window ends", () => {
    const counter = makeWindowCounter({ limit: 3, windowMs: 60_000 });
    for (let attempt = 0; attempt < 3; attempt += 1) counter.record("a", 1_000);
    expect(counter.blockedFor("a", 1_000)).toBe(60);
    expect(counter.blockedFor("a", 31_000)).toBe(30);
    expect(counter.blockedFor("a", 61_000)).toBeNull();
  });

  it("keeps addresses independent", () => {
    const counter = makeWindowCounter({ limit: 1, windowMs: 60_000 });
    counter.record("a", 0);
    expect(counter.blockedFor("a", 0)).not.toBeNull();
    expect(counter.blockedFor("b", 0)).toBeNull();
  });
});
