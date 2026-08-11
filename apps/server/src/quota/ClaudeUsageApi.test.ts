import { describe, expect, it } from "vite-plus/test";

import { nextMonthStartUtc, parseClaudeUsageResponse, prettifyPlanTier } from "./ClaudeUsageApi.ts";

const NOW = "2026-07-24T10:00:00.000Z";

describe("parseClaudeUsageResponse", () => {
  it("parses a realistic limits payload into scoped windows", () => {
    const body = {
      limits: [
        {
          kind: "session",
          percent: 64,
          severity: "normal",
          resets_at: "2026-07-08T22:29:59Z",
          scope: null,
          is_active: false,
        },
        {
          kind: "weekly_all",
          percent: 80,
          severity: "warning",
          resets_at: "2026-07-10T00:00:00Z",
          scope: null,
          is_active: false,
        },
        {
          kind: "weekly_scoped",
          percent: 97,
          severity: "critical",
          resets_at: "2026-07-10T00:00:00Z",
          scope: { model: { id: null, display_name: "Fable" } },
          is_active: true,
        },
      ],
    };

    const parsed = parseClaudeUsageResponse(body, NOW);

    expect(parsed.degraded).toBe(false);
    expect(parsed.windows.map((window) => window.id)).toEqual([
      "session:all",
      "weekly:all",
      "weekly:model:Fable",
    ]);

    const [session, weeklyAll, weeklyFable] = parsed.windows;
    expect(session).toMatchObject({
      kind: "session",
      scope: { kind: "all" },
      percent: 64,
      severity: "normal",
      resetsAt: "2026-07-08T22:29:59Z",
      windowHours: 5,
      isActive: false,
      billing: "subscription",
    });
    expect(weeklyAll).toMatchObject({
      kind: "weekly",
      scope: { kind: "all" },
      percent: 80,
      severity: "warning",
      windowHours: 168,
    });
    expect(weeklyFable).toMatchObject({
      kind: "weekly",
      scope: { kind: "model", displayName: "Fable" },
      percent: 97,
      severity: "critical",
      windowHours: 168,
      isActive: true,
    });
  });

  it("drops malformed limits entries individually and stays non-degraded", () => {
    const body = {
      limits: [
        { kind: "session", percent: 12, severity: "normal", resets_at: null, scope: null },
        { kind: "weekly_all", severity: "normal" }, // missing percent
        "garbage", // not an object
        42,
      ],
    };

    const parsed = parseClaudeUsageResponse(body, NOW);

    expect(parsed.windows.map((window) => window.id)).toEqual(["session:all"]);
    expect(parsed.degraded).toBe(false);
  });

  it("reports degraded when every limits entry is malformed", () => {
    const body = {
      limits: [{ kind: "session" }, { percent: 50 }, null],
    };

    const parsed = parseClaudeUsageResponse(body, NOW);

    expect(parsed.windows).toEqual([]);
    expect(parsed.degraded).toBe(true);
  });

  it("falls back to five_hour/seven_day scalars when limits is absent", () => {
    const body = {
      five_hour: { utilization: 64, resets_at: "2026-07-08T22:29:59Z" },
      seven_day: { utilization: 80, resets_at: "2026-07-10T00:00:00Z" },
    };

    const parsed = parseClaudeUsageResponse(body, NOW);

    expect(parsed.degraded).toBe(false);
    expect(parsed.windows.map((window) => window.id)).toEqual(["session:all", "weekly:all"]);
    expect(parsed.windows[0]).toMatchObject({
      kind: "session",
      percent: 64,
      resetsAt: "2026-07-08T22:29:59Z",
      windowHours: 5,
    });
    expect(parsed.windows[1]).toMatchObject({
      kind: "weekly",
      percent: 80,
      resetsAt: "2026-07-10T00:00:00Z",
      windowHours: 168,
    });
  });

  it("emits the monthly spend pool from extra_usage even when is_enabled is false", () => {
    const body = {
      extra_usage: {
        monthly_limit: 10000,
        used_credits: 2500,
        decimal_places: 2,
        is_enabled: false,
      },
    };

    const parsed = parseClaudeUsageResponse(body, NOW);

    const monthly = parsed.windows.find((window) => window.id === "monthly:all");
    expect(monthly).toBeDefined();
    expect(monthly).toMatchObject({
      kind: "monthly",
      scope: { kind: "all" },
      percent: 25,
      severity: "normal",
      billing: "pay-per-use",
      dollars: { used: 25, limit: 100, currency: "USD" },
      resetsAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("omits the monthly window when monthly_limit is null", () => {
    const body = {
      extra_usage: { monthly_limit: null, used_credits: 2500, decimal_places: 2 },
    };

    const parsed = parseClaudeUsageResponse(body, NOW);

    expect(parsed.windows.find((window) => window.id === "monthly:all")).toBeUndefined();
  });

  it("tolerates explicit JSON nulls on scalar fields without throwing", () => {
    const body = {
      five_hour: null,
      seven_day: { utilization: null, resets_at: null },
      extra_usage: null,
      limits: null,
    };

    const parsed = parseClaudeUsageResponse(body, NOW);

    expect(parsed.windows).toEqual([]);
    expect(parsed.degraded).toBe(false);
  });
});

describe("prettifyPlanTier", () => {
  it("maps max multiplier tiers", () => {
    expect(prettifyPlanTier("default_claude_max_20x")).toBe("Max 20x");
  });

  it("maps plain max tiers", () => {
    expect(prettifyPlanTier("claude_max")).toBe("Max");
  });

  it("maps pro tiers", () => {
    expect(prettifyPlanTier("raven_pro")).toBe("Pro");
  });

  it("passes unknown tiers through unchanged", () => {
    expect(prettifyPlanTier("mystery_tier")).toBe("mystery_tier");
  });
});

describe("nextMonthStartUtc", () => {
  it("anchors to the first instant of the next month", () => {
    expect(nextMonthStartUtc("2026-07-24T10:00:00.000Z")).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rolls over December into January of the next year", () => {
    expect(nextMonthStartUtc("2026-12-15T23:59:59.000Z")).toBe("2027-01-01T00:00:00.000Z");
  });
});
