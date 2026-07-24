import { createUsageEnvironmentAtoms } from "@t3tools/client-runtime/state/usage";
import type { AccountUsageState } from "@t3tools/client-runtime/state/usage";
import type { QueuedMessage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export const usageEnvironment = createUsageEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_ACCOUNTS: ReadonlyArray<AccountUsageState> = [];
const EMPTY_QUEUED_MESSAGES: ReadonlyArray<QueuedMessage> = [];

/** All Claude accounts' usage for the primary environment. */
export const primaryAccountUsageAtom = Atom.make((get): ReadonlyArray<AccountUsageState> => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return EMPTY_ACCOUNTS;
  }
  const projection = Option.getOrNull(
    AsyncResult.value(get(usageEnvironment.usageProjection({ environmentId, input: {} }))),
  );
  return projection?.accounts ?? EMPTY_ACCOUNTS;
}).pipe(Atom.withLabel("web-primary-account-usage"));

/** All queued messages for the primary environment. */
export const primaryQueuedMessagesAtom = Atom.make((get): ReadonlyArray<QueuedMessage> => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return EMPTY_QUEUED_MESSAGES;
  }
  const projection = Option.getOrNull(
    AsyncResult.value(get(usageEnvironment.queuedMessagesProjection({ environmentId, input: {} }))),
  );
  return projection?.messages ?? EMPTY_QUEUED_MESSAGES;
}).pipe(Atom.withLabel("web-primary-queued-messages"));
