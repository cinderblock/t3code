import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  accountWindowIdForKind,
  emphasizedWeeklyWindowId,
  formatPercent,
  formatResetEta,
  sortWindowsForDisplay,
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

describe("formatResetEta", () => {
  const nowMs = Date.parse("2026-09-10T12:00:00Z");

  it("returns null when no reset time is reported", () => {
    expect(formatResetEta(undefined, nowMs)).toBeNull();
  });

  it("formats minutes, hours and days", () => {
    expect(formatResetEta("2026-09-10T12:30:00Z", nowMs)).toBe("resets in 30m");
    expect(formatResetEta("2026-09-10T14:15:00Z", nowMs)).toBe("resets in 2h 15m");
    expect(formatResetEta("2026-09-13T15:00:00Z", nowMs)).toBe("resets in 3d 3h");
  });

  it("reads as resetting once the moment has passed", () => {
    expect(formatResetEta("2026-09-10T11:00:00Z", nowMs)).toBe("resetting…");
  });
});

describe("formatPercent", () => {
  it("keeps one decimal below ten percent and rounds above", () => {
    expect(formatPercent(3.25)).toBe("3.3%");
    expect(formatPercent(3)).toBe("3%");
    expect(formatPercent(42.6)).toBe("43%");
  });
});
