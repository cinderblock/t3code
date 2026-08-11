import { describe, expect, it } from "vite-plus/test";
import type { UsageWindow } from "@t3tools/contracts";

import {
  emphasizedWeeklyWindowId,
  formatPercent,
  formatResetEta,
  sortWindowsForDisplay,
} from "./usagePresentation";

const makeWindow = (overrides: Partial<UsageWindow>): UsageWindow =>
  ({
    id: "weekly:all",
    kind: "weekly",
    scope: { kind: "all" },
    percent: 50,
    severity: "normal",
    resetsAt: null,
    windowHours: 168,
    isActive: false,
    billing: "subscription",
    ...overrides,
  }) as UsageWindow;

const sessionAll = makeWindow({ id: "session:all", kind: "session", windowHours: 5 });
const weeklyAll = makeWindow({ id: "weekly:all" });
const weeklyFable = makeWindow({
  id: "weekly:model:Fable",
  scope: { kind: "model", displayName: "Fable" },
});
const weeklyOpus = makeWindow({
  id: "weekly:model:Opus",
  scope: { kind: "model", displayName: "Opus" },
});
const monthlyAll = makeWindow({
  id: "monthly:all",
  kind: "monthly",
  windowHours: 720,
  billing: "pay-per-use",
});

describe("sortWindowsForDisplay", () => {
  it("orders session, then weekly (all before scoped, scoped alphabetical), then monthly", () => {
    const shuffled = [monthlyAll, weeklyOpus, weeklyFable, weeklyAll, sessionAll];
    expect(sortWindowsForDisplay(shuffled).map((window) => window.id)).toEqual([
      "session:all",
      "weekly:all",
      "weekly:model:Fable",
      "weekly:model:Opus",
      "monthly:all",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [weeklyAll, sessionAll];
    sortWindowsForDisplay(input);
    expect(input.map((window) => window.id)).toEqual(["weekly:all", "session:all"]);
  });
});

describe("emphasizedWeeklyWindowId", () => {
  const windows = [weeklyAll, weeklyFable];

  it("emphasizes the model-scoped weekly window matching the selected slug", () => {
    expect(emphasizedWeeklyWindowId(windows, "claude-fable-5")).toBe("weekly:model:Fable");
  });

  it("falls back to the all-models weekly window when no scoped window matches", () => {
    expect(emphasizedWeeklyWindowId(windows, "claude-opus-4-8")).toBe("weekly:all");
  });

  it("emphasizes the all-models weekly window when no model is selected", () => {
    expect(emphasizedWeeklyWindowId(windows, null)).toBe("weekly:all");
  });

  it("returns null when there are no weekly windows", () => {
    expect(emphasizedWeeklyWindowId([sessionAll, monthlyAll], "claude-fable-5")).toBeNull();
  });
});

describe("formatResetEta", () => {
  const NOW_MS = Date.parse("2026-07-24T12:00:00Z");
  const minutesFromNow = (minutes: number): string =>
    new Date(NOW_MS + minutes * 60_000).toISOString();

  it("returns null when no reset time is reported", () => {
    expect(formatResetEta(null, NOW_MS)).toBeNull();
  });

  it("formats short waits in minutes", () => {
    expect(formatResetEta(minutesFromNow(45), NOW_MS)).toBe("resets in 45m");
  });

  it("formats mid-range waits in hours and minutes", () => {
    expect(formatResetEta(minutesFromNow(2 * 60 + 13), NOW_MS)).toBe("resets in 2h 13m");
  });

  it("formats long waits in days and hours", () => {
    expect(formatResetEta(minutesFromNow(3 * 24 * 60 + 5 * 60), NOW_MS)).toBe("resets in 3d 5h");
  });

  it("reports resetting once the reset moment has passed", () => {
    expect(formatResetEta(minutesFromNow(-1), NOW_MS)).toBe("resetting…");
  });
});

describe("formatPercent", () => {
  it("renders zero without a decimal", () => {
    expect(formatPercent(0)).toBe("0%");
  });

  it("keeps one decimal for small non-zero values", () => {
    expect(formatPercent(7.5)).toBe("7.5%");
  });

  it("rounds larger values to whole percents", () => {
    expect(formatPercent(64.4)).toBe("64%");
  });
});
