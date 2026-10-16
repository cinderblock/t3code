import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAdministrativeScopes, AuthStandardClientScopes } from "@t3tools/contracts";

// Enrolling needs access:write; the rest shows the passkey keeps exactly these scopes.
const ENROLLER_SCOPES = ["orchestration:read", "access:read", "access:write"] as const;
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as PublicAccess from "./PublicAccess.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { makeSoftwareAuthenticator } from "./testing/softwareAuthenticator.ts";
import { resolveForwardedClientAddress } from "./utils.ts";

const ORIGIN = "https://t3.example.com";
const client = { deviceType: "desktop" as const, browser: "Chrome", os: "macOS" };

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-public-access-test-" })),
);

const browserSession = (scopes: ReadonlyArray<(typeof AuthAdministrativeScopes)[number]>) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const issued = yield* sessions.issue({
      method: "browser-session-cookie",
      subject: "one-time-token",
      scopes,
    });
    return { sessionId: issued.sessionId, method: issued.method, scopes: issued.scopes };
  });

/** Enrolls a passkey from a fresh browser session and returns it with its authenticator. */
const enroll = (scopes: ReadonlyArray<(typeof AuthAdministrativeScopes)[number]>) =>
  Effect.gen(function* () {
    const publicAccess = yield* PublicAccess.PublicAccess;
    const session = yield* browserSession(scopes);
    const authenticator = makeSoftwareAuthenticator();
    const options = yield* publicAccess.beginRegistration({
      origin: ORIGIN,
      session,
      label: "Laptop",
    });
    const passkey = yield* publicAccess.finishRegistration({
      origin: ORIGIN,
      session,
      credential: authenticator.register({
        rpId: options.rp.id,
        origin: ORIGIN,
        challenge: options.challenge,
        userHandle: options.user.id,
      }),
    });
    return { passkey, authenticator };
  });

const signIn = (authenticator: ReturnType<typeof makeSoftwareAuthenticator>, origin = ORIGIN) =>
  Effect.gen(function* () {
    const publicAccess = yield* PublicAccess.PublicAccess;
    const options = yield* publicAccess.beginLogin({ origin, address: "198.51.100.7" });
    const credential = authenticator.assert({
      rpId: options.rpId,
      origin,
      challenge: options.challenge,
    });
    return { credential, result: yield* publicAccess.finishLogin({ origin, credential, client }) };
  });

it.layer(NodeServices.layer)("PublicAccess", (it) => {
  it.effect("enrolls a passkey and signs in with the enrolling session's scopes", () =>
    Effect.gen(function* () {
      const publicAccess = yield* PublicAccess.PublicAccess;
      const sessions = yield* SessionStore.SessionStore;
      yield* publicAccess.setConfig({ origins: [`${ORIGIN}/`], trustedProxies: [] });

      const { passkey, authenticator } = yield* enroll(ENROLLER_SCOPES);
      expect(passkey).toMatchObject({ label: "Laptop", origin: ORIGIN, lastUsedAt: null });
      expect(passkey.scopes).toEqual(ENROLLER_SCOPES);

      const { result } = yield* signIn(authenticator);
      expect(result.response.sessionMethod).toBe("browser-session-cookie");
      expect(result.response.scopes).toEqual(ENROLLER_SCOPES);
      const verified = yield* sessions.verify(result.sessionToken);
      expect(verified.subject).toBe(PublicAccess.passkeySessionSubject(passkey.id));
      // Labeled from the device signing in, not the one that saved the passkey.
      const issued = (yield* sessions.listActive()).find(
        (session) => session.sessionId === verified.sessionId,
      );
      expect(issued?.client).toMatchObject({ browser: "Chrome", os: "macOS" });
      expect(issued?.client.label).toBeUndefined();

      const [listed] = yield* publicAccess.listPasskeys;
      expect(listed?.lastUsedAt).not.toBeNull();
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("refuses to replay a used sign-in challenge", () =>
    Effect.gen(function* () {
      const publicAccess = yield* PublicAccess.PublicAccess;
      yield* publicAccess.setConfig({ origins: [ORIGIN], trustedProxies: [] });
      const { authenticator } = yield* enroll(AuthAdministrativeScopes);
      const { credential } = yield* signIn(authenticator);

      const replay = yield* Effect.flip(
        publicAccess.finishLogin({ origin: ORIGIN, credential, client }),
      );
      expect(replay).toMatchObject({ _tag: "PasskeyCeremonyError", code: "challenge_unknown" });
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("only offers sign-in on configured origins that have passkeys", () =>
    Effect.gen(function* () {
      const publicAccess = yield* PublicAccess.PublicAccess;
      const unconfigured = yield* Effect.flip(
        publicAccess.beginLogin({ origin: ORIGIN, address: "198.51.100.7" }),
      );
      expect(unconfigured._tag).toBe("PasskeyOriginNotConfiguredError");

      yield* publicAccess.setConfig({ origins: [ORIGIN], trustedProxies: [] });
      const empty = yield* Effect.flip(
        publicAccess.beginLogin({ origin: ORIGIN, address: "198.51.100.7" }),
      );
      expect(empty._tag).toBe("PasskeyUnavailableError");
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("only enrolls from browser sessions", () =>
    Effect.gen(function* () {
      const publicAccess = yield* PublicAccess.PublicAccess;
      yield* publicAccess.setConfig({ origins: [ORIGIN], trustedProxies: [] });
      const error = yield* Effect.flip(
        publicAccess.beginRegistration({
          origin: ORIGIN,
          session: {
            ...(yield* browserSession(AuthAdministrativeScopes)),
            method: "bearer-access-token",
          },
          label: undefined,
        }),
      );
      expect(error).toMatchObject({
        _tag: "PasskeyRegistrationNotAllowedError",
        reason: "browser_session_required",
      });
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("only sessions that manage access may enroll", () =>
    Effect.gen(function* () {
      const publicAccess = yield* PublicAccess.PublicAccess;
      yield* publicAccess.setConfig({ origins: [ORIGIN], trustedProxies: [] });
      const error = yield* Effect.flip(
        publicAccess.beginRegistration({
          origin: ORIGIN,
          session: yield* browserSession(AuthStandardClientScopes),
          label: undefined,
        }),
      );
      expect(error).toMatchObject({
        _tag: "PasskeyRegistrationNotAllowedError",
        reason: "access_write_required",
      });
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("one address cannot crowd out another's pending sign-in", () =>
    Effect.gen(function* () {
      const publicAccess = yield* PublicAccess.PublicAccess;
      yield* publicAccess.setConfig({ origins: [ORIGIN], trustedProxies: [] });
      const { authenticator } = yield* enroll(AuthAdministrativeScopes);
      const options = yield* publicAccess.beginLogin({ origin: ORIGIN, address: "203.0.113.1" });
      for (let index = 0; index < 2000; index += 1) {
        yield* publicAccess.beginLogin({ origin: ORIGIN, address: "198.51.100.66" });
      }
      const credential = authenticator.assert({
        rpId: options.rpId,
        origin: ORIGIN,
        challenge: options.challenge,
      });
      const result = yield* publicAccess.finishLogin({ origin: ORIGIN, credential, client });
      expect(result.response.authenticated).toBe(true);
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("revoking other clients revokes every passkey but the current one", () =>
    Effect.gen(function* () {
      const publicAccess = yield* PublicAccess.PublicAccess;
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      yield* publicAccess.setConfig({ origins: [ORIGIN], trustedProxies: [] });
      const first = yield* enroll(AuthAdministrativeScopes);
      const second = yield* enroll(AuthAdministrativeScopes);
      const { result } = yield* signIn(first.authenticator);
      const current = yield* sessions.verify(result.sessionToken);

      yield* serverAuth.revokeOtherClientSessions(current.sessionId);
      const remaining = yield* publicAccess.listPasskeys;
      expect(remaining.map((passkey) => passkey.id)).toEqual([first.passkey.id]);
      expect(second.passkey.id).not.toBe(first.passkey.id);
      // The current session survives.
      yield* sessions.verify(result.sessionToken);
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("revoking a passkey ends its sessions and future sign-ins", () =>
    Effect.gen(function* () {
      const publicAccess = yield* PublicAccess.PublicAccess;
      const sessions = yield* SessionStore.SessionStore;
      yield* publicAccess.setConfig({ origins: [ORIGIN], trustedProxies: [] });
      const { passkey, authenticator } = yield* enroll(AuthAdministrativeScopes);
      // A second passkey keeps the origin usable so sign-in reaches credential lookup.
      yield* enroll(AuthAdministrativeScopes);
      const { result } = yield* signIn(authenticator);

      expect(yield* publicAccess.revokePasskey(passkey.id)).toBe(true);
      expect(yield* publicAccess.revokePasskey(passkey.id)).toBe(false);
      const sessionError = yield* Effect.flip(sessions.verify(result.sessionToken));
      expect(SessionStore.isSessionCredentialInvalidError(sessionError)).toBe(true);
      const signInError = yield* Effect.flip(signIn(authenticator));
      expect(signInError).toMatchObject({ code: "unknown_credential" });
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("removing an origin disables its passkeys", () =>
    Effect.gen(function* () {
      const publicAccess = yield* PublicAccess.PublicAccess;
      yield* publicAccess.setConfig({ origins: [ORIGIN], trustedProxies: [] });
      const { authenticator } = yield* enroll(AuthAdministrativeScopes);
      yield* publicAccess.setConfig({ origins: [], trustedProxies: [] });
      const error = yield* Effect.flip(signIn(authenticator));
      expect(error._tag).toBe("PasskeyOriginNotConfiguredError");
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("persists configuration and trusts configured proxies", () =>
    Effect.gen(function* () {
      const publicAccess = yield* PublicAccess.PublicAccess;
      yield* publicAccess.setConfig({ origins: [ORIGIN], trustedProxies: ["10.0.0.0/8", "::1"] });
      expect(yield* publicAccess.getConfig).toEqual({
        origins: [ORIGIN],
        trustedProxies: ["10.0.0.0/8", "::1"],
      });
      expect(publicAccess.isTrustedProxy("10.1.2.3")).toBe(true);
      expect(publicAccess.isTrustedProxy("::1")).toBe(true);
      expect(publicAccess.isTrustedProxy("192.168.1.1")).toBe(false);
    }).pipe(Effect.provide(authLayer)),
  );
});

describe("validatePublicAccessConfig", () => {
  it.each([
    "http://t3.example.com",
    "https://t3.example.com/app",
    "https://192.168.1.10",
    "not a url",
  ])("rejects %s", (origin) => {
    const result = PublicAccess.validatePublicAccessConfig({
      origins: [origin],
      trustedProxies: [],
    });
    expect(Result.isFailure(result)).toBe(true);
  });

  it("normalizes and de-duplicates origins", () => {
    const result = PublicAccess.validatePublicAccessConfig({
      origins: ["https://T3.Example.com/", "https://t3.example.com", "http://localhost:3773"],
      trustedProxies: [" 10.0.0.1 "],
    });
    expect(result).toEqual(
      Result.succeed({
        origins: ["https://t3.example.com", "http://localhost:3773"],
        trustedProxies: ["10.0.0.1"],
      }),
    );
  });

  it("rejects malformed proxies", () => {
    for (const proxy of ["10.0.0.0/33", "proxy.local", "10.0.0.1/8/1"]) {
      const result = PublicAccess.validatePublicAccessConfig({
        origins: [],
        trustedProxies: [proxy],
      });
      expect(Result.isFailure(result)).toBe(true);
    }
  });
});

describe("resolveForwardedClientAddress", () => {
  const isTrustedProxy = (address: string) => address === "10.0.0.2" || address === "10.0.0.3";

  it("ignores forwarding headers from untrusted peers", () => {
    expect(
      resolveForwardedClientAddress({
        peerAddress: "203.0.113.9",
        forwardedFor: "198.51.100.1",
        isTrustedProxy,
      }),
    ).toBe("203.0.113.9");
  });

  it("takes the nearest untrusted hop so clients cannot spoof their address", () => {
    expect(
      resolveForwardedClientAddress({
        peerAddress: "10.0.0.2",
        forwardedFor: "1.2.3.4, 198.51.100.1, 10.0.0.3",
        isTrustedProxy,
      }),
    ).toBe("198.51.100.1");
  });
});
