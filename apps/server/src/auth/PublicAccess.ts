/**
 * PublicAccess — signing in to an environment served from a public HTTPS
 * origin (usually behind a reverse proxy) with a passkey.
 *
 * The user configures the origins the environment is reachable on. A browser
 * that paired on one of those origins can enroll a passkey; later visits sign
 * in with it and receive an ordinary browser session cookie. A passkey carries
 * the scopes of the session that enrolled it, so the pairing link's scopes
 * decide what it can do. One enrolled from a session holding every standard
 * scope (a default pairing link) is a full-access passkey: it signs in with the
 * standard set current at sign-in, so permissions added later reach it
 * without re-enrolling. Revoking a passkey also revokes the sessions it
 * issued, and removing an origin disables the passkeys enrolled on it.
 *
 * Ceremony challenges live in memory: they are single-use, expire after a few
 * minutes, and are bounded so unauthenticated callers cannot grow the map.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - WebAuthn needs JWK public keys and signature verification, which Effect Crypto does not provide.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import {
  type AuthBrowserSessionResult,
  type AuthClientMetadata,
  AuthAccessWriteScope,
  authScopeResponse,
  type AuthEnvironmentScope,
  AuthEnvironmentScopes,
  type AuthPasskey,
  type AuthPasskeyLoginCredential,
  type AuthPasskeyLoginOptions,
  type AuthPasskeyRegistrationCredential,
  type AuthPasskeyRegistrationOptions,
  type AuthPublicAccessConfig,
  type AuthSessionId,
  AuthStandardClientScopes,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "./SessionStore.ts";
import {
  SUPPORTED_COSE_ALGORITHMS,
  type WebAuthnFailureCode,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "./webauthn.ts";

const CEREMONY_TTL_MS = 5 * 60 * 1000;
// Backstop for the whole map; per-address limits keep one client from filling it.
const MAX_PENDING_CEREMONIES = 1024;
const MAX_PENDING_LOGINS_PER_ADDRESS = 8;
const RP_NAME = "T3 Code";
const DEFAULT_PASSKEY_LABEL = "Passkey";
const MAX_PUBLIC_ORIGINS = 16;
const MAX_TRUSTED_PROXIES = 32;

/** Session subject for sessions a passkey issued; lets revocation find them. */
export const passkeySessionSubject = (passkeyId: string) => `passkey:${passkeyId}`;
const PASSKEY_SUBJECT_PREFIX = "passkey:";
/** The passkey a session came from, if a passkey sign-in issued it. */
export const passkeyIdFromSessionSubject = (subject: string): string | undefined =>
  subject.startsWith(PASSKEY_SUBJECT_PREFIX)
    ? subject.slice(PASSKEY_SUBJECT_PREFIX.length)
    : undefined;

export class PublicAccessInvalidConfigError extends Schema.TaggedError<PublicAccessInvalidConfigError>()(
  "PublicAccessInvalidConfigError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class PasskeyOriginNotConfiguredError extends Schema.TaggedError<PasskeyOriginNotConfiguredError>()(
  "PasskeyOriginNotConfiguredError",
  { origin: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.origin
      ? `${this.origin} is not one of this environment's public origins.`
      : "The request did not say which origin it came from.";
  }
}

export class PasskeyUnavailableError extends Schema.TaggedError<PasskeyUnavailableError>()(
  "PasskeyUnavailableError",
  { origin: Schema.String },
) {
  override get message(): string {
    return `No passkeys are enrolled for ${this.origin}.`;
  }
}

export class PasskeyRegistrationNotAllowedError extends Schema.TaggedError<PasskeyRegistrationNotAllowedError>()(
  "PasskeyRegistrationNotAllowedError",
  { reason: Schema.Literals(["browser_session_required", "access_write_required"]) },
) {
  override get message(): string {
    return this.reason === "browser_session_required"
      ? "Passkeys can only be enrolled from a browser session."
      : "Only a session that can manage access may enroll a passkey.";
  }
}

export class PasskeyCeremonyError extends Schema.TaggedError<PasskeyCeremonyError>()(
  "PasskeyCeremonyError",
  { code: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class PublicAccessStoreError extends Schema.TaggedError<PublicAccessStoreError>()(
  "PublicAccessStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Public access storage failed during ${this.operation}.`;
  }
}

export class PasskeySessionIssueError extends Schema.TaggedError<PasskeySessionIssueError>()(
  "PasskeySessionIssueError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to issue a session for the passkey.";
  }
}

export interface PasskeyEnrollingSession {
  readonly sessionId: AuthSessionId;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export interface PasskeyLoginResult {
  readonly response: AuthBrowserSessionResult;
  readonly sessionToken: string;
}

export class PublicAccess extends Context.Service<
  PublicAccess,
  {
    readonly getConfig: Effect.Effect<AuthPublicAccessConfig>;
    readonly setConfig: (
      config: AuthPublicAccessConfig,
    ) => Effect.Effect<
      AuthPublicAccessConfig,
      PublicAccessInvalidConfigError | PublicAccessStoreError
    >;
    /** Whether forwarding headers from this peer address should be believed. */
    readonly isTrustedProxy: (address: string) => boolean;
    readonly listPasskeys: Effect.Effect<ReadonlyArray<AuthPasskey>, PublicAccessStoreError>;
    readonly revokePasskey: (id: string) => Effect.Effect<boolean, PublicAccessStoreError>;
    /** Revokes every passkey and its sessions, except the one named (if any). */
    readonly revokePasskeysExcept: (
      keepId: string | undefined,
    ) => Effect.Effect<number, PublicAccessStoreError>;
    readonly beginRegistration: (input: {
      readonly origin: string | undefined;
      readonly session: PasskeyEnrollingSession;
      readonly label: string | undefined;
    }) => Effect.Effect<
      AuthPasskeyRegistrationOptions,
      PasskeyOriginNotConfiguredError | PasskeyRegistrationNotAllowedError | PublicAccessStoreError
    >;
    readonly finishRegistration: (input: {
      readonly origin: string | undefined;
      readonly session: PasskeyEnrollingSession;
      readonly credential: AuthPasskeyRegistrationCredential;
    }) => Effect.Effect<
      AuthPasskey,
      | PasskeyOriginNotConfiguredError
      | PasskeyRegistrationNotAllowedError
      | PasskeyCeremonyError
      | PublicAccessStoreError
    >;
    readonly beginLogin: (input: {
      readonly origin: string | undefined;
      /** Requesting client's address; bounds how many sign-ins it can have pending. */
      readonly address: string | undefined;
    }) => Effect.Effect<
      AuthPasskeyLoginOptions,
      PasskeyOriginNotConfiguredError | PasskeyUnavailableError | PublicAccessStoreError
    >;
    readonly finishLogin: (input: {
      readonly origin: string | undefined;
      readonly credential: AuthPasskeyLoginCredential;
      readonly client: AuthClientMetadata;
    }) => Effect.Effect<
      PasskeyLoginResult,
      | PasskeyOriginNotConfiguredError
      | PasskeyCeremonyError
      | PublicAccessStoreError
      | PasskeySessionIssueError
    >;
    /** Emits whenever the configuration or the set of passkeys changes. */
    readonly streamChanges: Stream.Stream<void>;
  }
>()("t3/auth/PublicAccess") {}

/**
 * Canonical origin for a configured public URL, or null when it cannot host
 * passkeys. WebAuthn needs a secure context, so plain HTTP is only accepted
 * for `localhost`.
 */
export function normalizePublicOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
  if (!secure || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  // WebAuthn RP IDs are domains; an IP-literal origin cannot use passkeys.
  if (NodeNet.isIP(url.hostname.replace(/^\[|\]$/gu, "")) !== 0) return null;
  return url.origin;
}

/** Parses `10.0.0.5`, `10.0.0.0/8`, `fd00::/8`, … into a BlockList entry. */
export function parseTrustedProxy(
  value: string,
): { readonly address: string; readonly prefix: number; readonly family: "ipv4" | "ipv6" } | null {
  const [address = "", prefixText, ...rest] = value.trim().split("/");
  if (rest.length > 0) return null;
  const version = NodeNet.isIP(address);
  if (version === 0) return null;
  const family = version === 4 ? "ipv4" : "ipv6";
  const maxPrefix = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;
  return { address, prefix, family };
}

function buildTrustedProxyList(entries: ReadonlyArray<string>): NodeNet.BlockList {
  const list = new NodeNet.BlockList();
  for (const entry of entries) {
    const parsed = parseTrustedProxy(entry);
    if (parsed) list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  return list;
}

export function validatePublicAccessConfig(
  config: AuthPublicAccessConfig,
): Result.Result<AuthPublicAccessConfig, PublicAccessInvalidConfigError> {
  if (config.origins.length > MAX_PUBLIC_ORIGINS) {
    return Result.fail(
      new PublicAccessInvalidConfigError({ reason: `At most ${MAX_PUBLIC_ORIGINS} origins.` }),
    );
  }
  if (config.trustedProxies.length > MAX_TRUSTED_PROXIES) {
    return Result.fail(
      new PublicAccessInvalidConfigError({
        reason: `At most ${MAX_TRUSTED_PROXIES} trusted proxies.`,
      }),
    );
  }
  const origins: Array<string> = [];
  for (const origin of config.origins) {
    const normalized = normalizePublicOrigin(origin);
    if (!normalized) {
      return Result.fail(
        new PublicAccessInvalidConfigError({
          reason: `${origin} is not an HTTPS origin like https://t3.example.com.`,
        }),
      );
    }
    if (!origins.includes(normalized)) origins.push(normalized);
  }
  const trustedProxies: Array<string> = [];
  for (const proxy of config.trustedProxies) {
    if (!parseTrustedProxy(proxy)) {
      return Result.fail(
        new PublicAccessInvalidConfigError({
          reason: `${proxy} is not an IP address or CIDR range.`,
        }),
      );
    }
    const trimmed = proxy.trim();
    if (!trustedProxies.includes(trimmed)) trustedProxies.push(trimmed);
  }
  return Result.succeed({ origins, trustedProxies });
}

type PendingCeremony =
  | {
      readonly kind: "registration";
      readonly origin: string;
      readonly expiresAtMs: number;
      readonly sessionId: AuthSessionId;
      readonly userHandle: string;
      readonly label: string;
    }
  | {
      readonly kind: "login";
      readonly origin: string;
      readonly expiresAtMs: number;
      readonly address: string;
    };

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const ScopesJson = Schema.fromJsonString(AuthEnvironmentScopes);
const JwkJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const PublicAccessRow = Schema.Struct({
  origins: StringArrayJson,
  trustedProxies: StringArrayJson,
});
const decodePublicAccessRow = Schema.decodeUnknownEffect(PublicAccessRow);

const PasskeyRow = Schema.Struct({
  id: Schema.String,
  credentialId: Schema.String,
  publicKeyJwk: JwkJson,
  algorithm: Schema.Literals(SUPPORTED_COSE_ALGORITHMS),
  signCount: Schema.Number,
  userHandle: Schema.String,
  rpId: Schema.String,
  origin: Schema.String,
  label: Schema.String,
  scopes: ScopesJson,
  administrative: Schema.Number,
  backedUp: Schema.Number,
  createdAt: Schema.DateTimeUtcFromString,
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
type PasskeyRow = typeof PasskeyRow.Type;
const decodePasskeyRows = Schema.decodeUnknownEffect(Schema.Array(PasskeyRow));

const encodeStringArray = Schema.encodeSync(StringArrayJson);
const encodeScopes = Schema.encodeSync(ScopesJson);
const encodeJwk = Schema.encodeSync(JwkJson);

const isAdministrativeGrant = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  AuthStandardClientScopes.every((scope) => scopes.includes(scope));

const passkeyScopes = (row: PasskeyRow): ReadonlyArray<AuthEnvironmentScope> =>
  row.administrative !== 0 ? AuthStandardClientScopes : row.scopes;

const toAuthPasskey = (row: PasskeyRow): AuthPasskey => ({
  id: row.id,
  label: row.label,
  origin: row.origin,
  scopes: passkeyScopes(row),
  administrative: row.administrative !== 0,
  backedUp: row.backedUp !== 0,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

const randomBase64Url = (bytes: number) =>
  Base64Url.encode(new Uint8Array(NodeCrypto.randomBytes(bytes)));

/** Reads the challenge a ceremony answered, to find its pending entry. */
const ClientDataChallenge = Schema.fromJsonString(Schema.Struct({ challenge: Schema.String }));
const decodeClientDataChallenge = Schema.decodeUnknownOption(ClientDataChallenge);
function readCeremonyChallenge(clientDataJson: string): string | null {
  const bytes = Base64Url.decodeString(clientDataJson);
  if (Result.isFailure(bytes)) return null;
  return Option.getOrNull(
    Option.map(decodeClientDataChallenge(bytes.success), (data) => data.challenge),
  );
}

const ceremonyFailure = (failure: {
  readonly code: WebAuthnFailureCode;
  readonly reason: string;
}) => new PasskeyCeremonyError({ code: failure.code, reason: failure.reason });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionStore.SessionStore;
  const changes = yield* PubSub.unbounded<void>();
  const pending = new Map<string, PendingCeremony>();

  const storeError = (operation: string) => (cause: unknown) =>
    new PublicAccessStoreError({ operation, cause });

  const loadConfig = Effect.gen(function* () {
    const rows = yield* sql`
      SELECT origins_json AS "origins", trusted_proxies_json AS "trustedProxies"
      FROM fork_auth_public_access
      WHERE id = 1
    `;
    if (rows.length === 0) return { origins: [], trustedProxies: [] };
    return yield* decodePublicAccessRow(rows[0]);
  }).pipe(Effect.mapError(storeError("loadConfig")));

  const initialConfig = yield* loadConfig;
  const configRef = yield* Ref.make<AuthPublicAccessConfig>(initialConfig);
  // Read synchronously while deriving request metadata.
  let trustedProxyList = buildTrustedProxyList(initialConfig.trustedProxies);

  const publishChange = PubSub.publish(changes, undefined);

  const resolveOrigin = (origin: string | undefined) =>
    Effect.gen(function* () {
      const normalized = origin === undefined ? null : normalizePublicOrigin(origin);
      const config = yield* Ref.get(configRef);
      if (!normalized || !config.origins.includes(normalized)) {
        return yield* new PasskeyOriginNotConfiguredError(origin === undefined ? {} : { origin });
      }
      return { origin: normalized, rpId: new URL(normalized).hostname };
    });

  const selectPasskeys = (
    where: "all-active" | { readonly credentialId: string } | { readonly rpId: string },
  ) =>
    Effect.gen(function* () {
      const filter =
        where === "all-active"
          ? sql``
          : "credentialId" in where
            ? sql`AND credential_id = ${where.credentialId}`
            : sql`AND rp_id = ${where.rpId}`;
      const rows = yield* sql`
        SELECT
          id AS "id",
          credential_id AS "credentialId",
          public_key_jwk AS "publicKeyJwk",
          algorithm AS "algorithm",
          sign_count AS "signCount",
          user_handle AS "userHandle",
          rp_id AS "rpId",
          origin AS "origin",
          label AS "label",
          scopes_json AS "scopes",
          administrative AS "administrative",
          backed_up AS "backedUp",
          created_at AS "createdAt",
          last_used_at AS "lastUsedAt"
        FROM fork_auth_passkeys
        WHERE revoked_at IS NULL ${filter}
        ORDER BY created_at DESC, id DESC
      `;
      return yield* decodePasskeyRows(rows);
    }).pipe(Effect.mapError(storeError("selectPasskeys")));

  /** Removes and returns the pending ceremony a response answered. */
  const takeCeremony = (clientDataJson: string) =>
    Effect.gen(function* () {
      const challenge = readCeremonyChallenge(clientDataJson);
      const entry = challenge === null ? undefined : pending.get(challenge);
      if (challenge === null || entry === undefined) {
        return yield* new PasskeyCeremonyError({
          code: "challenge_unknown",
          reason: "This passkey request expired or was already used. Try again.",
        });
      }
      pending.delete(challenge);
      if (entry.expiresAtMs <= (yield* Clock.currentTimeMillis)) {
        return yield* new PasskeyCeremonyError({
          code: "challenge_expired",
          reason: "This passkey request expired. Try again.",
        });
      }
      return { challenge, entry };
    });

  const rememberCeremony = (challenge: string, entry: PendingCeremony) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const [key, value] of pending) {
        if (value.expiresAtMs <= now) pending.delete(key);
      }
      // Map iteration is insertion ordered, so these drop the oldest requests.
      if (entry.kind === "login") {
        const sameAddress = [...pending].filter(
          ([, value]) => value.kind === "login" && value.address === entry.address,
        );
        for (const [key] of sameAddress.slice(
          0,
          Math.max(0, sameAddress.length - MAX_PENDING_LOGINS_PER_ADDRESS + 1),
        )) {
          pending.delete(key);
        }
      }
      while (pending.size >= MAX_PENDING_CEREMONIES) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      pending.set(challenge, entry);
    });

  // A passkey outlives the session that enrolls it, so only access managers may create one.
  const requireBrowserSession = (session: PasskeyEnrollingSession) =>
    session.method !== "browser-session-cookie"
      ? Effect.fail(new PasskeyRegistrationNotAllowedError({ reason: "browser_session_required" }))
      : !session.scopes.includes(AuthAccessWriteScope)
        ? Effect.fail(new PasskeyRegistrationNotAllowedError({ reason: "access_write_required" }))
        : Effect.void;

  const getConfig: PublicAccess["Service"]["getConfig"] = Ref.get(configRef);

  const setConfig: PublicAccess["Service"]["setConfig"] = Effect.fn("PublicAccess.setConfig")(
    function* (input) {
      const config = yield* Effect.fromResult(validatePublicAccessConfig(input));
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO fork_auth_public_access (id, origins_json, trusted_proxies_json, updated_at)
        VALUES (1, ${encodeStringArray(config.origins)}, ${encodeStringArray(config.trustedProxies)}, ${updatedAt})
        ON CONFLICT (id) DO UPDATE SET
          origins_json = excluded.origins_json,
          trusted_proxies_json = excluded.trusted_proxies_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(storeError("setConfig")));
      yield* Ref.set(configRef, config);
      trustedProxyList = buildTrustedProxyList(config.trustedProxies);
      yield* publishChange;
      return config;
    },
  );

  const isTrustedProxy: PublicAccess["Service"]["isTrustedProxy"] = (address) => {
    const version = NodeNet.isIP(address);
    return version !== 0 && trustedProxyList.check(address, version === 4 ? "ipv4" : "ipv6");
  };

  const listPasskeys: PublicAccess["Service"]["listPasskeys"] = selectPasskeys("all-active").pipe(
    Effect.map((rows) => rows.map(toAuthPasskey)),
    Effect.withSpan("PublicAccess.listPasskeys"),
  );

  /** Sessions a passkey issued go with it. */
  const revokeSessionsOf = (passkeyIds: ReadonlyArray<string>) => {
    const subjects = new Set(passkeyIds.map(passkeySessionSubject));
    return sessions.listActive().pipe(
      Effect.flatMap((activeSessions) =>
        Effect.forEach(
          activeSessions.filter((session) => subjects.has(session.subject)),
          (session) => sessions.revoke(session.sessionId),
          { discard: true },
        ),
      ),
      Effect.mapError(storeError("revokePasskeySessions")),
    );
  };

  const revokePasskey: PublicAccess["Service"]["revokePasskey"] = Effect.fn(
    "PublicAccess.revokePasskey",
  )(function* (id) {
    const revokedAt = DateTime.formatIso(yield* DateTime.now);
    const revoked = yield* sql`
      UPDATE fork_auth_passkeys
      SET revoked_at = ${revokedAt}
      WHERE id = ${id} AND revoked_at IS NULL
      RETURNING id
    `.pipe(Effect.mapError(storeError("revokePasskey")));
    if (revoked.length === 0) return false;
    yield* revokeSessionsOf([id]);
    yield* publishChange;
    return true;
  });

  const revokePasskeysExcept: PublicAccess["Service"]["revokePasskeysExcept"] = Effect.fn(
    "PublicAccess.revokePasskeysExcept",
  )(function* (keepId) {
    const revokedAt = DateTime.formatIso(yield* DateTime.now);
    const revoked = yield* sql<{ readonly id: string }>`
      UPDATE fork_auth_passkeys
      SET revoked_at = ${revokedAt}
      WHERE revoked_at IS NULL ${keepId === undefined ? sql`` : sql`AND id <> ${keepId}`}
      RETURNING id
    `.pipe(Effect.mapError(storeError("revokePasskeysExcept")));
    if (revoked.length === 0) return 0;
    yield* revokeSessionsOf(revoked.map((row) => row.id));
    yield* publishChange;
    return revoked.length;
  });

  const beginRegistration: PublicAccess["Service"]["beginRegistration"] = Effect.fn(
    "PublicAccess.beginRegistration",
  )(function* (input) {
    yield* requireBrowserSession(input.session);
    const { origin, rpId } = yield* resolveOrigin(input.origin);
    const existing = yield* selectPasskeys({ rpId });
    const challenge = randomBase64Url(32);
    const userHandle = randomBase64Url(16);
    const label = input.label?.trim() || DEFAULT_PASSKEY_LABEL;
    yield* rememberCeremony(challenge, {
      kind: "registration",
      origin,
      expiresAtMs: (yield* Clock.currentTimeMillis) + CEREMONY_TTL_MS,
      sessionId: input.session.sessionId,
      userHandle,
      label,
    });
    return {
      challenge,
      rp: { id: rpId, name: RP_NAME },
      user: { id: userHandle, name: `${RP_NAME} · ${label}`, displayName: label },
      pubKeyCredParams: SUPPORTED_COSE_ALGORITHMS.map((alg) => ({
        type: "public-key" as const,
        alg,
      })),
      timeout: CEREMONY_TTL_MS,
      // One passkey per authenticator: re-enrolling a device is refused by the browser.
      excludeCredentials: existing.map((row) => ({
        id: row.credentialId,
        type: "public-key" as const,
      })),
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
    } satisfies AuthPasskeyRegistrationOptions;
  });

  const finishRegistration: PublicAccess["Service"]["finishRegistration"] = Effect.fn(
    "PublicAccess.finishRegistration",
  )(function* (input) {
    yield* requireBrowserSession(input.session);
    const { origin, rpId } = yield* resolveOrigin(input.origin);
    const { challenge, entry } = yield* takeCeremony(input.credential.response.clientDataJSON);
    if (
      entry.kind !== "registration" ||
      entry.origin !== origin ||
      entry.sessionId !== input.session.sessionId
    ) {
      return yield* new PasskeyCeremonyError({
        code: "challenge_mismatch",
        reason: "This passkey request belongs to another sign-in.",
      });
    }
    const verified = verifyRegistrationResponse({
      credential: input.credential,
      expectedChallenge: challenge,
      relyingParty: { rpId, origin },
    });
    if (!verified.ok) {
      yield* Effect.logWarning("Rejected passkey registration.", { code: verified.code });
      return yield* ceremonyFailure(verified);
    }

    const id = NodeCrypto.randomUUID();
    const createdAt = yield* DateTime.now;
    const administrative = isAdministrativeGrant(input.session.scopes);
    yield* sql`
      INSERT INTO fork_auth_passkeys (
        id, credential_id, public_key_jwk, algorithm, sign_count, transports_json,
        user_handle, rp_id, origin, label, scopes_json, administrative, backed_up, created_at
      )
      VALUES (
        ${id},
        ${verified.credentialId},
        ${encodeJwk(verified.publicKeyJwk as Record<string, string>)},
        ${verified.algorithm},
        ${verified.signCount},
        ${encodeStringArray(verified.transports)},
        ${entry.userHandle},
        ${rpId},
        ${origin},
        ${entry.label},
        ${encodeScopes(input.session.scopes)},
        ${administrative ? 1 : 0},
        ${verified.backedUp ? 1 : 0},
        ${DateTime.formatIso(createdAt)}
      )
    `.pipe(Effect.mapError(storeError("finishRegistration")));
    yield* publishChange;
    return {
      id,
      label: entry.label,
      origin,
      scopes: administrative ? AuthStandardClientScopes : input.session.scopes,
      administrative,
      backedUp: verified.backedUp,
      createdAt: DateTime.toUtc(createdAt),
      lastUsedAt: null,
    } satisfies AuthPasskey;
  });

  const beginLogin: PublicAccess["Service"]["beginLogin"] = Effect.fn("PublicAccess.beginLogin")(
    function* (input) {
      const { origin, rpId } = yield* resolveOrigin(input.origin);
      const enrolled = yield* selectPasskeys({ rpId });
      if (!enrolled.some((row) => row.origin === origin)) {
        return yield* new PasskeyUnavailableError({ origin });
      }
      const challenge = randomBase64Url(32);
      yield* rememberCeremony(challenge, {
        kind: "login",
        origin,
        address: input.address ?? "unknown",
        expiresAtMs: (yield* Clock.currentTimeMillis) + CEREMONY_TTL_MS,
      });
      // Discoverable credentials: the browser offers every passkey for this RP.
      return {
        challenge,
        rpId,
        timeout: CEREMONY_TTL_MS,
        allowCredentials: [],
        userVerification: "required",
      } satisfies AuthPasskeyLoginOptions;
    },
  );

  const finishLogin: PublicAccess["Service"]["finishLogin"] = Effect.fn("PublicAccess.finishLogin")(
    function* (input) {
      const { origin, rpId } = yield* resolveOrigin(input.origin);
      const { challenge, entry } = yield* takeCeremony(input.credential.response.clientDataJSON);
      if (entry.kind !== "login" || entry.origin !== origin) {
        return yield* new PasskeyCeremonyError({
          code: "challenge_mismatch",
          reason: "This passkey request belongs to another sign-in.",
        });
      }
      const [stored] = yield* selectPasskeys({ credentialId: input.credential.id });
      if (!stored || stored.rpId !== rpId || stored.origin !== origin) {
        return yield* new PasskeyCeremonyError({
          code: "unknown_credential",
          reason: "This passkey is not enrolled here, or it was revoked.",
        });
      }
      const verified = verifyAuthenticationResponse({
        credential: input.credential,
        expectedChallenge: challenge,
        relyingParty: { rpId, origin },
        stored: {
          credentialId: stored.credentialId,
          publicKeyJwk: stored.publicKeyJwk as NodeCrypto.JsonWebKey,
          algorithm: stored.algorithm,
          signCount: stored.signCount,
          userHandle: stored.userHandle,
        },
      });
      if (!verified.ok) {
        yield* Effect.logWarning("Rejected passkey sign-in.", { code: verified.code });
        return yield* ceremonyFailure(verified);
      }

      const usedAt = DateTime.formatIso(yield* DateTime.now);
      const stillEnrolled = yield* sql`
        UPDATE fork_auth_passkeys
        SET sign_count = ${verified.signCount},
            backed_up = ${verified.backedUp ? 1 : 0},
            last_used_at = ${usedAt}
        WHERE id = ${stored.id} AND revoked_at IS NULL
        RETURNING id
      `.pipe(Effect.mapError(storeError("finishLogin")));
      // Revoked while this sign-in was being verified: issue nothing.
      if (stillEnrolled.length === 0) {
        return yield* new PasskeyCeremonyError({
          code: "unknown_credential",
          reason: "This passkey is not enrolled here, or it was revoked.",
        });
      }

      const session = yield* sessions
        .issue({
          method: "browser-session-cookie",
          subject: passkeySessionSubject(stored.id),
          scopes: passkeyScopes(stored),
          // Describe the device signing in, not the one that saved the passkey;
          // the subject records which passkey it was.
          client: input.client,
        })
        .pipe(Effect.mapError((cause) => new PasskeySessionIssueError({ cause })));
      yield* publishChange;
      return {
        response: {
          authenticated: true,
          // Same shape as every other session response: without `permissions`, clients
          // infer the new fine-grained permissions from the legacy parent scopes.
          ...authScopeResponse(session.scopes),
          sessionMethod: session.method,
          expiresAt: DateTime.toUtc(session.expiresAt),
        },
        sessionToken: session.token,
      } satisfies PasskeyLoginResult;
    },
  );

  return PublicAccess.of({
    getConfig,
    setConfig,
    isTrustedProxy,
    listPasskeys,
    revokePasskey,
    revokePasskeysExcept,
    beginRegistration,
    finishRegistration,
    beginLogin,
    finishLogin,
    streamChanges: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(PublicAccess, make);
