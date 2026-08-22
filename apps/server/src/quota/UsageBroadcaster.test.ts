import { describe, expect, it } from "vite-plus/test";
import type { AccountUsageSnapshot, ProviderInstanceId, UsageWindow } from "@t3tools/contracts";

import { encodeSnapshot, restorableWindows, restoredSnapshot } from "./UsageBroadcaster.ts";

const NOW_MS = Date.UTC(2026, 7, 22, 5, 0, 0);

const window = (overrides: Partial<UsageWindow>): UsageWindow => ({
  id: "session:all",
  kind: "session",
  scope: { kind: "all" },
  percent: 42,
  severity: "normal",
  resetsAt: "2026-08-22T09:00:00.000Z",
  windowHours: 5,
  isActive: false,
  billing: "subscription",
  ...overrides,
});

describe("restorableWindows", () => {
  it("keeps windows that have not reset yet", () => {
    const windows = [window({ resetsAt: "2026-08-22T05:00:00.001Z" })];

    expect(restorableWindows(windows, NOW_MS)).toEqual(windows);
  });

  it("drops windows whose reset has passed, since their percent is stale fiction", () => {
    const windows = [
      window({ id: "session:all", resetsAt: "2026-08-22T04:59:59.999Z" }),
      window({ id: "weekly:all", kind: "weekly", resetsAt: "2026-08-25T00:00:00.000Z" }),
    ];

    expect(restorableWindows(windows, NOW_MS).map((entry) => entry.id)).toEqual(["weekly:all"]);
  });

  it("treats a window resetting exactly now as expired", () => {
    const windows = [window({ resetsAt: "2026-08-22T05:00:00.000Z" })];

    expect(restorableWindows(windows, NOW_MS)).toEqual([]);
  });

  it("keeps windows the provider reported without a reset time", () => {
    const windows = [window({ resetsAt: null })];

    expect(restorableWindows(windows, NOW_MS)).toEqual(windows);
  });

  it("drops a window whose reset time cannot be parsed", () => {
    const windows = [window({ resetsAt: "not-a-timestamp" })];

    expect(restorableWindows(windows, NOW_MS)).toEqual([]);
  });

  it("accepts the offset form the usage endpoint actually sends", () => {
    const windows = [window({ resetsAt: "2026-08-22T05:29:59.797279+00:00" })];

    expect(restorableWindows(windows, NOW_MS)).toEqual(windows);
  });
});

const snapshot = (windows: ReadonlyArray<UsageWindow>): AccountUsageSnapshot => ({
  accountKey: "C:\\Users\\someone\\.claude",
  instanceIds: ["claudeAgent" as ProviderInstanceId],
  planLabel: "Max 20x",
  capturedAt: "2026-08-22T04:30:00.000Z",
  windows,
});

describe("restoredSnapshot", () => {
  it("round-trips a persisted snapshot", () => {
    const original = snapshot([
      window({}),
      window({
        id: "weekly:model:Fable",
        kind: "weekly",
        scope: { kind: "model", displayName: "Fable" },
        severity: "warning",
        windowHours: 168,
        resetsAt: "2026-08-25T00:00:00.000Z",
      }),
    ]);

    expect(restoredSnapshot(encodeSnapshot(original), NOW_MS)).toEqual(original);
  });

  it("keeps a snapshot's live windows and drops the reset ones", () => {
    const restored = restoredSnapshot(
      encodeSnapshot(
        snapshot([
          window({ id: "session:all", resetsAt: "2026-08-22T01:00:00.000Z" }),
          window({ id: "weekly:all", kind: "weekly", resetsAt: "2026-08-25T00:00:00.000Z" }),
        ]),
      ),
      NOW_MS,
    );

    expect(restored?.windows.map((entry) => entry.id)).toEqual(["weekly:all"]);
    // The rest of the snapshot survives intact — the plan label and account
    // identity are what let the restored bars render with their heading.
    expect(restored?.planLabel).toBe("Max 20x");
  });

  it("restores nothing when every window has already reset", () => {
    const stale = snapshot([window({ resetsAt: "2026-08-22T01:00:00.000Z" })]);

    expect(restoredSnapshot(encodeSnapshot(stale), NOW_MS)).toBeNull();
  });

  it("restores nothing from a row it cannot decode", () => {
    expect(restoredSnapshot('{"accountKey":', NOW_MS)).toBeNull();
    expect(restoredSnapshot(JSON.stringify({ accountKey: "acct" }), NOW_MS)).toBeNull();
  });
});
