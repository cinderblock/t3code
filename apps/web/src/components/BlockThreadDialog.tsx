import type { ThreadBlockUntil } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { cn } from "~/lib/utils";
import { useThreadShells } from "../state/entities";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

type BlockChoice = { readonly blockerThreadId: string; readonly until: ThreadBlockUntil };
type BlockTarget = { readonly environmentId: string; readonly threadId: string };
type Request = { readonly target: BlockTarget; readonly resolve: (c: BlockChoice | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestThreadBlock(target: BlockTarget): Promise<BlockChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { target, resolve } }));
}

function finish(choice: BlockChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

/** Threads a thread can wait on: live ones in the same environment, newest first. */
function useAwaitableThreads(target: BlockTarget, query: string) {
  const needle = query.trim().toLowerCase();
  return useThreadShells()
    .filter(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.id !== target.threadId &&
        thread.archivedAt === null &&
        thread.settledOverride !== "settled" &&
        (needle === "" || thread.title.toLowerCase().includes(needle)),
    )
    .toSorted((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

/** Search and pick one thread; shared by this dialog and the send-later trigger form. */
export function AwaitedThreadPicker(props: {
  readonly target: BlockTarget;
  readonly value: string | null;
  readonly onChange: (threadId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const threads = useAwaitableThreads(props.target, query);
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <Input
        size="sm"
        placeholder="Search threads"
        aria-label="Search threads"
        value={query}
        onValueChange={setQuery}
      />
      <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto" role="listbox">
        {threads.length === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground text-xs">No matching threads.</p>
        ) : null}
        {threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            role="option"
            aria-selected={props.value === thread.id}
            onClick={() => props.onChange(thread.id)}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-foreground",
              props.value === thread.id ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
            <CheckIcon
              aria-hidden
              className={cn("size-3.5 shrink-0", props.value !== thread.id && "invisible")}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

export function AwaitedUntilToggle(props: {
  readonly value: ThreadBlockUntil;
  readonly onChange: (until: ThreadBlockUntil) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Wait until"
      className="w-full *:flex-1"
      value={[props.value]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "finished" || value === "settled") props.onChange(value);
      }}
    >
      <Toggle value="finished">It finishes</Toggle>
      <Toggle value="settled">It settles</Toggle>
    </ToggleGroup>
  );
}

export function BlockThreadDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- settles the pending caller promise, held outside React, when the host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <BlockThreadDialog target={request.target} /> : null;
}

function BlockThreadDialog(props: { readonly target: BlockTarget }) {
  const [blockerThreadId, setBlockerThreadId] = useState<string | null>(null);
  const [until, setUntil] = useState<ThreadBlockUntil>("finished");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Blocked on a thread</DialogTitle>
          <DialogDescription>
            This thread returns to your inbox when the other one is done, or if it fails.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <AwaitedThreadPicker
              target={props.target}
              value={blockerThreadId}
              onChange={setBlockerThreadId}
            />
            <AwaitedUntilToggle value={until} onChange={setUntil} />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button
            disabled={blockerThreadId === null}
            onClick={() => {
              if (blockerThreadId !== null) finish({ blockerThreadId, until });
            }}
          >
            Block
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
