import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createInboxReturnTracker,
  isThreadWorking,
  resolveThreadShelf,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
  stepThreadPriority,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("resolveThreadShelf", () => {
  it("shelves a thread that has never run, waiting on its first message, as scheduled", () => {
    expect(resolveThreadShelf(thread("new", false), true)).toBe("scheduled");
  });

  it("shelves an idle or failed thread holding a scheduled message as scheduled", () => {
    expect(resolveThreadShelf(thread("a", false), true)).toBe("scheduled");
    expect(resolveThreadShelf(thread("a", false), false)).toBeNull();
    const failed = {
      ...thread("a", true),
      runtime: { ...thread("a", true).runtime!, status: "failed" as const, lastError: "limit" },
    };
    expect(isThreadWorking(failed)).toBe(false);
    expect(resolveThreadShelf(failed, true)).toBe("scheduled");
  });

  it("keeps a working thread in Working even with a scheduled message", () => {
    expect(resolveThreadShelf(thread("a", true), true)).toBe("working");
    const parked = {
      ...thread("a", true),
      runtime: { ...thread("a", true).runtime!, status: "idle" as const },
    };
    expect(resolveThreadShelf(parked, true)).toBe("working");
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "approval" as const },
    { pendingGuestMessageCount: 1 },
  ])("returns a scheduled thread that needs the user: %j", (change) => {
    expect(resolveThreadShelf({ ...thread("a", false), ...change }, true)).toBeNull();
  });
});

describe("createInboxReturnTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    const first = tracker.observe([thread("a", true), thread("b", false)]);
    expect(first.returnedAt(thread("a", true))).toBeUndefined();
    expect(first.returnedAt(thread("b", false))).toBeUndefined();

    const held = tracker.observe([thread("a", false), thread("b", false)]);
    vi.advanceTimersByTime(2_000);
    const second = tracker.observe([thread("a", false), thread("b", false)]);
    expect(second.returnedAt(thread("a", false))).toBeDefined();
    expect(second.returnedAt(thread("b", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("a", false))).toBe(second.returnedAt(thread("a", false)));
    // An earlier observation keeps its answer, so lists built from it stay valid.
    expect(held.isWorking(thread("a", false))).toBe(true);
    expect(held.returnedAt(thread("a", false))).toBeUndefined();
  });

  it.each([
    {
      runtime: { ...thread("a", true).runtime!, status: "failed" as const, lastError: "limit" },
    },
    { interactionMode: "plan" as const, hasActionableProposedPlan: true },
  ])("holds a scheduled thread with old news until its sent message runs: %j", (change) => {
    const tracker = createInboxReturnTracker();
    const idle = { ...thread("a", false), ...change };
    let scheduled = true;
    const isScheduled = () => scheduled;
    tracker.observe([idle], isScheduled);
    scheduled = false;
    const sent = tracker.observe([idle], isScheduled);
    expect(sent.shelf(idle)).toBe("scheduled");
    expect(sent.returnedAt(idle)).toBeUndefined();
    const started = tracker.observe([thread("a", true)], isScheduled);
    expect(started.shelf(thread("a", true))).toBe("working");
    expect(started.returnedAt(idle)).toBeUndefined();
  });

  it("returns a scheduled thread at once when it asks the user something", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", false)], () => true);
    const asking = { ...thread("a", false), hasPendingUserInput: true };
    expect(tracker.observe([asking], () => true).shelf(asking)).toBeNull();
  });

  it("shelves a scheduled thread until its message is no longer scheduled, then returns it", () => {
    const tracker = createInboxReturnTracker();
    let scheduled = true;
    const isScheduled = () => scheduled;
    const first = tracker.observe([thread("a", false)], isScheduled);
    expect(first.shelf(thread("a", false))).toBe("scheduled");
    expect(first.isWorking(thread("a", false))).toBe(false);
    scheduled = false;
    const sending = tracker.observe([thread("a", false)], isScheduled);
    expect(sending.shelf(thread("a", false))).toBe("scheduled");
    vi.advanceTimersByTime(2_000);
    const returned = tracker.observe([thread("a", false)], isScheduled);
    expect(returned.shelf(thread("a", false))).toBeNull();
    expect(tracker.returnedAt(thread("a", false))).toBe(12_000);
  });

  it("moves a finished thread from Working to Scheduled after the grace, without a return", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    tracker.subscribe(notify);
    const isScheduled = () => true;
    tracker.observe([thread("a", true)], isScheduled);
    const held = tracker.observe([thread("a", false)], isScheduled);
    expect(held.shelf(thread("a", false))).toBe("working");
    vi.advanceTimersByTime(2_000);
    expect(notify).toHaveBeenCalledTimes(1);
    const after = tracker.observe([thread("a", false)], isScheduled);
    expect(after.shelf(thread("a", false))).toBe("scheduled");
    expect(after.returnedAt(thread("a", false))).toBeUndefined();
  });

  it("moves a scheduled thread straight to Working when its run starts", () => {
    const tracker = createInboxReturnTracker();
    let scheduled = true;
    const isScheduled = () => scheduled;
    tracker.observe([thread("a", false)], isScheduled);
    scheduled = false;
    tracker.observe([thread("a", false)], isScheduled);
    const running = tracker.observe([thread("a", true)], isScheduled);
    expect(running.shelf(thread("a", true))).toBe("working");
    vi.advanceTimersByTime(2_000);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
  });

  it("sends a scheduled thread straight back when it needs the user", () => {
    const tracker = createInboxReturnTracker();
    const isScheduled = () => true;
    tracker.observe([thread("a", false)], isScheduled);
    const asked = { ...thread("a", false), hasPendingApprovals: true };
    expect(tracker.observe([asked], isScheduled).shelf(asked)).toBeNull();
    expect(tracker.returnedAt(asked)).toBe(10_000);
  });

  it("holds only placement, then expires and notifies without another shell event", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    const unsubscribe = tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    expect(isThreadWorking(thread("a", false))).toBe(false);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1_999);
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(12_000);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("cancels a transient return on resume and grants a fresh grace after the next finish", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    tracker.observe([thread("a", true)]);
    expect(tracker.isWorking(thread("a", true))).toBe(true);
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_500);
    tracker.observe([thread("a", true)]);
    vi.advanceTimersByTime(1_000);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.returnedAt(thread("a", false))).toBe(14_500);
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "approval" as const },
    { pendingSubagentRequest: "user_input" as const },
    { pendingGuestMessageCount: 1 },
    { interactionMode: "plan" as const, hasActionableProposedPlan: true },
    { runtime: { ...thread("a", true).runtime!, status: "failed" as const, lastError: "failed" } },
    { pinnedAt: "2026-06-01T00:00:01Z" },
    { settledOverride: "settled" as const },
    { snoozedUntil: "2026-06-02T00:00:00Z" },
    { activeOrderKey: "manual-order" },
  ])("ends a grace immediately for attention or manual placement: %j", (change) => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([{ ...thread("a", false), ...change }]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["interrupted", "cancelled", "rolled_back"] as const)(
    "holds a %s run, because the server can still settle it",
    (status) => {
      const tracker = createInboxReturnTracker();
      const stopped = {
        ...thread("a", false),
        latestRun: {
          runId: RunId.make("stopped"),
          status,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      };
      tracker.observe([thread("a", true)]);
      tracker.observe([stopped]);
      expect(tracker.isWorking(stopped)).toBe(true);
      tracker.observe([{ ...stopped, settledOverride: "settled" as const }]);
      expect(tracker.isWorking(stopped)).toBe(false);
    },
  );

  it("grants grace after a retained expired snooze", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:05.000Z",
      latestRun: {
        runId: RunId.make("completed-wake"),
        status: "completed" as const,
        requestedAt: "1970-01-01T00:00:02.000Z",
        startedAt: "1970-01-01T00:00:02.000Z",
        completedAt: "1970-01-01T00:00:09.000Z",
        assistantMessageId: null,
      },
    };
    const active = { ...thread("a", true), ...retained };
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([active]);
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(true);
    expect(tracker.returnedAt(finished)).toBeUndefined();
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(finished)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(tracker.returnedAt(finished)).toBe(12_000);
  });

  it("does not grant grace to a future snooze after background completion", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:30.000Z",
    };
    tracker.observe([{ ...thread("a", true), ...retained }]);
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stamps only stable returns and sorts them in their actual return order", () => {
    const tracker = createInboxReturnTracker();
    const a = { ...thread("a", false), createdAt: "1970-01-01T00:00:00Z" };
    const b = { ...thread("b", false), createdAt: "1970-01-01T00:00:00Z" };
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([a, thread("b", true)]);
    vi.advanceTimersByTime(500);
    tracker.observe([a, b]);
    vi.advanceTimersByTime(1_500);
    expect(tracker.returnedAt(a)).toBe(12_000);
    expect(tracker.returnedAt(b)).toBeUndefined();
    vi.advanceTimersByTime(500);
    const newestFirst = {
      high: "newest_first",
      normal: "newest_first",
      low: "newest_first",
    } as const;
    expect(
      sortInboxThreadsByReturn([a, b], newestFirst, "1970-01-01T00:00:13Z", tracker.returnedAt).map(
        (entry) => entry.id,
      ),
    ).toEqual(["b", "a"]);
  });

  it("cancels pending timers for removed threads and disabled shelves", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([]);
    expect(vi.getTimerCount()).toBe(0);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe(null);
    vi.advanceTimersByTime(2_000);
    expect(notify).not.toHaveBeenCalled();
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("stepThreadPriority", () => {
  it.each([
    [null, 1, 1],
    [1, 1, 1],
    [-1, 1, null],
    [null, -1, -1],
    [-1, -1, -1],
    [1, -1, null],
    [4, 1, 4],
    [4, -1, 1],
    [-4, 1, -1],
    [-4, -1, -4],
  ] as const)("steps %s by %s to %s", (priority, delta, expected) => {
    expect(stepThreadPriority(priority, delta)).toBe(expected);
  });
});
