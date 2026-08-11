import type { AccountUsageState } from "@t3tools/client-runtime/state/quota";
import type { QueuedMessageTrigger } from "@t3tools/contracts";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const DEFAULT_HEADROOM_PERCENT = 20;
const DEFAULT_HEADROOM_LEAD_MINUTES = 60;

type TriggerChoice = "session-reset" | "weekly-reset" | "at" | "headroom";
type HeadroomWindowChoice = "session" | "weekly";

/**
 * Resolve which usage account a queued message should be bound to: the
 * account whose provider instances include the composer's current instance,
 * falling back to the first known account.
 */
export function resolveQueuedMessageAccountKey(
  accounts: ReadonlyArray<AccountUsageState>,
  preferredInstanceId: string | null,
): string | null {
  const preferred = preferredInstanceId
    ? accounts.find((account) =>
        (account.snapshot?.instanceIds ?? []).some(
          (instanceId) => instanceId === preferredInstanceId,
        ),
      )
    : undefined;
  return (preferred ?? accounts[0])?.accountKey ?? null;
}

function describeWindow(windowId: string): string {
  if (windowId.startsWith("session")) return "5-hour window";
  if (windowId.startsWith("weekly")) return "weekly window";
  if (windowId.startsWith("monthly")) return "monthly window";
  return `${windowId} window`;
}

/** Human description of a queued message trigger for list rows. */
export function describeQueuedMessageTrigger(trigger: QueuedMessageTrigger): string {
  switch (trigger.type) {
    case "at": {
      const parsed = new Date(trigger.at);
      if (Number.isNaN(parsed.getTime())) {
        return "Sends at a scheduled time";
      }
      return `Sends at ${parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`;
    }
    case "window-reset":
      return `Sends when the ${describeWindow(trigger.windowId)} resets`;
    case "headroom":
      return `Sends when >${trigger.minRemainingPercent}% remains near ${describeWindow(
        trigger.windowId,
      )} reset`;
  }
}

function toDatetimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function initialChoiceForTrigger(
  trigger: QueuedMessageTrigger | undefined,
  hasUsageAccount: boolean,
): TriggerChoice {
  if (!hasUsageAccount) return "at";
  if (!trigger) return "session-reset";
  switch (trigger.type) {
    case "at":
      return "at";
    case "headroom":
      return "headroom";
    case "window-reset":
      return trigger.windowId.startsWith("weekly") ? "weekly-reset" : "session-reset";
  }
}

/**
 * Trigger picker shared by the composer's queue popover and the queued
 * message list's "Edit trigger" popover. Builds a `QueuedMessageTrigger`
 * and hands it back via `onConfirm`.
 */
export function QueuedMessageTriggerForm(props: {
  accounts: ReadonlyArray<AccountUsageState>;
  preferredInstanceId: string | null;
  initialTrigger?: QueuedMessageTrigger;
  confirmLabel: string;
  onConfirm: (trigger: QueuedMessageTrigger) => void;
}) {
  const { accounts, preferredInstanceId, initialTrigger, confirmLabel, onConfirm } = props;

  const accountKey = resolveQueuedMessageAccountKey(accounts, preferredInstanceId);
  const hasUsageAccount = accountKey !== null;

  const [choice, setChoice] = useState<TriggerChoice>(() =>
    initialChoiceForTrigger(initialTrigger, hasUsageAccount),
  );
  const [atValue, setAtValue] = useState<string>(() => {
    if (initialTrigger?.type === "at") {
      const parsed = new Date(initialTrigger.at);
      if (!Number.isNaN(parsed.getTime())) {
        return toDatetimeLocalValue(parsed);
      }
    }
    return toDatetimeLocalValue(new Date(Date.now() + 60 * 60 * 1000));
  });
  const [headroomPercent, setHeadroomPercent] = useState<string>(() =>
    initialTrigger?.type === "headroom"
      ? String(initialTrigger.minRemainingPercent)
      : String(DEFAULT_HEADROOM_PERCENT),
  );
  const [headroomWindow, setHeadroomWindow] = useState<HeadroomWindowChoice>(() =>
    initialTrigger?.type === "headroom" && initialTrigger.windowId.startsWith("weekly")
      ? "weekly"
      : "session",
  );

  const choiceOptions: Array<{ value: TriggerChoice; label: string }> = [
    ...(hasUsageAccount
      ? [
          { value: "session-reset" as const, label: "When the 5-hour window resets" },
          { value: "weekly-reset" as const, label: "When the weekly window resets" },
        ]
      : []),
    { value: "at" as const, label: "At a specific time" },
    ...(hasUsageAccount
      ? [{ value: "headroom" as const, label: "When headroom remains near a window reset" }]
      : []),
  ];

  const parsedAtTime = Date.parse(atValue);
  const atInvalid = choice === "at" && (atValue.length === 0 || Number.isNaN(parsedAtTime));
  const parsedPercent = Number(headroomPercent);
  const percentInvalid =
    choice === "headroom" &&
    (!Number.isFinite(parsedPercent) || parsedPercent <= 0 || parsedPercent >= 100);
  const confirmDisabled = atInvalid || percentInvalid || (!hasUsageAccount && choice !== "at");

  const confirm = () => {
    if (confirmDisabled) return;
    if (choice === "at") {
      onConfirm({ type: "at", at: new Date(parsedAtTime).toISOString() });
      return;
    }
    if (accountKey === null) return;
    if (choice === "session-reset") {
      onConfirm({ type: "window-reset", accountKey, windowId: "session:all" });
      return;
    }
    if (choice === "weekly-reset") {
      onConfirm({ type: "window-reset", accountKey, windowId: "weekly:all" });
      return;
    }
    onConfirm({
      type: "headroom",
      accountKey,
      windowId: headroomWindow === "weekly" ? "weekly:all" : "session:all",
      minRemainingPercent: Math.round(parsedPercent),
      leadMinutes: DEFAULT_HEADROOM_LEAD_MINUTES,
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="font-medium text-muted-foreground text-xs">Send later</div>
      <div className="flex flex-col gap-1" role="radiogroup" aria-label="Send trigger">
        {choiceOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={choice === option.value}
            onClick={() => setChoice(option.value)}
            className={cn(
              "cursor-pointer rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
              choice === option.value
                ? "border-primary/45 bg-primary/10 text-foreground"
                : "border-border/65 text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {choice === "at" ? (
        <label className="flex flex-col gap-1 text-muted-foreground text-xs">
          Send at
          <Input
            type="datetime-local"
            size="sm"
            value={atValue}
            onValueChange={(value) => setAtValue(value)}
          />
        </label>
      ) : null}
      {choice === "headroom" ? (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="whitespace-nowrap">More than</span>
            <Input
              type="number"
              size="sm"
              min={1}
              max={99}
              className="w-16"
              value={headroomPercent}
              onValueChange={(value) => setHeadroomPercent(value)}
            />
            <span className="whitespace-nowrap">% remaining</span>
          </label>
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Headroom window">
            {(["session", "weekly"] as const).map((window) => (
              <button
                key={window}
                type="button"
                role="radio"
                aria-checked={headroomWindow === window}
                onClick={() => setHeadroomWindow(window)}
                className={cn(
                  "cursor-pointer rounded-md border px-2 py-1 text-xs transition-colors",
                  headroomWindow === window
                    ? "border-primary/45 bg-primary/10 text-foreground"
                    : "border-border/65 text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {window === "session" ? "5-hour window" : "Weekly window"}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-muted-foreground/70">
            Sends within {DEFAULT_HEADROOM_LEAD_MINUTES} minutes of the window reset.
          </div>
        </div>
      ) : null}
      <Button
        size="sm"
        type="button"
        className="self-end"
        disabled={confirmDisabled}
        onClick={confirm}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}
