import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isAssetAttachmentNotFoundFailure } from "@t3tools/client-runtime/state/attachments";
import {
  QueuedMessageId,
  type ChatAttachment,
  type EnvironmentId,
  type ProjectId,
  type QueuedMessage,
  type QueuedMessageTrigger,
  type RuntimeMode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useRef } from "react";
import { resolveAssetUrl } from "~/assets/assetUrls";
import { newMessageId, randomUUID } from "~/lib/utils";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import {
  composerTargetKey,
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
  type ComposerThreadTarget,
  type DraftThreadEnvMode,
} from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { queuedMessagesAtom, usageEnvironment } from "../../state/quota";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  deriveComposerSendState,
  sendTitleFallbackLabels,
  snapshotComposerSend,
} from "../ChatView.logic";
import { toastManager, stackedThreadToast } from "../ui/toast";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { pendingDraftWork } from "./pendingDraftWork";
import {
  draftStillHoldsSnapshot,
  draftWorkspaceForLaunch,
  forgetQueueTrigger,
  rememberQueueTrigger,
  resolveQueuedLaunchStrategy,
  restoreQueuedMessageToDraft,
  takeBackQueuedMessage,
  takeBackReopensDraft,
  type AttachmentDownload,
} from "./queuedMessageRestore";
import { downloadAttachmentBlob } from "./useComposerContextImport";

function warn(title: string, description?: string) {
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title,
      ...(description === undefined ? {} : { description }),
    }),
  );
}

/** Moves a message between the composer and the send-later queue, in both directions. */
export function useQueuedMessageComposer(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly threadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly canQueue: boolean;
  readonly awaitingMachine: boolean;
  readonly composerRef: ComposerHandleRef;
  /** The draft on screen, which is not the thread's own during a queued-run edit. */
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly threadDraftTarget: ComposerThreadTarget;
  readonly promptRef: { current: string };
  readonly runtimeMode: RuntimeMode;
  /** What a first send would use; a message queued as the first one has to keep it. */
  readonly firstSend: {
    readonly isLocalDraftThread: boolean;
    readonly activeMessageCount: number;
    readonly projectId: ProjectId | null;
    readonly sendEnvMode: DraftThreadEnvMode;
    readonly worktreePath: string | null;
    readonly branch: string | null;
    readonly startFromOrigin: boolean;
  };
  readonly setThreadError: (threadId: ScopedThreadRef["threadId"], error: string | null) => void;
}) {
  const {
    environmentId,
    threadRef,
    threadKey,
    currentRouteThreadKeyRef,
    canQueue,
    awaitingMachine,
    composerRef,
    composerDraftTarget,
    threadDraftTarget,
    promptRef,
    runtimeMode,
    firstSend,
    setThreadError,
  } = input;
  const enqueueQueuedMessage = useAtomCommand(
    usageEnvironment.enqueueMessage,
    "queued message enqueue",
  );
  const cancelQueuedMessage = useAtomCommand(usageEnvironment.cancelQueuedMessage, {
    reportFailure: false,
  });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();
  const queueInFlightRef = useRef(false);

  const queueDraft = async (trigger: QueuedMessageTrigger) => {
    if (!canQueue || threadRef === null || queueInFlightRef.current) return;
    if (awaitingMachine) {
      warn("Choose a machine to continue", "Pick one in the composer, then queue this again.");
      return;
    }
    const sendContext = composerRef.current?.getSendContext();
    if (!sendContext) return;
    if (pendingDraftWork.has(composerTargetKey(composerDraftTarget))) {
      toastManager.add({
        type: "info",
        title: "Still bringing attached context into this message.",
        description: "Queue it again once its chip resolves.",
      });
      return;
    }
    const contents = {
      prompt: sendContext.prompt,
      images: sendContext.images,
      files: sendContext.files,
      terminalContexts: sendContext.terminalContexts,
      previewAnnotations: sendContext.previewAnnotations,
      reviewComments: sendContext.reviewComments,
      threadContexts: sendContext.threadContexts,
    };
    const { sendableTerminalContexts, hasSendableContent } = deriveComposerSendState({
      prompt: contents.prompt,
      imageCount: contents.images.length + contents.files.length,
      terminalContexts: contents.terminalContexts,
      elementContextCount:
        contents.previewAnnotations.length +
        contents.reviewComments.length +
        contents.threadContexts.length,
    });
    if (!hasSendableContent) return;
    const snapshot = snapshotComposerSend({ ...contents, sendableTerminalContexts });
    const { threadId } = threadRef;
    const launchStrategy = resolveQueuedLaunchStrategy(firstSend);
    if (launchStrategy === "missing-base-branch") {
      setThreadError(threadId, "Select a base branch before queueing in New worktree mode.");
      return;
    }
    if (launchStrategy !== null && firstSend.projectId === null) {
      warn("Choose a project first", "This draft no longer points to an available project.");
      return;
    }
    const fileBlockReason = () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
      return fileAttachmentCapabilityBlockReason({
        files: snapshot.files,
        attachmentUploadsCapabilityKnown: config !== null,
        supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
        maxFileAttachmentBytes:
          config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
      });
    };
    const blocked = fileBlockReason();
    if (blocked !== null) {
      setThreadError(threadId, blocked);
      return;
    }

    queueInFlightRef.current = true;
    try {
      for (const attachment of snapshot.attachments) {
        const upload =
          readAttachmentUpload(attachment.id)?.status === "failed"
            ? retryAttachmentUpload
            : startAttachmentUpload;
        upload({ environmentId, image: attachment, draftTarget: composerDraftTarget });
      }
      await awaitAttachmentUploads(snapshot.attachments.map((attachment) => attachment.id));
      const attachments = getUploadedAttachments({ environmentId, images: snapshot.attachments });
      if (attachments === null) {
        setThreadError(threadId, "Retry or remove failed uploads before queueing.");
        return;
      }
      const context = buildMessageContext({
        terminalContexts: snapshot.terminalContexts,
        reviewComments: snapshot.reviewComments,
        previewAnnotations: snapshot.previewAnnotations,
        threadContexts: snapshot.threadContexts,
        attachments: snapshot.attachments.map((attachment, index) => ({
          attachment,
          attachmentId: attachments[index]!.id,
        })),
      });
      const result = await enqueueQueuedMessage({
        environmentId,
        input: {
          id: QueuedMessageId.make(randomUUID()),
          threadId,
          messageId: newMessageId(),
          text: snapshot.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(context === undefined ? {} : { context }),
          trigger,
          sendContext: {
            modelSelection: sendContext.selectedModelSelection,
            runtimeMode,
            interactionMode: sendContext.interactionMode,
            ...(launchStrategy !== null && firstSend.projectId !== null
              ? {
                  launch: {
                    projectId: firstSend.projectId,
                    title: deriveThreadTitleSeed({
                      text: snapshot.messageText,
                      attachments: snapshot.attachments,
                      fallbackLabels: sendTitleFallbackLabels(snapshot),
                    }),
                    workspaceStrategy: launchStrategy,
                  },
                }
              : {}),
          },
          origin: "user",
        },
      });
      // The draft stays until the server has the message, so a failure loses nothing.
      if (result._tag === "Failure") return;
      forgetQueueTrigger(threadKey);
      const store = useComposerDraftStore.getState();
      const attachmentIds = snapshot.attachments.map((attachment) => attachment.id);
      if (
        draftStillHoldsSnapshot(store.getComposerDraft(composerDraftTarget), {
          prompt: contents.prompt,
          attachmentIds,
        })
      ) {
        store.clearComposerContent(composerDraftTarget);
        releaseDraftAttachments(snapshot.attachments);
        if (currentRouteThreadKeyRef.current === threadKey) {
          promptRef.current = "";
          composerRef.current?.resetCursorState();
        }
      } else {
        toastManager.add({
          type: "info",
          title: "Message queued",
          description: "The draft changed while it was queueing, so it stayed in the composer.",
        });
      }
      // No message or run will appear to finalize this draft, which is what a send waits for.
      if (firstSend.isLocalDraftThread) finalizePromotedDraftThreadByRef(threadRef);
    } finally {
      queueInFlightRef.current = false;
    }
  };

  const downloadAttachment = async (attachment: ChatAttachment): Promise<AttachmentDownload> => {
    const connection = readPreparedConnection(environmentId);
    if (!connection) return "failed";
    const result = await createAssetUrl({
      environmentId,
      input: { resource: { _tag: "attachment", attachmentId: attachment.id } },
    });
    if (result._tag === "Failure") {
      return isAssetAttachmentNotFoundFailure(squashAtomCommandFailure(result))
        ? "missing"
        : "failed";
    }
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    const blob = url === null ? null : await downloadAttachmentBlob(url);
    return blob === null
      ? "failed"
      : new File([blob], attachment.name, { type: attachment.mimeType || blob.type });
  };

  /** Opens a new draft with the setup a first message was queued with, if it should go back. */
  const reopenDraft = async (message: QueuedMessage) => {
    const { launch, runtimeMode: queuedRuntimeMode, interactionMode } = message.sendContext;
    if (
      launch === undefined ||
      threadRef === null ||
      currentRouteThreadKeyRef.current !== threadKey ||
      !takeBackReopensDraft({
        message,
        allMessages: appAtomRegistry.get(queuedMessagesAtom(environmentId)),
        thread: readThreadShell(threadRef),
      })
    ) {
      return null;
    }
    const opened = await handleNewThread(scopeProjectRef(environmentId, launch.projectId), {
      ...draftWorkspaceForLaunch(launch.workspaceStrategy),
      replace: true,
    });
    if (opened !== null) {
      useComposerDraftStore.getState().setDraftThreadContext(opened.draftId, {
        runtimeMode: queuedRuntimeMode,
        interactionMode,
      });
    }
    return opened;
  };

  /**
   * Cancels a message and puts it back in the composer. Only this client's own click restores,
   * never the queue stream, so a cancel elsewhere touches no draft.
   */
  const takeBack = async (message: QueuedMessage) => {
    if (threadRef === null) return;
    const result = await takeBackQueuedMessage({
      attachments: message.attachments ?? [],
      download: downloadAttachment,
      cancel: async () => {
        const cancelled = await cancelQueuedMessage({ environmentId, input: { id: message.id } });
        return cancelled._tag === "Success";
      },
      restore: async (files) => {
        // The draft is written before the thread goes: deleting it navigates away from it.
        const reopened = await reopenDraft(message);
        rememberQueueTrigger(
          reopened === null
            ? threadKey
            : scopedThreadKey(scopeThreadRef(environmentId, reopened.threadId)),
          message.trigger,
        );
        const { prompt, unrestoredNames } = restoreQueuedMessageToDraft({
          target: reopened?.draftId ?? threadDraftTarget,
          threadId: reopened?.threadId ?? threadRef.threadId,
          message,
          files,
        });
        if (unrestoredNames.length > 0) {
          warn(
            "Some attachments were not restored",
            `${unrestoredNames.join(", ")} could not be added. Attach them again if you still need them.`,
          );
        }
        if (reopened !== null) {
          await deleteThread({ environmentId, input: { threadId: threadRef.threadId } });
        } else if (
          currentRouteThreadKeyRef.current === threadKey &&
          composerDraftTarget === threadDraftTarget
        ) {
          composerRef.current?.resetCursorState({
            cursor: collapseExpandedComposerCursor(prompt, prompt.length),
            prompt,
          });
          window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
        }
      },
    });
    if (result.outcome === "download-failed") {
      warn(`Couldn't download ${result.name}`, "The message is still queued. Try again.");
    } else if (result.outcome === "lost-race") {
      warn(
        "Couldn't take this message back",
        "It may already be sending. If so, it will appear in the thread.",
      );
    }
  };

  return { queueDraft, takeBack };
}
