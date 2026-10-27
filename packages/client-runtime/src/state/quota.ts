import {
  WS_METHODS,
  type QueuedMessage,
  type QueuedMessageStreamEvent,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { providersWithLimits } from "@t3tools/shared/usageLimits";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { SnoozeUsageResets } from "./threadSettled.ts";

/**
 * Fork state behind the usage meters, queued messages and reset snoozes. Live
 * limits ride on `ServerProvider.usageLimits`; this module adds the history
 * read, the queued-message RPCs, and helpers over those limits.
 */

const ACCOUNT_WIDE_LABELS = new Set(["session", "weekly", "monthly", "primary", "secondary"]);
const ACCOUNT_WIDE_IDS = new Set(["five_hour", "seven_day", "primary", "secondary"]);

/**
 * The model a window is scoped to, or null for an account-wide window. Claude
 * scoped weeklies extend the base id (`seven_day_<model>`) and put the model
 * after the kind in the label; everything labelled with its kind alone is
 * account-wide.
 */
export function windowScopeName(window: ServerProviderUsageWindow): string | null {
  if (ACCOUNT_WIDE_IDS.has(window.id) || ACCOUNT_WIDE_LABELS.has(window.label.toLowerCase())) {
    return null;
  }
  const separator = window.label.lastIndexOf(" · ");
  return separator === -1 ? window.label : window.label.slice(separator + 3);
}

/**
 * When the account behind one provider instance next resets its account-wide
 * session and weekly windows. Instances signed in to the same login share
 * limits, so the freshest snapshot among them wins.
 */
export function usageResetsForInstance(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string | null | undefined,
): SnoozeUsageResets {
  const withLimits = providersWithLimits(providers);
  const target = withLimits.find((provider) => provider.instanceId === instanceId);
  if (target === undefined) return {};
  const email = target.auth.email?.trim().toLowerCase();
  const limits = withLimits
    .filter(
      (provider) =>
        provider === target ||
        (email !== undefined &&
          email !== "" &&
          provider.driver === target.driver &&
          provider.auth.email?.trim().toLowerCase() === email),
    )
    .flatMap((provider) => (provider.usageLimits === undefined ? [] : [provider.usageLimits]))
    .reduce((freshest, candidate) =>
      Date.parse(candidate.checkedAt) > Date.parse(freshest.checkedAt) ? candidate : freshest,
    );
  const resetOf = (kind: ServerProviderUsageWindow["kind"]) =>
    limits.windows.find((window) => window.kind === kind && windowScopeName(window) === null)
      ?.resetsAt;
  return { session: resetOf("session"), weekly: resetOf("weekly") };
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
