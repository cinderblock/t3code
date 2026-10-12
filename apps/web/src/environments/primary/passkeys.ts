/**
 * Passkey sign-in and enrollment for an environment served from a public
 * HTTPS origin. The browser talks to the environment that served this page,
 * so the WebAuthn RP is always the current origin.
 */
import type {
  AuthPasskey,
  AuthPasskeyLoginOptions,
  AuthPasskeyRegistrationOptions,
  AuthPublicAccessConfig,
  EnvironmentHttpCommonError as EnvironmentHttpCommonErrorType,
} from "@t3tools/contracts";
import { EnvironmentHttpCommonError } from "@t3tools/contracts";
import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/unstable/http";

import { runPrimaryHttp } from "../../lib/runtime";
import { completeBrowserSessionSignIn } from "./auth";
import { PrimaryEnvironmentHttpClient } from "./httpClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

/** A failure worth showing to the user as-is. A cancelled browser prompt needs no message. */
export class PasskeyActionError extends Schema.TaggedError<PasskeyActionError>()(
  "PasskeyActionError",
  {
    message: Schema.String,
    cancelled: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const isPasskeyActionError = Schema.is(PasskeyActionError);

/** True when the user dismissed the browser's passkey prompt; nothing to report. */
export const isPasskeyPromptDismissed = (error: unknown) =>
  isPasskeyActionError(error) && error.cancelled === true;

// The contract's read-only shapes, copied into the browser API's mutable JSON types.
const toRequestOptionsJson = (
  options: AuthPasskeyLoginOptions,
): PublicKeyCredentialRequestOptionsJSON => ({
  challenge: options.challenge,
  rpId: options.rpId,
  timeout: options.timeout,
  userVerification: options.userVerification,
  allowCredentials: options.allowCredentials.map(({ id, type }) => ({ id, type })),
});

const toCreationOptionsJson = (
  options: AuthPasskeyRegistrationOptions,
): PublicKeyCredentialCreationOptionsJSON => ({
  challenge: options.challenge,
  rp: { ...options.rp },
  user: { ...options.user },
  pubKeyCredParams: options.pubKeyCredParams.map(({ type, alg }) => ({ type, alg })),
  timeout: options.timeout,
  excludeCredentials: options.excludeCredentials.map(({ id, type }) => ({ id, type })),
  authenticatorSelection: { ...options.authenticatorSelection },
  attestation: options.attestation,
});

const IP_HOSTNAME = /^[\d.]+$|^\[[\da-f:]+\]$/iu;

/**
 * Whether this page can use passkeys for its own origin: a secure, non-desktop
 * page on a domain name (WebAuthn RP IDs cannot be IP addresses).
 */
export function isPasskeyCapablePage(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    window.desktopBridge === undefined &&
    !IP_HOSTNAME.test(window.location.hostname) &&
    browserSupportsWebAuthn()
  );
}

function readEnvironmentError(error: unknown): EnvironmentHttpCommonErrorType | null {
  return isEnvironmentHttpCommonError(error) ? error : null;
}

function describeCeremonyError(error: unknown, action: "save" | "use"): PasskeyActionError {
  const cancelled =
    (error instanceof WebAuthnError && error.code === "ERROR_CEREMONY_ABORTED") ||
    // Browsers report both "cancelled" and "timed out" as NotAllowedError.
    (error instanceof Error && error.name === "NotAllowedError");
  if (cancelled) {
    return new PasskeyActionError({
      message: "Passkey request cancelled.",
      cancelled: true,
      cause: error,
    });
  }
  if (
    error instanceof WebAuthnError &&
    error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"
  ) {
    return new PasskeyActionError({
      message: "This device already has a passkey for this server.",
      cause: error,
    });
  }
  return new PasskeyActionError({
    message: action === "save" ? "Could not save a passkey." : "Could not sign in with a passkey.",
    cause: error,
  });
}

/** Sign-in options for this origin, or null when the server has no passkeys for it. */
export async function fetchPasskeyLoginOptions(): Promise<AuthPasskeyLoginOptions | null> {
  try {
    return await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.passkeyLoginOptions()),
      ),
    );
  } catch (error) {
    // Servers that predate passkeys answer 404 for the route itself.
    const notFound =
      readEnvironmentError(error)?._tag === "EnvironmentResourceNotFoundError" ||
      (HttpClientError.isHttpClientError(error) && error.response?.status === 404);
    if (notFound) return null;
    throw error;
  }
}

export async function signInWithPasskey(): Promise<void> {
  const options = await fetchPasskeyLoginOptions();
  if (!options) {
    throw new PasskeyActionError({ message: "No passkeys are set up for this address." });
  }
  let credential: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    credential = await startAuthentication({ optionsJSON: toRequestOptionsJson(options) });
  } catch (error) {
    throw describeCeremonyError(error, "use");
  }
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.passkeyLogin({ payload: { credential } })),
      ),
    );
  } catch (error) {
    if (readEnvironmentError(error)?._tag === "EnvironmentAuthInvalidError") {
      throw new PasskeyActionError({
        message: "This passkey was not accepted. It may have been revoked.",
        cause: error,
      });
    }
    throw error;
  }
  await completeBrowserSessionSignIn();
}

export function fetchPublicAccess(): Promise<AuthPublicAccessConfig> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.auth.publicAccess({ headers: {} })),
    ),
  );
}

/** Adds an origin to the server's public origins, keeping the rest of the configuration. */
export async function addPublicOrigin(origin: string): Promise<void> {
  const config = await fetchPublicAccess();
  if (config.origins.includes(origin)) return;
  await updatePublicAccess({ ...config, origins: [...config.origins, origin] });
}

export async function updatePublicAccess(
  config: AuthPublicAccessConfig,
): Promise<AuthPublicAccessConfig> {
  try {
    return await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.auth.updatePublicAccess({ headers: {}, payload: config }),
        ),
      ),
    );
  } catch (error) {
    const environmentError = readEnvironmentError(error);
    if (
      environmentError?._tag === "EnvironmentRequestInvalidError" &&
      environmentError.reason === "invalid_public_access"
    ) {
      throw new PasskeyActionError({
        message:
          "Use HTTPS origins like https://t3.example.com, and IP addresses or CIDR ranges for proxies.",
        cause: error,
      });
    }
    throw error;
  }
}

export async function revokePasskey(id: string): Promise<boolean> {
  const result = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.auth.revokePasskey({ headers: {}, payload: { id } })),
    ),
  );
  return result.revoked;
}

const fetchRegistrationOptions = (label: string | undefined) =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.auth.passkeyRegistrationOptions({
          headers: {},
          payload: label ? { label } : {},
        }),
      ),
    ),
  );

const isOriginNotConfigured = (error: unknown) => {
  const environmentError = readEnvironmentError(error);
  return (
    environmentError?._tag === "EnvironmentRequestInvalidError" &&
    environmentError.reason === "passkey_origin_not_configured"
  );
};

/**
 * Enrolls a passkey for this browser on the current origin. When the origin is
 * not yet one of the server's public origins and `addOrigin` is given (the
 * caller may manage access), it is added first.
 */
export async function enrollPasskey(input: {
  readonly label?: string;
  readonly addOrigin?: (origin: string) => Promise<void>;
}): Promise<AuthPasskey> {
  let options: Awaited<ReturnType<typeof fetchRegistrationOptions>>;
  try {
    options = await fetchRegistrationOptions(input.label);
  } catch (error) {
    if (!isOriginNotConfigured(error)) throw error;
    if (!input.addOrigin) {
      throw new PasskeyActionError({
        message: `${window.location.origin} is not set up for passkeys on this server. An admin can add it under Settings → Connections.`,
        cause: error,
      });
    }
    await input.addOrigin(window.location.origin);
    options = await fetchRegistrationOptions(input.label);
  }

  let credential: Awaited<ReturnType<typeof startRegistration>>;
  try {
    credential = await startRegistration({ optionsJSON: toCreationOptionsJson(options) });
  } catch (error) {
    throw describeCeremonyError(error, "save");
  }
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.auth.registerPasskey({ headers: {}, payload: { credential } }),
      ),
    ),
  );
}
