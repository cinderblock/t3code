import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * Queued messages — user messages held server-side until a trigger fires,
 * then dispatched as a normal `message.dispatch`.
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
   * Send after a usage window's next reset. The server stamps the two baseline
   * fields; anything a client sends in them is replaced. Rows queued before
   * they existed have neither and fire on what the window reads now.
   */
  Schema.Struct({
    type: Schema.Literal("window-reset"),
    /** The provider instance whose limits are watched. */
    accountKey: TrimmedNonEmptyString,
    /**
     * `ServerProviderUsageWindow.id` (`five_hour`, `seven_day`, …). The
     * fork's earlier `session:all` / `weekly:all` ids are still honoured by
     * window kind, so messages queued before the switch keep firing.
     */
    windowId: TrimmedNonEmptyString,
    /** The reset this message waits for. Null until the window advertises one ahead of it. */
    resetsAt: Schema.optional(Schema.NullOr(IsoDateTime)),
    /** Highest usage seen since queueing. A fall from it to near zero is a reset. */
    peakPercent: Schema.optional(Schema.Number),
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
  /**
   * Claimed by the reactor and being dispatched. A row that is still `sending`
   * when the server starts was interrupted mid-dispatch and is marked failed
   * rather than re-sent, since the turn may already have started.
   */
  "sending",
  /** Trigger fired; turn dispatched. */
  "sent",
  /** Dispatch attempted but the orchestration command failed. */
  "failed",
  /** Cancelled before firing, or dismissed after failing. */
  "cancelled",
]);
export type QueuedMessageStatus = typeof QueuedMessageStatus.Type;

/**
 * Only `modelSelection` is replayed: runtime and interaction mode are thread state, so the
 * composer saves them when it queues, as a send does, and the message uses the thread's modes
 * when it fires. The two fields stay because rows queued before orchestration v2 carry them.
 */
export const QueuedMessageSendContext = Schema.Struct({
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** Set when this may be the thread's first message, which starts it the way a first send does. */
  launch: Schema.optional(
    Schema.Struct({
      projectId: ProjectId,
      title: TrimmedNonEmptyString,
      workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
    }),
  ),
});
export type QueuedMessageSendContext = typeof QueuedMessageSendContext.Type;

export const QueuedMessage = Schema.Struct({
  id: QueuedMessageId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  /** Owned by the row until it sends; empty once sent, or cancelled and no longer restorable. */
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  context: Schema.optional(OrchestrationMessageContext),
  trigger: QueuedMessageTrigger,
  sendContext: QueuedMessageSendContext,
  status: QueuedMessageStatus,
  /** Why the message was queued (e.g. auto-converted after a cap hit). */
  origin: Schema.Literals(["user", "cap-hit-auto", "agent"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Set when status is "sent". */
  sentAt: Schema.NullOr(IsoDateTime),
  /** Set when status is "failed". */
  failureDetail: Schema.NullOr(Schema.String),
  /** Set on a cancelled message that still holds its content; the server drops it at this time. */
  restorableUntil: Schema.optional(IsoDateTime),
  cancelledBy: Schema.optional(Schema.Literals(["user", "agent"])),
});
export type QueuedMessage = typeof QueuedMessage.Type;

export const QueuedMessageEnqueueInput = Schema.Struct({
  id: QueuedMessageId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  /** Pending uploads; the server claims them for the thread, so they outlive the upload sweep. */
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  context: Schema.optional(OrchestrationMessageContext),
  trigger: QueuedMessageTrigger,
  sendContext: QueuedMessageSendContext,
  origin: Schema.Literals(["user", "cap-hit-auto", "agent"]),
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

export const QueuedMessageDiscardInput = Schema.Struct({
  id: QueuedMessageId,
});
export type QueuedMessageDiscardInput = typeof QueuedMessageDiscardInput.Type;

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
  Schema.TaggedStruct("snapshot", { messages: Schema.Array(QueuedMessage) }),
  Schema.TaggedStruct("upserted", { message: QueuedMessage }),
  Schema.TaggedStruct("removed", { id: QueuedMessageId }),
]);
export type QueuedMessageStreamEvent = typeof QueuedMessageStreamEvent.Type;

export class QueuedMessageError extends Schema.TaggedError<QueuedMessageError>()(
  "QueuedMessageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
