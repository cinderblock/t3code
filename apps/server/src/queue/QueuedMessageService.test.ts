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
  observeTriggerWindow,
  resolveScheduledTrigger,
  stampTriggerBaseline,
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

    describe("with a baseline", () => {
      const baseline = (resetsAt: string | null, peakPercent: number): QueuedMessageTrigger => ({
        type: "window-reset",
        accountKey: "claude-main",
        windowId: "seven_day",
        resetsAt,
        peakPercent,
      });

      it("waits for the reset when the window was nearly unused from the start", () => {
        const limits = makeLimits("claude-main", [
          makeWindow({ usedPercent: 3, resetsAt: minutesFromNow(60) }),
        ]);
        expect(isTriggerDue(baseline(minutesFromNow(60), 3), NOW_MS, limits)).toBe(false);
      });

      it("fires when its reset passes, whatever the window reads by then", () => {
        const limits = makeLimits("claude-main", [makeWindow({ usedPercent: 0 })]);
        expect(isTriggerDue(baseline(minutesFromNow(-1), 3), NOW_MS, limits)).toBe(true);
      });

      it("ignores the second of jitter in a provider's advertised reset", () => {
        const limits = makeLimits("claude-main", [
          makeWindow({ usedPercent: 4, resetsAt: minutesFromNow(60.01) }),
        ]);
        expect(isTriggerDue(baseline(minutesFromNow(60), 4), NOW_MS, limits)).toBe(false);
      });

      it("fires on a reset that came early, once usage had been above the line", () => {
        const limits = makeLimits("claude-main", [
          makeWindow({ usedPercent: 1, resetsAt: minutesFromNow(300) }),
        ]);
        expect(isTriggerDue(baseline(minutesFromNow(60), 73), NOW_MS, limits)).toBe(true);
      });

      it("reads a window with no reset time as reset once it falls from its peak", () => {
        const limits = makeLimits("claude-main", [makeWindow({ usedPercent: 2 })]);
        expect(isTriggerDue(baseline(null, 60), NOW_MS, limits)).toBe(true);
        const stillBusy = makeLimits("claude-main", [makeWindow({ usedPercent: 40 })]);
        expect(isTriggerDue(baseline(null, 60), NOW_MS, stillBusy)).toBe(false);
      });

      it("waits while an idle window has no clock running", () => {
        const limits = makeLimits("claude-main", [makeWindow({ usedPercent: 0 })]);
        expect(isTriggerDue(baseline(null, 0), NOW_MS, limits)).toBe(false);
      });

      it("does not fire when the instance publishes no limits", () => {
        expect(isTriggerDue(baseline(minutesFromNow(-1), 40), NOW_MS, noLimits)).toBe(false);
      });
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

describe("window baselines", () => {
  const bare: QueuedMessageTrigger = {
    type: "window-reset",
    accountKey: "claude-main",
    windowId: "five_hour",
  };
  const fiveHour = (overrides: Partial<ServerProviderUsageWindow>) =>
    makeLimits("claude-main", [makeWindow({ id: "five_hour", kind: "session", ...overrides })]);

  it("stamps the window's upcoming reset and usage at queue time", () => {
    const limits = fiveHour({ usedPercent: 3, resetsAt: minutesFromNow(60) });
    expect(stampTriggerBaseline(bare, NOW_MS, limits)).toEqual({
      ...bare,
      resetsAt: minutesFromNow(60),
      peakPercent: 3,
    });
  });

  it("stamps what the server sees, not what a client sent", () => {
    const stale = { ...bare, resetsAt: minutesFromNow(-90), peakPercent: 99 };
    const limits = fiveHour({ usedPercent: 3, resetsAt: minutesFromNow(60) });
    expect(stampTriggerBaseline(stale, NOW_MS, limits)).toEqual({
      ...bare,
      resetsAt: minutesFromNow(60),
      peakPercent: 3,
    });
  });

  it("stamps no reset when the window advertises none, or no limits are known", () => {
    expect(stampTriggerBaseline(bare, NOW_MS, fiveHour({ usedPercent: 0 }))).toEqual({
      ...bare,
      resetsAt: null,
      peakPercent: 0,
    });
    expect(stampTriggerBaseline(bare, NOW_MS, noLimits)).toEqual({
      ...bare,
      resetsAt: null,
      peakPercent: 0,
    });
  });

  it("does not wait for a reset that a stale read shows as already past", () => {
    const limits = fiveHour({ usedPercent: 3, resetsAt: minutesFromNow(-2) });
    const stamped = stampTriggerBaseline(bare, NOW_MS, limits);
    expect(stamped).toEqual({ ...bare, resetsAt: null, peakPercent: 3 });
    expect(isTriggerDue(stamped, NOW_MS, limits)).toBe(false);
  });

  it("still sends after the reset a capped window was about to take", () => {
    const stale = fiveHour({ usedPercent: 99, resetsAt: minutesFromNow(-2) });
    const stamped = stampTriggerBaseline(bare, NOW_MS, stale);
    expect(isTriggerDue(stamped, NOW_MS, fiveHour({ usedPercent: 0 }))).toBe(true);
  });

  it("leaves other triggers alone", () => {
    const at: QueuedMessageTrigger = { type: "at", at: minutesFromNow(5) };
    expect(stampTriggerBaseline(at, NOW_MS, noLimits)).toBe(at);
  });

  it("learns the reset once an idle window's clock starts", () => {
    const stamped = stampTriggerBaseline(bare, NOW_MS, fiveHour({ usedPercent: 0 }));
    const started = fiveHour({ usedPercent: 1, resetsAt: minutesFromNow(300) });
    expect(observeTriggerWindow(stamped, NOW_MS, started)).toEqual({
      ...bare,
      resetsAt: minutesFromNow(300),
      peakPercent: 1,
    });
  });

  it("keeps the reset it already has and the highest usage it has seen", () => {
    const seen = { ...bare, resetsAt: minutesFromNow(60), peakPercent: 40 };
    const limits = fiveHour({ usedPercent: 20, resetsAt: minutesFromNow(60.01) });
    expect(observeTriggerWindow(seen, NOW_MS, limits)).toBe(seen);
    const risen = fiveHour({ usedPercent: 55, resetsAt: minutesFromNow(60.01) });
    expect(observeTriggerWindow(seen, NOW_MS, risen)).toEqual({ ...seen, peakPercent: 55 });
  });

  it("leaves a message queued before baselines on the rule it was queued under", () => {
    const limits = fiveHour({ usedPercent: 40, resetsAt: minutesFromNow(60) });
    expect(observeTriggerWindow(bare, NOW_MS, limits)).toBe(bare);
  });
});

describe("resolveScheduledTrigger", () => {
  const limits = (usedPercent: number) =>
    makeLimits("claude", [
      makeWindow({
        id: "five_hour",
        kind: "session",
        label: "5-hour",
        usedPercent,
        resetsAt: minutesFromNow(30),
      }),
    ]);

  it("stores the provider's own id for a window named by kind", () => {
    expect(
      resolveScheduledTrigger({ windowReset: "session" }, "claude", NOW_MS, limits(60)),
    ).toEqual({ trigger: { type: "window-reset", accountKey: "claude", windowId: "five_hour" } });
  });

  it("refuses a window the provider does not report, which would never fire", () => {
    expect(
      resolveScheduledTrigger({ windowReset: "weekly" }, "claude", NOW_MS, limits(60)),
    ).toEqual({ error: "This thread's provider reports no weekly usage window" });
  });

  it("accepts a nearly empty window, which waits for its reset", () => {
    expect(
      resolveScheduledTrigger({ windowReset: "session" }, "claude", NOW_MS, limits(3)),
    ).toEqual({ trigger: { type: "window-reset", accountKey: "claude", windowId: "five_hour" } });
  });

  it("accepts a future time and refuses a past one", () => {
    const at = minutesFromNow(10);
    expect(resolveScheduledTrigger({ at }, "claude", NOW_MS, noLimits)).toEqual({
      trigger: { type: "at", at },
    });
    expect(resolveScheduledTrigger({ at: minutesFromNow(-1) }, "claude", NOW_MS, noLimits)).toEqual(
      { error: `${minutesFromNow(-1)} is not in the future` },
    );
  });
});

describe("decodeQueuedMessageRow", () => {
  const row = {
    id: "qm_1",
    threadId: "thread_1",
    messageId: "msg_1",
    text: "hello",
    attachmentsJson: null,
    contextJson: null,
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
