/**
 * A software WebAuthn authenticator for tests. It produces the same
 * base64url JSON a browser hands to the server, signed with a real key.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - The test authenticator generates key pairs and signs assertions, which Effect Crypto does not provide.
import * as NodeCrypto from "node:crypto";

import type {
  AuthPasskeyLoginCredential,
  AuthPasskeyRegistrationCredential,
} from "@t3tools/contracts";
import { encodeCBOR, type CBORType } from "@levischuck/tiny-cbor";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";

const encodeClientDataJson = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.String, challenge: Schema.String, origin: Schema.String }),
  ),
);

export type SoftwareAuthenticatorAlgorithm = "ES256" | "EdDSA";

export interface SoftwareAuthenticatorOptions {
  readonly algorithm?: SoftwareAuthenticatorAlgorithm;
  /** Counter reported on each assertion. Defaults to 0, like synced passkeys. */
  readonly signCount?: () => number;
  readonly userVerified?: boolean;
}

const sha256 = (value: Uint8Array | string) =>
  new Uint8Array(NodeCrypto.createHash("sha256").update(value).digest());

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

export function makeSoftwareAuthenticator(options: SoftwareAuthenticatorOptions = {}) {
  const algorithm = options.algorithm ?? "ES256";
  const { privateKey, publicKey } =
    algorithm === "ES256"
      ? NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
      : NodeCrypto.generateKeyPairSync("ed25519");
  const credentialId = new Uint8Array(NodeCrypto.randomBytes(32));
  const credentialIdText = Base64Url.encode(credentialId);
  let userHandle: string | undefined;

  const coseKey = (key: NodeCrypto.KeyObject): CBORType => {
    const jwk = key.export({ format: "jwk" });
    const decode = (value: string | undefined) =>
      new Uint8Array(Buffer.from(value ?? "", "base64url"));
    return algorithm === "ES256"
      ? new Map<number, CBORType>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, decode(jwk.x)],
          [-3, decode(jwk.y)],
        ])
      : new Map<number, CBORType>([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, decode(jwk.x)],
        ]);
  };

  const flags = (attested: boolean) =>
    0x01 | (options.userVerified === false ? 0 : 0x04) | (attested ? 0x40 : 0);

  const clientData = (type: string, challenge: string, origin: string) =>
    new TextEncoder().encode(encodeClientDataJson({ type, challenge, origin }));

  return {
    credentialId: credentialIdText,
    get userHandle() {
      return userHandle;
    },

    register(input: {
      readonly rpId: string;
      readonly origin: string;
      readonly challenge: string;
      readonly userHandle: string;
    }): AuthPasskeyRegistrationCredential {
      userHandle = input.userHandle;
      const credentialIdLength = new Uint8Array(2);
      new DataView(credentialIdLength.buffer).setUint16(0, credentialId.length);
      const authData = concat(
        sha256(input.rpId),
        new Uint8Array([flags(true)]),
        uint32(0),
        new Uint8Array(16),
        credentialIdLength,
        credentialId,
        encodeCBOR(coseKey(publicKey)),
      );
      const attestationObject = encodeCBOR(
        new Map<string, CBORType>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id: credentialIdText,
        rawId: credentialIdText,
        type: "public-key",
        response: {
          clientDataJSON: Base64Url.encode(
            clientData("webauthn.create", input.challenge, input.origin),
          ),
          attestationObject: Base64Url.encode(attestationObject),
          transports: ["internal", "hybrid"],
        },
      };
    },

    assert(input: {
      readonly rpId: string;
      readonly origin: string;
      readonly challenge: string;
    }): AuthPasskeyLoginCredential {
      const authData = concat(
        sha256(input.rpId),
        new Uint8Array([flags(false)]),
        uint32(options.signCount?.() ?? 0),
      );
      const clientDataBytes = clientData("webauthn.get", input.challenge, input.origin);
      const signedData = concat(authData, sha256(clientDataBytes));
      const signature =
        algorithm === "ES256"
          ? NodeCrypto.sign("sha256", signedData, { key: privateKey, dsaEncoding: "der" })
          : NodeCrypto.sign(null, signedData, privateKey);
      return {
        id: credentialIdText,
        rawId: credentialIdText,
        type: "public-key",
        response: {
          clientDataJSON: Base64Url.encode(clientDataBytes),
          authenticatorData: Base64Url.encode(authData),
          signature: Base64Url.encode(new Uint8Array(signature)),
          ...(userHandle ? { userHandle } : {}),
        },
      };
    },
  };
}
