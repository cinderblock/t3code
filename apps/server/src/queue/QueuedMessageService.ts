/**
 * QueuedMessageService — durable "send later" for chat messages.
 *
 * Messages live in the `fork_queued_messages` table (outside the orchestration
 * event log — a cancelled queued message leaves no trace in the thread).
 * A reactor loop evaluates triggers against the clock and the usage limits
 * every provider instance publishes; when a trigger fires the stored send
 * context is replayed as a normal `message.dispatch` through thread
 * management, so downstream behavior is identical to the user pressing send.
 *
 * Dispatch is two-phase: a row is claimed as `sending` before the turn starts
 * and settled to `sent`/`failed` afterwards, so a dispatch whose settle write
 * fails can never be replayed as a second turn on the next tick.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  ChatAttachment,
  CommandId,
  MessageId,
  OrchestrationMessageContext,
  QueuedMessageError,
  QueuedMessageSendContext,
  QueuedMessageStatus,
  QueuedMessageTrigger,
  ThreadId,
  type QueuedMessage,
  type QueuedMessageCancelInput,
  type QueuedMessageEnqueueInput,
  type QueuedMessageId,
  type QueuedMessageListInput,
  type QueuedMessageListResult,
  type QueuedMessageStreamEvent,
  type QueuedMessageUpdateInput,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  remapComposerContextAttachments,
} from "@t3tools/shared/composerContextReferences";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as AttachmentClaims from "../orchestration-v2/AttachmentClaims.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";

const REACTOR_TICK = Duration.seconds(15);
/** A window read as ≤ this percent counts as freshly reset. */
const RESET_EPSILON_PERCENT = 5;

const TriggerJson = Schema.fromJsonString(QueuedMessageTrigger);
const SendContextJson = Schema.fromJsonString(QueuedMessageSendContext);
const AttachmentsJson = Schema.fromJsonString(Schema.Array(ChatAttachment));
const ContextJson = Schema.fromJsonString(OrchestrationMessageContext);
const decodeTriggerExit = Schema.decodeUnknownExit(TriggerJson);
const decodeSendContextExit = Schema.decodeUnknownExit(SendContextJson);
const decodeAttachmentsExit = Schema.decodeUnknownExit(AttachmentsJson);
const decodeContextExit = Schema.decodeUnknownExit(ContextJson);
const decodeStatusExit = Schema.decodeUnknownExit(QueuedMessageStatus);
const encodeTrigger = Schema.encodeSync(TriggerJson);
const encodeSendContext = Schema.encodeSync(SendContextJson);
const encodeAttachments = Schema.encodeSync(AttachmentsJson);
const encodeContext = Schema.encodeSync(ContextJson);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * The usage limits the reactor evaluates triggers against, keyed by provider
 * instance id (the trigger's `accountKey`).
 */
export type UsageLimitsByInstance = ReadonlyMap<string, ServerProviderUsageLimits>;

export function usageLimitsByInstance(
  providers: ReadonlyArray<ServerProvider>,
): UsageLimitsByInstance {
  const limits = new Map<string, ServerProviderUsageLimits>();
  for (const provider of providers) {
    if (provider.usageLimits !== undefined && provider.usageLimits.windows.length > 0) {
      limits.set(provider.instanceId, provider.usageLimits);
    }
  }
  return limits;
}

const LEGACY_WINDOW_KINDS: Readonly<Record<string, ServerProviderUsageWindow["kind"]>> = {
  session: "session",
  weekly: "weekly",
  monthly: "monthly",
};

/**
 * Resolve a trigger's window. Exact provider ids win; the fork's earlier
 * `session:all` / `weekly:all` ids (and any other `<kind>:…` form) fall back
 * to the account-wide window of that kind — the one with the shortest id, since
 * model-scoped windows extend the base id (`seven_day` vs `seven_day_fable`).
 */
export function findTriggerWindow(
  limits: ServerProviderUsageLimits | undefined,
  windowId: string,
): ServerProviderUsageWindow | null {
  if (limits === undefined) return null;
  const exact = limits.windows.find((window) => window.id === windowId);
  if (exact !== undefined) return exact;
  const kind = LEGACY_WINDOW_KINDS[windowId.split(":")[0] ?? ""];
  if (kind === undefined) return null;
  return (
    limits.windows
      .filter((window) => window.kind === kind)
      .toSorted((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id))[0] ?? null
  );
}

/**
 * Pure trigger predicate, evaluated by the reactor each tick.
 *
 * Usage-based triggers tolerate missing data conservatively: no limits for
 * the instance means "not due" (never fire blind).
 */
export function isTriggerDue(
  trigger: QueuedMessageTrigger,
  nowMs: number,
  limitsByInstance: UsageLimitsByInstance,
): boolean {
  switch (trigger.type) {
    case "at": {
      const atMs = Date.parse(trigger.at);
      return Number.isFinite(atMs) && nowMs >= atMs;
    }
    case "window-reset": {
      const window = findTriggerWindow(limitsByInstance.get(trigger.accountKey), trigger.windowId);
      if (window === null) {
        return false;
      }
      // Fresh window after the reset: utilization collapsed back to ~zero.
      if (window.usedPercent <= RESET_EPSILON_PERCENT) {
        return true;
      }
      // The advertised reset moment has passed but no read has seen the new
      // window yet.
      const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
      return Number.isFinite(resetMs) && nowMs >= resetMs;
    }
    case "headroom": {
      const window = findTriggerWindow(limitsByInstance.get(trigger.accountKey), trigger.windowId);
      if (window === null || window.resetsAt === undefined) {
        return false;
      }
      const resetMs = Date.parse(window.resetsAt);
      if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
        return false;
      }
      const remainingPercent = 100 - window.usedPercent;
      const minutesToReset = (resetMs - nowMs) / 60_000;
      return (
        remainingPercent >= trigger.minRemainingPercent && minutesToReset <= trigger.leadMinutes
      );
    }
  }
}

/** When an agent's message sends. Windows are named by kind; the provider's ids vary. */
export type QueuedMessageWhen =
  | { readonly at: string }
  | { readonly windowReset: "session" | "weekly" };

/**
 * Refuses what would send at once or never, since an agent cannot see the sidebar to notice.
 * A window this empty already reads as freshly reset, so `isTriggerDue` would send it now.
 */
export function resolveScheduledTrigger(
  when: QueuedMessageWhen,
  accountKey: string,
  nowMs: number,
  limitsByInstance: UsageLimitsByInstance,
): { readonly trigger: QueuedMessageTrigger } | { readonly error: string } {
  if ("at" in when) {
    return Date.parse(when.at) > nowMs
      ? { trigger: { type: "at", at: when.at } }
      : { error: `${when.at} is not in the future` };
  }
  const window = findTriggerWindow(limitsByInstance.get(accountKey), `${when.windowReset}:all`);
  if (window === null) {
    return { error: `This thread's provider reports no ${when.windowReset} usage window` };
  }
  if (window.usedPercent <= RESET_EPSILON_PERCENT) {
    const useAt =
      window.resetsAt === undefined ? "`at`" : `\`at\` with its reset time, ${window.resetsAt}`;
    return {
      error: `The ${when.windowReset} window is nearly unused and would send now. Use ${useAt}.`,
    };
  }
  return { trigger: { type: "window-reset", accountKey, windowId: window.id } };
}

interface QueuedMessageRow {
  readonly id: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly attachmentsJson: string | null;
  readonly contextJson: string | null;
  readonly triggerJson: string;
  readonly sendContextJson: string;
  readonly status: string;
  readonly origin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sentAt: string | null;
  readonly failureDetail: string | null;
}

/**
 * Decode one row, or explain why it cannot be. A row an older build wrote in a
 * shape this one no longer accepts must not take the whole queue down with it:
 * `list` leaves it out and the reactor retires it as failed.
 */
export function decodeQueuedMessageRow(
  row: QueuedMessageRow,
): { readonly message: QueuedMessage } | { readonly error: string } {
  const trigger = decodeTriggerExit(row.triggerJson);
  if (Exit.isFailure(trigger)) return { error: "Stored trigger could not be read" };
  const sendContext = decodeSendContextExit(row.sendContextJson);
  if (Exit.isFailure(sendContext)) return { error: "Stored send settings could not be read" };
  const status = decodeStatusExit(row.status);
  if (Exit.isFailure(status)) return { error: `Unknown status "${row.status}"` };
  const attachments =
    row.attachmentsJson === null ? null : decodeAttachmentsExit(row.attachmentsJson);
  if (attachments !== null && Exit.isFailure(attachments)) {
    return { error: "Stored attachments could not be read" };
  }
  const context = row.contextJson === null ? null : decodeContextExit(row.contextJson);
  if (context !== null && Exit.isFailure(context)) {
    return { error: "Stored context could not be read" };
  }
  return {
    message: {
      id: row.id as QueuedMessageId,
      threadId: ThreadId.make(row.threadId),
      messageId: MessageId.make(row.messageId),
      text: row.text,
      ...(attachments === null ? {} : { attachments: attachments.value }),
      ...(context === null ? {} : { context: context.value }),
      trigger: trigger.value,
      sendContext: sendContext.value,
      status: status.value,
      origin: row.origin as QueuedMessage["origin"],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sentAt: row.sentAt,
      failureDetail: row.failureDetail,
    },
  };
}

export class QueuedMessageService extends Context.Service<
  QueuedMessageService,
  {
    readonly enqueue: (
      input: QueuedMessageEnqueueInput,
    ) => Effect.Effect<QueuedMessage, QueuedMessageError>;
    /** Queues a message an agent wrote. It sends as the agent, in the thread's modes and model. */
    readonly enqueueForThread: (input: {
      readonly id: QueuedMessageId;
      readonly thread: Pick<
        OrchestrationV2ThreadShell,
        "id" | "providerInstanceId" | "runtimeMode" | "interactionMode"
      >;
      readonly text: string;
      readonly when: QueuedMessageWhen;
    }) => Effect.Effect<QueuedMessage, QueuedMessageError>;
    readonly update: (
      input: QueuedMessageUpdateInput,
    ) => Effect.Effect<QueuedMessage, QueuedMessageError>;
    /**
     * Cancels a pending message and removes its files, or dismisses a failed one. Fails when the
     * message is past that, so a success proves this caller took it back and nobody else did.
     */
    readonly cancel: (
      input: QueuedMessageCancelInput,
    ) => Effect.Effect<QueuedMessage, QueuedMessageError>;
    /** `cancel`, refusing a message that belongs to another thread. */
    readonly cancelForThread: (input: {
      readonly id: QueuedMessageId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<QueuedMessage, QueuedMessageError>;
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
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry;
  const config = yield* ServerConfig.ServerConfig;
  const attachmentServices = yield* Effect.context<
    FileSystem.FileSystem | ServerConfig.ServerConfig | DocumentText.DocumentText
  >();

  const eventsPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<QueuedMessageStreamEvent>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const serviceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );

  const selectRows = (threadId: string | undefined, status: string | undefined) =>
    sql`
      SELECT
        id,
        thread_id AS "threadId",
        message_id AS "messageId",
        text,
        attachments_json AS "attachmentsJson",
        context_json AS "contextJson",
        trigger_json AS "triggerJson",
        send_context_json AS "sendContextJson",
        status,
        origin,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        sent_at AS "sentAt",
        failure_detail AS "failureDetail"
      FROM fork_queued_messages
      WHERE 1 = 1
        ${threadId === undefined ? sql`` : sql`AND thread_id = ${threadId}`}
        ${status === undefined ? sql`` : sql`AND status = ${status}`}
      ORDER BY created_at ASC
    `.pipe(
      Effect.map((rows) => rows as unknown as ReadonlyArray<QueuedMessageRow>),
      Effect.mapError(toQueuedError("Failed to load queued messages")),
    );

  const loadById = Effect.fn("QueuedMessageService.loadById")(function* (id: string) {
    const rows = yield* sql`
      SELECT
        id,
        thread_id AS "threadId",
        message_id AS "messageId",
        text,
        attachments_json AS "attachmentsJson",
        context_json AS "contextJson",
        trigger_json AS "triggerJson",
        send_context_json AS "sendContextJson",
        status,
        origin,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        sent_at AS "sentAt",
        failure_detail AS "failureDetail"
      FROM fork_queued_messages
      WHERE id = ${id}
    `.pipe(Effect.mapError(toQueuedError("Failed to load queued message")));
    if (rows.length === 0) {
      return yield* new QueuedMessageError({ message: `Queued message ${id} was not found` });
    }
    const decoded = decodeQueuedMessageRow(rows[0] as unknown as QueuedMessageRow);
    if ("error" in decoded) {
      return yield* new QueuedMessageError({ message: `Queued message ${id}: ${decoded.error}` });
    }
    return decoded.message;
  });

  const publishUpsert = (message: QueuedMessage) =>
    PubSub.publish(eventsPubSub, { _tag: "upserted", message }).pipe(Effect.asVoid);

  const enqueue: QueuedMessageService["Service"]["enqueue"] = Effect.fn(
    "QueuedMessageService.enqueue",
  )(function* (input) {
    const uploads = input.attachments ?? [];
    // `cancel` deletes these files, so a row may only hold copies made for it.
    if (!uploads.every(AttachmentClaims.attachmentIsPendingUpload)) {
      return yield* new QueuedMessageError({ message: "Attachments must be pending uploads" });
    }
    // A pending upload is swept after a day; a message can wait a week for its window.
    const claimed = yield* AttachmentClaims.claimPendingAttachments({
      threadId: input.threadId,
      attachments: uploads,
    }).pipe(
      Effect.provide(attachmentServices),
      Effect.mapError((cause) => new QueuedMessageError({ message: cause.message, cause })),
    );
    const context = remapComposerContextAttachments(input.context, uploads, claimed.attachments);
    const now = yield* nowIso;
    yield* sql`
      INSERT INTO fork_queued_messages (
        id, thread_id, message_id, text, attachments_json, context_json, trigger_json,
        send_context_json, status, origin, created_at, updated_at, sent_at, failure_detail
      ) VALUES (
        ${input.id}, ${input.threadId}, ${input.messageId}, ${input.text},
        ${claimed.attachments.length === 0 ? null : encodeAttachments(claimed.attachments)},
        ${context === undefined ? null : encodeContext(context)},
        ${encodeTrigger(input.trigger)}, ${encodeSendContext(input.sendContext)},
        ${"pending"}, ${input.origin}, ${now}, ${now}, ${null}, ${null}
      )
    `.pipe(
      Effect.mapError(toQueuedError("Failed to enqueue message")),
      Effect.tapError(() =>
        AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths).pipe(
          Effect.provide(attachmentServices),
        ),
      ),
    );
    const message = yield* loadById(input.id);
    yield* publishUpsert(message);
    return message;
  });

  const enqueueForThread: QueuedMessageService["Service"]["enqueueForThread"] = Effect.fn(
    "QueuedMessageService.enqueueForThread",
  )(function* ({ id, thread, text, when }) {
    const resolved = resolveScheduledTrigger(
      when,
      thread.providerInstanceId,
      yield* Clock.currentTimeMillis,
      usageLimitsByInstance(yield* providerRegistry.getProviders),
    );
    if ("error" in resolved) {
      return yield* new QueuedMessageError({ message: resolved.error });
    }
    return yield* enqueue({
      id,
      threadId: thread.id,
      messageId: MessageId.make(`send-later:${id}`),
      text,
      trigger: resolved.trigger,
      sendContext: { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode },
      origin: "agent",
    });
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
      UPDATE fork_queued_messages
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
    const refused = (status: QueuedMessage["status"]) =>
      new QueuedMessageError({
        message: `Queued message ${input.id} is ${status}; only pending or failed messages can be cancelled`,
      });
    const existing = yield* loadById(input.id);
    if (existing.status !== "pending" && existing.status !== "failed") {
      return yield* refused(existing.status);
    }
    const now = yield* nowIso;
    // A failed row is dismissed the same way: it stops showing, and nothing
    // downstream ever distinguishes "cancelled before" from "dismissed after".
    const updated = yield* sql`
      UPDATE fork_queued_messages
      SET status = 'cancelled', updated_at = ${now}, attachments_json = NULL, context_json = NULL
      WHERE id = ${input.id} AND status = ${existing.status}
      RETURNING id
    `.pipe(Effect.mapError(toQueuedError("Failed to cancel queued message")));
    if (updated.length === 0) {
      return yield* refused((yield* loadById(input.id)).status);
    }
    // A failed send may still have reached the thread, which then owns these files.
    if (existing.status === "pending") {
      yield* AttachmentClaims.releaseClaimedAttachments(
        (existing.attachments ?? []).flatMap((attachment) => {
          const path = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          return path === null ? [] : [path];
        }),
      ).pipe(Effect.provide(attachmentServices));
    }
    const message = yield* loadById(input.id);
    yield* publishUpsert(message);
    return message;
  });

  const cancelForThread: QueuedMessageService["Service"]["cancelForThread"] = Effect.fn(
    "QueuedMessageService.cancelForThread",
  )(function* ({ id, threadId }) {
    const message = yield* loadById(id);
    if (message.threadId !== threadId) {
      return yield* new QueuedMessageError({ message: `Queued message ${id} was not found` });
    }
    return yield* cancel({ id });
  });

  const list: QueuedMessageService["Service"]["list"] = Effect.fn("QueuedMessageService.list")(
    function* (input) {
      const rows = yield* selectRows(input.threadId, undefined);
      const messages: Array<QueuedMessage> = [];
      for (const row of rows) {
        const decoded = decodeQueuedMessageRow(row);
        if ("message" in decoded) messages.push(decoded.message);
      }
      return { messages };
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

  /**
   * Take ownership of a pending row. Only a row still `pending` flips, so a
   * message can be dispatched at most once no matter how the settle goes.
   */
  const claim = Effect.fn("QueuedMessageService.claim")(function* (id: string) {
    const now = yield* nowIso;
    yield* sql`
      UPDATE fork_queued_messages
      SET status = 'sending', updated_at = ${now}
      WHERE id = ${id} AND status = 'pending'
    `.pipe(Effect.mapError(toQueuedError("Failed to claim queued message")));
    const message = yield* loadById(id);
    return message.status === "sending" ? message : null;
  });

  const markSent = Effect.fn("QueuedMessageService.markSent")(function* (id: string) {
    const now = yield* nowIso;
    yield* sql`
      UPDATE fork_queued_messages
      SET status = 'sent', sent_at = ${now}, updated_at = ${now},
        attachments_json = NULL, context_json = NULL
      WHERE id = ${id} AND status = 'sending'
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
      UPDATE fork_queued_messages
      SET status = 'failed', failure_detail = ${detail}, updated_at = ${now}
      WHERE id = ${id} AND status IN ('pending', 'sending')
    `.pipe(Effect.mapError(toQueuedError("Failed to mark queued message failed")));
    const message = yield* loadById(id);
    yield* publishUpsert(message);
  });

  const dispatchMessage = Effect.fn("QueuedMessageService.dispatchMessage")(function* (
    message: QueuedMessage,
  ) {
    // Runtime and interaction mode are thread state in orchestration v2, so the
    // send follows the thread's current modes; only the model rides along.
    // `queue_after_active` starts the run when the thread is idle and lines it
    // up behind a run that is still going when the trigger fires.
    const attachments = message.attachments ?? [];
    const dispatched = yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:queued-message:${message.id}`),
        threadId: message.threadId,
        messageId: message.messageId,
        text:
          message.text.length === 0 && attachments.length > 0
            ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT
            : message.text,
        ...(message.context !== undefined ? { context: message.context } : {}),
        attachments,
        ...(message.sendContext.modelSelection !== undefined
          ? { modelSelection: message.sendContext.modelSelection }
          : {}),
        dispatchMode: { type: "queue_after_active" },
        createdBy: message.origin === "agent" ? "agent" : "user",
        creationSource: "server",
      })
      .pipe(Effect.exit);
    if (Exit.isSuccess(dispatched)) {
      yield* markSent(message.id);
    } else {
      yield* markFailed(message.id, String(dispatched.cause));
    }
  });

  const reactorTick = Effect.gen(function* () {
    const rows = yield* selectRows(undefined, "pending");
    if (rows.length === 0) {
      return;
    }
    const limitsByInstance = usageLimitsByInstance(yield* providerRegistry.getProviders);
    const nowMs = yield* Clock.currentTimeMillis;
    for (const row of rows) {
      const decoded = decodeQueuedMessageRow(row);
      if ("error" in decoded) {
        // Retire it visibly instead of re-evaluating it forever.
        yield* markFailed(row.id, decoded.error);
        continue;
      }
      if (!isTriggerDue(decoded.message.trigger, nowMs, limitsByInstance)) {
        continue;
      }
      const claimed = yield* claim(row.id);
      if (claimed !== null) {
        yield* dispatchMessage(claimed);
      }
    }
  });

  // A row left `sending` by a crash mid-dispatch may or may not have started
  // its turn; re-sending could double it, so it is retired with a reason.
  yield* Effect.gen(function* () {
    const stuck = yield* selectRows(undefined, "sending");
    for (const row of stuck) {
      yield* markFailed(row.id, "Interrupted by a server restart while sending");
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to retire interrupted queued messages", {
        detail: String(cause),
      }),
    ),
  );

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
    enqueueForThread,
    update,
    cancel,
    cancelForThread,
    list,
    streamMessages,
  });
});

export const layer = Layer.effect(QueuedMessageService, make);
