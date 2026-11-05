import {
  CommandId,
  threadBlockReleased,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

class ThreadBlockServiceV2 extends Context.Service<
  ThreadBlockServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadBlockService/ThreadBlockServiceV2") {}

const RUN_STOPPED: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** The thread whose state this event can change for threads waiting on it, if any. */
function eventBlockerThreadId(event: OrchestrationV2DomainEvent): ThreadId | null {
  switch (event.type) {
    case "thread.settled":
    case "thread.archived":
    case "thread.deleted":
    case "thread.unblocked":
      return event.threadId;
    case "run.updated":
      return RUN_STOPPED.has(event.payload.status) ? event.threadId : null;
    default:
      return null;
  }
}

/** Releases every block that has run its course, or only those waiting on one thread. */
export const releaseBlockedThreads = Effect.fn("ThreadBlockServiceV2.release")(
  function* (blockerThreadId: ThreadId | undefined) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const random = yield* SecureRandom.SecureRandom;
    const blocked = yield* projections.getBlockedThreads(blockerThreadId);
    yield* Effect.forEach(
      blocked,
      (thread) =>
        Effect.gen(function* () {
          const blocker = yield* projections.getThreadShell(thread.blockedOn.threadId);
          if (!threadBlockReleased(thread.blockedOn, blocker)) return;
          const uuid = yield* random.uuidV4();
          yield* orchestrator.dispatch({
            type: "thread.unblock",
            commandId: CommandId.make(`server:unblock:${thread.id}:${uuid}`),
            threadId: thread.id,
            reason: "blocker",
          });
        }),
      { discard: true },
    );
  },
  (effect) =>
    effect.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("releasing blocked threads failed", { cause: Cause.pretty(cause) }),
      ),
    ),
);

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const context = yield* Effect.context<
    Orchestrator.OrchestratorV2 | ProjectionStore.ProjectionStoreV2 | SecureRandom.SecureRandom
  >();
  const sweeps = yield* makeDrainableWorker((blockerThreadId: ThreadId | undefined) =>
    releaseBlockedThreads(blockerThreadId).pipe(Effect.provide(context)),
  );

  const start: ThreadBlockServiceV2["Service"]["start"] = Effect.fn("ThreadBlockServiceV2.start")(
    function* () {
      // Catches what happened while the server was down, and a blocker that vanished without an event.
      yield* forkParked(
        sweeps.enqueue(undefined).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
          const blockerThreadId = eventBlockerThreadId(event);
          return blockerThreadId === null ? Effect.void : sweeps.enqueue(blockerThreadId);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Thread block event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return { start, drain: sweeps.drain } satisfies ThreadBlockServiceV2["Service"];
});
