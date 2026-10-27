import { useAtomValue } from "@effect/atom-react";
import {
  createUsageEnvironmentAtoms,
  scheduledThreadKeys,
} from "@t3tools/client-runtime/state/quota";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { mobilePreferencesAtom } from "./preferences";

const usageEnvironment = createUsageEnvironmentAtoms(connectionAtomRuntime);

const NO_SCHEDULED_THREADS: ReadonlySet<string> = new Set();

/**
 * `${environmentId}:${threadId}` of threads holding a send-later message, across the
 * comma-joined environment ids. Used only for Working placement and the row status.
 */
const scheduledThreadKeysAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlySet<string> => {
    const keys = environmentIds
      .split(",")
      .filter((environmentId) => environmentId.length > 0)
      .flatMap((environmentId) => {
        const projection = Option.getOrNull(
          AsyncResult.value(
            get(
              usageEnvironment.queuedMessagesProjection({
                environmentId: environmentId as EnvironmentId,
                input: {},
              }),
            ),
          ),
        );
        return scheduledThreadKeys(environmentId, projection?.messages ?? []);
      });
    return keys.length === 0 ? NO_SCHEDULED_THREADS : new Set(keys);
  }).pipe(Atom.withLabel(`mobile-scheduled-thread-keys:${environmentIds}`)),
);

const threadScheduledAtom = Atom.family((key: string) =>
  Atom.make((get): boolean => {
    const [environmentId, threadId] = JSON.parse(key) as [string, string];
    return get(scheduledThreadKeysAtom(environmentId)).has(`${environmentId}:${threadId}`);
  }).pipe(Atom.withLabel(`mobile-thread-scheduled:${key}`)),
);

const notScheduledAtom = Atom.make(false);

function useScheduledMessagesWorking(): boolean {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return (
    AsyncResult.isSuccess(preferences) &&
    preferences.value.workingShelfEnabled !== false &&
    preferences.value.scheduledMessagesWorking !== false
  );
}

/** Threads in `environmentIds` that hold a send-later message, when the user counts those as working. */
export function useScheduledThreadKeys(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlySet<string> {
  const enabled = useScheduledMessagesWorking();
  return useAtomValue(
    scheduledThreadKeysAtom(enabled ? [...new Set(environmentIds)].sort().join(",") : ""),
  );
}

/** Whether one row should read "Scheduled"; re-renders only when that answer changes. */
export function useThreadScheduled(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
}): boolean {
  const enabled = useScheduledMessagesWorking();
  return useAtomValue(
    enabled
      ? threadScheduledAtom(JSON.stringify([thread.environmentId, thread.id]))
      : notScheduledAtom,
  );
}
