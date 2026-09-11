import { WS_METHODS, type QueuedMessage, type QueuedMessageStreamEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Fork state behind the usage meter strip and queued messages.
 *
 * Live usage limits are not here: they ride on every provider snapshot
 * (`ServerProvider.usageLimits`) that the server-config subscription already
 * delivers, so clients derive the meters from that. What this module adds is
 * the history read for the charts and the queued-message RPCs.
 */

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
