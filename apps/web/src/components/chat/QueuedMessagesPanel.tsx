import { useAtomValue } from "@effect/atom-react";
import type { QueuedMessage, ThreadId } from "@t3tools/contracts";
import { CircleAlertIcon, ClockIcon, XIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import {
  primaryAccountUsageAtom,
  primaryQueuedMessagesAtom,
  usageEnvironment,
} from "../../state/usage";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  describeQueuedMessageTrigger,
  QueuedMessageTriggerForm,
} from "./QueuedMessageTriggerPicker";

/**
 * Compact rows for the active thread's queued messages, rendered above the
 * composer next to the banner stack. Pending rows can retarget their trigger
 * or be cancelled; failed rows surface the failure and can be dismissed.
 */
export const QueuedMessagesPanel = memo(function QueuedMessagesPanel(props: {
  threadId: ThreadId;
  className?: string;
}) {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const queuedMessages = useAtomValue(primaryQueuedMessagesAtom);
  const usageAccounts = useAtomValue(primaryAccountUsageAtom);
  const updateQueuedMessage = useAtomCommand(
    usageEnvironment.updateQueuedMessage,
    "queued message update",
  );
  const cancelQueuedMessage = useAtomCommand(
    usageEnvironment.cancelQueuedMessage,
    "queued message cancel",
  );
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const threadQueuedMessages = useMemo<ReadonlyArray<QueuedMessage>>(
    () =>
      queuedMessages.filter(
        (message) =>
          message.threadId === props.threadId &&
          (message.status === "pending" || message.status === "failed"),
      ),
    [props.threadId, queuedMessages],
  );

  if (environmentId === null || threadQueuedMessages.length === 0) {
    return null;
  }

  return (
    <div className={cn("mx-auto mb-2 flex max-w-3xl flex-col gap-1.5", props.className)}>
      {threadQueuedMessages.map((message) =>
        message.status === "failed" ? (
          <div
            key={message.id}
            className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/8 px-3 py-2"
          >
            <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-foreground/90">{message.text}</div>
              <div className="truncate text-[11px] text-destructive/90">
                Failed to send
                {message.failureDetail ? `: ${message.failureDetail}` : ""}
              </div>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0"
              aria-label="Dismiss failed queued message"
              onClick={() => void cancelQueuedMessage({ environmentId, input: { id: message.id } })}
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
              <div className="truncate text-[13px] text-foreground/90">{message.text}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {message.origin === "cap-hit-auto" ? "Queued after a usage cap hit — " : null}
                {describeQueuedMessageTrigger(message.trigger)}
              </div>
            </div>
            <Popover
              open={editingMessageId === message.id}
              onOpenChange={(open) => setEditingMessageId(open ? message.id : null)}
            >
              <PopoverTrigger
                render={
                  <Button size="xs" variant="ghost" className="shrink-0 text-muted-foreground" />
                }
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
              variant="ghost"
              className="shrink-0 text-muted-foreground"
              onClick={() => void cancelQueuedMessage({ environmentId, input: { id: message.id } })}
            >
              Cancel
            </Button>
          </div>
        ),
      )}
    </div>
  );
});
