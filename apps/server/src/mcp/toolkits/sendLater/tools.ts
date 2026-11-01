import {
  IsoDateTime,
  OrchestratorMcpFailure,
  QueuedMessageId,
  QueuedMessageStatus,
  QueuedMessageTrigger,
  ThreadBlockUntil,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as QueuedMessageService from "../../../queue/QueuedMessageService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const SendLaterEntry = Schema.Struct({
  id: QueuedMessageId,
  threadId: ThreadId,
  text: Schema.String,
  truncated: Schema.Boolean,
  trigger: QueuedMessageTrigger,
  status: QueuedMessageStatus,
  failureDetail: Schema.NullOr(Schema.String),
});

const SendLaterTool = Tool.make("t3_send_later", {
  description:
    "Send one message into a thread later, once, when the user asks to send something at a time or when their usage resets, or when another thread is done. Omit `threadId` for this thread. schedule: `text`, plus `at`, `windowReset`, or `afterThread` with `until`. list: messages not sent yet, and failed ones. cancel: by `id`. For repeating work use schedule_task. For follow-ups behind the current run use t3_queue.",
  parameters: Schema.Struct({
    action: Schema.Literals(["schedule", "list", "cancel"]),
    threadId: Schema.optional(ThreadId),
    text: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(100000))),
    at: Schema.optional(
      IsoDateTime.annotate({ description: "When to send, with a UTC offset. Must be future." }),
    ),
    windowReset: Schema.optional(
      Schema.Literals(["session", "weekly"]).annotate({
        description: "Send when this usage window resets. session is the 5-hour window.",
      }),
    ),
    afterThread: Schema.optional(
      ThreadId.annotate({ description: "Send when this other thread is done." }),
    ),
    until: Schema.optional(
      ThreadBlockUntil.annotate({
        description:
          "With afterThread. finished: it stops working. settled: the user is done with it.",
      }),
    ),
    id: Schema.optional(QueuedMessageId),
  }),
  success: Schema.Union([Schema.Struct({ items: Schema.Array(SendLaterEntry) }), SendLaterEntry]),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    QueuedMessageService.QueuedMessageService,
    Crypto.Crypto,
  ],
}).annotate(Tool.Destructive, true);

export const SendLaterToolkit = Toolkit.make(SendLaterTool);
