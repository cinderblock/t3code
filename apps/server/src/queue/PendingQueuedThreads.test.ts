import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import createQueuedMessages from "../persistence/Migrations/fork/002_QueuedMessages.ts";
import * as PendingQueuedThreads from "./PendingQueuedThreads.ts";

it.effect("lists threads whose send-later message has not gone out yet", () =>
  Effect.gen(function* () {
    yield* createQueuedMessages;
    const sql = yield* SqlClient.SqlClient;
    const rows: ReadonlyArray<readonly [string, string, string]> = [
      ["m1", "waiting", "pending"],
      ["m2", "waiting", "pending"],
      ["m3", "dispatching", "sending"],
      ["m4", "done", "sent"],
      ["m5", "dropped", "cancelled"],
      ["m6", "broken", "failed"],
    ];
    for (const [id, threadId, status] of rows) {
      yield* sql`
        INSERT INTO fork_queued_messages (
          id, thread_id, message_id, text, trigger_json, send_context_json,
          status, origin, created_at, updated_at
        ) VALUES (
          ${id}, ${threadId}, ${`message-${id}`}, 'hi', '{}', '{}',
          ${status}, 'user', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z'
        )
      `;
    }
    const pending = yield* PendingQueuedThreads.make;
    assert.deepStrictEqual([...(yield* pending.threadIds)].toSorted(), ["dispatching", "waiting"]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
