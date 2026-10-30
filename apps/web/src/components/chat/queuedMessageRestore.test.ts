import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ChatAttachmentId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedMessageId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type QueuedMessage,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  draftStillHoldsSnapshot,
  draftWorkspaceForLaunch,
  mergeRestoredPrompt,
  pendingQueuedLaunch,
  rememberedQueueTrigger,
  rememberQueueTrigger,
  resolveQueuedLaunchStrategy,
  restoreQueuedMessageToDraft,
  takeBackQueuedMessage,
  takeBackReopensDraft,
} from "./queuedMessageRestore";

const environmentId = EnvironmentId.make("environment-restore");
const threadId = ThreadId.make("thread-restore");
const target = scopeThreadRef(environmentId, threadId);
const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");

const imageAttachment: ChatAttachment = {
  type: "image",
  id: ChatAttachmentId.make("thread-restore-11111111-1111-4111-8111-111111111111"),
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
};
const fileAttachment: ChatAttachment = {
  type: "file",
  id: ChatAttachmentId.make("thread-restore-22222222-2222-4222-8222-222222222222-txt"),
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 6,
  source: { _tag: "pasted-text" },
};
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};

const files = new Map([
  [imageAttachment.id, new File(["image"], "screen.png", { type: "image/png" })],
  [fileAttachment.id, new File(["pasted"], "notes.txt", { type: "text/plain" })],
]);

const attachmentRecord = (attachment: ChatAttachment, localId: string) =>
  ({
    version: 1,
    kind: attachment.type,
    contextId: ComposerContextId.make(`${attachment.type}_${localId}`),
    label: attachment.name,
    attachmentId: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  }) as NonNullable<QueuedMessage["context"]>["records"][number];

const queued = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: QueuedMessageId.make("queued-1"),
  threadId,
  messageId: MessageId.make("message-1"),
  text: "Look at this",
  trigger: { type: "at", at: "2026-10-30T13:00:00.000Z" },
  sendContext: { modelSelection, runtimeMode: "full-access", interactionMode: "default" },
  status: "pending",
  origin: "user",
  createdAt: "2026-10-30T11:00:00.000Z",
  updatedAt: "2026-10-30T11:00:00.000Z",
  sentAt: null,
  failureDetail: null,
  ...overrides,
});

const restore = (message: QueuedMessage) =>
  restoreQueuedMessageToDraft({ target, threadId, message, files });
const draft = () => useComposerDraftStore.getState().getComposerDraft(target);

describe("restoreQueuedMessageToDraft", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
  });

  it("puts the text, attachments and context back as they were", () => {
    const { unrestoredNames } = restore(
      queued({
        attachments: [imageAttachment, fileAttachment],
        context: {
          version: 1,
          records: [
            attachmentRecord(imageAttachment, "local-image"),
            attachmentRecord(fileAttachment, "local-file"),
            {
              version: 1,
              kind: "terminal",
              contextId: ComposerContextId.make("terminal_local-terminal"),
              label: "Terminal lines 1-2",
              terminalId: "term-1",
              terminalLabel: "Terminal 1",
              lineStart: 1,
              lineEnd: 2,
              text: "npm test",
            },
          ],
        },
      }),
    );

    expect(unrestoredNames).toEqual([]);
    expect(draft()?.prompt).toBe("Look at this");
    expect(draft()?.images.map((image) => [image.id, image.name])).toEqual([
      ["local-image", "screen.png"],
    ]);
    expect(draft()?.files.map((file) => [file.id, file.source])).toEqual([
      ["local-file", { _tag: "pasted-text" }],
    ]);
    expect(draft()?.files[0]?.file).toBe(files.get(fileAttachment.id));
    expect(draft()?.terminalContexts.map((context) => [context.id, context.text])).toEqual([
      ["local-terminal", "npm test"],
    ]);
  });

  it("keeps a draft the user already has, with the restored text after it", () => {
    useComposerDraftStore.getState().setPrompt(target, "Something new\n");

    restore(queued());

    expect(draft()?.prompt).toBe("Something new\n\nLook at this");
  });

  it("restores the model the message was queued with", () => {
    restore(queued());

    expect(draft()?.activeProvider).toBe(modelSelection.instanceId);
    expect(draft()?.modelSelectionByProvider[modelSelection.instanceId]?.model).toBe("gpt-5");
  });

  it("leaves the model alone for a message that has none", () => {
    restore(
      queued({
        origin: "agent",
        sendContext: { runtimeMode: "full-access", interactionMode: "default" },
      }),
    );

    expect(draft()?.activeProvider ?? null).toBeNull();
  });

  it("names an attachment it could not bring back rather than dropping it silently", () => {
    const { unrestoredNames } = restoreQueuedMessageToDraft({
      target,
      threadId,
      message: queued({ attachments: [imageAttachment, fileAttachment] }),
      files: new Map([[imageAttachment.id, files.get(imageAttachment.id)!]]),
    });

    expect(unrestoredNames).toEqual(["notes.txt"]);
    expect(draft()?.images).toHaveLength(1);
  });
});

describe("resolveQueuedLaunchStrategy", () => {
  const draft = {
    isLocalDraftThread: true,
    activeMessageCount: 0,
    sendEnvMode: "local" as const,
    worktreePath: null,
    branch: null,
    startFromOrigin: false,
  };

  it("starts a draft where the composer says", () => {
    expect(resolveQueuedLaunchStrategy(draft)).toEqual({ type: "root" });
    expect(resolveQueuedLaunchStrategy({ ...draft, branch: "main" })).toEqual({
      type: "root",
      branch: "main",
    });
    expect(
      resolveQueuedLaunchStrategy({
        ...draft,
        sendEnvMode: "worktree",
        worktreePath: "/worktrees/feature",
        branch: "feature",
      }),
    ).toEqual({
      type: "existing_worktree",
      worktreePath: "/worktrees/feature",
      branch: "feature",
    });
  });

  it("asks a new worktree for a base, as a send does", () => {
    const worktree = { ...draft, sendEnvMode: "worktree" as const };
    expect(resolveQueuedLaunchStrategy(worktree)).toBe("missing-base-branch");
    expect(
      resolveQueuedLaunchStrategy({ ...worktree, branch: "main", startFromOrigin: true }),
    ).toEqual({ type: "worktree", baseRef: "main", startFromOrigin: true });
  });

  it("leaves a started thread, or an empty one staying where it is, to a plain dispatch", () => {
    const serverThread = { ...draft, isLocalDraftThread: false };
    expect(resolveQueuedLaunchStrategy(serverThread)).toBeNull();
    expect(
      resolveQueuedLaunchStrategy({
        ...serverThread,
        activeMessageCount: 3,
        sendEnvMode: "worktree",
        branch: "main",
      }),
    ).toBeNull();
  });

  it("gives an empty server thread in worktree mode its worktree", () => {
    expect(
      resolveQueuedLaunchStrategy({
        ...draft,
        isLocalDraftThread: false,
        sendEnvMode: "worktree",
        branch: "main",
      }),
    ).toEqual({ type: "worktree", baseRef: "main" });
  });
});

describe("draftWorkspaceForLaunch", () => {
  it("turns each strategy back into the draft that produced it", () => {
    for (const sendEnvMode of ["local", "worktree"] as const) {
      for (const worktreePath of [null, "/worktrees/feature"]) {
        const draft = {
          isLocalDraftThread: true,
          activeMessageCount: 0,
          sendEnvMode: worktreePath === null ? sendEnvMode : ("worktree" as const),
          worktreePath,
          branch: "main",
          startFromOrigin: worktreePath === null && sendEnvMode === "worktree",
        };
        const strategy = resolveQueuedLaunchStrategy(draft);
        if (strategy === null || strategy === "missing-base-branch") {
          throw new Error("expected a strategy");
        }
        expect(draftWorkspaceForLaunch(strategy)).toEqual({
          branch: draft.branch,
          worktreePath: draft.worktreePath,
          envMode: draft.sendEnvMode,
          startFromOrigin: draft.startFromOrigin,
        });
      }
    }
  });
});

describe("first messages on an unstarted thread", () => {
  const launch = {
    projectId: ProjectId.make("project-restore"),
    title: "Title",
    workspaceStrategy: { type: "worktree", baseRef: "main" },
  } as const;
  const plain = queued();
  const first: QueuedMessage = { ...plain, sendContext: { ...plain.sendContext, launch } };
  const otherThreadId = ThreadId.make("thread-other");
  const unstarted = { latestUserMessageAt: null, latestRun: null };
  const reopens = (overrides: Partial<Parameters<typeof takeBackReopensDraft>[0]>) =>
    takeBackReopensDraft({ message: first, allMessages: [first], thread: unstarted, ...overrides });

  it("reopens a draft when the thread only held this message", () => {
    expect(reopens({})).toBe(true);
  });

  it("keeps a thread that has started, or that holds nothing to take back", () => {
    expect(reopens({ message: plain })).toBe(false);
    expect(reopens({ thread: null })).toBe(false);
    expect(
      reopens({ thread: { latestUserMessageAt: "2026-10-30T12:00:00.000Z", latestRun: null } }),
    ).toBe(false);
    expect(reopens({ thread: { latestUserMessageAt: null, latestRun: { runId: "run" } } })).toBe(
      false,
    );
  });

  it("keeps a thread with another message still waiting, but not one already sent", () => {
    const other = { ...first, id: QueuedMessageId.make("other") };
    expect(reopens({ allMessages: [first, other] })).toBe(false);
    expect(reopens({ allMessages: [first, { ...other, status: "sent" as const }] })).toBe(true);
    expect(reopens({ allMessages: [first, { ...other, threadId: otherThreadId }] })).toBe(true);
  });

  it("reads the waiting setup only for that thread, and only while it waits", () => {
    expect(pendingQueuedLaunch([first], first.threadId)).toEqual(launch);
    expect(pendingQueuedLaunch([first], otherThreadId)).toBeUndefined();
    expect(pendingQueuedLaunch([first], undefined)).toBeUndefined();
    expect(
      pendingQueuedLaunch([{ ...first, status: "sent" as const }], first.threadId),
    ).toBeUndefined();
  });
});

describe("takeBackQueuedMessage", () => {
  const image = files.get(imageAttachment.id)!;

  it("waits for a restore that has to open a draft first", async () => {
    let restored = false;
    const result = await takeBackQueuedMessage({
      attachments: [],
      download: async () => image,
      cancel: async () => true,
      restore: async () => {
        await Promise.resolve();
        restored = true;
      },
    });

    expect(result).toEqual({ outcome: "restored" });
    expect(restored).toBe(true);
  });

  it("restores only after the server confirms the cancel", async () => {
    const order: string[] = [];

    const result = await takeBackQueuedMessage({
      attachments: [imageAttachment],
      download: async () => {
        order.push("download");
        return image;
      },
      cancel: async () => {
        order.push("cancel");
        return true;
      },
      restore: (restored) => {
        order.push("restore");
        expect(restored.get(imageAttachment.id)).toBe(image);
      },
    });

    expect(result).toEqual({ outcome: "restored" });
    expect(order).toEqual(["download", "cancel", "restore"]);
  });

  it("leaves the composer alone when the cancel loses the race with the send", async () => {
    const restore = vi.fn();

    const result = await takeBackQueuedMessage({
      attachments: [],
      download: async () => image,
      cancel: async () => false,
      restore,
    });

    expect(result).toEqual({ outcome: "lost-race" });
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not cancel a message whose attachment it could not download", async () => {
    const cancel = vi.fn(async () => true);
    const restore = vi.fn();

    const result = await takeBackQueuedMessage({
      attachments: [imageAttachment],
      download: async () => "failed",
      cancel,
      restore,
    });

    expect(result).toEqual({ outcome: "download-failed", name: "screen.png" });
    expect(cancel).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("still cancels when an attachment is gone for good", async () => {
    const restore = vi.fn();

    const result = await takeBackQueuedMessage({
      attachments: [imageAttachment],
      download: async () => "missing",
      cancel: async () => true,
      restore,
    });

    expect(result).toEqual({ outcome: "restored" });
    expect(restore.mock.calls[0]?.[0].size).toBe(0);
  });
});

describe("mergeRestoredPrompt", () => {
  it("does not add a blank line to an empty draft or an empty message", () => {
    expect(mergeRestoredPrompt("  \n", "Hello")).toBe("Hello");
    expect(mergeRestoredPrompt("Draft", "")).toBe("Draft");
  });
});

describe("draftStillHoldsSnapshot", () => {
  const snapshot = { prompt: "Hello", attachmentIds: ["a", "b"] };

  it("matches only the draft that was queued", () => {
    const held = { prompt: "Hello", images: [{ id: "a" }], files: [{ id: "b" }] };

    expect(draftStillHoldsSnapshot(held, snapshot)).toBe(true);
    expect(draftStillHoldsSnapshot({ ...held, prompt: "Hello there" }, snapshot)).toBe(false);
    expect(draftStillHoldsSnapshot({ ...held, files: [] }, snapshot)).toBe(false);
    expect(draftStillHoldsSnapshot(null, snapshot)).toBe(false);
  });
});

describe("rememberedQueueTrigger", () => {
  const key = "thread-remembered";

  it("reopens the picker on the trigger the message had", () => {
    const trigger = { type: "at", at: "2026-10-30T13:00:00.000Z" } as const;
    rememberQueueTrigger(key, trigger);

    expect(rememberedQueueTrigger(key, NOW_MS)).toEqual(trigger);
  });

  it("drops a time that has passed, which would send on the next tick", () => {
    rememberQueueTrigger(key, { type: "at", at: "2026-10-30T11:00:00.000Z" });

    expect(rememberedQueueTrigger(key, NOW_MS)).toBeUndefined();
  });

  it("keeps usage triggers, which have no time of their own", () => {
    const trigger = {
      type: "window-reset",
      accountKey: "codex",
      windowId: "seven_day",
    } as QueuedMessage["trigger"];
    rememberQueueTrigger(key, trigger);

    expect(rememberedQueueTrigger(key, NOW_MS)).toEqual(trigger);
  });
});
