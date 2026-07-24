/**
 * QueuedMessageService — durable "send later" for chat messages.
 *
 * Messages live in the `queued_messages` table (outside the orchestration
 * event log — a cancelled queued message leaves no trace in the thread).
 * A reactor loop evaluates triggers against the clock and the latest
 * account usage snapshots; when a trigger fires the stored send context is
 * replayed as a normal `thread.turn.start` through the orchestration
 * engine, so downstream behavior is identical to the user pressing send.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  MessageId,
  QueuedMessageError,
  QueuedMessageSendContext,
  QueuedMessageTrigger,
  ThreadId,
  type AccountUsageSnapshot,
  type QueuedMessage,
  type QueuedMessageCancelInput,
  type QueuedMessageEnqueueInput,
  type QueuedMessageId,
  type QueuedMessageListInput,
  type QueuedMessageListResult,
  type QueuedMessageStreamEvent,
  type QueuedMessageUpdateInput,
  type UsageWindow,
} from "@t3tools/contracts";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { UsageBroadcaster } from "../usage/UsageBroadcaster.ts";

const REACTOR_TICK = Duration.seconds(15);
/** A window read as ≤ this percent counts as freshly reset. */
const RESET_EPSILON_PERCENT = 5;

const TriggerJson = Schema.fromJsonString(QueuedMessageTrigger);
const SendContextJson = Schema.fromJsonString(QueuedMessageSendContext);
const decodeTrigger = Schema.decodeUnknownSync(TriggerJson);
const decodeSendContext = Schema.decodeUnknownSync(SendContextJson);
const encodeTrigger = Schema.encodeSync(TriggerJson);
const encodeSendContext = Schema.encodeSync(SendContextJson);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Pure trigger predicate, evaluated by the reactor each tick.
 *
 * Usage-based triggers tolerate missing data conservatively: no snapshot
 * for the account means "not due" (never fire blind).
 */
export function isTriggerDue(
  trigger: QueuedMessageTrigger,
  nowMs: number,
  snapshotsByAccount: ReadonlyMap<string, AccountUsageSnapshot>,
): boolean {
  switch (trigger.type) {
    case "at": {
      const atMs = Date.parse(trigger.at);
      return Number.isFinite(atMs) && nowMs >= atMs;
    }
    case "window-reset": {
      const window = findWindow(snapshotsByAccount, trigger.accountKey, trigger.windowId);
      if (window === null) {
        return false;
      }
      // Fresh window after the reset: utilization collapsed back to ~zero.
      if (window.percent <= RESET_EPSILON_PERCENT) {
        return true;
      }
      // The advertised reset moment has passed but the poller hasn't seen
      // the new window yet.
      const resetMs = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
      return Number.isFinite(resetMs) && nowMs >= resetMs;
    }
    case "headroom": {
      const window = findWindow(snapshotsByAccount, trigger.accountKey, trigger.windowId);
      if (window === null || window.resetsAt === null) {
        return false;
      }
      const resetMs = Date.parse(window.resetsAt);
      if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
        return false;
      }
      const remainingPercent = 100 - window.percent;
      const minutesToReset = (resetMs - nowMs) / 60_000;
      return (
        remainingPercent >= trigger.minRemainingPercent && minutesToReset <= trigger.leadMinutes
      );
    }
  }
}

function findWindow(
  snapshotsByAccount: ReadonlyMap<string, AccountUsageSnapshot>,
  accountKey: string,
  windowId: string,
): UsageWindow | null {
  const snapshot = snapshotsByAccount.get(accountKey);
  if (!snapshot) return null;
  return snapshot.windows.find((window) => window.id === windowId) ?? null;
}

interface QueuedMessageRow {
  readonly id: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly triggerJson: string;
  readonly sendContextJson: string;
  readonly status: string;
  readonly origin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sentAt: string | null;
  readonly failureDetail: string | null;
}

function rowToMessage(row: QueuedMessageRow): QueuedMessage {
  return {
    id: row.id as QueuedMessageId,
    threadId: ThreadId.make(row.threadId),
    messageId: MessageId.make(row.messageId),
    text: row.text,
    trigger: decodeTrigger(row.triggerJson),
    sendContext: decodeSendContext(row.sendContextJson),
    status: row.status as QueuedMessage["status"],
    origin: row.origin as QueuedMessage["origin"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sentAt: row.sentAt,
    failureDetail: row.failureDetail,
  };
}

export class QueuedMessageService extends Context.Service<
  QueuedMessageService,
  {
    readonly enqueue: (
      input: QueuedMessageEnqueueInput,
    ) => Effect.Effect<QueuedMessage, QueuedMessageError>;
    readonly update: (
      input: QueuedMessageUpdateInput,
    ) => Effect.Effect<QueuedMessage, QueuedMessageError>;
    readonly cancel: (
      input: QueuedMessageCancelInput,
    ) => Effect.Effect<QueuedMessage, QueuedMessageError>;
    readonly list: (
      input: QueuedMessageListInput,
    ) => Effect.Effect<QueuedMessageListResult, QueuedMessageError>;
    readonly streamMessages: (
      input: QueuedMessageListInput,
    ) => Stream.Stream<QueuedMessageStreamEvent, QueuedMessageError>;
  }
>()("t3/queue/QueuedMessageService") {}

const toQueuedError = (message: string) => (cause: unknown) =>
  new QueuedMessageError({ message, cause });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const usageBroadcaster = yield* UsageBroadcaster;

  const eventsPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<QueuedMessageStreamEvent>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const serviceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );

  const loadById = Effect.fn("QueuedMessageService.loadById")(function* (id: string) {
    const rows = yield* sql`
      SELECT
        id,
        thread_id AS "threadId",
        message_id AS "messageId",
        text,
        trigger_json AS "triggerJson",
        send_context_json AS "sendContextJson",
        status,
        origin,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        sent_at AS "sentAt",
        failure_detail AS "failureDetail"
      FROM queued_messages
      WHERE id = ${id}
    `.pipe(Effect.mapError(toQueuedError("Failed to load queued message")));
    if (rows.length === 0) {
      return yield* new QueuedMessageError({ message: `Queued message ${id} was not found` });
    }
    return rowToMessage(rows[0] as unknown as QueuedMessageRow);
  });

  const publishUpsert = (message: QueuedMessage) =>
    PubSub.publish(eventsPubSub, { _tag: "upserted", message }).pipe(Effect.asVoid);

  const enqueue: QueuedMessageService["Service"]["enqueue"] = Effect.fn(
    "QueuedMessageService.enqueue",
  )(function* (input) {
    const now = yield* nowIso;
    yield* sql`
      INSERT INTO queued_messages (
        id, thread_id, message_id, text, trigger_json, send_context_json,
        status, origin, created_at, updated_at, sent_at, failure_detail
      ) VALUES (
        ${input.id}, ${input.threadId}, ${input.messageId}, ${input.text},
        ${encodeTrigger(input.trigger)}, ${encodeSendContext(input.sendContext)},
        ${"pending"}, ${input.origin}, ${now}, ${now}, ${null}, ${null}
      )
    `.pipe(Effect.mapError(toQueuedError("Failed to enqueue message")));
    const message = yield* loadById(input.id);
    yield* publishUpsert(message);
    return message;
  });

  const update: QueuedMessageService["Service"]["update"] = Effect.fn(
    "QueuedMessageService.update",
  )(function* (input) {
    const existing = yield* loadById(input.id);
    if (existing.status !== "pending") {
      return yield* new QueuedMessageError({
        message: `Queued message ${input.id} is ${existing.status}; only pending messages can be edited`,
      });
    }
    const now = yield* nowIso;
    const nextTrigger = input.trigger ?? existing.trigger;
    const nextText = input.text ?? existing.text;
    yield* sql`
      UPDATE queued_messages
      SET trigger_json = ${encodeTrigger(nextTrigger)}, text = ${nextText}, updated_at = ${now}
      WHERE id = ${input.id} AND status = 'pending'
    `.pipe(Effect.mapError(toQueuedError("Failed to update queued message")));
    const message = yield* loadById(input.id);
    yield* publishUpsert(message);
    return message;
  });

  const cancel: QueuedMessageService["Service"]["cancel"] = Effect.fn(
    "QueuedMessageService.cancel",
  )(function* (input) {
    const now = yield* nowIso;
    yield* sql`
      UPDATE queued_messages
      SET status = 'cancelled', updated_at = ${now}
      WHERE id = ${input.id} AND status = 'pending'
    `.pipe(Effect.mapError(toQueuedError("Failed to cancel queued message")));
    const message = yield* loadById(input.id);
    yield* publishUpsert(message);
    return message;
  });

  const list: QueuedMessageService["Service"]["list"] = Effect.fn("QueuedMessageService.list")(
    function* (input) {
      const rows = yield* (
        input.threadId !== undefined
          ? sql`
            SELECT
              id,
              thread_id AS "threadId",
              message_id AS "messageId",
              text,
              trigger_json AS "triggerJson",
              send_context_json AS "sendContextJson",
              status,
              origin,
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              sent_at AS "sentAt",
              failure_detail AS "failureDetail"
            FROM queued_messages
            WHERE thread_id = ${input.threadId}
            ORDER BY created_at ASC
          `
          : sql`
            SELECT
              id,
              thread_id AS "threadId",
              message_id AS "messageId",
              text,
              trigger_json AS "triggerJson",
              send_context_json AS "sendContextJson",
              status,
              origin,
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              sent_at AS "sentAt",
              failure_detail AS "failureDetail"
            FROM queued_messages
            ORDER BY created_at ASC
          `
      ).pipe(Effect.mapError(toQueuedError("Failed to list queued messages")));
      return { messages: rows.map((row) => rowToMessage(row as unknown as QueuedMessageRow)) };
    },
  );

  const streamMessages: QueuedMessageService["Service"]["streamMessages"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(eventsPubSub);
        const initial = yield* list(input);
        return Stream.concat(
          Stream.make({ _tag: "snapshot" as const, messages: initial.messages }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (event) =>
                input.threadId === undefined ||
                event._tag === "removed" ||
                (event._tag === "upserted" && event.message.threadId === input.threadId) ||
                event._tag === "snapshot",
            ),
          ),
        );
      }),
    );

  const markSent = Effect.fn("QueuedMessageService.markSent")(function* (id: string) {
    const now = yield* nowIso;
    yield* sql`
      UPDATE queued_messages
      SET status = 'sent', sent_at = ${now}, updated_at = ${now}
      WHERE id = ${id} AND status = 'pending'
    `.pipe(Effect.mapError(toQueuedError("Failed to mark queued message sent")));
    const message = yield* loadById(id);
    yield* publishUpsert(message);
  });

  const markFailed = Effect.fn("QueuedMessageService.markFailed")(function* (
    id: string,
    detail: string,
  ) {
    const now = yield* nowIso;
    yield* sql`
      UPDATE queued_messages
      SET status = 'failed', failure_detail = ${detail}, updated_at = ${now}
      WHERE id = ${id} AND status = 'pending'
    `.pipe(Effect.mapError(toQueuedError("Failed to mark queued message failed")));
    const message = yield* loadById(id);
    yield* publishUpsert(message);
  });

  const dispatchMessage = Effect.fn("QueuedMessageService.dispatchMessage")(function* (
    message: QueuedMessage,
  ) {
    const dispatched = yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:queued-message:${message.id}`),
        threadId: message.threadId,
        message: {
          messageId: message.messageId,
          role: "user",
          text: message.text,
          attachments: [],
        },
        ...(message.sendContext.modelSelection !== undefined
          ? { modelSelection: message.sendContext.modelSelection }
          : {}),
        runtimeMode: message.sendContext.runtimeMode,
        interactionMode: message.sendContext.interactionMode,
        createdAt: yield* nowIso,
      })
      .pipe(Effect.exit);
    if (Exit.isSuccess(dispatched)) {
      yield* markSent(message.id);
    } else {
      yield* markFailed(message.id, String(dispatched.cause));
    }
  });

  const reactorTick = Effect.gen(function* () {
    const pending = yield* list({});
    const pendingMessages = pending.messages.filter((message) => message.status === "pending");
    if (pendingMessages.length === 0) {
      return;
    }
    const snapshots = yield* usageBroadcaster.getSnapshots;
    const snapshotsByAccount = new Map(
      snapshots.map((snapshot) => [snapshot.accountKey, snapshot] as const),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    for (const message of pendingMessages) {
      if (isTriggerDue(message.trigger, nowMs, snapshotsByAccount)) {
        yield* dispatchMessage(message);
      }
    }
  });

  yield* reactorTick.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Queued message reactor tick failed", { detail: String(cause) }),
    ),
    Effect.flatMap(() => Effect.sleep(REACTOR_TICK)),
    Effect.forever,
    Effect.forkIn(serviceScope),
  );

  return QueuedMessageService.of({
    enqueue,
    update,
    cancel,
    list,
    streamMessages,
  });
});

export const layer = Layer.effect(QueuedMessageService, make);
