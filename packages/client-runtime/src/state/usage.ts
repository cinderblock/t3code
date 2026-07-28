import {
  WS_METHODS,
  type AccountUsageSnapshot,
  type AccountUsageStreamEvent,
  type AccountUsageUnavailableReason,
  type QueuedMessage,
  type QueuedMessageStreamEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export interface AccountUsageState {
  readonly accountKey: string;
  /**
   * Null until the first successful poll. The account is still tracked so
   * the UI can render a placeholder rather than vanishing, which reads as a
   * bug rather than a transient backoff.
   */
  readonly snapshot: AccountUsageSnapshot | null;
  /** Set while the poller cannot refresh this account; snapshot is stale. */
  readonly unavailableReason: AccountUsageUnavailableReason | null;
  readonly unavailableDetail: string | null;
}

export interface AccountUsageProjection {
  readonly accounts: ReadonlyArray<AccountUsageState>;
}

export function applyAccountUsageEvent(
  current: Option.Option<AccountUsageProjection>,
  event: AccountUsageStreamEvent,
): Option.Option<AccountUsageProjection> {
  const currentAccounts = Option.match(current, {
    onNone: () => [] as ReadonlyArray<AccountUsageState>,
    onSome: (projection) => projection.accounts,
  });

  switch (event._tag) {
    case "snapshot":
      return Option.some({
        accounts: event.accounts.map((account) => ({
          accountKey: account.accountKey,
          snapshot: account.snapshot,
          unavailableReason: account.unavailableReason,
          unavailableDetail: account.unavailableDetail,
        })),
      });
    case "accountUpdated": {
      const others = currentAccounts.filter(
        (account) => account.accountKey !== event.snapshot.accountKey,
      );
      return Option.some({
        accounts: [
          ...others,
          {
            accountKey: event.snapshot.accountKey,
            snapshot: event.snapshot,
            unavailableReason: null,
            unavailableDetail: null,
          },
        ],
      });
    }
    case "accountUnavailable": {
      // Upsert: the account may have failed before it ever produced a
      // snapshot, in which case this is the first we hear of it.
      const existing = currentAccounts.find((account) => account.accountKey === event.accountKey);
      const others = currentAccounts.filter((account) => account.accountKey !== event.accountKey);
      return Option.some({
        accounts: [
          ...others,
          {
            accountKey: event.accountKey,
            snapshot: existing?.snapshot ?? null,
            unavailableReason: event.reason,
            unavailableDetail: event.detail,
          },
        ],
      });
    }
  }
}

export function projectAccountUsage(
  current: Option.Option<AccountUsageProjection>,
  event: AccountUsageStreamEvent,
): readonly [Option.Option<AccountUsageProjection>, ReadonlyArray<AccountUsageProjection>] {
  const next = applyAccountUsageEvent(current, event);
  return [next, Option.toArray(next)];
}

export interface QueuedMessagesProjection {
  readonly messages: ReadonlyArray<QueuedMessage>;
}

export function applyQueuedMessageEvent(
  current: Option.Option<QueuedMessagesProjection>,
  event: QueuedMessageStreamEvent,
): Option.Option<QueuedMessagesProjection> {
  switch (event._tag) {
    case "snapshot":
      return Option.some({ messages: event.messages });
    case "upserted": {
      const messages = Option.match(current, {
        onNone: () => [] as ReadonlyArray<QueuedMessage>,
        onSome: (projection) => projection.messages,
      });
      const withoutMessage = messages.filter((message) => message.id !== event.message.id);
      return Option.some({ messages: [...withoutMessage, event.message] });
    }
    case "removed":
      return Option.map(current, (projection) => ({
        messages: projection.messages.filter((message) => message.id !== event.id),
      }));
  }
}

export function projectQueuedMessages(
  current: Option.Option<QueuedMessagesProjection>,
  event: QueuedMessageStreamEvent,
): readonly [Option.Option<QueuedMessagesProjection>, ReadonlyArray<QueuedMessagesProjection>] {
  const next = applyQueuedMessageEvent(current, event);
  return [next, Option.toArray(next)];
}

export function createUsageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    usageProjection: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:usage:projection",
      tag: WS_METHODS.subscribeAccountUsage,
      transform: (stream) =>
        stream.pipe(Stream.mapAccum(Option.none<AccountUsageProjection>, projectAccountUsage)),
    }),
    usageHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:usage:history",
      tag: WS_METHODS.usageGetHistory,
      staleTimeMs: 60_000,
    }),
    enqueueMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:queue:enqueue",
      tag: WS_METHODS.queueEnqueueMessage,
    }),
    updateQueuedMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:queue:update",
      tag: WS_METHODS.queueUpdateMessage,
    }),
    cancelQueuedMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:queue:cancel",
      tag: WS_METHODS.queueCancelMessage,
    }),
    queuedMessagesProjection: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:queue:projection",
      tag: WS_METHODS.subscribeQueuedMessages,
      transform: (stream) =>
        stream.pipe(Stream.mapAccum(Option.none<QueuedMessagesProjection>, projectQueuedMessages)),
    }),
  };
}
