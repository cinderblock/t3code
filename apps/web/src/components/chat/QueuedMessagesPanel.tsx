import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, QueuedMessage, ThreadId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { BanIcon, CircleAlertIcon, ClockIcon, XIcon } from "lucide-react";
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

  return (
    <div className={cn("mx-auto mb-2 flex max-w-3xl flex-col gap-1.5", props.className)}>
      {threadQueuedMessages.map((message) =>
        isRestorable(message) ? (
          <div
            key={message.id}
            className="flex items-center gap-2 rounded-xl border border-border/65 bg-card/90 px-3 py-2"
          >
            <BanIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-foreground/90">{previewText(message)}</div>
              <div className="truncate text-2xs text-muted-foreground">
                {message.cancelledBy === "agent" ? "Cancelled by an agent" : "Cancelled"}
                {describeAttachments(message)}
              </div>
            </div>
            <Button
              size="xs"
              variant="ghost-muted"
              className="shrink-0"
              disabled={takingBackMessageId !== null}
              onClick={() => takeBack(message)}
            >
              Restore
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0"
              aria-label="Dismiss cancelled queued message"
              disabled={takingBackMessageId !== null}
              onClick={() =>
                void discardQueuedMessage({ environmentId, input: { id: message.id } })
              }
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ) : message.status === "failed" ? (
          <div
            key={message.id}
            className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/8 px-3 py-2"
          >
            <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-foreground/90">{previewText(message)}</div>
              <div className="truncate text-2xs text-destructive/90">
                Failed to send
                {describeAttachments(message)}
                {message.failureDetail ? `: ${message.failureDetail}` : ""}
              </div>
            </div>
            <Button
              size="xs"
              variant="ghost-muted"
              className="shrink-0"
              disabled={takingBackMessageId !== null}
              onClick={() => takeBack(message)}
            >
              Edit message
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0"
              aria-label="Dismiss failed queued message"
              disabled={takingBackMessageId !== null}
              onClick={() =>
                void discardQueuedMessage({ environmentId, input: { id: message.id } })
              }
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ) : (
          <div
            key={message.id}
            className="flex items-center gap-2 rounded-xl border border-border/65 bg-card/90 px-3 py-2"
          >
            <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-foreground/90">{previewText(message)}</div>
              <div className="truncate text-2xs text-muted-foreground">
                {message.origin === "cap-hit-auto" ? "Queued after a usage cap hit: " : null}
                {describeQueuedMessageTrigger(message.trigger)}
                {describeAttachments(message)}
              </div>
            </div>
            {message.status === "sending" ? (
              // Claimed by the server: the turn is starting, so there is nothing left to
              // edit or cancel. The row disappears once the send settles.
              <span className="shrink-0 text-2xs text-muted-foreground">Sending…</span>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  className="shrink-0"
                  disabled={takingBackMessageId !== null}
                  onClick={() => takeBack(message)}
                >
                  Edit message
                </Button>
                <Popover
                  open={editingMessageId === message.id}
                  onOpenChange={(open) => setEditingMessageId(open ? message.id : null)}
                >
                  <PopoverTrigger
                    render={<Button size="xs" variant="ghost-muted" className="shrink-0" />}
                  >
                    Edit trigger
                  </PopoverTrigger>
                  <PopoverPopup side="top" align="end" className="w-72 max-w-none">
                    <QueuedMessageTriggerForm
                      accounts={usageAccounts}
                      preferredInstanceId={message.sendContext.modelSelection?.instanceId ?? null}
                      initialTrigger={message.trigger}
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
                  className="shrink-0"
                  disabled={takingBackMessageId !== null}
                  onClick={() => takeBack(message)}
                >
                  Cancel
                </Button>
              </>
            )}
          </div>
        ),
      )}
    </div>
  );
});
