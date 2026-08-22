/**
 * UsageBroadcaster — polls account-level usage for every configured Claude
 * login and broadcasts provider-generic snapshots to subscribers.
 *
 * Accounts are keyed by the resolved Claude home directory: multiple
 * provider instances that share one login (one `~/.claude`) share one
 * account and one poll loop. The poll cadence honors per-account backoff
 * (exponential, capped) for genuine failures, while a 429 — an ordinary
 * condition on an endpoint whose budget is shared with every other client
 * signed in as this account — retries at a flat floor instead. The last good
 * snapshot is retained through failures.
 *
 * Samples from every successful poll land in `fork_usage_samples` (SQLite) to
 * feed the expanded history chart, and the whole snapshot in
 * `fork_usage_snapshots` so a restart shows the last known meters instead of an
 * empty bar.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AccountUsageError,
  AccountUsageSnapshot,
  type AccountUsageStatus,
  type AccountUsageStreamEvent,
  type AccountUsageUnavailableReason,
  type ProviderInstanceId,
  type UsageHistoryInput,
  type UsageHistoryResult,
  type UsageWindow,
} from "@t3tools/contracts";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ClaudeUsageFetchFailed,
  fetchClaudePlanLabel,
  fetchClaudeUsage,
  isTokenExpiring,
  parseClaudeUsageResponse,
  readClaudeCredentials,
  refreshClaudeCredentials,
  type ClaudeOAuthCredentials,
} from "./ClaudeUsageApi.ts";

const POLL_INTERVAL = Duration.minutes(2);
/** Scheduler tick — each account keeps its own due time. */
const TICK_INTERVAL = Duration.seconds(30);
const BACKOFF_BASE = Duration.minutes(2);
const BACKOFF_MAX = Duration.minutes(30);
/** Flat retry delay on HTTP 429; the endpoint's own Retry-After is always 0. */
const RATE_LIMIT_FLOOR = Duration.minutes(5);
const MAX_PLAN_FETCH_ATTEMPTS = 5;
const HISTORY_RETENTION_DAYS = 90;

interface AccountPollState {
  credentials: ClaudeOAuthCredentials | null;
  planLabel: string | null;
  planFetchAttempts: number;
  consecutiveErrors: number;
  nextPollAtMs: number;
  lastSnapshotFingerprint: string | null;
  unavailableReason: AccountUsageUnavailableReason | null;
  unavailableDetail: string | null;
}

interface ClaudeAccount {
  readonly accountKey: string;
  readonly homePath: string;
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
}

export class UsageBroadcaster extends Context.Service<
  UsageBroadcaster,
  {
    /** Current snapshots for every account with data. */
    readonly getSnapshots: Effect.Effect<ReadonlyArray<AccountUsageSnapshot>>;
    /** Every known account, including ones still awaiting a first snapshot. */
    readonly getAccountStates: Effect.Effect<ReadonlyArray<AccountUsageStatus>>;
    /** Snapshot burst followed by live change events. */
    readonly streamUsage: Stream.Stream<AccountUsageStreamEvent, AccountUsageError>;
    readonly getHistory: (
      input: UsageHistoryInput,
    ) => Effect.Effect<UsageHistoryResult, AccountUsageError>;
    /** Ask the poller to re-poll everything as soon as possible. */
    readonly pollSoon: Effect.Effect<void>;
  }
>()("t3/quota/UsageBroadcaster") {}

const toUsageError = (message: string) => (cause: unknown) =>
  new AccountUsageError({ message, cause });

const SnapshotJson = Schema.fromJsonString(AccountUsageSnapshot);
export const encodeSnapshot = Schema.encodeSync(SnapshotJson);
const decodeSnapshotExit = Schema.decodeUnknownExit(SnapshotJson);

/**
 * Windows from a persisted snapshot that still describe the present.
 *
 * A window whose reset time has passed says nothing about now — it dropped back
 * to near zero at some moment we were not around to observe — so restoring it
 * would put a confidently wrong number on screen. Windows the provider reported
 * without a reset time are kept: they are all we know, and the UI marks a
 * restored snapshot stale as soon as the first poll fails.
 */
export const restorableWindows = (
  windows: ReadonlyArray<UsageWindow>,
  nowMs: number,
): ReadonlyArray<UsageWindow> =>
  windows.filter((window) => {
    if (window.resetsAt === null) return true;
    return Option.match(DateTime.make(window.resetsAt), {
      onNone: () => false,
      onSome: (resetsAt) => DateTime.toEpochMillis(resetsAt) > nowMs,
    });
  });

/**
 * Decode one persisted row into a snapshot worth showing, or null when there is
 * nothing left worth showing. A row that fails to decode is dropped rather than
 * raised: it is a display convenience written by an older build, and refusing to
 * start the poller over it would trade a cosmetic problem for a real one.
 */
export const restoredSnapshot = (
  snapshotJson: string,
  nowMs: number,
): AccountUsageSnapshot | null => {
  const decoded = decodeSnapshotExit(snapshotJson);
  if (Exit.isFailure(decoded)) return null;
  const windows = restorableWindows(decoded.value.windows, nowMs);
  // Every window has since reset, so there is nothing true left to show.
  if (windows.length === 0) return null;
  return { ...decoded.value, windows };
};

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;

  const eventsPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<AccountUsageStreamEvent>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const snapshotsRef = yield* Ref.make(new Map<string, AccountUsageSnapshot>());
  const pollStatesRef = yield* Ref.make(new Map<string, AccountPollState>());
  const pollSoonRef = yield* Ref.make(false);
  /** Account keys discovered by the tick loop; see `getAccountStates`. */
  const knownAccountKeysRef = yield* Ref.make<ReadonlyArray<string>>([]);

  /**
   * Enumerate distinct Claude accounts from settings — the legacy
   * single-instance config plus every `providerInstances` entry whose
   * driver is claudeAgent. Instances sharing a resolved home share an
   * account.
   */
  const listClaudeAccounts = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) {
      return [] as ReadonlyArray<ClaudeAccount>;
    }
    const candidates: Array<{ instanceId: string; homePath: string }> = [];
    const legacy = settings.providers.claudeAgent;
    if (legacy.enabled !== false) {
      candidates.push({ instanceId: "claudeAgent", homePath: legacy.homePath });
    }
    for (const [instanceId, envelope] of Object.entries(settings.providerInstances)) {
      if (envelope.driver !== "claudeAgent") continue;
      const config =
        typeof envelope.config === "object" && envelope.config !== null
          ? (envelope.config as { homePath?: unknown })
          : {};
      candidates.push({
        instanceId,
        homePath: typeof config.homePath === "string" ? config.homePath : "",
      });
    }

    const byHome = new Map<string, Array<ProviderInstanceId>>();
    for (const candidate of candidates) {
      const resolved = yield* resolveClaudeHomePath({ homePath: candidate.homePath });
      const existing = byHome.get(resolved);
      const instanceId = candidate.instanceId as ProviderInstanceId;
      if (existing) {
        if (!existing.includes(instanceId)) existing.push(instanceId);
      } else {
        byHome.set(resolved, [instanceId]);
      }
    }

    return Array.from(byHome.entries()).map(
      ([homePath, instanceIds]): ClaudeAccount => ({
        accountKey: homePath,
        homePath,
        instanceIds,
      }),
    );
  });

  const getPollState = (accountKey: string) =>
    Ref.modify(pollStatesRef, (states) => {
      const existing = states.get(accountKey);
      if (existing) return [existing, states] as const;
      const created: AccountPollState = {
        credentials: null,
        planLabel: null,
        planFetchAttempts: 0,
        consecutiveErrors: 0,
        nextPollAtMs: 0,
        lastSnapshotFingerprint: null,
        unavailableReason: null,
        unavailableDetail: null,
      };
      const next = new Map(states);
      next.set(accountKey, created);
      return [created, next] as const;
    });

  const setPollState = (accountKey: string, update: Partial<AccountPollState>) =>
    Ref.update(pollStatesRef, (states) => {
      const existing = states.get(accountKey);
      if (!existing) return states;
      const next = new Map(states);
      next.set(accountKey, { ...existing, ...update });
      return next;
    });

  const persistSamples = Effect.fn("UsageBroadcaster.persistSamples")(function* (
    snapshot: AccountUsageSnapshot,
  ) {
    for (const window of snapshot.windows) {
      yield* sql`
        INSERT OR REPLACE INTO fork_usage_samples (account_key, window_id, captured_at, percent, resets_at)
        VALUES (${snapshot.accountKey}, ${window.id}, ${snapshot.capturedAt}, ${window.percent}, ${window.resetsAt})
      `;
    }
    const now = yield* DateTime.now;
    const retentionCutoff = DateTime.formatIso(
      DateTime.add(now, { days: -HISTORY_RETENTION_DAYS }),
    );
    yield* sql`DELETE FROM fork_usage_samples WHERE captured_at < ${retentionCutoff}`;
  });

  /**
   * Keep the last good snapshot on disk so a restart doesn't blank the meters.
   * Samples alone cannot rebuild one — they carry a percentage and nothing of
   * the severity, scope or billing kind the bars are drawn from.
   */
  const persistSnapshot = Effect.fn("UsageBroadcaster.persistSnapshot")(function* (
    snapshot: AccountUsageSnapshot,
  ) {
    yield* sql`
      INSERT OR REPLACE INTO fork_usage_snapshots (account_key, captured_at, snapshot_json)
      VALUES (${snapshot.accountKey}, ${snapshot.capturedAt}, ${encodeSnapshot(snapshot)})
    `;
  });

  /**
   * Seed in-memory state from the persisted snapshots. Runs before the poll
   * loop starts so a poll that succeeds immediately always wins over the
   * restored value rather than racing it.
   */
  const restoreSnapshots = Effect.fn("UsageBroadcaster.restoreSnapshots")(function* () {
    const rows = yield* sql<{ readonly snapshot_json: string }>`
      SELECT snapshot_json FROM fork_usage_snapshots
    `;
    const nowMs = yield* Clock.currentTimeMillis;
    const restored = new Map<string, AccountUsageSnapshot>();
    for (const row of rows) {
      const snapshot = restoredSnapshot(row.snapshot_json, nowMs);
      if (snapshot === null) continue;
      restored.set(snapshot.accountKey, snapshot);
    }
    if (restored.size === 0) return;
    yield* Ref.set(snapshotsRef, restored);
    // The tick loop refreshes this within a moment, but seeding it here means a
    // client connecting first still learns the account exists.
    yield* Ref.set(knownAccountKeysRef, Array.from(restored.keys()));
    yield* Effect.logDebug("Restored persisted usage snapshots", { accounts: restored.size });
  });

  const publishSnapshot = Effect.fn("UsageBroadcaster.publishSnapshot")(function* (
    snapshot: AccountUsageSnapshot,
  ) {
    // Change detection only — a stable hand-rolled key beats a JSON codec
    // here because capturedAt must NOT participate (it changes every poll).
    const fingerprint = [
      snapshot.planLabel ?? "",
      ...snapshot.windows.map(
        (window) =>
          `${window.id}|${window.percent}|${window.severity}|${window.resetsAt ?? ""}|${window.isActive}|${window.dollars?.used ?? ""}`,
      ),
    ].join(";");
    const state = yield* getPollState(snapshot.accountKey);
    yield* Ref.update(snapshotsRef, (snapshots) => {
      const next = new Map(snapshots);
      next.set(snapshot.accountKey, snapshot);
      return next;
    });
    if (state.lastSnapshotFingerprint !== fingerprint || state.unavailableReason !== null) {
      yield* setPollState(snapshot.accountKey, {
        lastSnapshotFingerprint: fingerprint,
        unavailableReason: null,
        unavailableDetail: null,
      });
      yield* PubSub.publish(eventsPubSub, { _tag: "accountUpdated", snapshot });
    }
  });

  const publishUnavailable = Effect.fn("UsageBroadcaster.publishUnavailable")(function* (
    accountKey: string,
    reason: AccountUsageUnavailableReason,
    detail: string | null,
  ) {
    const state = yield* getPollState(accountKey);
    if (state.unavailableReason === reason) {
      return;
    }
    yield* setPollState(accountKey, { unavailableReason: reason, unavailableDetail: detail });
    yield* PubSub.publish(eventsPubSub, {
      _tag: "accountUnavailable",
      accountKey,
      reason,
      detail,
    });
  });

  /**
   * Every account we know about, including ones that have never produced a
   * snapshot. Subscribers need these so a still-polling or rate-limited
   * account renders as a placeholder rather than disappearing.
   */
  const getAccountStates: UsageBroadcaster["Service"]["getAccountStates"] = Effect.gen(
    function* () {
      // Reads only refs — resolving the account list needs `Path`, which the
      // service interface deliberately doesn't require, so the tick loop
      // keeps `knownAccountKeysRef` current instead.
      const accountKeys = yield* Ref.get(knownAccountKeysRef);
      const snapshots = yield* Ref.get(snapshotsRef);
      const states = yield* Ref.get(pollStatesRef);
      return accountKeys.map((accountKey): AccountUsageStatus => {
        const state = states.get(accountKey);
        return {
          accountKey,
          snapshot: snapshots.get(accountKey) ?? null,
          unavailableReason: state?.unavailableReason ?? null,
          unavailableDetail: state?.unavailableDetail ?? null,
        };
      });
    },
  );

  const ensureCredentials = Effect.fn("UsageBroadcaster.ensureCredentials")(function* (
    account: ClaudeAccount,
  ) {
    const loaded = yield* readClaudeCredentials(account.homePath);
    const nowMs = yield* Clock.currentTimeMillis;
    if (!isTokenExpiring(loaded.credentials, nowMs)) {
      return loaded.credentials;
    }
    return yield* refreshClaudeCredentials(loaded);
  });

  const pollAccount = Effect.fn("UsageBroadcaster.pollAccount")(function* (account: ClaudeAccount) {
    const state = yield* getPollState(account.accountKey);
    const outcome = yield* Effect.gen(function* () {
      const credentials = yield* ensureCredentials(account);
      yield* setPollState(account.accountKey, { credentials });

      if (state.planLabel === null && state.planFetchAttempts < MAX_PLAN_FETCH_ATTEMPTS) {
        const planLabel = yield* fetchClaudePlanLabel(credentials.accessToken).pipe(
          Effect.orElseSucceed(() => null),
        );
        yield* setPollState(account.accountKey, {
          planLabel,
          planFetchAttempts: state.planFetchAttempts + 1,
        });
      }

      const body = yield* fetchClaudeUsage(credentials.accessToken);
      const capturedAt = DateTime.formatIso(yield* DateTime.now);
      const parsed = parseClaudeUsageResponse(body, capturedAt);
      if (parsed.degraded) {
        // The API reported limits but none survived the parse — keep the
        // last good snapshot rather than publishing an empty one.
        return yield* Effect.fail(
          new ClaudeUsageFetchFailed("Degraded usage payload (no parseable windows)"),
        );
      }
      const stateAfterPlan = yield* getPollState(account.accountKey);
      const snapshot: AccountUsageSnapshot = {
        accountKey: account.accountKey,
        instanceIds: account.instanceIds,
        planLabel: stateAfterPlan.planLabel,
        capturedAt,
        windows: parsed.windows,
      };
      yield* Effect.andThen(persistSamples(snapshot), persistSnapshot(snapshot)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to persist usage", { detail: String(cause) }),
        ),
      );
      yield* publishSnapshot(snapshot);
      return snapshot;
    }).pipe(Effect.exit);

    if (Exit.isSuccess(outcome)) {
      const successMs = yield* Clock.currentTimeMillis;
      yield* setPollState(account.accountKey, {
        consecutiveErrors: 0,
        nextPollAtMs: successMs + Duration.toMillis(POLL_INTERVAL),
      });
      return;
    }

    const failReason = outcome.cause.reasons.find(Cause.isFailReason);
    const failure = failReason?.error as
      | { _tag?: string; retryAfterSeconds?: number | null; message?: string }
      | undefined;
    const tag = failure?._tag;
    const rateLimited = tag === "ClaudeUsageRateLimited";
    // A 429 says the account's shared budget for this endpoint is momentarily
    // spent — it is not evidence that anything here is unhealthy, so it must not
    // feed the exponential ladder. Counting it did: hours of ordinary rate
    // limiting pushed the retry out to BACKOFF_MAX, and at one attempt every 30
    // minutes the poller essentially stopped asking, staying dark long after the
    // budget had room again.
    const consecutiveErrors = rateLimited ? state.consecutiveErrors : state.consecutiveErrors + 1;
    const backoffMs = Math.min(
      Duration.toMillis(BACKOFF_BASE) * Math.pow(2, Math.min(consecutiveErrors, 6)),
      Duration.toMillis(BACKOFF_MAX),
    );
    let delayMs = backoffMs;
    let reason: AccountUsageUnavailableReason = "fetch-failed";
    if (tag === "ClaudeCredentialsUnavailable") {
      reason = "no-credentials";
    } else if (tag === "ClaudeTokenRejected") {
      reason = "token-rejected";
    } else if (rateLimited) {
      reason = "rate-limited";
      // The endpoint answers `Retry-After: 0`, which is no guidance at all, so
      // the floor is what actually governs the cadence.
      const retryAfterMs = (failure?.retryAfterSeconds ?? 0) * 1000;
      delayMs = Math.max(retryAfterMs, Duration.toMillis(RATE_LIMIT_FLOOR));
    }
    const failureMs = yield* Clock.currentTimeMillis;
    yield* setPollState(account.accountKey, {
      consecutiveErrors,
      nextPollAtMs: failureMs + delayMs,
    });
    yield* publishUnavailable(account.accountKey, reason, failure?.message ?? null);
    yield* Effect.logDebug("Claude usage poll failed", {
      accountKey: account.accountKey,
      reason,
      consecutiveErrors,
      nextDelayMs: delayMs,
    });
  });

  const tick = Effect.gen(function* () {
    const accounts = yield* listClaudeAccounts;
    yield* Ref.set(
      knownAccountKeysRef,
      accounts.map((account) => account.accountKey),
    );
    const pollAll = yield* Ref.getAndSet(pollSoonRef, false);
    const nowMs = yield* Clock.currentTimeMillis;
    for (const account of accounts) {
      const state = yield* getPollState(account.accountKey);
      if (pollAll || state.nextPollAtMs <= nowMs) {
        // Advance the due time before polling so a slow poll doesn't stack.
        yield* setPollState(account.accountKey, {
          nextPollAtMs: nowMs + Duration.toMillis(POLL_INTERVAL),
        });
        yield* pollAccount(account);
      }
    }
  });

  yield* restoreSnapshots().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to restore persisted usage snapshots", { detail: String(cause) }),
    ),
  );

  yield* tick.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Usage poll tick failed", { detail: String(cause) }),
    ),
    Effect.flatMap(() => Effect.sleep(TICK_INTERVAL)),
    Effect.forever,
    Effect.forkIn(broadcasterScope),
  );

  const getSnapshots = Ref.get(snapshotsRef).pipe(
    Effect.map((snapshots) => Array.from(snapshots.values())),
  );

  const streamUsage: UsageBroadcaster["Service"]["streamUsage"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(eventsPubSub);
      const accounts = yield* getAccountStates;
      return Stream.concat(
        Stream.make({ _tag: "snapshot" as const, accounts }),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  const getHistory: UsageBroadcaster["Service"]["getHistory"] = Effect.fn(
    "UsageBroadcaster.getHistory",
  )(function* (input) {
    const since = input.since ?? "1970-01-01T00:00:00.000Z";
    const rows = yield* sql`
      SELECT captured_at AS "capturedAt", percent, resets_at AS "resetsAt"
      FROM fork_usage_samples
      WHERE account_key = ${input.accountKey}
        AND window_id = ${input.windowId}
        AND captured_at >= ${since}
      ORDER BY captured_at ASC
    `.pipe(Effect.mapError(toUsageError("Failed to load usage history")));
    return {
      samples: rows.map((row) => ({
        capturedAt: String(row.capturedAt),
        percent: Number(row.percent),
        resetsAt: row.resetsAt === null ? null : String(row.resetsAt),
      })),
    };
  });

  const pollSoon = Ref.set(pollSoonRef, true);

  return UsageBroadcaster.of({
    getSnapshots,
    getAccountStates,
    streamUsage,
    getHistory,
    pollSoon,
  });
});

export const layer = Layer.effect(UsageBroadcaster, make);
