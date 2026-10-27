import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

/**
 * Threads holding a send-later message that has not gone out yet. A read-only view of the
 * queue table, kept apart from `QueuedMessageService` because building that service starts
 * its dispatcher, and a second dispatcher would race the first on `claim`.
 */
export class PendingQueuedThreads extends Context.Service<
  PendingQueuedThreads,
  {
    readonly threadIds: Effect.Effect<ReadonlySet<ThreadId>, SqlError.SqlError>;
  }
>()("t3/queue/PendingQueuedThreads") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadIds = sql<{ readonly threadId: string }>`
    SELECT DISTINCT thread_id AS "threadId"
    FROM fork_queued_messages
    WHERE status IN ('pending', 'sending')
  `.pipe(Effect.map((rows) => new Set(rows.map((row) => ThreadId.make(row.threadId)))));
  return PendingQueuedThreads.of({ threadIds });
});

export const layer = Layer.effect(PendingQueuedThreads, make);
