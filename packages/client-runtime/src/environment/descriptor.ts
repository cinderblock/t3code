import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;
// A busy-but-alive backend (e.g. the local status-refresh burst right after startup) can miss the
// descriptor request's deadline while the endpoint is perfectly reachable. Retry a timed-out
// request a few times before failing the connection attempt, so transient busyness surfaces as a
// brief delay rather than a disconnect/reconnect cycle. Non-timeout errors are not retried.
const DESCRIPTOR_MAX_ATTEMPTS = 3;
const DESCRIPTOR_RETRY_DELAY = "1 second";

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.metadata.descriptor(),
  ).pipe(
    Effect.retry({
      schedule: Schedule.spaced(DESCRIPTOR_RETRY_DELAY),
      times: DESCRIPTOR_MAX_ATTEMPTS - 1,
      while: (error) => error._tag === "RemoteEnvironmentAuthTimeoutError",
    }),
  );
});
