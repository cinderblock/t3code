/**
 * ClaudeUsageApi — direct client for the Claude subscription usage endpoint.
 *
 * Reuses the OAuth token Claude Code stores in `<home>/.claude/.credentials.json`
 * (the same login the SDK subprocess uses). The direct endpoint is the only
 * source that reports per-model weekly windows (Fable/Opus/Sonnet scoped
 * limits) plus severity; the Agent SDK's snapshot has a fixed key set and is
 * marked experimental.
 *
 * Parsing is deliberately lenient: a degraded backend nulls out scalars it
 * normally populates and can ship malformed `limits[]` entries. Individual
 * bad entries are dropped; an entirely-empty parse is treated as a failed
 * poll by the caller so the last good snapshot survives.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { UsageDollars, UsageScope, UsageSeverity, UsageWindow } from "@t3tools/contracts";
import { usageScopeKey } from "@t3tools/contracts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
/** Public OAuth client id of the Claude Code application. */
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const USER_AGENT = "t3code/usage-meter";
/** Refresh when the token expires within this many milliseconds. */
const TOKEN_EXPIRY_SLACK_MS = 60_000;

export interface ClaudeOAuthCredentials {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Epoch milliseconds. */
  readonly expiresAt: number | null;
}

export class ClaudeCredentialsUnavailable extends Error {
  readonly _tag = "ClaudeCredentialsUnavailable";
}
export class ClaudeTokenRejected extends Error {
  readonly _tag = "ClaudeTokenRejected";
}
export class ClaudeUsageRateLimited extends Error {
  readonly _tag = "ClaudeUsageRateLimited";
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super(`Usage endpoint rate limited (retry after ${retryAfterSeconds ?? "unknown"}s)`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
export class ClaudeUsageFetchFailed extends Error {
  readonly _tag = "ClaudeUsageFetchFailed";
}

export type ClaudeUsageApiError =
  | ClaudeCredentialsUnavailable
  | ClaudeTokenRejected
  | ClaudeUsageRateLimited
  | ClaudeUsageFetchFailed;

// effect beta.103 replaced the pre-applied `Schema.UnknownFromJsonString` with the
// general `Schema.fromJsonString(schema)` combinator.
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJsonStringExit = Schema.decodeUnknownExit(UnknownFromJsonString);
const encodeJsonString = Schema.encodeSync(UnknownFromJsonString);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

export const readClaudeCredentials = Effect.fn("readClaudeCredentials")(function* (
  homePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(homePath, ".claude", ".credentials.json");
  const raw = yield* fs
    .readFileString(filePath)
    .pipe(Effect.mapError(() => new ClaudeCredentialsUnavailable(`No credentials at ${filePath}`)));
  const parsedExit = decodeJsonStringExit(raw);
  if (Exit.isFailure(parsedExit)) {
    return yield* Effect.fail(
      new ClaudeCredentialsUnavailable(`Credentials at ${filePath} are not valid JSON`),
    );
  }
  const parsed = parsedExit.value;
  const oauth = asRecord(asRecord(parsed)?.claudeAiOauth);
  const accessToken = asString(oauth?.accessToken);
  if (oauth === null || accessToken === null || accessToken.length === 0) {
    return yield* Effect.fail(
      new ClaudeCredentialsUnavailable(`Credentials at ${filePath} carry no OAuth access token`),
    );
  }
  return {
    credentials: {
      accessToken,
      refreshToken: asString(oauth.refreshToken),
      expiresAt: asFiniteNumber(oauth.expiresAt),
    } satisfies ClaudeOAuthCredentials,
    /** Full parsed file, preserved for write-back on refresh. */
    rawFile: asRecord(parsed) ?? {},
    filePath,
  };
});

export const isTokenExpiring = (credentials: ClaudeOAuthCredentials, nowMs: number): boolean =>
  credentials.expiresAt !== null && credentials.expiresAt - nowMs < TOKEN_EXPIRY_SLACK_MS;

/**
 * Refresh the OAuth token and atomically write the rotated credentials back
 * so Claude Code (and any other reader) stays in sync.
 */
export const refreshClaudeCredentials = Effect.fn("refreshClaudeCredentials")(function* (input: {
  readonly credentials: ClaudeOAuthCredentials;
  readonly rawFile: Record<string, unknown>;
  readonly filePath: string;
}) {
  const refreshToken = input.credentials.refreshToken;
  if (refreshToken === null || refreshToken.length === 0) {
    return yield* Effect.fail(
      new ClaudeCredentialsUnavailable("Token expired and no refresh token is available"),
    );
  }
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const response = yield* httpClient
    .execute(
      HttpClientRequest.post(TOKEN_URL).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        HttpClientRequest.bodyJsonUnsafe({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLAUDE_CODE_CLIENT_ID,
        }),
      ),
    )
    .pipe(Effect.mapError((cause) => new ClaudeUsageFetchFailed(`Token refresh failed: ${cause}`)));
  if (response.status === 401 || response.status === 403) {
    return yield* Effect.fail(new ClaudeTokenRejected("Refresh token rejected"));
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(
      new ClaudeUsageFetchFailed(`Token refresh returned HTTP ${response.status}`),
    );
  }
  const body = asRecord(
    yield* response.json.pipe(
      Effect.mapError(() => new ClaudeUsageFetchFailed("Token refresh returned malformed JSON")),
    ),
  );
  const accessToken = asString(body?.access_token);
  if (body === null || accessToken === null || accessToken.length === 0) {
    return yield* Effect.fail(
      new ClaudeUsageFetchFailed("Token refresh response carried no access token"),
    );
  }
  const nowMs = yield* Clock.currentTimeMillis;
  const expiresInSeconds = asFiniteNumber(body.expires_in) ?? 8 * 3600;
  const nextCredentials: ClaudeOAuthCredentials = {
    accessToken,
    refreshToken: asString(body.refresh_token) ?? refreshToken,
    expiresAt: nowMs + expiresInSeconds * 1000,
  };

  const previousOauth = asRecord(input.rawFile.claudeAiOauth) ?? {};
  const nextFile = {
    ...input.rawFile,
    claudeAiOauth: {
      ...previousOauth,
      accessToken: nextCredentials.accessToken,
      refreshToken: nextCredentials.refreshToken,
      expiresAt: nextCredentials.expiresAt,
    },
  };
  // Atomic-ish write-back: temp file in the same directory, then rename.
  const tempPath = `${input.filePath}.t3tmp`;
  yield* fs.writeFileString(tempPath, encodeJsonString(nextFile)).pipe(
    Effect.flatMap(() => fs.rename(tempPath, input.filePath)),
    Effect.catch((cause) =>
      // Failing to persist the rotated token is survivable for this poll,
      // but the old refresh token may now be burned — log loudly.
      Effect.logWarning("Failed to write refreshed Claude credentials back", {
        filePath: input.filePath,
        detail: String(cause),
      }),
    ),
  );
  return nextCredentials;
});

const parseSeverity = (value: unknown): UsageSeverity => {
  switch (value) {
    case "warning":
      return "warning";
    case "critical":
      return "critical";
    case "exceeded":
      return "exceeded";
    default:
      return "normal";
  }
};

const parseScope = (value: unknown): UsageScope | null => {
  const scope = asRecord(value);
  if (scope === null) {
    return { kind: "all" };
  }
  const model = asRecord(scope.model);
  const displayName = asString(model?.display_name) ?? asString(model?.id);
  if (displayName === null || displayName.length === 0) {
    return { kind: "all" };
  }
  const modelId = asString(model?.id);
  return {
    kind: "model",
    ...(modelId !== null && modelId.length > 0 ? { modelId } : {}),
    displayName,
  };
};

const windowKindOf = (kind: string): { kind: UsageWindow["kind"]; hours: number } => {
  if (kind.startsWith("weekly")) return { kind: "weekly", hours: 7 * 24 };
  if (kind.startsWith("monthly")) return { kind: "monthly", hours: 30 * 24 };
  return { kind: "session", hours: 5 };
};

/**
 * First instant of the next calendar month, UTC — the spend pool anchor.
 * Takes/returns ISO strings so callers in Effect code never construct Dates.
 */
export const nextMonthStartUtc = (nowIso: string): string => {
  const year = Number(nowIso.slice(0, 4));
  const month = Number(nowIso.slice(5, 7));
  const nextYear = month >= 12 ? year + 1 : year;
  const nextMonth = month >= 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00.000Z`;
};

export interface ParsedClaudeUsage {
  readonly windows: ReadonlyArray<UsageWindow>;
  /** True when the payload had a limits[] array but no entry survived. */
  readonly degraded: boolean;
}

/**
 * Pure lenient parse of the `/api/oauth/usage` response body.
 *
 * `nowIso` is injected so tests are deterministic and the month anchor for
 * the spend pool doesn't depend on ambient clock reads mid-parse.
 */
export function parseClaudeUsageResponse(body: unknown, nowIso: string): ParsedClaudeUsage {
  const root = asRecord(body);
  const windows: Array<UsageWindow> = [];
  const rawLimits = Array.isArray(root?.limits) ? root.limits : [];
  let sawLimitEntries = rawLimits.length > 0;

  for (const rawLimit of rawLimits) {
    const limit = asRecord(rawLimit);
    const kindRaw = asString(limit?.kind);
    const percent = asFiniteNumber(limit?.percent);
    if (limit === null || kindRaw === null || percent === null) {
      continue;
    }
    const scope = parseScope(limit.scope);
    if (scope === null) {
      continue;
    }
    const { kind, hours } = windowKindOf(kindRaw);
    windows.push({
      id: `${kind}:${usageScopeKey(scope)}`,
      kind,
      scope,
      percent,
      severity: parseSeverity(limit.severity),
      resetsAt: asString(limit.resets_at),
      windowHours: hours,
      isActive: limit.is_active === true,
      billing: "subscription",
    });
  }

  // Legacy scalar fallback when the limits[] array is entirely absent.
  if (!sawLimitEntries) {
    const fiveHour = asRecord(root?.five_hour);
    const sevenDay = asRecord(root?.seven_day);
    const fiveHourUtilization = asFiniteNumber(fiveHour?.utilization);
    const sevenDayUtilization = asFiniteNumber(sevenDay?.utilization);
    if (fiveHourUtilization !== null) {
      windows.push({
        id: "session:all",
        kind: "session",
        scope: { kind: "all" },
        percent: fiveHourUtilization,
        severity: "normal",
        resetsAt: asString(fiveHour?.resets_at),
        windowHours: 5,
        isActive: false,
        billing: "subscription",
      });
      sawLimitEntries = true;
    }
    if (sevenDayUtilization !== null) {
      windows.push({
        id: "weekly:all",
        kind: "weekly",
        scope: { kind: "all" },
        percent: sevenDayUtilization,
        severity: "normal",
        resetsAt: asString(sevenDay?.resets_at),
        windowHours: 7 * 24,
        isActive: false,
        billing: "subscription",
      });
      sawLimitEntries = true;
    }
  }

  // Usage-based billing pool. Visibility derives from real dollar figures,
  // NOT `is_enabled` — the API flips is_enabled to false when the pool is
  // exhausted, which is exactly when the meter matters most.
  const extraUsage = asRecord(root?.extra_usage);
  const monthlyLimitMinor = asFiniteNumber(extraUsage?.monthly_limit);
  const usedCreditsMinor = asFiniteNumber(extraUsage?.used_credits);
  if (monthlyLimitMinor !== null && usedCreditsMinor !== null && monthlyLimitMinor > 0) {
    const decimals = asFiniteNumber(extraUsage?.decimal_places) ?? 2;
    const scale = Math.pow(10, decimals);
    const dollars: UsageDollars = {
      used: usedCreditsMinor / scale,
      limit: monthlyLimitMinor / scale,
      currency: asString(extraUsage?.currency) ?? "USD",
    };
    windows.push({
      id: "monthly:all",
      kind: "monthly",
      scope: { kind: "all" },
      // Hard dollar cap: cannot exceed 100, unlike rolling windows.
      percent: Math.min((usedCreditsMinor / monthlyLimitMinor) * 100, 100),
      severity: usedCreditsMinor >= monthlyLimitMinor ? "exceeded" : "normal",
      resetsAt: nextMonthStartUtc(nowIso),
      windowHours: 30 * 24,
      isActive: false,
      billing: "pay-per-use",
      dollars,
    });
  }

  const hasSubscriptionWindow = windows.some((window) => window.billing === "subscription");
  return {
    windows,
    degraded: sawLimitEntries === false ? false : !hasSubscriptionWindow,
  };
}

const authedGet = (url: string, accessToken: string) =>
  HttpClientRequest.get(url).pipe(
    HttpClientRequest.bearerToken(accessToken),
    HttpClientRequest.setHeader("anthropic-beta", OAUTH_BETA_HEADER),
    HttpClientRequest.setHeader("User-Agent", USER_AGENT),
  );

export const fetchClaudeUsage = Effect.fn("fetchClaudeUsage")(function* (accessToken: string) {
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient
    .execute(authedGet(USAGE_URL, accessToken))
    .pipe(Effect.mapError((cause) => new ClaudeUsageFetchFailed(`Usage fetch failed: ${cause}`)));
  if (response.status === 401 || response.status === 403) {
    return yield* Effect.fail(new ClaudeTokenRejected("Usage endpoint rejected the token"));
  }
  if (response.status === 429) {
    const retryAfterRaw = response.headers["retry-after"];
    const retryAfter =
      typeof retryAfterRaw === "string" ? Number.parseInt(retryAfterRaw, 10) : Number.NaN;
    return yield* Effect.fail(
      new ClaudeUsageRateLimited(Number.isFinite(retryAfter) ? retryAfter : null),
    );
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(
      new ClaudeUsageFetchFailed(`Usage endpoint returned HTTP ${response.status}`),
    );
  }
  return yield* response.json.pipe(
    Effect.mapError(() => new ClaudeUsageFetchFailed("Usage endpoint returned malformed JSON")),
  );
});

/** Map an org rate-limit tier slug to a short human plan label. */
export function prettifyPlanTier(tier: string): string {
  const normalized = tier.toLowerCase();
  const maxMultiplier = normalized.match(/max[_-]?(\d+)x/);
  if (maxMultiplier) return `Max ${maxMultiplier[1]}x`;
  if (normalized.includes("max")) return "Max";
  if (normalized.includes("pro")) return "Pro";
  if (normalized.includes("team")) return "Team";
  if (normalized.includes("enterprise")) return "Enterprise";
  if (normalized.includes("free")) return "Free";
  return tier;
}

export const fetchClaudePlanLabel = Effect.fn("fetchClaudePlanLabel")(function* (
  accessToken: string,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient
    .execute(authedGet(PROFILE_URL, accessToken))
    .pipe(Effect.mapError((cause) => new ClaudeUsageFetchFailed(`Profile fetch failed: ${cause}`)));
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(
      new ClaudeUsageFetchFailed(`Profile endpoint returned HTTP ${response.status}`),
    );
  }
  const body = asRecord(
    yield* response.json.pipe(
      Effect.mapError(() => new ClaudeUsageFetchFailed("Profile endpoint returned malformed JSON")),
    ),
  );
  const tier = asString(asRecord(body?.organization)?.rate_limit_tier);
  return tier === null ? null : prettifyPlanTier(tier);
});
