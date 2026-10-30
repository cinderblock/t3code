import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachment,
  ChatAttachmentId,
  ComposerContextId,
  MessageId,
  QueuedMessageId,
  ThreadId,
  type OrchestrationMessageContext,
  type OrchestrationV2ServerCommand,
  type QueuedMessageEnqueueInput,
  type ServerProvider,
} from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { createPendingAttachmentId, sweepStalePendingAttachments } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import createQueuedMessages from "../persistence/Migrations/fork/002_QueuedMessages.ts";
import addQueuedMessageContent from "../persistence/Migrations/fork/008_QueuedMessageContent.ts";
import addQueuedMessageRestore from "../persistence/Migrations/fork/009_QueuedMessageRestore.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as QueuedMessageService from "./QueuedMessageService.ts";

const threadId = ThreadId.make("queue-attachments-thread");
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type ThreadState = "active" | "archived" | "deleted";

const shellOf = (state: ThreadState) =>
  state === "deleted"
    ? null
    : ({ id: threadId, archivedAt: state === "archived" ? "archived" : null } as never);

const layerFor = (
  onDispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>,
  options: {
    readonly threadState?: Ref.Ref<ThreadState>;
    /** The send went out before it failed, so the thread holds the message. */
    readonly landed?: boolean;
    /** Runs before the service starts, for rows an earlier run of the server left behind. */
    readonly seed?: Effect.Effect<
      void,
      never,
      SqlClient.SqlClient | FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
    >;
  } = {},
) => {
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    dispatch: (command) => onDispatch(command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
    getThreadShell: () =>
      options.threadState === undefined
        ? Effect.succeed(shellOf("active"))
        : Ref.get(options.threadState).pipe(Effect.map(shellOf)),
    getThreadRecords: ((_threadId: ThreadId, _fields: never, filter?: ProjectionRecordFilter) =>
      Effect.succeed({
        thread: shellOf("active"),
        runs: [],
        messages: options.landed ? (filter?.messageIds ?? []).map((id) => ({ id })) : [],
      })) as never,
  });
  const providers = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed<ReadonlyArray<ServerProvider>>([]),
  });
  const documents = Layer.succeed(DocumentText.DocumentText, {
    ensure: () => Effect.succeed(null),
  } as unknown as DocumentText.DocumentText["Service"]);
  return QueuedMessageService.layer.pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        createQueuedMessages.pipe(
          Effect.andThen(addQueuedMessageContent),
          Effect.andThen(addQueuedMessageRestore),
          Effect.orDie,
          Effect.andThen(options.seed ?? Effect.void),
        ),
      ),
    ),
    Layer.provide(providers),
    Layer.provide(threads),
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(documents),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-queued-attachments-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
};

const uploadPending = (bytes: string, extension: string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const id = createPendingAttachmentId(extension);
    yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fileSystem.writeFileString(path.join(config.attachmentsDir, `${id}${extension}`), bytes);
    return {
      type: "file",
      id: ChatAttachmentId.make(id),
      name: `notes${extension}`,
      mimeType: "text/plain",
      sizeBytes: bytes.length,
    } satisfies ChatAttachment;
  });

const storedPath = (attachment: ChatAttachment) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return path.join(config.attachmentsDir, `${attachment.id}.txt`);
  });

const contextFor = (attachment: ChatAttachment): OrchestrationMessageContext => ({
  version: 1,
  records: [
    {
      version: 1,
      kind: "file",
      contextId: ComposerContextId.make("file-local-1"),
      label: attachment.name,
      attachmentId: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    },
  ],
});

const enqueueInput = (
  overrides: Partial<QueuedMessageEnqueueInput>,
): QueuedMessageEnqueueInput => ({
  id: QueuedMessageId.make("queued-1"),
  threadId,
  messageId: MessageId.make("message-1"),
  text: "Look at this",
  trigger: { type: "at", at: "1970-01-01T00:10:00.000Z" },
  sendContext: { runtimeMode: "full-access", interactionMode: "default" },
  origin: "user",
  ...overrides,
});

const fireTrigger = TestClock.adjust("11 minutes");

const unused = () => Effect.void;

it.effect("a queued attachment outlives the pending-upload sweep", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const pending = yield* uploadPending("hello", ".txt");

    const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
    const claimed = queued.attachments?.[0];

    assert.notStrictEqual(claimed?.id, pending.id);
    assert.isTrue(claimed?.id.startsWith("queue-attachments-thread-"));
    sweepStalePendingAttachments({
      attachmentsDir: config.attachmentsDir,
      nowMs: (yield* Clock.currentTimeMillis) + ONE_WEEK_MS,
    });
    assert.strictEqual(yield* fileSystem.readFileString(yield* storedPath(claimed!)), "hello");
  }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("the send carries the attachments and context under their claimed ids", () =>
  Effect.gen(function* () {
    const dispatched = yield* Deferred.make<OrchestrationV2ServerCommand>();
    yield* Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      const pending = yield* uploadPending("hello", ".txt");
      const queued = yield* service.enqueue(
        enqueueInput({ attachments: [pending], context: contextFor(pending) }),
      );
      const claimed = queued.attachments![0]!;

      assert.deepInclude(queued.context?.records[0], { attachmentId: claimed.id });

      yield* fireTrigger;
      const command = yield* Deferred.await(dispatched);
      assert.deepInclude(command, { type: "message.dispatch", text: "Look at this" });
      if (command.type !== "message.dispatch") return;
      assert.deepStrictEqual(command.attachments, [claimed]);
      assert.deepInclude(command.context?.records[0], { attachmentId: claimed.id });
    }).pipe(
      Effect.provide(
        layerFor((command) => Deferred.succeed(dispatched, command).pipe(Effect.asVoid)),
      ),
    );
  }),
);

it.effect("a message of only attachments sends the bootstrap prompt", () =>
  Effect.gen(function* () {
    const dispatched = yield* Deferred.make<OrchestrationV2ServerCommand>();
    yield* Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      const pending = yield* uploadPending("hello", ".txt");
      yield* service.enqueue(enqueueInput({ text: "", attachments: [pending] }));

      yield* fireTrigger;
      assert.deepInclude(yield* Deferred.await(dispatched), {
        text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      });
    }).pipe(
      Effect.provide(
        layerFor((command) => Deferred.succeed(dispatched, command).pipe(Effect.asVoid)),
      ),
    );
  }),
);

it.effect("a cancel keeps everything restorable, so a lost response loses nothing", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const pending = yield* uploadPending("hello", ".txt");
    const queued = yield* service.enqueue(
      enqueueInput({ attachments: [pending], context: contextFor(pending) }),
    );

    yield* service.cancel({ id: queued.id });

    // What a client that never heard back reads once it reconnects.
    const stored = yield* findMessage(service, queued.id);
    assert.strictEqual(stored?.status, "cancelled");
    assert.strictEqual(stored?.restorableUntil, "1970-01-08T00:00:00.000Z");
    assert.strictEqual(stored?.cancelledBy, "user");
    assert.strictEqual(stored?.text, "Look at this");
    assert.deepStrictEqual(stored?.attachments, queued.attachments);
    assert.deepStrictEqual(stored?.context, queued.context);
    assert.strictEqual(
      yield* fileSystem.readFileString(yield* storedPath(queued.attachments![0]!)),
      "hello",
    );
  }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("only the first cancel wins, so two clients can't both take a message back", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const queued = yield* service.enqueue(enqueueInput({}));

    yield* service.cancel({ id: queued.id });

    assert.isTrue(Exit.isFailure(yield* service.cancel({ id: queued.id }).pipe(Effect.exit)));
  }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("discarding a cancelled message removes its content, and can be retried", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const pending = yield* uploadPending("hello", ".txt");
    const queued = yield* service.enqueue(
      enqueueInput({ attachments: [pending], context: contextFor(pending) }),
    );
    yield* service.cancel({ id: queued.id });

    const discarded = yield* service.discard({ id: queued.id });
    const retried = yield* service.discard({ id: queued.id });

    assert.isUndefined(discarded.restorableUntil);
    assert.isUndefined(discarded.attachments);
    assert.isUndefined(discarded.context);
    assert.strictEqual(retried.status, "cancelled");
    assert.isFalse(yield* fileSystem.exists(yield* storedPath(queued.attachments![0]!)));
  }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("a message still waiting can't be discarded, only cancelled", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const queued = yield* service.enqueue(enqueueInput({}));

    assert.isTrue(Exit.isFailure(yield* service.discard({ id: queued.id }).pipe(Effect.exit)));
    assert.strictEqual((yield* findMessage(service, queued.id))?.status, "pending");
  }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("an agent cancelling the user's message leaves it restorable and says who did", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const pending = yield* uploadPending("hello", ".txt");
    const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));

    const cancelled = yield* service.cancelForThread({ id: queued.id, threadId });

    assert.strictEqual(cancelled.cancelledBy, "agent");
    assert.isDefined(cancelled.restorableUntil);
    assert.deepStrictEqual(cancelled.attachments, queued.attachments);
    assert.isTrue(yield* fileSystem.exists(yield* storedPath(queued.attachments![0]!)));
  }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("an agent cancelling its own message leaves nothing to restore", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const queued = yield* service.enqueue(enqueueInput({ origin: "agent" }));

    const cancelled = yield* service.cancelForThread({ id: queued.id, threadId });

    assert.strictEqual(cancelled.status, "cancelled");
    assert.isUndefined(cancelled.restorableUntil);
  }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("a restorable message is swept when its window ends, and clients are told", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const pending = yield* uploadPending("hello", ".txt");
    const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
    const path = yield* storedPath(queued.attachments![0]!);
    yield* service.cancel({ id: queued.id });
    yield* service.enqueue(
      enqueueInput({
        id: QueuedMessageId.make("queued-2"),
        messageId: MessageId.make("message-2"),
        trigger: { type: "at", at: "1970-01-07T00:00:00.000Z" },
      }),
    );
    const statuses = yield* watchStatuses(service);

    yield* TestClock.setTime(Date.parse("1970-01-07T00:00:00.000Z"));
    assert.strictEqual(yield* statuses.next, "sent");
    assert.isTrue(yield* fileSystem.exists(path));

    yield* TestClock.setTime(Date.parse("1970-01-08T00:00:00.000Z"));
    assert.strictEqual(yield* statuses.next, "cancelled");
    yield* statuses.stop;
    const stored = yield* findMessage(service, queued.id);
    assert.isUndefined(stored?.restorableUntil);
    assert.isUndefined(stored?.attachments);
    assert.isFalse(yield* fileSystem.exists(path));
  }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("a message already sent cannot be cancelled and keeps its files", () =>
  Effect.gen(function* () {
    const dispatched = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      const fileSystem = yield* FileSystem.FileSystem;
      const pending = yield* uploadPending("hello", ".txt");
      const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
      const path = yield* storedPath(queued.attachments![0]!);

      yield* fireTrigger;
      yield* Deferred.await(dispatched);
      const sent = (yield* service.list({})).messages[0];

      assert.strictEqual(sent?.status, "sent");
      assert.isUndefined(sent?.attachments);
      assert.isTrue(Exit.isFailure(yield* service.cancel({ id: queued.id }).pipe(Effect.exit)));
      assert.isTrue(yield* fileSystem.exists(path));
    }).pipe(
      Effect.provide(layerFor(() => Deferred.succeed(dispatched, undefined).pipe(Effect.asVoid))),
    );
  }),
);

const failingSend = () => Effect.die("dispatch failed");

const failQueuedMessage = (service: QueuedMessageService.QueuedMessageService["Service"]) =>
  Effect.gen(function* () {
    const pending = yield* uploadPending("hello", ".txt");
    const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
    const statuses = yield* watchStatuses(service);
    yield* fireTrigger;
    assert.strictEqual(yield* statuses.next, "failed");
    yield* statuses.stop;
    return { queued, path: yield* storedPath(queued.attachments![0]!) };
  });

it.effect("dismissing a failed message removes the files of a send that never landed", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const { queued, path } = yield* failQueuedMessage(service);
    assert.deepStrictEqual(
      (yield* findMessage(service, queued.id))?.attachments,
      queued.attachments,
    );

    const dismissed = yield* service.discard({ id: queued.id });

    assert.strictEqual(dismissed.status, "cancelled");
    assert.isUndefined(dismissed.attachments);
    assert.isFalse(yield* fileSystem.exists(path));
  }).pipe(Effect.provide(layerFor(failingSend))),
);

it.effect("dismissing a failed message leaves files the thread took when the send landed", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const { queued, path } = yield* failQueuedMessage(service);

    const dismissed = yield* service.discard({ id: queued.id });

    assert.isUndefined(dismissed.attachments);
    assert.isTrue(yield* fileSystem.exists(path));
  }).pipe(Effect.provide(layerFor(failingSend, { landed: true }))),
);

it.effect("taking back a failed message keeps its files until the take-back finishes", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const { queued, path } = yield* failQueuedMessage(service);

    const cancelled = yield* service.cancel({ id: queued.id });

    assert.isDefined(cancelled.restorableUntil);
    assert.isTrue(yield* fileSystem.exists(path));
    yield* service.discard({ id: queued.id });
    assert.isFalse(yield* fileSystem.exists(path));
  }).pipe(Effect.provide(layerFor(failingSend))),
);

it.effect("refuses an attachment the row would not own", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const pending = yield* uploadPending("hello", ".txt");

    const exit = yield* service
      .enqueue(
        enqueueInput({
          attachments: [{ ...pending, id: ChatAttachmentId.make(`${threadId}-${"0".repeat(8)}`) }],
        }),
      )
      .pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual((yield* service.list({})).messages, []);
  }).pipe(Effect.provide(layerFor(unused))),
);

const findMessage = (service: QueuedMessageService.QueuedMessageService["Service"], id: string) =>
  service
    .list({ threadId })
    .pipe(Effect.map(({ messages }) => messages.find((message) => message.id === id)));

/** Resolves once subscribed, so nothing published after it can be missed. */
const watchStatuses = (service: QueuedMessageService.QueuedMessageService["Service"]) =>
  Effect.gen(function* () {
    const statuses = yield* Queue.unbounded<string>();
    const subscribed = yield* Deferred.make<void>();
    const watcher = yield* service.streamMessages({ threadId }).pipe(
      Stream.runForEach((event) =>
        event._tag === "upserted"
          ? Queue.offer(statuses, event.message.status)
          : Deferred.succeed(subscribed, undefined),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);
    return {
      next: Queue.take(statuses),
      stop: Fiber.interrupt(watcher),
    };
  });

const countSends = (sends: Ref.Ref<number>) => () => Ref.update(sends, (count) => count + 1);

it.effect(
  "deleting a thread cancels its waiting message, removes its files, and tells clients",
  () =>
    Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      const fileSystem = yield* FileSystem.FileSystem;
      const pending = yield* uploadPending("hello", ".txt");
      const queued = yield* service.enqueue(
        enqueueInput({ attachments: [pending], context: contextFor(pending) }),
      );
      const statuses = yield* watchStatuses(service);

      yield* service.cancelForDeletedThread(threadId);

      assert.strictEqual(yield* statuses.next, "cancelled");
      yield* statuses.stop;
      const stored = yield* findMessage(service, queued.id);
      assert.strictEqual(stored?.status, "cancelled");
      assert.isUndefined(stored?.attachments);
      assert.isUndefined(stored?.context);
      assert.isFalse(yield* fileSystem.exists(yield* storedPath(queued.attachments![0]!)));
    }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("deleting a thread removes a restorable message at once", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const pending = yield* uploadPending("hello", ".txt");
    const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
    yield* service.cancel({ id: queued.id });

    yield* service.cancelForDeletedThread(threadId);

    const stored = yield* findMessage(service, queued.id);
    assert.isUndefined(stored?.restorableUntil);
    assert.isUndefined(stored?.attachments);
    assert.isFalse(yield* fileSystem.exists(yield* storedPath(queued.attachments![0]!)));
  }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("deleting a thread leaves a sent message alone, however many times it runs", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const queued = yield* service.enqueue(enqueueInput({}));
    const statuses = yield* watchStatuses(service);
    yield* fireTrigger;
    assert.strictEqual(yield* statuses.next, "sent");
    yield* statuses.stop;

    yield* service.cancelForDeletedThread(threadId);
    yield* service.cancelForDeletedThread(threadId);

    assert.strictEqual((yield* findMessage(service, queued.id))?.status, "sent");
  }).pipe(Effect.provide(layerFor(unused))),
);

it.effect("deleting a thread clears a failed message's files, which nothing else would", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const pending = yield* uploadPending("hello", ".txt");
    const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
    const statuses = yield* watchStatuses(service);
    yield* fireTrigger;
    assert.strictEqual(yield* statuses.next, "failed");

    yield* service.cancelForDeletedThread(threadId);

    assert.strictEqual(yield* statuses.next, "cancelled");
    yield* statuses.stop;
    assert.isFalse(yield* fileSystem.exists(yield* storedPath(queued.attachments![0]!)));
  }).pipe(Effect.provide(layerFor(() => Effect.die("provider exploded")))),
);

it.effect("a delete that lands during the send wins, and the send cannot report over it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      const fileSystem = yield* FileSystem.FileSystem;
      const pending = yield* uploadPending("hello", ".txt");
      const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
      const statuses = yield* watchStatuses(service);
      yield* fireTrigger;
      yield* Deferred.await(started);
      assert.strictEqual((yield* findMessage(service, queued.id))?.status, "sending");

      yield* service.cancelForDeletedThread(threadId);
      yield* Deferred.succeed(release, undefined);

      assert.strictEqual(yield* statuses.next, "cancelled");
      assert.strictEqual(yield* statuses.next, "cancelled");
      yield* statuses.stop;
      assert.isFalse(yield* fileSystem.exists(yield* storedPath(queued.attachments![0]!)));
    }).pipe(
      Effect.provide(
        layerFor(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.die("Thread is deleted")),
          ),
        ),
      ),
    );
  }),
);

it.effect("a message due on a deleted thread is cancelled, neither sent nor failed", () =>
  Effect.gen(function* () {
    const threadState = yield* Ref.make<ThreadState>("active");
    const sends = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      const fileSystem = yield* FileSystem.FileSystem;
      const pending = yield* uploadPending("hello", ".txt");
      const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
      const statuses = yield* watchStatuses(service);
      yield* Ref.set(threadState, "deleted");

      yield* fireTrigger;

      assert.strictEqual(yield* statuses.next, "cancelled");
      yield* statuses.stop;
      assert.isNull((yield* findMessage(service, queued.id))?.failureDetail);
      assert.strictEqual(yield* Ref.get(sends), 0);
      assert.isFalse(yield* fileSystem.exists(yield* storedPath(queued.attachments![0]!)));
    }).pipe(Effect.provide(layerFor(countSends(sends), { threadState })));
  }),
);

it.effect("a message due on an archived thread fails with the reason and keeps its files", () =>
  Effect.gen(function* () {
    const threadState = yield* Ref.make<ThreadState>("active");
    const sends = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      const fileSystem = yield* FileSystem.FileSystem;
      const pending = yield* uploadPending("hello", ".txt");
      const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
      const statuses = yield* watchStatuses(service);
      yield* Ref.set(threadState, "archived");

      yield* fireTrigger;

      assert.strictEqual(yield* statuses.next, "failed");
      yield* statuses.stop;
      assert.match((yield* findMessage(service, queued.id))?.failureDetail ?? "", /archived/);
      assert.strictEqual(yield* Ref.get(sends), 0);
      assert.isTrue(yield* fileSystem.exists(yield* storedPath(queued.attachments![0]!)));
    }).pipe(Effect.provide(layerFor(countSends(sends), { threadState })));
  }),
);

it.effect("a message whose thread is archived mid-send fails with the same reason", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const queued = yield* service.enqueue(enqueueInput({}));
    const statuses = yield* watchStatuses(service);

    yield* fireTrigger;

    assert.strictEqual(yield* statuses.next, "failed");
    yield* statuses.stop;
    assert.strictEqual(
      (yield* findMessage(service, queued.id))?.failureDetail,
      "The thread was archived when this message came due",
    );
  }).pipe(
    Effect.provide(
      layerFor((command) =>
        Effect.fail(
          new Orchestrator.OrchestratorThreadNotActiveError({
            commandId: command.commandId,
            threadId,
            state: "archived",
          }),
        ),
      ),
    ),
  ),
);

it.effect("a message waits out an archive that ends before it comes due", () =>
  Effect.gen(function* () {
    const threadState = yield* Ref.make<ThreadState>("active");
    yield* Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      yield* service.enqueue(enqueueInput({}));
      const statuses = yield* watchStatuses(service);
      yield* Ref.set(threadState, "archived");
      yield* TestClock.adjust("1 minute");
      yield* Ref.set(threadState, "active");

      yield* fireTrigger;

      assert.strictEqual(yield* statuses.next, "sent");
      yield* statuses.stop;
    }).pipe(Effect.provide(layerFor(unused, { threadState })));
  }),
);

const encodeAttachments = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ChatAttachment)));

const seedRow = (input: {
  readonly id: string;
  readonly status: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly restorableUntil?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "1970-01-01T00:00:00.000Z";
    yield* sql`
      INSERT INTO fork_queued_messages (
        id, thread_id, message_id, text, attachments_json, trigger_json, send_context_json,
        status, origin, created_at, updated_at, restorable_until
      ) VALUES (
        ${input.id}, ${threadId}, ${`message-${input.id}`}, ${"Left behind"},
        ${encodeAttachments(input.attachments)},
        ${'{"type":"at","at":"2100-01-01T00:00:00.000Z"}'},
        ${'{"runtimeMode":"full-access","interactionMode":"default"}'},
        ${input.status}, ${"user"}, ${now}, ${now}, ${input.restorableUntil ?? null}
      )
    `;
  });

const leftBehind = (id: string): ChatAttachment => ({
  type: "file",
  id: ChatAttachmentId.make(`queue-attachments-thread-${id}`),
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
});

it.effect("startup clears what an earlier build left on deleted threads, without failing it", () =>
  Effect.gen(function* () {
    const threadState = yield* Ref.make<ThreadState>("deleted");
    const pendingFile = leftBehind("11111111-1111-4111-8111-111111111111");
    const failedFile = leftBehind("22222222-2222-4222-8222-222222222222");
    const restorableFile = leftBehind("33333333-3333-4333-8333-333333333333");
    const seed = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(yield* storedPath(pendingFile), "hello");
      yield* fileSystem.writeFileString(yield* storedPath(failedFile), "hello");
      yield* fileSystem.writeFileString(yield* storedPath(restorableFile), "hello");
      yield* seedRow({ id: "orphan-pending", status: "pending", attachments: [pendingFile] });
      yield* seedRow({ id: "orphan-failed", status: "failed", attachments: [failedFile] });
      yield* seedRow({
        id: "orphan-restorable",
        status: "cancelled",
        attachments: [restorableFile],
        restorableUntil: "2100-01-01T00:00:00.000Z",
      });
    }).pipe(Effect.orDie);
    yield* Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      const fileSystem = yield* FileSystem.FileSystem;

      const { messages } = yield* service.list({ threadId });

      assert.deepStrictEqual(messages.map((message) => message.status).toSorted(), [
        "cancelled",
        "cancelled",
        "cancelled",
      ]);
      assert.isFalse(yield* fileSystem.exists(yield* storedPath(pendingFile)));
      assert.isFalse(yield* fileSystem.exists(yield* storedPath(failedFile)));
      assert.isFalse(yield* fileSystem.exists(yield* storedPath(restorableFile)));
    }).pipe(Effect.provide(layerFor(unused, { threadState, seed })));
  }),
);

it.effect("startup leaves rows on threads that still exist", () =>
  Effect.gen(function* () {
    const seed = Effect.gen(function* () {
      yield* seedRow({ id: "live-pending", status: "pending", attachments: [] });
      yield* seedRow({ id: "live-failed", status: "failed", attachments: [] });
    }).pipe(Effect.orDie);
    yield* Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      const { messages } = yield* service.list({ threadId });
      assert.deepStrictEqual(messages.map((message) => message.status).toSorted(), [
        "failed",
        "pending",
      ]);
    }).pipe(Effect.provide(layerFor(unused, { seed })));
  }),
);
