import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  QueuedMessageId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../config.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import createQueuedMessages from "../../../persistence/Migrations/fork/002_QueuedMessages.ts";
import addQueuedMessageContent from "../../../persistence/Migrations/fork/008_QueuedMessageContent.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as QueuedMessageService from "../../../queue/QueuedMessageService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("send-later-thread");
const shell = McpToolAccessTestkit.liveThreadShell(threadId);

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("send-later-environment"),
  requestNamespace: "send-later-session",
  thread: {
    threadId,
    providerSessionId: "send-later-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "send-later", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "send-later", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layerFor = (
  onDispatch: (command: OrchestrationV2ServerCommand) => Effect.Effect<void>,
  getProviders: Effect.Effect<ReadonlyArray<ServerProvider>> = Effect.succeed([]),
) => {
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
    getProjectThreadRecords: () => Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell)),
    dispatch: (command) => onDispatch(command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
  });
  const providers = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders,
  });
  const queued = QueuedMessageService.layer.pipe(
    Layer.provideMerge(
      Layer.effectDiscard(Effect.andThen(createQueuedMessages, addQueuedMessageContent)),
    ),
    Layer.provide(providers),
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(DocumentText.DocumentText)({})),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-send-later-" })),
    Layer.provide(NodeServices.layer),
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  return McpHttpServer.layerSendLaterToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(queued),
    Layer.provideMerge(threads),
  );
};

const callTool = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_send_later", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const text = result.content[0];
    return JSON.parse(text?.type === "text" ? text.text : "null");
  });

const withSessionWindow = (
  overrides: Pick<ServerProviderUsageWindow, "usedPercent"> & Partial<ServerProviderUsageWindow>,
) =>
  [
    {
      instanceId: ProviderInstanceId.make("codex"),
      usageLimits: {
        checkedAt: "1970-01-01T00:00:00.000Z",
        windows: [{ id: "five_hour", kind: "session", label: "5-hour", ...overrides }],
      },
    },
  ] as unknown as ReadonlyArray<ServerProvider>;

it.effect("a window-reset message on a nearly unused window waits for the reset", () =>
  Effect.gen(function* () {
    const dispatched = yield* Deferred.make<OrchestrationV2ServerCommand>();
    yield* Effect.gen(function* () {
      const scheduled = yield* callTool({
        action: "schedule",
        text: "After the reset",
        windowReset: "session",
      });
      assert.strictEqual(scheduled.status, "pending");

      yield* TestClock.adjust("29 minutes");
      assert.strictEqual(yield* Deferred.isDone(dispatched), false);

      yield* TestClock.adjust("2 minutes");
      const command = yield* Deferred.await(dispatched);
      assert.deepInclude(command, { type: "message.dispatch", text: "After the reset" });
    }).pipe(
      Effect.provide(
        layerFor(
          (command) => Deferred.succeed(dispatched, command).pipe(Effect.asVoid),
          Effect.succeed(
            withSessionWindow({ usedPercent: 3, resetsAt: "1970-01-01T00:30:00.000Z" }),
          ),
        ),
      ),
    );
  }),
);

it.effect("a message queued on an idle window sends at the reset of the clock it then starts", () =>
  Effect.gen(function* () {
    const dispatched = yield* Deferred.make<OrchestrationV2ServerCommand>();
    const providers = yield* Ref.make(withSessionWindow({ usedPercent: 0 }));
    yield* Effect.gen(function* () {
      yield* callTool({ action: "schedule", text: "Idle", windowReset: "session" });
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(yield* Deferred.isDone(dispatched), false);

      yield* Ref.set(
        providers,
        withSessionWindow({ usedPercent: 1, resetsAt: "1970-01-01T01:00:00.000Z" }),
      );
      yield* TestClock.adjust("1 minute");
      // The read after the reset shows an idle window again, so only the stored reset can fire it.
      yield* Ref.set(providers, withSessionWindow({ usedPercent: 0 }));
      yield* TestClock.adjust("57 minutes");
      assert.strictEqual(yield* Deferred.isDone(dispatched), false);

      yield* TestClock.adjust("2 minutes");
      const command = yield* Deferred.await(dispatched);
      assert.deepInclude(command, { type: "message.dispatch", text: "Idle" });
    }).pipe(
      Effect.provide(
        layerFor(
          (command) => Deferred.succeed(dispatched, command).pipe(Effect.asVoid),
          Ref.get(providers),
        ),
      ),
    );
  }),
);

it.effect("choosing a window trigger again waits for the window's reset as it is now", () =>
  Effect.gen(function* () {
    const queued = yield* QueuedMessageService.QueuedMessageService;
    const trigger = {
      type: "window-reset",
      accountKey: "codex",
      windowId: "five_hour",
      resetsAt: "1970-01-01T00:01:00.000Z",
      peakPercent: 99,
    } as const;
    const message = yield* queued.enqueue({
      id: QueuedMessageId.make("re-picked"),
      threadId,
      messageId: MessageId.make("re-picked-message"),
      text: "Hello",
      trigger,
      sendContext: { runtimeMode: "full-access", interactionMode: "default" },
      origin: "user",
    });
    const stamped = {
      ...trigger,
      resetsAt: "1970-01-01T00:30:00.000Z",
      peakPercent: 3,
    };
    assert.deepStrictEqual(message.trigger, stamped);

    const retexted = yield* queued.update({ id: message.id, text: "Hello again" });
    assert.deepStrictEqual(retexted.trigger, stamped);

    const repicked = yield* queued.update({ id: message.id, trigger });
    assert.deepStrictEqual(repicked.trigger, stamped);
  }).pipe(
    Effect.provide(
      layerFor(
        () => Effect.void,
        Effect.succeed(withSessionWindow({ usedPercent: 3, resetsAt: "1970-01-01T00:30:00.000Z" })),
      ),
    ),
  ),
);

it.effect("a scheduled message sends as the agent once its time comes", () =>
  Effect.gen(function* () {
    const dispatched = yield* Deferred.make<OrchestrationV2ServerCommand>();
    yield* Effect.gen(function* () {
      const scheduled = yield* callTool({
        action: "schedule",
        text: "Run the nightly check",
        at: "1970-01-01T00:10:00.000Z",
      });
      assert.strictEqual(scheduled.status, "pending");

      const listed = yield* callTool({ action: "list" });
      assert.deepStrictEqual(
        listed.items.map((item: { id: string }) => item.id),
        [scheduled.id],
      );

      yield* TestClock.adjust("11 minutes");
      const command = yield* Deferred.await(dispatched);
      assert.deepInclude(command, {
        type: "message.dispatch",
        threadId,
        text: "Run the nightly check",
        createdBy: "agent",
        creationSource: "server",
      });
      assert.deepStrictEqual((yield* callTool({ action: "list" })).items, []);
    }).pipe(
      Effect.provide(
        layerFor((command) => Deferred.succeed(dispatched, command).pipe(Effect.asVoid)),
      ),
    );
  }),
);

it.effect("cancel takes only this thread's messages", () =>
  Effect.gen(function* () {
    const queued = yield* QueuedMessageService.QueuedMessageService;
    const foreign = yield* queued.enqueue({
      id: QueuedMessageId.make("foreign"),
      threadId: ThreadId.make("another-thread"),
      messageId: MessageId.make("foreign-message"),
      text: "Not yours",
      trigger: { type: "at", at: "1970-01-01T01:00:00.000Z" },
      sendContext: { runtimeMode: "full-access", interactionMode: "default" },
      origin: "user",
    });
    assert.deepInclude(yield* callTool({ action: "cancel", id: foreign.id }), {
      code: "invalid_request",
      message: "Queued message foreign was not found",
    });

    const own = yield* callTool({
      action: "schedule",
      text: "Mine",
      at: "1970-01-01T01:00:00.000Z",
    });
    assert.strictEqual((yield* callTool({ action: "cancel", id: own.id })).status, "cancelled");
  }).pipe(Effect.provide(layerFor(() => Effect.void))),
);

it.effect("schedule needs a time, and refuses one already past", () =>
  Effect.gen(function* () {
    assert.deepInclude(yield* callTool({ action: "schedule", text: "When?" }), {
      code: "invalid_request",
      message: "This action needs `at` or `windowReset`.",
    });
    yield* TestClock.adjust("1 hour");
    assert.deepInclude(
      yield* callTool({ action: "schedule", text: "Late", at: "1970-01-01T00:10:00.000Z" }),
      { code: "invalid_request", message: "1970-01-01T00:10:00.000Z is not in the future" },
    );
  }).pipe(Effect.provide(layerFor(() => Effect.void))),
);
