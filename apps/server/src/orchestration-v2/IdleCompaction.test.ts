import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  type OrchestrationV2ThreadProjection,
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

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
  it("skips small contexts, unknown expiry, other providers, switched threads, compactions, and side chats", () => {
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
    const steered = records(cache);
    steered.runs = [
      ...steered.runs,
      {
        ...steered.runs[0]!,
        id: RunId.make("run-2"),
        ordinal: 2,
        userMessageId: MessageId.make("message-2"),
        status: "cancelled",
        startedAt: null,
      },
    ];
    expect(idleCompactionWindow(steered, NOW_MS)?.runId).toBe(runId);
    // A turn Claude itself reported as cancelled did run, so it stays the latest.
    steered.runs = steered.runs.map((run) => ({ ...run, startedAt: at(-MINUTE_MS) }));
    expect(idleCompactionWindow(steered, NOW_MS)).toBeNull();
    const archived = records(cache);
    archived.thread = { ...archived.thread, archivedAt: at() };
    expect(idleCompactionWindow(archived, NOW_MS)).toBeNull();
    const sideChat = records(cache);
    expect(idleCompactionWindow(sideChat, NOW_MS)).not.toBeNull();
    sideChat.thread = {
      ...sideChat.thread,
      lineage: { ...sideChat.thread.lineage, relationshipToParent: "fork", sideChat: true },
    };
    expect(idleCompactionWindow(sideChat, NOW_MS)).toBeNull();
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

describe("IdleCompactionService", () => {
  it.effect.each([
    { mode: "onReturn", reads: 0 },
    { mode: "off", reads: 0 },
    { mode: "beforeCacheExpires", reads: 1 },
    { mode: "beforeCacheExpires", override: "off", reads: 0 },
    { mode: "onReturn", override: "beforeCacheExpires", reads: 1 },
    { mode: "beforeCacheExpires", projectDisabled: true, reads: 0 },
    { mode: "beforeCacheExpires", enabled: false, reads: 0 },
    { mode: "beforeCacheExpires", driver: "codex", instance: "codex", reads: 0 },
    { mode: "beforeCacheExpires", driver: "codex", instance: "custom-codex", reads: 0 },
    { mode: "beforeCacheExpires", driver: "claudeAgent", instance: "custom-claude", reads: 1 },
    { mode: "beforeCacheExpires", unconfigured: true, reads: 1 },
  ] as const)(
    "loads history only for eligible idle compaction: $mode/$override/$enabled/$projectDisabled/$instance/$unconfigured",
    (scenario) => {
      const test = {
        override: "default",
        enabled: true,
        projectDisabled: false,
        ...scenario,
      } as const;
      return Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW_MS);
          const selectedInstance = ProviderInstanceId.make(
            "instance" in test ? test.instance : "claudeAgent",
          );
          const driver = ProviderDriverKind.make("driver" in test ? test.driver : "claudeAgent");
          const base = records({ cacheExpiresInMs: 2 * MINUTE_MS });
          const data: OrchestrationV2ThreadProjection = {
            ...base,
            thread: {
              ...base.thread,
              providerInstanceId: selectedInstance,
              modelSelection: { ...base.thread.modelSelection, instanceId: selectedInstance },
            },
            runs: base.runs.map((run) => ({
              ...run,
              providerInstanceId: selectedInstance,
              modelSelection: { ...run.modelSelection, instanceId: selectedInstance },
            })),
            providerThreads: base.providerThreads.map((thread) => ({
              ...thread,
              driver,
              providerInstanceId: selectedInstance,
            })),
            attempts: [],
            nodes: [],
            subagents: [],
            providerSessions: [],
            plans: [],
            checkpointScopes: [],
            checkpoints: [],
            contextHandoffs: [],
            visibleTurnItems: [],
            updatedAt: at(),
          };
          let historyReads = 0;
          let dispatches = 0;
          const done = yield* Deferred.make<void>();
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (...args) => {
                end(...args);
                if (span.name === "IdleCompactionService.compactWhenDue")
                  Deferred.doneUnsafe(done, Effect.void);
              };
              return span;
            },
          });
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.make({
                id: EventId.make("idle-completed"),
                type: "run.updated",
                threadId,
                runId,
                occurredAt: at(),
                payload: data.runs[0]!,
              }),
              dispatch: () =>
                Effect.sync(() => {
                  dispatches++;
                  return { sequence: 1, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () => Effect.succeed(data.thread),
              getThreadRecords: () =>
                Effect.sync(() => {
                  historyReads++;
                  return data;
                }),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                idleCompaction: test.mode,
                providerInstances:
                  "unconfigured" in test
                    ? {}
                    : {
                        [selectedInstance]: {
                          driver,
                          enabled: test.enabled,
                          config: { idleCompaction: test.override },
                        },
                      },
                projectSettingsOverrides: test.projectDisabled
                  ? {
                      [data.thread.projectId]: {
                        providerInstances: { [selectedInstance]: { enabled: false } },
                      },
                    }
                  : {},
              }),
            }),
          );
          yield* Effect.gen(function* () {
            const service = yield* IdleCompactionService.make;
            yield* service.start();
            yield* Deferred.await(done);
          }).pipe(Effect.provide(dependencies), Effect.withTracer(tracer));
          expect(historyReads).toBe(test.reads);
          expect(dispatches).toBe(test.reads);
        }),
      );
    },
  );

  it.effect("keeps the latest run's compaction when an earlier run reports completed again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const base = records({ cacheExpiresInMs: 10 * MINUTE_MS });
        const laterRunId = RunId.make("run-2");
        const laterMessageId = MessageId.make("message-2");
        const earlierRun = base.runs[0]!;
        const laterRun = {
          ...earlierRun,
          id: laterRunId,
          ordinal: 2,
          userMessageId: laterMessageId,
        };
        const cancelledRun = {
          ...earlierRun,
          id: RunId.make("run-3"),
          ordinal: 3,
          userMessageId: MessageId.make("message-3"),
          status: "cancelled" as const,
          startedAt: null,
        };
        const data: OrchestrationV2ThreadProjection = {
          ...base,
          runs: [earlierRun, laterRun, cancelledRun],
          messages: [
            ...base.messages,
            { ...base.messages[0]!, id: laterMessageId, runId: laterRunId, text: "Keep going" },
          ],
          providerThreads: [{ ...base.providerThreads[0]!, lastRunOrdinal: 2 }],
          attempts: [],
          nodes: [],
          subagents: [],
          providerSessions: [],
          plans: [],
          checkpointScopes: [],
          checkpoints: [],
          contextHandoffs: [],
          visibleTurnItems: [],
          updatedAt: at(),
        };
        const completed = (run: typeof earlierRun) => ({
          id: EventId.make(`completed-${run.id}`),
          type: "run.updated" as const,
          threadId,
          runId: run.id,
          occurredAt: at(),
          payload: run,
        });
        const dispatched: Array<string> = [];
        const streamDone = yield* Deferred.make<void>();
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            // A delegated completion on the earlier run lands after the later run completed.
            streamDomainEvents: Stream.make(completed(laterRun), completed(earlierRun)).pipe(
              Stream.ensuring(Deferred.succeed(streamDone, undefined)),
            ),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command.commandId);
                return { sequence: 1, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed(data.thread),
            getThreadRecords: (_threadId, _keys, options) =>
              Effect.succeed({
                ...data,
                messages: data.messages.filter(
                  (message) =>
                    options?.messageRunIds === undefined ||
                    (message.runId !== null && options.messageRunIds.includes(message.runId)),
                ),
              }),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              idleCompaction: "beforeCacheExpires",
            }),
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* IdleCompactionService.make;
          yield* service.start();
          yield* Deferred.await(streamDone);
          yield* TestClock.adjust(9 * MINUTE_MS);
        }).pipe(Effect.provide(dependencies));
        expect(dispatched).toEqual(["server:idle-compact:idle-thread:run-2"]);
      }),
    ),
  );
});
