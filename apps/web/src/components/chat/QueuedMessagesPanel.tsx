import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, QueuedMessage, ThreadId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { BanIcon, CircleAlertIcon, ClockIcon } from "lucide-react";
import { memo, useState } from "react";
import { cn } from "~/lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useAtomCommand } from "../../state/use-atom-command";
import { queuedMessagesAtom, usageAccountsAtom, usageEnvironment } from "../../state/quota";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  describeQueuedMessageTrigger,
  QueuedMessageTriggerForm,
} from "./QueuedMessageTriggerPicker";
import { isRestorable, panelQueuedMessages } from "./queuedMessageRestore";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

/** Prompts hold context as link markup; a row shows the label a chip would. */
function previewText(message: QueuedMessage): string {
  return replaceComposerContextReferences(message.text, (reference) => reference.label);
}

function describeAttachments(message: QueuedMessage): string {
  const count = message.attachments?.length ?? 0;
  return count === 0 ? "" : ` · ${count} attachment${count === 1 ? "" : "s"}`;
}

/**
 * Rows above the composer for the active thread's queued messages. Pending rows can retarget
 * their trigger or go back to the composer. Failed rows, and cancelled rows nobody took back such
 * as an agent's cancel, can go back to the composer or be dismissed.
 */
export const QueuedMessagesPanel = memo(function QueuedMessagesPanel(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onTakeBack: (message: QueuedMessage) => Promise<void>;
  className?: string;
}) {
  const { environmentId } = props;
  const queuedMessages = useAtomValue(queuedMessagesAtom(environmentId));
  const usageAccounts = useAtomValue(usageAccountsAtom(environmentId));
  const updateQueuedMessage = useAtomCommand(
    usageEnvironment.updateQueuedMessage,
    "queued message update",
  );
  const discardQueuedMessage = useAtomCommand(
    usageEnvironment.discardQueuedMessage,
    "queued message dismiss",
  );
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  // Attachments download before the cancel, so a click can take a while to land.
  const [takingBackMessageId, setTakingBackMessageId] = useState<string | null>(null);
  const takeBack = useStableCallback((message: QueuedMessage) => {
    if (takingBackMessageId !== null) return;
    setTakingBackMessageId(message.id);
    void props.onTakeBack(message).finally(() => setTakingBackMessageId(null));
  });

  const threadQueuedMessages = panelQueuedMessages(
    queuedMessages,
    props.threadId,
    takingBackMessageId,
  );

  if (threadQueuedMessages.length === 0) {
    return null;
  }

  const busy = takingBackMessageId !== null;
  const dismiss = (message: QueuedMessage) =>
    void discardQueuedMessage({ environmentId, input: { id: message.id } });
  const items = threadQueuedMessages.map((message): ComposerBannerStackItem => {
    const base = { id: message.id, title: previewText(message) };
    if (isRestorable(message)) {
      return {
        ...base,
        variant: "default",
        icon: <BanIcon />,
        description: `${message.cancelledBy === "agent" ? "Cancelled by an agent" : "Cancelled"}${describeAttachments(message)}`,
        actions: (
          <Button size="xs" variant="ghost-muted" disabled={busy} onClick={() => takeBack(message)}>
            Restore
          </Button>
        ),
        dismissLabel: "Dismiss cancelled queued message",
        ...(busy ? {} : { onDismiss: () => dismiss(message) }),
      };
    }
    if (message.status === "failed") {
      return {
        ...base,
        variant: "error",
        icon: <CircleAlertIcon className="text-destructive" />,
        description: `Failed to send${describeAttachments(message)}${message.failureDetail ? `: ${message.failureDetail}` : ""}`,
        actions: (
          <Button size="xs" variant="ghost-muted" disabled={busy} onClick={() => takeBack(message)}>
            Edit message
          </Button>
        ),
        dismissLabel: "Dismiss failed queued message",
        ...(busy ? {} : { onDismiss: () => dismiss(message) }),
      };
    }
    return {
      ...base,
      variant: "default",
      icon: <ClockIcon />,
      description: `${message.origin === "cap-hit-auto" ? "Queued after a usage cap hit: " : ""}${describeQueuedMessageTrigger(message.trigger)}${describeAttachments(message)}`,
      actions:
        message.status === "sending" ? (
          // Claimed by the server: the turn is starting, so there is nothing left to
          // edit or cancel. The row disappears once the send settles.
          <span className="text-muted-foreground">Sending…</span>
        ) : (
          <>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => takeBack(message)}
            >
              Edit message
            </Button>
            <Popover
              open={editingMessageId === message.id}
              onOpenChange={(open) => setEditingMessageId(open ? message.id : null)}
            >
              <PopoverTrigger render={<Button size="xs" variant="ghost-muted" />}>
                Edit trigger
              </PopoverTrigger>
              <PopoverPopup side="top" align="end" className="w-72 max-w-none">
                <QueuedMessageTriggerForm
                  accounts={usageAccounts}
                  preferredInstanceId={message.sendContext.modelSelection?.instanceId ?? null}
                  initialTrigger={message.trigger}
                  thread={{ environmentId, threadId: message.threadId }}
                  confirmLabel="Save trigger"
                  onConfirm={(trigger) => {
                    setEditingMessageId(null);
                    void updateQueuedMessage({
                      environmentId,
                      input: { id: message.id, trigger },
                    });
                  }}
                />
              </PopoverPopup>
            </Popover>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => takeBack(message)}
            >
              Cancel
            </Button>
          </>
        ),
    };
  });

  return (
    <div
      className={cn(
        "mx-auto mb-2 flex max-w-(--chat-content-max-width) flex-col gap-1.5",
        props.className,
      )}
    >
      <ComposerBannerStack items={items} detached />
    </div>
  );
});
