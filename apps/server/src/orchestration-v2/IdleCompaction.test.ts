import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  idleCompactionWindow,
  shouldCompactBeforeSend,
  type IdleCompactionRecords,
} from "./IdleCompaction.ts";

const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const threadId = ThreadId.make("idle-thread");
const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

function records(
  usage: {
    readonly usedTokens?: number;
    readonly cacheExpiresInMs?: number;
    readonly ageMs?: number;
    readonly promptCacheTtlMs?: number;
  } = {},
): { -readonly [Key in keyof IdleCompactionRecords]: IdleCompactionRecords[Key] } {
  const messageId = MessageId.make("message-1");
  const nodeId = NodeId.make("root-node");
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-MINUTE_MS),
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Explain this code",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-MINUTE_MS),
        updatedAt: at(-MINUTE_MS),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-MINUTE_MS),
        updatedAt: at(),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("provider-turn-1"),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        tokenUsage: {
          usedTokens: usage.usedTokens ?? 250_000,
          ...(usage.cacheExpiresInMs === undefined
            ? {}
            : { promptCacheExpiresAt: DateTime.formatIso(at(usage.cacheExpiresInMs)) }),
          ...(usage.promptCacheTtlMs === undefined
            ? {}
            : { promptCacheTtlMs: usage.promptCacheTtlMs }),
          updatedAt: DateTime.formatIso(at(-(usage.ageMs ?? 0))),
        },
      },
    ],
    runtimeRequests: [],
    turnItems: [],
    contextTransfers: [],
  };
}

describe("idleCompactionWindow", () => {
  it("skips small contexts, unknown expiry, other providers, switched threads, and compactions", () => {
    const cache = { cacheExpiresInMs: 60 * MINUTE_MS };
    expect(idleCompactionWindow(records({ ...cache, usedTokens: 199_999 }), NOW_MS)).toBeNull();
    expect(idleCompactionWindow(records(), NOW_MS)).toBeNull();
    const codex = records(cache);
    codex.providerThreads = [
      { ...codex.providerThreads[0]!, driver: ProviderDriverKind.make("codex") },
    ];
    expect(idleCompactionWindow(codex, NOW_MS)).toBeNull();
    const switched = records(cache);
    switched.thread = { ...switched.thread, providerInstanceId: ProviderInstanceId.make("codex") };
    expect(idleCompactionWindow(switched, NOW_MS)).toBeNull();
    const compacted = records(cache);
    compacted.messages = [{ ...compacted.messages[0]!, text: "/compact" }];
    expect(idleCompactionWindow(compacted, NOW_MS)).toBeNull();
    const archived = records(cache);
    archived.thread = { ...archived.thread, archivedAt: at() };
    expect(idleCompactionWindow(archived, NOW_MS)).toBeNull();
  });
});

describe("shouldCompactBeforeSend", () => {
  const NOW = DateTime.formatIso(at());
  const stale = { ageMs: 2 * 60 * MINUTE_MS };

  it("compacts a large session once its prompt cache has expired", () => {
    expect(shouldCompactBeforeSend(records(stale), NOW)).toBe(true);
    expect(
      shouldCompactBeforeSend(
        records({ ageMs: 6 * MINUTE_MS, promptCacheTtlMs: 5 * MINUTE_MS }),
        NOW,
      ),
    ).toBe(true);
  });

  it("uses the fallback TTL when Claude reported none", () => {
    expect(shouldCompactBeforeSend(records({ ageMs: 69 * MINUTE_MS }), NOW)).toBe(false);
    expect(shouldCompactBeforeSend(records({ ageMs: 70 * MINUTE_MS }), NOW)).toBe(true);
  });

  it("leaves a warm or small session alone", () => {
    expect(
      shouldCompactBeforeSend(
        records({ ageMs: 4 * MINUTE_MS, promptCacheTtlMs: 5 * MINUTE_MS }),
        NOW,
      ),
    ).toBe(false);
    expect(shouldCompactBeforeSend(records({ ...stale, usedTokens: 199_999 }), NOW)).toBe(false);
  });

  it("still compacts a thread that is settled, snoozed, or whose last run did not complete", () => {
    const settled = records(stale);
    settled.thread = { ...settled.thread, settledAt: at() };
    expect(shouldCompactBeforeSend(settled, NOW)).toBe(true);
    const snoozed = records(stale);
    snoozed.thread = { ...snoozed.thread, snoozedUntil: at(60 * MINUTE_MS) };
    expect(shouldCompactBeforeSend(snoozed, NOW)).toBe(true);
    for (const status of ["failed", "interrupted"] as const) {
      const ended = records(stale);
      ended.runs = [{ ...ended.runs[0]!, status }];
      expect(shouldCompactBeforeSend(ended, NOW)).toBe(true);
    }
  });

  it("skips a thread that has no session yet, and any other provider", () => {
    const unstarted = records(stale);
    unstarted.runs = [];
    unstarted.messages = [];
    unstarted.providerTurns = [];
    expect(shouldCompactBeforeSend(unstarted, NOW)).toBe(false);
    const codex = records(stale);
    codex.providerThreads = [
      { ...codex.providerThreads[0]!, driver: ProviderDriverKind.make("codex") },
    ];
    expect(shouldCompactBeforeSend(codex, NOW)).toBe(false);
  });

  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "waits out a %s run instead of compacting into it",
    (status) => {
      const busy = records(stale);
      busy.runs = [...busy.runs, { ...busy.runs[0]!, id: RunId.make("run-2"), ordinal: 2, status }];
      expect(shouldCompactBeforeSend(busy, NOW)).toBe(false);
    },
  );

  it("never compacts a compaction", () => {
    const compacted = records(stale);
    compacted.messages = [{ ...compacted.messages[0]!, text: "/compact" }];
    expect(shouldCompactBeforeSend(compacted, NOW)).toBe(false);
  });

  it("keeps full history once the thread answered Don't ask again", () => {
    const dismissed = records(stale);
    dismissed.runtimeRequests = [
      {
        kind: "user_input",
        status: "resolved",
        answers: {
          "This session is 2h 0m old and uses 250,000 tokens. Compact it before continuing?":
            "Don't ask again",
        },
      } as never,
    ];
    expect(shouldCompactBeforeSend(dismissed, NOW)).toBe(false);
  });

  it("leaves work meant for the next turn to reach it", () => {
    const waiting = records(stale);
    waiting.runtimeRequests = [{ kind: "user_input", status: "pending" } as never];
    expect(shouldCompactBeforeSend(waiting, NOW)).toBe(false);
    const mergeBack = records(stale);
    mergeBack.contextTransfers = [
      { type: "merge_back", targetThreadId: threadId, status: "pending" } as never,
    ];
    expect(shouldCompactBeforeSend(mergeBack, NOW)).toBe(false);
  });
});
