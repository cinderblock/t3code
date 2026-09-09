import {
  type ServerConfig,
  type ServerConfigStreamEvent,
  WsSubscribeServerConfigRpc,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
  withoutEnvironmentThemes,
} from "../state/serverConfigProjection.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly subscribeServerConfig: (
    input: ServerConfigSubscriptionInput,
  ) => ServerConfigSubscription;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
}

export interface RpcSessionOptions {
  readonly environmentThemes?: boolean;
  readonly usageLimitSources?: boolean;
  /** This client answers /usage-limits itself, so the server may advertise it. */
  readonly usageLimitsCommand?: boolean;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@t3tools/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;
type ProbeError = Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverProbe]>>;
type ServerConfigSubscriptionError =
  | Rpc.ErrorExit<typeof WsSubscribeServerConfigRpc>
  | RpcClientError.RpcClientError;
type ServerConfigSubscription = Stream.Stream<
  ServerConfigStreamEvent,
  ServerConfigSubscriptionError
>;
type ServerConfigSubscriptionInput = Parameters<
  WsRpcProtocolClient[typeof WS_METHODS.subscribeServerConfig]
>[0];
type EnvironmentThemesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "environmentThemesUpdated" }
>;
type UsageLimitSourcesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "usageLimitSourcesUpdated" }
>;

interface ServerConfigReplayState {
  readonly projection: ServerConfigProjection;
  readonly revision: number;
  readonly themesEvent: EnvironmentThemesUpdatedEvent | undefined;
  readonly sourcesEvent: UsageLimitSourcesUpdatedEvent | undefined;
}

interface BufferedServerConfigEvent {
  readonly event: ServerConfigStreamEvent;
  readonly replay: ServerConfigReplayState;
  readonly revision: number;
}

function serverConfigReplayEvents(
  state: ServerConfigReplayState,
): ReadonlyArray<ServerConfigStreamEvent> {
  const snapshot = {
    version: 1 as const,
    type: "snapshot" as const,
    config: withoutEnvironmentThemes(state.projection.config),
  };
  return [
    snapshot,
    ...(state.themesEvent === undefined ? [] : [state.themesEvent]),
    ...(state.sourcesEvent === undefined ? [] : [state.sourcesEvent]),
  ];
}

const isSocketErrorReason = Schema.is(Socket.SocketErrorReason);

function mapSessionRpcError(
  error: InitialConfigError | ProbeError | ServerConfigSubscriptionError,
  networkHint: string,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: `${error.message}${isSocketErrorReason(error.reason) ? networkHint : ""}`,
      });
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("RpcSessionFactory.make")(function* (
  options: RpcSessionOptions = {},
) {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const serverConfigInput: ServerConfigSubscriptionInput = {
    ...(options.environmentThemes === true ? { environmentThemes: true } : {}),
    ...(options.usageLimitSources === true ? { usageLimitSources: true } : {}),
    ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
  };

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    const networkHint =
      connection.target._tag === "RelayConnectionTarget" ? ` ${NETWORK_BLOCKING_HINT}` : "";
    const mapRpcError = (error: Parameters<typeof mapSessionRpcError>[0]) =>
      mapSessionRpcError(error, networkHint);
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();

    // Capture the WebSocket close code.
    //
    // `onDisconnect` reports only that the socket closed, which is not enough
    // to act on: measured runs show repeated `reason: "transport"` drops after
    // a healthy connect, with zero probe timeouts, so the socket is being
    // closed by something rather than starved. The close code says who and why
    // -- 1006 means it died with no close frame (process death, network), 1001
    // going away, 1011 a server error, 1013 try-again-later. Without it the
    // next step is guesswork.
    let closeInfo: string | undefined;
    const observingWebSocketConstructor = ((url: string, protocols?: string | Array<string>) => {
      const socket = webSocketConstructor(url, protocols);
      try {
        (socket as unknown as EventTarget).addEventListener?.("close", (event: Event) => {
          const closed = event as CloseEvent;
          closeInfo = `code=${closed.code} clean=${closed.wasClean}${
            closed.reason ? ` reason=${closed.reason}` : ""
          }`;
          // Emit here rather than relying on `closeInfo` being set by the time
          // `onDisconnect` builds its error. It is not: Effect's socket fiber
          // observes the end before the browser dispatches this event, so the
          // first attempt at this reported "[no close event observed]" every
          // time. Emitting from the listener removes the ordering dependency.
          try {
            (
              globalThis as {
                __t3CrashLog?: { send?: (payload: unknown) => void };
              }
            ).__t3CrashLog?.send?.({
              level: "warn",
              source: "connection-socket",
              message: `socket close: ${connection.label}`,
              data: {
                event: "socket-close",
                target: connection.label,
                code: closed.code,
                wasClean: closed.wasClean,
                reason: closed.reason || undefined,
                msSinceLoad: typeof performance !== "undefined" ? Math.round(performance.now()) : 0,
              },
            });
          } catch {
            // A diagnostic must never affect the socket lifecycle.
          }
        });
      } catch {
        // Observation must never prevent the socket from being created.
      }
      return socket;
    }) as typeof webSocketConstructor;

    // Ping/pong watchdog observation.
    //
    // `makeProtocolSocket` runs a watchdog: it writes a Ping every 5s and, if no
    // Pong arrived since the previous one, fails the read loop with
    // `SocketError("ping timeout")`. With `retryPolicy: Schedule.recurs(0)`
    // below, one missed Pong is fatal, and the socket teardown then reports a
    // hard-coded `close(1000)` -- so this shows up as a clean, deliberate-looking
    // close roughly 10s after connect.
    //
    // Measured connection lifetimes are 86% inside 10.0-11.0s (median 10495ms),
    // which is a timer firing rather than load: a contended machine produces
    // scatter. But that is inference from timing. These hooks measure the thing
    // itself -- how long the server actually takes to answer a Ping.
    //
    // The point of `pongLatencyMs` is to locate the fix. The server answers Ping
    // inside its per-client RPC message loop, and backend bootstrap work is
    // async subprocess wait -- in-flight, not blocking -- so a Pong can sit
    // behind slow handlers for seconds while the event loop looks perfectly
    // healthy. That is exactly why the event-loop lag monitor and the CPU
    // profiler never saw this: neither can.
    let pingSentAtMs: number | undefined;
    let pingSeq = 0;
    const monotonicMs = () => (typeof performance !== "undefined" ? performance.now() : 0);
    const emitPingDiagnostic = (data: Record<string, unknown>) => {
      try {
        (
          globalThis as { __t3CrashLog?: { send?: (payload: unknown) => void } }
        ).__t3CrashLog?.send?.({
          level: "warn",
          source: "connection-ping",
          message: `${String(data["event"])}: ${connection.label}`,
          data: { ...data, target: connection.label, msSinceLoad: Math.round(monotonicMs()) },
        });
      } catch {
        // A diagnostic must never affect the connection it observes.
      }
    };

    const hooks = RpcClient.ConnectionHooks.of({
      onPing: Effect.sync(() => {
        pingSeq += 1;
        pingSentAtMs = monotonicMs();
      }),
      onPong: Effect.sync(() => {
        if (pingSentAtMs === undefined) return;
        const latency = Math.round(monotonicMs() - pingSentAtMs);
        // The first pong of a connection establishes a baseline; without it a
        // silent log could mean either "always fast" or "hook never fired".
        // After that only report the slow ones, so a healthy session stays quiet.
        if (pingSeq === 1 || latency >= 500) {
          emitPingDiagnostic({ event: "pong", pingSeq, pongLatencyMs: latency });
        }
      }),
      onPingTimeout: Effect.sync(() => {
        emitPingDiagnostic({
          event: "ping-timeout",
          pingSeq,
          // No pong arrived for this ping; this is how long it had been waiting
          // when the watchdog gave up and killed a socket that is very likely
          // still open.
          waitedMs: pingSentAtMs === undefined ? null : Math.round(monotonicMs() - pingSentAtMs),
        });
      }),
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) =>
          Deferred.fail(
            disconnected,
            new ConnectionTransientErrorClass({
              reason: "transport",
              detail: `${
                wasConnected
                  ? `${connection.label} disconnected.`
                  : `${connection.label} could not establish a WebSocket connection.`
              }${closeInfo ? ` [${closeInfo}]` : " [no close event observed]"}${networkHint}`,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    });
    const socketLayer = Socket.layerWebSocket(connection.socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(
      Layer.provide(Layer.succeed(Socket.WebSocketConstructor, observingWebSocketConstructor)),
    );
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const protocolClient = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfigDeferred = yield* Deferred.make<ServerConfig>();
    const serverConfigExit = yield* Deferred.make<void, ServerConfigSubscriptionError>();
    const configSubscriptionClosed = yield* Deferred.make<never, ConnectionAttemptError>();
    const serverConfigState = yield* Ref.make(Option.none<ServerConfigReplayState>());
    const serverConfigUpdates = yield* PubSub.sliding<BufferedServerConfigEvent>(64);
    const configSubscriptionEndedError = new ConnectionTransientErrorClass({
      reason: "remote-unavailable",
      detail: `${connection.label} config subscription ended.`,
    });
    const serverConfigSource = protocolClient[WS_METHODS.subscribeServerConfig](
      serverConfigInput,
    ).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const buffered = yield* Ref.modify(serverConfigState, (current) => {
            const projection = applyServerConfigProjection(
              Option.map(current, (state) => state.projection),
              event,
            );
            if (Option.isNone(projection)) {
              return [Option.none<BufferedServerConfigEvent>(), current] as const;
            }
            const next = {
              projection: projection.value,
              revision: Option.match(current, {
                onNone: () => 1,
                onSome: (state) => state.revision + 1,
              }),
              themesEvent:
                event.type === "environmentThemesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.environmentThemes !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.themesEvent,
              sourcesEvent:
                event.type === "usageLimitSourcesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.usageLimitSources !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.sourcesEvent,
            } satisfies ServerConfigReplayState;
            return [
              Option.some({ event, replay: next, revision: next.revision }),
              Option.some(next),
            ] as const;
          });
          if (Option.isSome(buffered)) {
            yield* PubSub.publish(serverConfigUpdates, buffered.value);
          }
          if (event.type === "snapshot") {
            yield* Deferred.succeed(initialConfigDeferred, event.config);
          }
        }),
      ),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) {
          return Effect.all([
            Deferred.succeed(serverConfigExit, undefined),
            Deferred.fail(configSubscriptionClosed, configSubscriptionEndedError),
          ]).pipe(Effect.asVoid);
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.void;
        }
        return Effect.all([
          Deferred.failCause(serverConfigExit, exit.cause),
          Deferred.failCause(configSubscriptionClosed, Cause.map(exit.cause, mapRpcError)),
        ]).pipe(Effect.asVoid);
      }),
    );
    yield* serverConfigSource.pipe(Effect.forkScoped);
    const initialConfig = Effect.raceFirst(
      Deferred.await(initialConfigDeferred),
      Deferred.await(serverConfigExit).pipe(
        Effect.mapError(mapRpcError),
        Effect.flatMap(() => Effect.fail(configSubscriptionEndedError)),
      ),
    ).pipe(Effect.withSpan("environment.initialSync"));
    const serverConfigEvents = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(serverConfigUpdates);
        yield* Effect.raceFirst(
          Deferred.await(initialConfigDeferred).pipe(Effect.asVoid),
          Deferred.await(serverConfigExit),
        );
        const snapshot = yield* Ref.get(serverConfigState);
        if (Option.isNone(snapshot)) {
          return Stream.empty;
        }
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((buffered) => buffered.revision > snapshot.value.revision),
          Stream.mapAccum(
            () => snapshot.value.revision,
            (revision, buffered) => [
              buffered.revision,
              buffered.revision === revision + 1
                ? [buffered.event]
                : serverConfigReplayEvents(buffered.replay),
            ],
          ),
        );
        const terminal = Stream.fromEffect(Deferred.await(serverConfigExit)).pipe(Stream.drain);
        return Stream.concat(
          Stream.fromIterable(serverConfigReplayEvents(snapshot.value)),
          Stream.merge(updates, terminal, { haltStrategy: "either" }),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Stream.failCause(cause);
        }
        // The supervisor keeps the original cause. Shared durable consumers
        // need a transport-shaped failure so they wait for its replacement.
        return Stream.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: `${connection.label} config subscription failed.`,
              cause,
            }),
          }),
        );
      }),
    );
    const subscribeServerConfig = (input: ServerConfigSubscriptionInput) =>
      Equal.equals(input, serverConfigInput)
        ? serverConfigEvents
        : protocolClient[WS_METHODS.subscribeServerConfig](input);
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? protocolClient[WS_METHODS.serverProbe]({})
          : protocolClient[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client: protocolClient,
      initialConfig,
      subscribeServerConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Effect.raceFirst(
        Deferred.await(disconnected),
        Deferred.await(configSubscriptionClosed),
      ),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layerWithOptions = (options: RpcSessionOptions) =>
  Layer.effect(RpcSessionFactory, make(options));
