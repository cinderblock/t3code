import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";
import { makeSoftwareAuthenticator } from "./testing/softwareAuthenticator.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("enrolls and signs in with a passkey through the HTTP routes", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    const origin = "https://t3.example.com";
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(async () => {
          const cookieOf = (response: Response) =>
            response.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
          const devSession = await environment.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          const devCookie = cookieOf(devSession);

          // Pair a browser with a token whose scopes the passkey should inherit.
          const pairing = (await (
            await environment.handler(
              postJson(
                "/api/auth/pairing-token",
                { scopes: ["orchestration:read", "access:read", "access:write"] },
                { cookie: devCookie },
              ),
              requestContext,
            )
          ).json()) as { credential: string };
          const pairedOverHttps = await environment.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }, { origin }),
            requestContext,
          );
          expect(pairedOverHttps.headers.getSetCookie()[0]).toContain("Secure");
          const browserCookie = cookieOf(pairedOverHttps);

          const notConfigured = await environment.handler(
            postJson(
              "/api/auth/passkeys/registration-options",
              {},
              { cookie: browserCookie, origin },
            ),
            requestContext,
          );
          expect(notConfigured.status).toBe(400);
          const configure = await environment.handler(
            postJson(
              "/api/auth/public-access",
              { origins: [origin], trustedProxies: [] },
              { cookie: devCookie },
            ),
            requestContext,
          );
          expect(configure.status).toBe(200);

          const registrationOptions = (await (
            await environment.handler(
              postJson(
                "/api/auth/passkeys/registration-options",
                {},
                { cookie: browserCookie, origin },
              ),
              requestContext,
            )
          ).json()) as { challenge: string; rp: { id: string }; user: { id: string } };
          const authenticator = makeSoftwareAuthenticator();
          const registered = await environment.handler(
            postJson(
              "/api/auth/passkeys/register",
              {
                credential: authenticator.register({
                  rpId: registrationOptions.rp.id,
                  origin,
                  challenge: registrationOptions.challenge,
                  userHandle: registrationOptions.user.id,
                }),
              },
              { cookie: browserCookie, origin },
            ),
            requestContext,
          );
          expect(registered.status).toBe(200);

          const elsewhere = await environment.handler(
            postJson(
              "/api/auth/passkeys/login-options",
              {},
              { origin: "https://other.example.com" },
            ),
            requestContext,
          );
          expect(elsewhere.status).toBe(404);
          const loginOptions = (await (
            await environment.handler(
              postJson("/api/auth/passkeys/login-options", {}, { origin }),
              requestContext,
            )
          ).json()) as { challenge: string; rpId: string };
          const login = await environment.handler(
            postJson(
              "/api/auth/passkeys/login",
              {
                credential: authenticator.assert({
                  rpId: loginOptions.rpId,
                  origin,
                  challenge: loginOptions.challenge,
                }),
              },
              { origin },
            ),
            requestContext,
          );
          expect(login.status).toBe(200);
          const loginCookie = login.headers.getSetCookie()[0] ?? "";
          expect(loginCookie).toContain("HttpOnly");
          expect(loginCookie).toContain("Secure");

          const session = await environment.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: loginCookie.split(";", 1)[0] ?? "" },
            }),
            requestContext,
          );
          expect(await session.json()).toMatchObject({
            authenticated: true,
            scopes: ["orchestration:read", "access:read", "access:write"],
          });

          // Repeated bad credentials from one address end in a 429.
          let lastStatus = 0;
          for (let attempt = 0; attempt < 21; attempt += 1) {
            const rejected = await environment.handler(
              postJson("/api/auth/browser-session", { credential: "NOT-A-REAL-TOKEN" }),
              requestContext,
            );
            lastStatus = rejected.status;
          }
          expect(lastStatus).toBe(429);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
