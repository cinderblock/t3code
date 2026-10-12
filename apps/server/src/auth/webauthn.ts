/**
 * WebAuthn ceremony verification for passkey login.
 *
 * Registration requests `attestation: "none"`: trust in a new credential comes
 * from the authenticated session that enrolls it, not from the authenticator's
 * vendor, so attestation statements are ignored. Both ceremonies require user
 * verification and check the challenge, origin, and RP ID hash. The origin in
 * `clientDataJSON` is written by the browser and covered by the assertion
 * signature, so it does not depend on proxy headers.
 */
import * as NodeCrypto from "node:crypto";

import type {
  AuthPasskeyLoginCredential,
  AuthPasskeyRegistrationCredential,
} from "@t3tools/contracts";
import { decodeCBOR, decodePartialCBOR, type CBORType } from "@levischuck/tiny-cbor";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** COSE algorithms we offer and accept: ES256, EdDSA (Ed25519), RS256. */
export const SUPPORTED_COSE_ALGORITHMS = [-7, -8, -257] as const;
export type SupportedCoseAlgorithm = (typeof SUPPORTED_COSE_ALGORITHMS)[number];

export type WebAuthnFailureCode =
  | "malformed"
  | "type_mismatch"
  | "challenge_mismatch"
  | "origin_mismatch"
  | "rp_id_mismatch"
  | "user_not_present"
  | "user_not_verified"
  | "unsupported_key"
  | "credential_mismatch"
  | "invalid_signature"
  | "counter_regression";

export type WebAuthnFailure = {
  readonly ok: false;
  readonly code: WebAuthnFailureCode;
  readonly reason: string;
};

export interface WebAuthnRelyingParty {
  readonly rpId: string;
  readonly origin: string;
}

export interface VerifiedRegistration {
  readonly ok: true;
  readonly credentialId: string;
  readonly publicKeyJwk: NodeCrypto.JsonWebKey;
  readonly algorithm: SupportedCoseAlgorithm;
  readonly signCount: number;
  readonly backedUp: boolean;
  readonly transports: ReadonlyArray<string>;
}

export interface VerifiedAuthentication {
  readonly ok: true;
  readonly signCount: number;
  readonly backedUp: boolean;
}

export interface StoredWebAuthnCredential {
  readonly credentialId: string;
  readonly publicKeyJwk: NodeCrypto.JsonWebKey;
  readonly algorithm: SupportedCoseAlgorithm;
  readonly signCount: number;
  readonly userHandle: string;
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_STATE = 0x10;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

const ClientDataJson = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    challenge: Schema.String,
    origin: Schema.String,
    crossOrigin: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeClientDataJson = Schema.decodeUnknownOption(ClientDataJson);

const fail = (code: WebAuthnFailureCode, reason: string): WebAuthnFailure => ({
  ok: false,
  code,
  reason,
});

function decodeBase64Url(value: string): Uint8Array | null {
  const decoded = Encoding.decodeBase64Url(value);
  return Result.isSuccess(decoded) ? decoded.success : null;
}

function sha256(bytes: Uint8Array | string): Uint8Array {
  return new Uint8Array(NodeCrypto.createHash("sha256").update(bytes).digest());
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
}

function checkClientData(
  clientDataBytes: Uint8Array,
  expected: {
    readonly type: "webauthn.create" | "webauthn.get";
    readonly challenge: string;
    readonly origin: string;
  },
): WebAuthnFailure | null {
  const clientData = decodeClientDataJson(new TextDecoder().decode(clientDataBytes));
  if (Option.isNone(clientData)) {
    return fail("malformed", "clientDataJSON is not valid JSON.");
  }
  if (clientData.value.type !== expected.type) {
    return fail("type_mismatch", `Expected a ${expected.type} ceremony.`);
  }
  // Both values are browser-encoded base64url strings of the same bytes.
  if (clientData.value.challenge !== expected.challenge) {
    return fail("challenge_mismatch", "The ceremony answered a different challenge.");
  }
  if (clientData.value.origin !== expected.origin || clientData.value.crossOrigin === true) {
    return fail("origin_mismatch", `The ceremony ran on ${clientData.value.origin}.`);
  }
  return null;
}

interface ParsedAuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly flags: number;
  readonly signCount: number;
  readonly attestedCredential?: {
    readonly credentialId: Uint8Array;
    readonly publicKey: CBORType;
  };
}

function parseAuthenticatorData(bytes: Uint8Array): ParsedAuthenticatorData | null {
  if (bytes.length < 37) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[32]!;
  const parsed = {
    rpIdHash: bytes.subarray(0, 32),
    flags,
    signCount: view.getUint32(33),
  };
  if ((flags & FLAG_ATTESTED_CREDENTIAL_DATA) === 0) return parsed;

  // aaguid (16 bytes), credential id length (2), credential id, COSE key.
  if (bytes.length < 55) return null;
  const credentialIdLength = view.getUint16(53);
  const keyOffset = 55 + credentialIdLength;
  if (bytes.length <= keyOffset) return null;
  let publicKey: CBORType;
  try {
    // Extensions may follow the key, so decode only the key's own bytes.
    [publicKey] = decodePartialCBOR(bytes, keyOffset);
  } catch {
    return null;
  }
  return {
    ...parsed,
    attestedCredential: {
      credentialId: bytes.subarray(55, keyOffset),
      publicKey,
    },
  };
}

function checkAuthenticatorFlags(
  authData: ParsedAuthenticatorData,
  rpId: string,
): WebAuthnFailure | null {
  if (!bytesEqual(authData.rpIdHash, sha256(rpId))) {
    return fail("rp_id_mismatch", `The credential is not scoped to ${rpId}.`);
  }
  if ((authData.flags & FLAG_USER_PRESENT) === 0) {
    return fail("user_not_present", "The authenticator did not confirm user presence.");
  }
  if ((authData.flags & FLAG_USER_VERIFIED) === 0) {
    return fail("user_not_verified", "The authenticator did not verify the user.");
  }
  return null;
}

function coseBytes(key: Map<string | number, CBORType>, label: number): string | null {
  const value = key.get(label);
  return value instanceof Uint8Array ? Encoding.encodeBase64Url(value) : null;
}

/** Converts a COSE_Key to a JWK for `node:crypto`. Returns null for anything we do not accept. */
export function coseKeyToJwk(
  key: CBORType,
): { readonly jwk: NodeCrypto.JsonWebKey; readonly algorithm: SupportedCoseAlgorithm } | null {
  if (!(key instanceof Map)) return null;
  const kty = key.get(1);
  const alg = key.get(3);
  if (alg === -7 && kty === 2 && key.get(-1) === 1) {
    const x = coseBytes(key, -2);
    const y = coseBytes(key, -3);
    return x && y ? { jwk: { kty: "EC", crv: "P-256", x, y }, algorithm: -7 } : null;
  }
  if (alg === -8 && kty === 1 && key.get(-1) === 6) {
    const x = coseBytes(key, -2);
    return x ? { jwk: { kty: "OKP", crv: "Ed25519", x }, algorithm: -8 } : null;
  }
  if (alg === -257 && kty === 3) {
    const n = coseBytes(key, -1);
    const e = coseBytes(key, -2);
    return n && e ? { jwk: { kty: "RSA", n, e }, algorithm: -257 } : null;
  }
  return null;
}

function verifySignature(
  credential: Pick<StoredWebAuthnCredential, "publicKeyJwk" | "algorithm">,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const key = NodeCrypto.createPublicKey({ key: credential.publicKeyJwk, format: "jwk" });
    switch (credential.algorithm) {
      case -7:
        // WebAuthn ES256 signatures are DER encoded.
        return NodeCrypto.verify("sha256", data, { key, dsaEncoding: "der" }, signature);
      case -257:
        return NodeCrypto.verify("sha256", data, key, signature);
      case -8:
        return NodeCrypto.verify(null, data, key, signature);
    }
  } catch {
    return false;
  }
}

export function verifyRegistrationResponse(input: {
  readonly credential: AuthPasskeyRegistrationCredential;
  readonly expectedChallenge: string;
  readonly relyingParty: WebAuthnRelyingParty;
}): VerifiedRegistration | WebAuthnFailure {
  const { credential, relyingParty } = input;
  const clientDataBytes = decodeBase64Url(credential.response.clientDataJSON);
  const attestationBytes = decodeBase64Url(credential.response.attestationObject);
  if (!clientDataBytes || !attestationBytes) {
    return fail("malformed", "The registration response is not base64url encoded.");
  }
  const clientDataFailure = checkClientData(clientDataBytes, {
    type: "webauthn.create",
    challenge: input.expectedChallenge,
    origin: relyingParty.origin,
  });
  if (clientDataFailure) return clientDataFailure;

  let attestation: CBORType;
  try {
    attestation = decodeCBOR(attestationBytes);
  } catch {
    return fail("malformed", "The attestation object is not valid CBOR.");
  }
  const authDataBytes = attestation instanceof Map ? attestation.get("authData") : undefined;
  if (!(authDataBytes instanceof Uint8Array)) {
    return fail("malformed", "The attestation object has no authenticator data.");
  }
  const authData = parseAuthenticatorData(authDataBytes);
  if (!authData) {
    return fail("malformed", "The authenticator data is truncated.");
  }
  const flagFailure = checkAuthenticatorFlags(authData, relyingParty.rpId);
  if (flagFailure) return flagFailure;
  if (!authData.attestedCredential) {
    return fail("malformed", "The authenticator returned no credential.");
  }

  const credentialId = Encoding.encodeBase64Url(authData.attestedCredential.credentialId);
  if (credentialId !== credential.rawId || credentialId !== credential.id) {
    return fail("credential_mismatch", "The credential id does not match the authenticator data.");
  }
  const key = coseKeyToJwk(authData.attestedCredential.publicKey);
  if (!key) {
    return fail("unsupported_key", "The authenticator created an unsupported key type.");
  }
  return {
    ok: true,
    credentialId,
    publicKeyJwk: key.jwk,
    algorithm: key.algorithm,
    signCount: authData.signCount,
    backedUp: (authData.flags & FLAG_BACKUP_STATE) !== 0,
    transports: credential.response.transports ?? [],
  };
}

export function verifyAuthenticationResponse(input: {
  readonly credential: AuthPasskeyLoginCredential;
  readonly expectedChallenge: string;
  readonly relyingParty: WebAuthnRelyingParty;
  readonly stored: StoredWebAuthnCredential;
}): VerifiedAuthentication | WebAuthnFailure {
  const { credential, relyingParty, stored } = input;
  if (credential.rawId !== stored.credentialId || credential.id !== stored.credentialId) {
    return fail("credential_mismatch", "The assertion is for a different credential.");
  }
  if (
    credential.response.userHandle !== undefined &&
    credential.response.userHandle !== stored.userHandle
  ) {
    return fail("credential_mismatch", "The assertion names a different user.");
  }
  const clientDataBytes = decodeBase64Url(credential.response.clientDataJSON);
  const authDataBytes = decodeBase64Url(credential.response.authenticatorData);
  const signature = decodeBase64Url(credential.response.signature);
  if (!clientDataBytes || !authDataBytes || !signature) {
    return fail("malformed", "The assertion is not base64url encoded.");
  }
  const clientDataFailure = checkClientData(clientDataBytes, {
    type: "webauthn.get",
    challenge: input.expectedChallenge,
    origin: relyingParty.origin,
  });
  if (clientDataFailure) return clientDataFailure;

  const authData = parseAuthenticatorData(authDataBytes);
  if (!authData) {
    return fail("malformed", "The authenticator data is truncated.");
  }
  const flagFailure = checkAuthenticatorFlags(authData, relyingParty.rpId);
  if (flagFailure) return flagFailure;

  const signedData = new Uint8Array(authDataBytes.length + 32);
  signedData.set(authDataBytes, 0);
  signedData.set(sha256(clientDataBytes), authDataBytes.length);
  if (!verifySignature(stored, signedData, signature)) {
    return fail("invalid_signature", "The assertion signature is invalid.");
  }

  // Synced passkeys report 0. A non-zero counter that fails to advance means
  // the credential may have been cloned.
  if (
    (authData.signCount !== 0 || stored.signCount !== 0) &&
    authData.signCount <= stored.signCount
  ) {
    return fail("counter_regression", "The authenticator's signature counter went backwards.");
  }
  return {
    ok: true,
    signCount: authData.signCount,
    backedUp: (authData.flags & FLAG_BACKUP_STATE) !== 0,
  };
}
