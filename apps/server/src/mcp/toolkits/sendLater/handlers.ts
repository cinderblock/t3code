import {
  OrchestratorMcpFailure,
  QueuedMessageId,
  type QueuedMessage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as QueuedMessageService from "../../../queue/QueuedMessageService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { SendLaterToolkit } from "./tools.ts";

const TEXT_LIMIT = 1000;

const entry = (message: QueuedMessage) => {
  const characters = Array.from(message.text);
  return {
    id: message.id,
    threadId: message.threadId,
    text: characters.slice(0, TEXT_LIMIT).join(""),
    truncated: characters.length > TEXT_LIMIT,
    trigger: message.trigger,
    status: message.status,
    failureDetail: message.failureDetail,
  };
};

const invalid = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(invalid({ message: `This action needs \`${name}\`.` }))
    : Effect.succeed(value);

const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(SendLaterToolkit, {
  t3_send_later: McpToolAccess.either(
    (input) => input.action === "list",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const queued = yield* QueuedMessageService.QueuedMessageService;
        const { messages } = yield* queued
          .list({ threadId: projection.thread.id })
          .pipe(Effect.mapError(invalid));
        return {
          items: messages
            .filter(({ status }) => status === "pending" || status === "failed")
            .map(entry),
        };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const queued = yield* QueuedMessageService.QueuedMessageService;
        if (input.action === "cancel") {
          const id = yield* required(input.id, "id");
          return entry(
            yield* queued
              .cancelForThread({ id, threadId: projection.thread.id })
              .pipe(Effect.mapError(invalid)),
          );
        }
        const text = yield* required(input.text, "text");
        const when =
          input.at !== undefined
            ? { at: input.at }
            : input.afterThread !== undefined
              ? { afterThread: input.afterThread, until: yield* required(input.until, "until") }
              : {
                  windowReset: yield* required(
                    input.windowReset,
                    "at`, `windowReset` or `afterThread",
                  ),
                };
        const crypto = yield* Crypto.Crypto;
        const id = QueuedMessageId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
        return entry(
          yield* queued
            .enqueueForThread({ id, thread: projection.thread, text, when })
            .pipe(Effect.mapError(invalid)),
        );
      }),
    ),
  ),
});
