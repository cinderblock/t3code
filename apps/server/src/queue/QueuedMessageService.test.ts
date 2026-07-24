import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { AccountUsageSnapshot, QueuedMessageTrigger, UsageWindow } from "@t3tools/contracts";

import { isTriggerDue } from "./QueuedMessageService.ts";

const NOW_MS = Date.parse("2026-07-24T12:00:00Z");

const minutesFromNow = (minutes: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW_MS + minutes * 60_000));

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

const makeSnapshots = (
  accountKey: string,
  windows: ReadonlyArray<UsageWindow>,
): Map<string, AccountUsageSnapshot> =>
  new Map([
    [
      accountKey,
      {
        accountKey,
        instanceIds: [],
        planLabel: null,
        capturedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW_MS)),
        windows,
      } as unknown as AccountUsageSnapshot,
    ],
  ]);

const noSnapshots = new Map<string, AccountUsageSnapshot>();

describe("isTriggerDue", () => {
  describe("at triggers", () => {
    const atTrigger = (at: string): QueuedMessageTrigger =>
      ({ type: "at", at }) as QueuedMessageTrigger;

    it("fires when the wall-clock time has passed", () => {
      expect(isTriggerDue(atTrigger(minutesFromNow(-1)), NOW_MS, noSnapshots)).toBe(true);
    });

    it("does not fire before the wall-clock time", () => {
      expect(isTriggerDue(atTrigger(minutesFromNow(1)), NOW_MS, noSnapshots)).toBe(false);
    });

    it("never fires on an unparseable date", () => {
      expect(isTriggerDue(atTrigger("not-a-date"), NOW_MS, noSnapshots)).toBe(false);
    });
  });

  describe("window-reset triggers", () => {
    const trigger: QueuedMessageTrigger = {
      type: "window-reset",
      accountKey: "acct",
      windowId: "weekly:all",
    } as QueuedMessageTrigger;

    it("does not fire when there is no snapshot for the account", () => {
      expect(isTriggerDue(trigger, NOW_MS, noSnapshots)).toBe(false);
    });

    it("does not fire when the window is missing from the snapshot", () => {
      const snapshots = makeSnapshots("acct", [makeWindow({ id: "session:all" })]);
      expect(isTriggerDue(trigger, NOW_MS, snapshots)).toBe(false);
    });

    it("fires when utilization has collapsed back near zero", () => {
      const snapshots = makeSnapshots("acct", [
        makeWindow({ percent: 3, resetsAt: minutesFromNow(60) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, snapshots)).toBe(true);
    });

    it("fires when the advertised reset moment has passed", () => {
      const snapshots = makeSnapshots("acct", [
        makeWindow({ percent: 80, resetsAt: minutesFromNow(-5) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, snapshots)).toBe(true);
    });

    it("does not fire while a busy window is still ahead of its reset", () => {
      const snapshots = makeSnapshots("acct", [
        makeWindow({ percent: 80, resetsAt: minutesFromNow(60) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, snapshots)).toBe(false);
    });

    it("does not fire on a busy window with no advertised reset", () => {
      const snapshots = makeSnapshots("acct", [makeWindow({ percent: 80, resetsAt: null })]);
      expect(isTriggerDue(trigger, NOW_MS, snapshots)).toBe(false);
    });
  });

  describe("headroom triggers", () => {
    const trigger: QueuedMessageTrigger = {
      type: "headroom",
      accountKey: "acct",
      windowId: "weekly:all",
      minRemainingPercent: 20,
      leadMinutes: 60,
    } as QueuedMessageTrigger;

    it("fires when enough capacity remains inside the lead window", () => {
      const snapshots = makeSnapshots("acct", [
        makeWindow({ percent: 70, resetsAt: minutesFromNow(30) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, snapshots)).toBe(true);
    });

    it("does not fire when remaining capacity is below the threshold", () => {
      const snapshots = makeSnapshots("acct", [
        makeWindow({ percent: 90, resetsAt: minutesFromNow(30) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, snapshots)).toBe(false);
    });

    it("does not fire when the reset is outside the lead window", () => {
      const snapshots = makeSnapshots("acct", [
        makeWindow({ percent: 50, resetsAt: minutesFromNow(5 * 60) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, snapshots)).toBe(false);
    });

    it("does not fire when the window has no advertised reset", () => {
      const snapshots = makeSnapshots("acct", [makeWindow({ percent: 50, resetsAt: null })]);
      expect(isTriggerDue(trigger, NOW_MS, snapshots)).toBe(false);
    });

    it("does not fire once the advertised reset is already in the past", () => {
      const snapshots = makeSnapshots("acct", [
        makeWindow({ percent: 50, resetsAt: minutesFromNow(-5) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, snapshots)).toBe(false);
    });
  });
});
