import type {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  QueuedMessage,
  QueuedMessageTrigger,
  ThreadId,
} from "@t3tools/contracts";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { producerIdFromComposerContextId } from "../../lib/composerContextReferences";
import {
  asKnownContextRecord,
  previewAnnotationFromRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
} from "../../lib/composerContextRecords";
import { randomUUID } from "~/lib/utils";

/** Same shape as a stash restore: what the user typed stays first. */
export function mergeRestoredPrompt(current: string, restored: string): string {
  if (restored.length === 0) return current;
  return current.trim().length > 0 ? `${current.replace(/\s+$/, "")}\n\n${restored}` : restored;
}

/** Whether a draft is still what was queued; anything typed since must not be cleared. */
export function draftStillHoldsSnapshot(
  draft: {
    readonly prompt: string;
    readonly images: ReadonlyArray<{ readonly id: string }>;
    readonly files: ReadonlyArray<{ readonly id: string }>;
  } | null,
  snapshot: { readonly prompt: string; readonly attachmentIds: ReadonlyArray<string> },
): boolean {
  if (draft === null || draft.prompt !== snapshot.prompt) return false;
  const attachmentIds = [...draft.images, ...draft.files].map((attachment) => attachment.id);
  return (
    attachmentIds.length === snapshot.attachmentIds.length &&
    attachmentIds.every((id, index) => id === snapshot.attachmentIds[index])
  );
}

export type AttachmentDownload = File | "missing" | "failed";

/**
 * The order is the point. The bytes come first because the server drops them with the cancel, so
 * a failed download leaves the message queued. The draft is written only after the cancel is
 * confirmed, so one that loses the race with the send leaves the composer alone. A file that is
 * gone for good cannot block the cancel; it is reported by the restore instead.
 */
export async function takeBackQueuedMessage(input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly download: (attachment: ChatAttachment) => Promise<AttachmentDownload>;
  readonly cancel: () => Promise<boolean>;
  readonly restore: (files: ReadonlyMap<string, File>) => void;
}): Promise<
  | { readonly outcome: "restored" | "lost-race" }
  | { readonly outcome: "download-failed"; readonly name: string }
> {
  const files = new Map<string, File>();
  for (const attachment of input.attachments) {
    const downloaded = await input.download(attachment);
    if (downloaded === "failed") return { outcome: "download-failed", name: attachment.name };
    if (downloaded !== "missing") files.set(attachment.id, downloaded);
  }
  if (!(await input.cancel())) return { outcome: "lost-race" };
  input.restore(files);
  return { outcome: "restored" };
}

const queueTriggersByThreadKey = new Map<string, QueuedMessageTrigger>();

export function rememberQueueTrigger(threadKey: string, trigger: QueuedMessageTrigger): void {
  queueTriggersByThreadKey.set(threadKey, trigger);
}

export function forgetQueueTrigger(threadKey: string): void {
  queueTriggersByThreadKey.delete(threadKey);
}

/** The trigger a taken-back message had, unless it is a time that has already passed. */
export function rememberedQueueTrigger(
  threadKey: string,
  nowMs: number,
): QueuedMessageTrigger | undefined {
  const trigger = queueTriggersByThreadKey.get(threadKey);
  return trigger?.type === "at" && Date.parse(trigger.at) <= nowMs ? undefined : trigger;
}

/**
 * Writes a queued message back into its thread's draft. Takes the target rather than the mounted
 * composer, so it lands correctly after navigating away or during a queued-run edit. Runtime and
 * interaction mode are thread state the queue never changed, so they have nothing to restore.
 */
export function restoreQueuedMessageToDraft(input: {
  readonly target: ComposerThreadTarget;
  readonly threadId: ThreadId;
  readonly message: QueuedMessage;
  readonly files: ReadonlyMap<string, File>;
}): { readonly prompt: string; readonly unrestoredNames: ReadonlyArray<string> } {
  const { target, threadId, message, files } = input;
  const store = useComposerDraftStore.getState();
  const prompt = mergeRestoredPrompt(store.getComposerDraft(target)?.prompt ?? "", message.text);
  store.setPrompt(target, prompt);
  const { modelSelection } = message.sendContext;
  if (modelSelection !== undefined) {
    store.setModelSelection(target, modelSelection, { replaceOptions: true });
  }

  const addedContext = { appendReference: false };
  const annotationIds = new Set<string>();
  // Local ids stay as they were, so the prompt's inline references keep pointing at their chips.
  const localIds = new Map<string, string>();
  for (const candidate of message.context?.records ?? []) {
    const record = asKnownContextRecord(candidate);
    if (record === undefined) continue;
    switch (record.kind) {
      case "image":
      case "file":
        localIds.set(
          record.attachmentId,
          producerIdFromComposerContextId(record.kind, record.contextId),
        );
        break;
      case "terminal":
        store.addTerminalContexts(
          target,
          [terminalContextDraftFromRecord(record, threadId)],
          addedContext,
        );
        break;
      case "review-comment":
        store.addReviewComment(target, reviewCommentFromRecord(record), addedContext);
        break;
      case "preview-annotation": {
        const annotation = previewAnnotationFromRecord(record);
        annotationIds.add(annotation.id);
        store.addPreviewAnnotation(target, annotation, addedContext);
        break;
      }
      case "thread":
        store.addThreadContexts(target, [record], addedContext);
        break;
      default:
        break;
    }
  }

  const addAttachment = (attachment: ChatAttachment, file: File) => {
    const id = localIds.get(attachment.id) ?? randomUUID();
    const base = { id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: file.size };
    if (attachment.type === "image") {
      const { source } = attachment as ChatImageAttachment;
      const image = {
        ...base,
        type: "image" as const,
        previewUrl: URL.createObjectURL(file),
        file,
        ...(source ? { source } : {}),
      };
      // A screenshot shares its annotation's id and may repeat an image already in the draft.
      return store.addImages(target, [image], { allowDuplicates: annotationIds.has(id) });
    }
    const { source } = attachment as ChatFileAttachment;
    return store.addFiles(
      target,
      [{ ...base, type: "file", file, ...(source ? { source } : {}) }],
      { appendReference: false },
    );
  };
  const unrestoredNames = (message.attachments ?? []).flatMap((attachment) => {
    const file = files.get(attachment.id);
    return file !== undefined && addAttachment(attachment, file).length > 0
      ? []
      : [attachment.name];
  });
  return { prompt, unrestoredNames };
}
