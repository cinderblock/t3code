import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type {
  QueuedMessageTrigger,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

import {
  decodeQueuedMessageRow,
  findTriggerWindow,
  isTriggerDue,
  type UsageLimitsByInstance,
} from "./QueuedMessageService.ts";

const NOW_MS = Date.parse("2026-07-24T12:00:00Z");

const minutesFromNow = (minutes: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW_MS + minutes * 60_000));

const makeWindow = (overrides: Partial<ServerProviderUsageWindow>): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 50,
  windowDurationMins: 7 * 24 * 60,
  ...overrides,
});

const makeLimits = (
  instanceId: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): UsageLimitsByInstance =>
  new Map<string, ServerProviderUsageLimits>([
    [instanceId, { checkedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW_MS)), windows }],
  ]);

const noLimits: UsageLimitsByInstance = new Map();

describe("findTriggerWindow", () => {
  const limits: ServerProviderUsageLimits = {
    checkedAt: minutesFromNow(0),
    windows: [
      makeWindow({ id: "five_hour", kind: "session", label: "Session" }),
      makeWindow({ id: "seven_day_fable", label: "Fable" }),
      makeWindow({ id: "seven_day" }),
    ],
  };

  it("matches a provider window id exactly", () => {
    expect(findTriggerWindow(limits, "seven_day_fable")?.id).toBe("seven_day_fable");
  });

  it("maps the fork's legacy kind ids onto the account-wide window of that kind", () => {
    expect(findTriggerWindow(limits, "weekly:all")?.id).toBe("seven_day");
    expect(findTriggerWindow(limits, "session:all")?.id).toBe("five_hour");
  });

  it("returns null for an unknown id and for missing limits", () => {
    expect(findTriggerWindow(limits, "monthly:all")).toBeNull();
    expect(findTriggerWindow(limits, "nope")).toBeNull();
    expect(findTriggerWindow(undefined, "seven_day")).toBeNull();
  });
});

describe("isTriggerDue", () => {
  describe("at triggers", () => {
    const atTrigger = (at: string): QueuedMessageTrigger =>
      ({ type: "at", at }) as QueuedMessageTrigger;

    it("fires when the wall-clock time has passed", () => {
      expect(isTriggerDue(atTrigger(minutesFromNow(-1)), NOW_MS, noLimits)).toBe(true);
    });

    it("does not fire before the wall-clock time", () => {
      expect(isTriggerDue(atTrigger(minutesFromNow(1)), NOW_MS, noLimits)).toBe(false);
    });

    it("never fires on an unparseable date", () => {
      expect(isTriggerDue(atTrigger("not-a-date"), NOW_MS, noLimits)).toBe(false);
    });
  });

  describe("window-reset triggers", () => {
    const trigger: QueuedMessageTrigger = {
      type: "window-reset",
      accountKey: "claude-main",
      windowId: "seven_day",
    } as QueuedMessageTrigger;

    it("does not fire when the instance publishes no limits", () => {
      expect(isTriggerDue(trigger, NOW_MS, noLimits)).toBe(false);
    });

    it("does not fire when the window is missing from the limits", () => {
      const limits = makeLimits("claude-main", [makeWindow({ id: "five_hour", kind: "session" })]);
      expect(isTriggerDue(trigger, NOW_MS, limits)).toBe(false);
    });

    it("fires when utilization has collapsed back near zero", () => {
      const limits = makeLimits("claude-main", [
        makeWindow({ usedPercent: 3, resetsAt: minutesFromNow(60) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, limits)).toBe(true);
    });

    it("fires when the advertised reset moment has passed", () => {
      const limits = makeLimits("claude-main", [
        makeWindow({ usedPercent: 80, resetsAt: minutesFromNow(-5) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, limits)).toBe(true);
    });

    it("does not fire while a busy window is still ahead of its reset", () => {
      const limits = makeLimits("claude-main", [
        makeWindow({ usedPercent: 80, resetsAt: minutesFromNow(60) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, limits)).toBe(false);
    });

    it("does not fire on a busy window with no advertised reset", () => {
      const limits = makeLimits("claude-main", [makeWindow({ usedPercent: 80 })]);
      expect(isTriggerDue(trigger, NOW_MS, limits)).toBe(false);
    });

    it("still fires for a message queued under the fork's legacy window id", () => {
      const legacy: QueuedMessageTrigger = {
        type: "window-reset",
        accountKey: "claude-main",
        windowId: "weekly:all",
      } as QueuedMessageTrigger;
      const limits = makeLimits("claude-main", [
        makeWindow({ usedPercent: 2, resetsAt: minutesFromNow(60) }),
      ]);
      expect(isTriggerDue(legacy, NOW_MS, limits)).toBe(true);
    });
  });

  describe("headroom triggers", () => {
    const trigger: QueuedMessageTrigger = {
      type: "headroom",
      accountKey: "claude-main",
      windowId: "seven_day",
      minRemainingPercent: 20,
      leadMinutes: 60,
    } as QueuedMessageTrigger;

    it("fires when enough capacity remains inside the lead window", () => {
      const limits = makeLimits("claude-main", [
        makeWindow({ usedPercent: 70, resetsAt: minutesFromNow(30) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, limits)).toBe(true);
    });

    it("does not fire when remaining capacity is below the threshold", () => {
      const limits = makeLimits("claude-main", [
        makeWindow({ usedPercent: 90, resetsAt: minutesFromNow(30) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, limits)).toBe(false);
    });

    it("does not fire when the reset is outside the lead window", () => {
      const limits = makeLimits("claude-main", [
        makeWindow({ usedPercent: 50, resetsAt: minutesFromNow(5 * 60) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, limits)).toBe(false);
    });

    it("does not fire when the window has no advertised reset", () => {
      const limits = makeLimits("claude-main", [makeWindow({ usedPercent: 50 })]);
      expect(isTriggerDue(trigger, NOW_MS, limits)).toBe(false);
    });

    it("does not fire once the advertised reset is already in the past", () => {
      const limits = makeLimits("claude-main", [
        makeWindow({ usedPercent: 50, resetsAt: minutesFromNow(-5) }),
      ]);
      expect(isTriggerDue(trigger, NOW_MS, limits)).toBe(false);
    });
  });
});

describe("decodeQueuedMessageRow", () => {
  const row = {
    id: "qm_1",
    threadId: "thread_1",
    messageId: "msg_1",
    text: "hello",
    triggerJson: JSON.stringify({ type: "at", at: minutesFromNow(5) }),
    sendContextJson: JSON.stringify({ runtimeMode: "full-access", interactionMode: "default" }),
    status: "pending",
    origin: "user",
    createdAt: minutesFromNow(0),
    updatedAt: minutesFromNow(0),
    sentAt: null,
    failureDetail: null,
  };

  it("decodes a well-formed row", () => {
    const decoded = decodeQueuedMessageRow(row);
    expect("message" in decoded && decoded.message.trigger.type).toBe("at");
  });

  it("explains a row whose trigger no longer parses instead of throwing", () => {
    const decoded = decodeQueuedMessageRow({ ...row, triggerJson: '{"type":"someday"}' });
    expect(decoded).toEqual({ error: "Stored trigger could not be read" });
  });

  it("explains an unknown status", () => {
    const decoded = decodeQueuedMessageRow({ ...row, status: "vanished" });
    expect(decoded).toEqual({ error: 'Unknown status "vanished"' });
  });
});
