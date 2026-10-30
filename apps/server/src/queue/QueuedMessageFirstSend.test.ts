import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedMessageId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type QueuedMessageEnqueueInput,
  type QueuedMessageSendContext,
  type ServerProvider,
} from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import createQueuedMessages from "../persistence/Migrations/fork/002_QueuedMessages.ts";
import addQueuedMessageContent from "../persistence/Migrations/fork/008_QueuedMessageContent.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as QueuedMessageService from "./QueuedMessageService.ts";

const threadId = ThreadId.make("first-send-thread");
const projectId = ProjectId.make("first-send-project");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const TITLE = "Fix the login redirect";
const worktree = { type: "worktree", baseRef: "main", startFromOrigin: true } as const;

interface ThreadState {
  /** Null until `thread.create` lands. */
  readonly title: string | null;
  readonly messages: number;
  readonly runs: number;
}

interface Harness {
  readonly commands: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>;
  readonly launches: Ref.Ref<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>;
  readonly thread: Ref.Ref<ThreadState>;
}

const threadRecords = (state: ThreadState) => ({
  thread: {
    title: state.title ?? "",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "plan",
  },
  runs: Array.from({ length: state.runs }, () => ({})),
});

const layerFor = (
  harness: Harness,
  options: {
    readonly onDispatch?: (
      command: OrchestrationV2ServerCommand,
    ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
    readonly baseCheck?: Effect.Effect<void, ThreadLaunch.ThreadLaunchBaseRefError>;
  } = {},
) => {
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    dispatch: (command) =>
      Effect.gen(function* () {
        yield* options.onDispatch?.(command) ?? Effect.void;
        yield* Ref.update(harness.commands, (commands) => [...commands, command]);
        if (command.type === "thread.create") {
          yield* Ref.update(harness.thread, (state) => ({ ...state, title: command.title }));
        }
        return { sequence: 1, storedEvents: [] };
      }),
    getThreadShell: () =>
      Ref.get(harness.thread).pipe(
        Effect.map((state) => (state.title === null ? null : ({ id: threadId } as never))),
      ),
    getThreadRecords: () =>
      Ref.get(harness.thread).pipe(Effect.map((state) => threadRecords(state) as never)),
    getMessageCount: () => Ref.get(harness.thread).pipe(Effect.map((state) => state.messages)),
  });
  const launches = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    checkWorktreeBase: () => options.baseCheck ?? Effect.void,
    launch: (input) =>
      Ref.update(harness.launches, (launched) => [...launched, input]).pipe(
        Effect.as({ threadId, projection: {} as never, resumed: false }),
      ),
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
    Layer.provide(launches),
    Layer.provide(documents),
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-queued-first-send-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
};

const firstSendContext: QueuedMessageSendContext = {
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  launch: { projectId, title: TITLE, workspaceStrategy: worktree },
};

const enqueueInput = (
  id: string,
  sendContext: QueuedMessageSendContext = firstSendContext,
): QueuedMessageEnqueueInput => ({
  id: QueuedMessageId.make(id),
  threadId,
  messageId: MessageId.make(`message-${id}`),
  text: "fix the login redirect",
  trigger: { type: "at", at: "1970-01-01T00:01:00.000Z" },
  sendContext,
  origin: "user",
});

const withHarness = <A, E>(
  initial: ThreadState,
  program: (
    harness: Harness,
    queue: QueuedMessageService.QueuedMessageService["Service"],
  ) => Effect.Effect<A, E, ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path>,
  options: Parameters<typeof layerFor>[1] = {},
) =>
  Effect.gen(function* () {
    const harness: Harness = {
      commands: yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]),
      launches: yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]),
      thread: yield* Ref.make(initial),
    };
    return yield* QueuedMessageService.QueuedMessageService.pipe(
      Effect.flatMap((queue) => program(harness, queue)),
      Effect.provide(layerFor(harness, options)),
    );
  });

const NEW_THREAD: ThreadState = { title: null, messages: 0, runs: 0 };
const fire = TestClock.adjust("2 minutes");

it.layer(Layer.empty)("first send of a new thread", (it) => {
  it.effect("creates the thread at queue time, with no worktree and no run", () =>
    withHarness(NEW_THREAD, (harness, queue) =>
      Effect.gen(function* () {
        yield* queue.enqueue(enqueueInput("a"));
        const commands = yield* Ref.get(harness.commands);
        assert.deepStrictEqual(
          commands.map((command) => command.type),
          ["thread.create"],
        );
        const create = commands[0];
        assert.isTrue(create?.type === "thread.create");
        if (create?.type !== "thread.create") return;
        assert.strictEqual(create.title, TITLE);
        assert.strictEqual(create.projectId, projectId);
        assert.deepStrictEqual(create.modelSelection, modelSelection);
        assert.strictEqual(create.runtimeMode, "full-access");
        // The base shows on the thread; `launch` swaps in the real branch and path.
        assert.strictEqual(create.branch, "main");
        assert.strictEqual(create.worktreePath, null);
        assert.lengthOf(yield* Ref.get(harness.launches), 0);
      }),
    ),
  );

  it.effect("fires through thread launch with the queued setup", () =>
    withHarness(NEW_THREAD, (harness, queue) =>
      Effect.gen(function* () {
        yield* queue.enqueue(enqueueInput("b"));
        yield* fire;
        const [launch] = yield* Ref.get(harness.launches);
        assert.isDefined(launch);
        assert.strictEqual(launch?.threadId, threadId);
        assert.isTrue(launch?.reuseExistingThread);
        assert.strictEqual(launch?.projectId, projectId);
        assert.deepStrictEqual(launch?.workspaceStrategy, worktree);
        assert.deepStrictEqual(launch?.modelSelection, modelSelection);
        assert.strictEqual(launch?.title, TITLE);
        assert.isTrue(launch?.generateTitle);
        assert.strictEqual(launch?.initialMessage?.text, "fix the login redirect");
        assert.strictEqual(launch?.initialMessage?.messageId, MessageId.make("message-b"));
        assert.deepStrictEqual(
          (yield* Ref.get(harness.commands)).map((command) => command.type),
          ["thread.create"],
        );
        const [row] = (yield* queue.list({ threadId })).messages;
        assert.strictEqual(row?.status, "sent");
      }),
    ),
  );

  it.effect("fires an attachment-only first message with its claimed files", () =>
    withHarness(NEW_THREAD, (harness, queue) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const id = createPendingAttachmentId(".txt");
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(config.attachmentsDir, `${id}.txt`), "notes");
        yield* queue.enqueue({
          ...enqueueInput("attachment"),
          text: "",
          attachments: [
            {
              type: "file",
              id: ChatAttachmentId.make(id),
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
          ],
        });
        yield* fire;
        const [launch] = yield* Ref.get(harness.launches);
        assert.strictEqual(launch?.initialMessage?.text, ATTACHMENT_ONLY_BOOTSTRAP_PROMPT);
        const attachment = launch?.initialMessage?.attachments[0];
        assert.strictEqual(attachment?.name, "notes.txt");
        // Claimed into the thread's space, so the upload sweep can't take it while it waits.
        assert.notStrictEqual(attachment?.id, id);
      }),
    ),
  );

  it.effect("keeps a title the user changed while the message waited", () =>
    withHarness(NEW_THREAD, (harness, queue) =>
      Effect.gen(function* () {
        yield* queue.enqueue(enqueueInput("c"));
        yield* Ref.update(harness.thread, (state) => ({ ...state, title: "Login" }));
        yield* fire;
        const [launch] = yield* Ref.get(harness.launches);
        assert.strictEqual(launch?.title, "Login");
        assert.isFalse(launch?.generateTitle);
      }),
    ),
  );

  it.effect("sends as a follow-up once the thread has started without it", () =>
    withHarness(NEW_THREAD, (harness, queue) =>
      Effect.gen(function* () {
        yield* queue.enqueue(enqueueInput("d"));
        yield* Ref.update(harness.thread, (state) => ({ ...state, messages: 1, runs: 1 }));
        yield* fire;
        assert.lengthOf(yield* Ref.get(harness.launches), 0);
        assert.deepStrictEqual(
          (yield* Ref.get(harness.commands)).map((command) => command.type),
          ["thread.create", "message.dispatch"],
        );
      }),
    ),
  );

  it.effect("a second message on the new thread keeps the setup", () =>
    withHarness(NEW_THREAD, (harness, queue) =>
      Effect.gen(function* () {
        yield* queue.enqueue(enqueueInput("first"));
        const { launch: _launch, ...plain } = firstSendContext;
        const second = yield* queue.enqueue(enqueueInput("second", plain));
        assert.deepStrictEqual(second.sendContext.launch, firstSendContext.launch);
        yield* queue.cancel({ id: QueuedMessageId.make("first") });
        yield* fire;
        const [launch] = yield* Ref.get(harness.launches);
        assert.strictEqual(launch?.initialMessage?.messageId, MessageId.make("message-second"));
        assert.deepStrictEqual(launch?.workspaceStrategy, worktree);
      }),
    ),
  );

  it.effect("does not recreate a thread that already exists but is empty", () =>
    withHarness({ title: "Empty", messages: 0, runs: 0 }, (harness, queue) =>
      Effect.gen(function* () {
        yield* queue.enqueue(enqueueInput("e"));
        assert.lengthOf(yield* Ref.get(harness.commands), 0);
      }),
    ),
  );

  it.effect("refuses a base ref that does not exist, leaving nothing behind", () =>
    withHarness(
      NEW_THREAD,
      (harness, queue) =>
        Effect.gen(function* () {
          const result = yield* queue.enqueue(enqueueInput("f")).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          assert.lengthOf(yield* Ref.get(harness.commands), 0);
          assert.lengthOf((yield* queue.list({ threadId })).messages, 0);
        }),
      {
        baseCheck: Effect.fail(
          new ThreadLaunch.ThreadLaunchBaseRefError({
            projectId,
            projectTitle: "Project",
            workspaceRoot: "/repo",
            baseRef: "main",
          }),
        ),
      },
    ),
  );

  it.effect("a failed thread create queues nothing", () =>
    withHarness(
      NEW_THREAD,
      (_harness, queue) =>
        Effect.gen(function* () {
          const result = yield* queue.enqueue(enqueueInput("g")).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          assert.lengthOf((yield* queue.list({ threadId })).messages, 0);
        }),
      {
        onDispatch: (command) =>
          command.type === "thread.create"
            ? Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "refused",
                }),
              )
            : Effect.void,
      },
    ),
  );

  it.effect("a launch spec survives a read back from storage", () =>
    withHarness(NEW_THREAD, (_harness, queue) =>
      Effect.gen(function* () {
        yield* queue.enqueue(enqueueInput("h"));
        const [row] = (yield* queue.list({ threadId })).messages;
        assert.deepStrictEqual(row?.sendContext.launch, firstSendContext.launch);
      }),
    ),
  );
});
