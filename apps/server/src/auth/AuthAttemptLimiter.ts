/**
 * AuthAttemptLimiter — per-client-address limits on the unauthenticated
 * sign-in endpoints of an environment that may face the internet.
 *
 * Credentials are not guessable, so these limits exist to keep one client from
 * degrading sign-in for everyone else: repeated failed sign-ins lock that
 * address out for a while, and passkey challenge requests are capped so a
 * flood cannot crowd out real ones. Successful requests from a well-behaved
 * client never count toward the lockout, so reconnect storms are unaffected.
 *
 * Addresses come from `deriveAuthClientMetadata`, which reads
 * `X-Forwarded-For` only from configured trusted proxies. Behind an untrusted
 * proxy every client shares the proxy's address and therefore one budget.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class AuthAttemptsExceededError extends Schema.TaggedError<AuthAttemptsExceededError>()(
  "AuthAttemptsExceededError",
  { retryAfterSeconds: Schema.Number },
) {
  override get message(): string {
    return `Too many sign-in attempts from this address. Try again in ${this.retryAfterSeconds} seconds.`;
  }
}

export interface WindowPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

/** Failed sign-ins allowed per address before it is locked out for the rest of the window. */
export const FAILED_SIGN_IN_POLICY: WindowPolicy = { limit: 20, windowMs: 10 * 60 * 1000 };
/** Passkey challenges an address may request per window. */
export const CHALLENGE_REQUEST_POLICY: WindowPolicy = { limit: 30, windowMs: 60 * 1000 };
const MAX_TRACKED_ADDRESSES = 10_000;

interface WindowCount {
  count: number;
  readonly startedAtMs: number;
}

/**
 * Fixed-window counter keyed by address. Pure apart from its own map, so the
 * policy can be tested without a clock.
 */
export function makeWindowCounter(policy: WindowPolicy) {
  const windows = new Map<string, WindowCount>();

  const current = (key: string, nowMs: number): WindowCount | undefined => {
    const window = windows.get(key);
    if (window && nowMs - window.startedAtMs >= policy.windowMs) {
      windows.delete(key);
      return undefined;
    }
    return window;
  };

  const retryAfterSeconds = (window: WindowCount, nowMs: number) =>
    Math.max(1, Math.ceil((window.startedAtMs + policy.windowMs - nowMs) / 1000));

  return {
    /** Seconds this address must wait, or null when it is under the limit. */
    blockedFor(key: string, nowMs: number): number | null {
      const window = current(key, nowMs);
      return window && window.count >= policy.limit ? retryAfterSeconds(window, nowMs) : null;
    },
    record(key: string, nowMs: number): void {
      const window = current(key, nowMs);
      if (window) {
        window.count += 1;
        return;
      }
      if (windows.size >= MAX_TRACKED_ADDRESSES) {
        for (const [entryKey, entry] of windows) {
          if (nowMs - entry.startedAtMs >= policy.windowMs) windows.delete(entryKey);
        }
        // Still full: forget the oldest windows rather than grow without bound.
        while (windows.size >= MAX_TRACKED_ADDRESSES) {
          const oldest = windows.keys().next().value;
          if (oldest === undefined) break;
          windows.delete(oldest);
        }
      }
      windows.set(key, { count: 1, startedAtMs: nowMs });
    },
  };
}

const addressKey = (address: string | undefined) => address ?? "unknown";

export class AuthAttemptLimiter extends Context.Service<
  AuthAttemptLimiter,
  {
    /** Fails while the address is locked out after repeated failed sign-ins. */
    readonly checkSignIn: (
      address: string | undefined,
    ) => Effect.Effect<void, AuthAttemptsExceededError>;
    readonly recordFailedSignIn: (address: string | undefined) => Effect.Effect<void>;
    /** Counts a passkey challenge request, failing once the address is over its budget. */
    readonly takeChallenge: (
      address: string | undefined,
    ) => Effect.Effect<void, AuthAttemptsExceededError>;
  }
>()("t3/auth/AuthAttemptLimiter") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.sync(() => {
  const failures = makeWindowCounter(FAILED_SIGN_IN_POLICY);
  const challenges = makeWindowCounter(CHALLENGE_REQUEST_POLICY);

  const failIfBlocked = (blockedFor: number | null) =>
    blockedFor === null
      ? Effect.void
      : Effect.fail(new AuthAttemptsExceededError({ retryAfterSeconds: blockedFor }));

  return AuthAttemptLimiter.of({
    checkSignIn: (address) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) => failIfBlocked(failures.blockedFor(addressKey(address), nowMs))),
      ),
    recordFailedSignIn: (address) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((nowMs) => failures.record(addressKey(address), nowMs)),
      ),
    takeChallenge: (address) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) => {
          const key = addressKey(address);
          const blockedFor = challenges.blockedFor(key, nowMs);
          if (blockedFor === null) challenges.record(key, nowMs);
          return failIfBlocked(blockedFor);
        }),
      ),
  });
});

export const layer = Layer.effect(AuthAttemptLimiter, make);
