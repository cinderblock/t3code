import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

/**
 * Queued messages — user messages held server-side until a trigger fires,
 * then dispatched as a normal `thread.turn.start`.
 *
 * These are scheduling metadata, not thread history: the thread's event log
 * only gains events when the send actually fires. The store lives outside
 * the orchestration event source on purpose — a cancelled queued message
 * leaves no trace in the thread.
 */

export const QueuedMessageId = TrimmedNonEmptyString.pipe(Schema.brand("QueuedMessageId"));
export type QueuedMessageId = typeof QueuedMessageId.Type;

export const QueuedMessageTrigger = Schema.Union([
  /** Send at an absolute wall-clock time. */
  Schema.Struct({
    type: Schema.Literal("at"),
    at: IsoDateTime,
  }),
  /**
   * Send when a usage window resets (its `resetsAt` passes, or the poller
   * observes utilization drop back near zero for that window).
   */
  Schema.Struct({
    type: Schema.Literal("window-reset"),
    accountKey: TrimmedNonEmptyString,
    /** UsageWindow id, e.g. "session:all" or "weekly:model:Fable". */
    windowId: TrimmedNonEmptyString,
  }),
  /**
   * Opportunistic headroom burn: send when the window is within `lead`
   * of its reset and at least `minRemainingPercent` of the window's
   * capacity is still unused — capacity that would otherwise expire.
   */
  Schema.Struct({
    type: Schema.Literal("headroom"),
    accountKey: TrimmedNonEmptyString,
    windowId: TrimmedNonEmptyString,
    minRemainingPercent: Schema.Number,
    /** How close to reset before firing, in minutes. */
    leadMinutes: Schema.Number,
  }),
]);
export type QueuedMessageTrigger = typeof QueuedMessageTrigger.Type;

export const QueuedMessageStatus = Schema.Literals([
  /** Waiting for its trigger. */
  "pending",
  /** Trigger fired; turn dispatched. */
  "sent",
  /** Dispatch attempted but the orchestration command failed. */
  "failed",
  /** Cancelled by the user before firing. */
  "cancelled",
]);
export type QueuedMessageStatus = typeof QueuedMessageStatus.Type;

/**
 * Everything needed to reconstruct the eventual `thread.turn.start`.
 * Captured from the composer at queue time so the send fires with the
 * settings the user saw, not whatever the thread drifted to later.
 */
export const QueuedMessageSendContext = Schema.Struct({
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type QueuedMessageSendContext = typeof QueuedMessageSendContext.Type;

export const QueuedMessage = Schema.Struct({
  id: QueuedMessageId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  trigger: QueuedMessageTrigger,
  sendContext: QueuedMessageSendContext,
  status: QueuedMessageStatus,
  /** Why the message was queued (e.g. auto-converted after a cap hit). */
  origin: Schema.Literals(["user", "cap-hit-auto"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Set when status is "sent". */
  sentAt: Schema.NullOr(IsoDateTime),
  /** Set when status is "failed". */
  failureDetail: Schema.NullOr(Schema.String),
});
export type QueuedMessage = typeof QueuedMessage.Type;

export const QueuedMessageEnqueueInput = Schema.Struct({
  id: QueuedMessageId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  trigger: QueuedMessageTrigger,
  sendContext: QueuedMessageSendContext,
  origin: Schema.Literals(["user", "cap-hit-auto"]),
});
export type QueuedMessageEnqueueInput = typeof QueuedMessageEnqueueInput.Type;

export const QueuedMessageUpdateInput = Schema.Struct({
  id: QueuedMessageId,
  /** Replace the trigger (the editable part). */
  trigger: Schema.optional(QueuedMessageTrigger),
  /** Replace the message text. */
  text: Schema.optional(Schema.String),
});
export type QueuedMessageUpdateInput = typeof QueuedMessageUpdateInput.Type;

export const QueuedMessageCancelInput = Schema.Struct({
  id: QueuedMessageId,
});
export type QueuedMessageCancelInput = typeof QueuedMessageCancelInput.Type;

export const QueuedMessageListInput = Schema.Struct({
  /** Restrict to one thread; omit for all pending messages. */
  threadId: Schema.optional(ThreadId),
});
export type QueuedMessageListInput = typeof QueuedMessageListInput.Type;

export const QueuedMessageListResult = Schema.Struct({
  messages: Schema.Array(QueuedMessage),
});
export type QueuedMessageListResult = typeof QueuedMessageListResult.Type;

export const QueuedMessageStreamEvent = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("snapshot"),
    messages: Schema.Array(QueuedMessage),
  }),
  Schema.Struct({
    _tag: Schema.Literal("upserted"),
    message: QueuedMessage,
  }),
  Schema.Struct({
    _tag: Schema.Literal("removed"),
    id: QueuedMessageId,
  }),
]);
export type QueuedMessageStreamEvent = typeof QueuedMessageStreamEvent.Type;

export class QueuedMessageError extends Schema.TaggedErrorClass<QueuedMessageError>()(
  "QueuedMessageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
