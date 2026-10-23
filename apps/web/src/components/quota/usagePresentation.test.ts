import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  accountWindowIdForKind,
  emphasizedWeeklyWindowId,
  formatPercent,
  formatUsageAge,
  oldestUsageCheckMs,
  sortWindowsForDisplay,
  usageIsStale,
  usageRefreshDue,
  windowScopeName,
  windowSeverity,
  windowShortLabel,
} from "./usagePresentation";

const makeWindow = (overrides: Partial<ServerProviderUsageWindow>): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 50,
  windowDurationMins: 7 * 24 * 60,
  ...overrides,
});

const session = makeWindow({
  id: "five_hour",
  kind: "session",
  label: "Session",
  windowDurationMins: 300,
});
const weekly = makeWindow({ id: "seven_day" });
const weeklyFable = makeWindow({ id: "seven_day_fable", label: "Fable" });
const weeklyOpus = makeWindow({ id: "seven_day_opus", label: "Opus" });
const monthly = makeWindow({
  id: "monthly",
  kind: "monthly",
  label: "Monthly",
  windowDurationMins: 720 * 60,
});

describe("windowScopeName", () => {
  it("treats the provider's kind-labelled windows as account-wide", () => {
    expect(windowScopeName(session)).toBeNull();
    expect(windowScopeName(weekly)).toBeNull();
    expect(windowScopeName(makeWindow({ id: "primary", label: "Primary" }))).toBeNull();
  });

  it("reads a model-scoped window's model off its label", () => {
    expect(windowScopeName(weeklyFable)).toBe("Fable");
    // Claude's probe labels scoped weeklies `Weekly · <model>`.
    expect(windowScopeName(makeWindow({ id: "seven_day_fable", label: "Weekly · Fable" }))).toBe(
      "Fable",
    );
  });
});

describe("windowShortLabel", () => {
  it("names the windows the way the strip has always shown them", () => {
    expect(windowShortLabel(session)).toBe("5h");
    expect(windowShortLabel(weekly)).toBe("Week");
    expect(windowShortLabel(weeklyFable)).toBe("Week · Fable");
    expect(windowShortLabel(monthly)).toBe("Month");
  });
});

describe("sortWindowsForDisplay", () => {
  it("orders session, then weekly (account-wide before scoped, scoped alphabetical), then monthly", () => {
    const sorted = sortWindowsForDisplay([monthly, weeklyOpus, weeklyFable, weekly, session]);
    expect(sorted.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_fable",
      "seven_day_opus",
      "monthly",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [weekly, session];
    sortWindowsForDisplay(input);
    expect(input.map((window) => window.id)).toEqual(["seven_day", "five_hour"]);
  });
});

describe("emphasizedWeeklyWindowId", () => {
  const windows = [session, weekly, weeklyFable, weeklyOpus];

  it("emphasizes the model-scoped weekly window matching the selected slug", () => {
    expect(emphasizedWeeklyWindowId(windows, "claude-fable-5-1")).toBe("seven_day_fable");
  });

  it("falls back to the account-wide weekly window when no scoped window matches", () => {
    expect(emphasizedWeeklyWindowId(windows, "claude-haiku-4-5")).toBe("seven_day");
  });

  it("emphasizes the account-wide weekly window when no model is selected", () => {
    expect(emphasizedWeeklyWindowId(windows, null)).toBe("seven_day");
  });

  it("returns null when there are no weekly windows", () => {
    expect(emphasizedWeeklyWindowId([session], "claude-fable-5-1")).toBeNull();
  });
});

describe("accountWindowIdForKind", () => {
  it("picks the account-wide window of the kind", () => {
    const account = {
      limits: { checkedAt: "2026-09-10T00:00:00.000Z", windows: [weeklyFable, weekly, session] },
    };
    expect(accountWindowIdForKind(account, "weekly")).toBe("seven_day");
    expect(accountWindowIdForKind(account, "session")).toBe("five_hour");
  });

  it("falls back to the legacy kind id the server still resolves", () => {
    const account = { limits: { checkedAt: "2026-09-10T00:00:00.000Z", windows: [session] } };
    expect(accountWindowIdForKind(account, "weekly")).toBe("weekly:all");
  });
});

describe("windowSeverity", () => {
  it("escalates on the used share", () => {
    expect(windowSeverity(makeWindow({ usedPercent: 10 }))).toBe("normal");
    expect(windowSeverity(makeWindow({ usedPercent: 75 }))).toBe("warning");
    expect(windowSeverity(makeWindow({ usedPercent: 90 }))).toBe("critical");
    expect(windowSeverity(makeWindow({ usedPercent: 100 }))).toBe("exceeded");
  });
});

describe("usage freshness", () => {
  const nowMs = Date.parse("2026-09-10T12:00:00Z");
  const fiveMinutes = 5 * 60_000;
  const minutesAgo = (minutes: number) => nowMs - minutes * 60_000;

  it("asks for a read only once the server's own interval has clearly lapsed", () => {
    expect(usageRefreshDue(minutesAgo(5.5), nowMs, fiveMinutes)).toBe(false);
    expect(usageRefreshDue(minutesAgo(7), nowMs, fiveMinutes)).toBe(true);
  });

  it("never asks when background refresh is off or nothing has been read", () => {
    expect(usageRefreshDue(minutesAgo(120), nowMs, 0)).toBe(false);
    expect(usageRefreshDue(null, nowMs, fiveMinutes)).toBe(false);
  });

  it("marks numbers stale after twice the interval, and never inside ten minutes", () => {
    expect(usageIsStale(minutesAgo(9), nowMs, fiveMinutes)).toBe(false);
    expect(usageIsStale(minutesAgo(11), nowMs, fiveMinutes)).toBe(true);
    expect(usageIsStale(minutesAgo(25), nowMs, 15 * 60_000)).toBe(false);
    expect(usageIsStale(minutesAgo(31), nowMs, 15 * 60_000)).toBe(true);
  });

  it("dates by the oldest account that can still get newer", () => {
    const at = (iso: string, reason?: "unsupported" | "probeFailed") => ({
      limits: {
        checkedAt: iso,
        windows: [],
        ...(reason ? { unavailable: { reason } } : {}),
      },
    });
    expect(
      oldestUsageCheckMs([
        at("2026-09-10T11:50:00Z"),
        at("2026-09-10T09:00:00Z", "unsupported"),
        at("2026-09-10T11:20:00Z", "probeFailed"),
      ]),
    ).toBe(Date.parse("2026-09-10T11:20:00Z"));
    expect(oldestUsageCheckMs([at("2026-09-10T09:00:00Z", "unsupported")])).toBeNull();
  });

  it("formats the age of a read", () => {
    expect(formatUsageAge(nowMs - 20_000, nowMs)).toBe("just now");
    expect(formatUsageAge(minutesAgo(125), nowMs)).toBe("2h 5m ago");
  });
});

describe("formatPercent", () => {
  it("keeps one decimal below ten percent and rounds above", () => {
    expect(formatPercent(3.25)).toBe("3.3%");
    expect(formatPercent(3)).toBe("3%");
    expect(formatPercent(42.6)).toBe("43%");
  });
});
