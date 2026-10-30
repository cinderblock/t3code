import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  ComposerContextId,
  MessageId,
  QueuedMessageId,
  ThreadId,
  type ChatAttachment,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { createPendingAttachmentId, sweepStalePendingAttachments } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import createQueuedMessages from "../persistence/Migrations/fork/002_QueuedMessages.ts";
import addQueuedMessageContent from "../persistence/Migrations/fork/008_QueuedMessageContent.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as QueuedMessageService from "./QueuedMessageService.ts";

const threadId = ThreadId.make("queue-attachments-thread");
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const layerFor = (onDispatch: (command: OrchestrationV2ServerCommand) => Effect.Effect<void>) => {
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    dispatch: (command) => onDispatch(command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
  });
  const providers = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed<ReadonlyArray<ServerProvider>>([]),
  });
  const documents = Layer.succeed(DocumentText.DocumentText, {
    ensure: () => Effect.succeed(null),
  } as unknown as DocumentText.DocumentText["Service"]);
  return QueuedMessageService.layer.pipe(
    Layer.provideMerge(
      Layer.effectDiscard(Effect.andThen(createQueuedMessages, addQueuedMessageContent)),
    ),
    Layer.provide(providers),
    Layer.provide(threads),
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(documents),
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

it.effect("cancelling a pending message removes its files, and only the first cancel wins", () =>
  Effect.gen(function* () {
    const service = yield* QueuedMessageService.QueuedMessageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const pending = yield* uploadPending("hello", ".txt");
    const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
    const path = yield* storedPath(queued.attachments![0]!);

    const cancelled = yield* service.cancel({ id: queued.id });

    assert.strictEqual(cancelled.status, "cancelled");
    assert.isFalse(yield* fileSystem.exists(path));
    assert.isTrue(Exit.isFailure(yield* service.cancel({ id: queued.id }).pipe(Effect.exit)));
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

it.effect("dismissing a failed message leaves its files, which the thread may own", () =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* QueuedMessageService.QueuedMessageService;
      const fileSystem = yield* FileSystem.FileSystem;
      const pending = yield* uploadPending("hello", ".txt");
      const queued = yield* service.enqueue(enqueueInput({ attachments: [pending] }));
      const path = yield* storedPath(queued.attachments![0]!);

      yield* fireTrigger;
      yield* Deferred.await(failed);
      const row = (yield* service.list({})).messages[0];
      assert.strictEqual(row?.status, "failed");
      assert.deepStrictEqual(row?.attachments, queued.attachments);

      yield* service.cancel({ id: queued.id });
      assert.isTrue(yield* fileSystem.exists(path));
    }).pipe(
      Effect.provide(
        layerFor(() =>
          Deferred.succeed(failed, undefined).pipe(Effect.andThen(Effect.die("dispatch failed"))),
        ),
      ),
    );
  }),
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
