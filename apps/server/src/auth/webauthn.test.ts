import { describe, expect, it } from "vite-plus/test";

import { makeSoftwareAuthenticator } from "./testing/softwareAuthenticator.ts";
import {
  type StoredWebAuthnCredential,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "./webauthn.ts";

const relyingParty = { rpId: "t3.example.com", origin: "https://t3.example.com" };
const userHandle = "dXNlci1oYW5kbGU";

function enroll(authenticator: ReturnType<typeof makeSoftwareAuthenticator>) {
  const result = verifyRegistrationResponse({
    credential: authenticator.register({ ...relyingParty, challenge: "reg-challenge", userHandle }),
    expectedChallenge: "reg-challenge",
    relyingParty,
  });
  if (!result.ok) throw new Error(result.reason);
  return {
    credentialId: result.credentialId,
    publicKeyJwk: result.publicKeyJwk,
    algorithm: result.algorithm,
    signCount: result.signCount,
    userHandle,
  } satisfies StoredWebAuthnCredential;
}

describe("verifyRegistrationResponse", () => {
  it("accepts an ES256 credential and extracts its key", () => {
    const authenticator = makeSoftwareAuthenticator();
    const result = verifyRegistrationResponse({
      credential: authenticator.register({ ...relyingParty, challenge: "c1", userHandle }),
      expectedChallenge: "c1",
      relyingParty,
    });
    expect(result).toMatchObject({
      ok: true,
      credentialId: authenticator.credentialId,
      algorithm: -7,
      publicKeyJwk: { kty: "EC", crv: "P-256" },
      transports: ["internal", "hybrid"],
    });
  });

  it("rejects a ceremony run on another origin", () => {
    const authenticator = makeSoftwareAuthenticator();
    const result = verifyRegistrationResponse({
      credential: authenticator.register({
        rpId: relyingParty.rpId,
        origin: "https://evil.example.com",
        challenge: "c1",
        userHandle,
      }),
      expectedChallenge: "c1",
      relyingParty,
    });
    expect(result).toMatchObject({ ok: false, code: "origin_mismatch" });
  });

  it("rejects a credential scoped to another RP ID", () => {
    const authenticator = makeSoftwareAuthenticator();
    const result = verifyRegistrationResponse({
      credential: authenticator.register({
        rpId: "example.com",
        origin: relyingParty.origin,
        challenge: "c1",
        userHandle,
      }),
      expectedChallenge: "c1",
      relyingParty,
    });
    expect(result).toMatchObject({ ok: false, code: "rp_id_mismatch" });
  });

  it("rejects a stale challenge", () => {
    const authenticator = makeSoftwareAuthenticator();
    const result = verifyRegistrationResponse({
      credential: authenticator.register({ ...relyingParty, challenge: "old", userHandle }),
      expectedChallenge: "new",
      relyingParty,
    });
    expect(result).toMatchObject({ ok: false, code: "challenge_mismatch" });
  });

  it("requires user verification", () => {
    const authenticator = makeSoftwareAuthenticator({ userVerified: false });
    const result = verifyRegistrationResponse({
      credential: authenticator.register({ ...relyingParty, challenge: "c1", userHandle }),
      expectedChallenge: "c1",
      relyingParty,
    });
    expect(result).toMatchObject({ ok: false, code: "user_not_verified" });
  });
});

describe("verifyAuthenticationResponse", () => {
  it.each(["ES256", "EdDSA"] as const)("accepts a valid %s assertion", (algorithm) => {
    const authenticator = makeSoftwareAuthenticator({ algorithm });
    const stored = enroll(authenticator);
    const result = verifyAuthenticationResponse({
      credential: authenticator.assert({ ...relyingParty, challenge: "login" }),
      expectedChallenge: "login",
      relyingParty,
      stored,
    });
    expect(result).toEqual({ ok: true, signCount: 0, backedUp: false });
  });

  it("rejects an assertion signed by a different key", () => {
    const stored = enroll(makeSoftwareAuthenticator());
    const impostor = makeSoftwareAuthenticator();
    const assertion = impostor.assert({ ...relyingParty, challenge: "login" });
    const result = verifyAuthenticationResponse({
      credential: {
        ...assertion,
        id: stored.credentialId,
        rawId: stored.credentialId,
        response: { ...assertion.response, userHandle },
      },
      expectedChallenge: "login",
      relyingParty,
      stored,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_signature" });
  });

  it("rejects a tampered client data origin even when the signature is replayed", () => {
    const authenticator = makeSoftwareAuthenticator();
    const stored = enroll(authenticator);
    const result = verifyAuthenticationResponse({
      credential: authenticator.assert({
        rpId: relyingParty.rpId,
        origin: "https://evil.example.com",
        challenge: "login",
      }),
      expectedChallenge: "login",
      relyingParty,
      stored,
    });
    expect(result).toMatchObject({ ok: false, code: "origin_mismatch" });
  });

  it("rejects a counter that fails to advance", () => {
    let counter = 5;
    const authenticator = makeSoftwareAuthenticator({ signCount: () => counter });
    const stored = { ...enroll(authenticator), signCount: 5 };
    const assert = () =>
      verifyAuthenticationResponse({
        credential: authenticator.assert({ ...relyingParty, challenge: "login" }),
        expectedChallenge: "login",
        relyingParty,
        stored,
      });
    expect(assert()).toMatchObject({ ok: false, code: "counter_regression" });
    counter = 6;
    expect(assert()).toMatchObject({ ok: true, signCount: 6 });
  });

  it("rejects an assertion naming another user", () => {
    const authenticator = makeSoftwareAuthenticator();
    const stored = { ...enroll(authenticator), userHandle: "c29tZW9uZS1lbHNl" };
    const result = verifyAuthenticationResponse({
      credential: authenticator.assert({ ...relyingParty, challenge: "login" }),
      expectedChallenge: "login",
      relyingParty,
      stored,
    });
    expect(result).toMatchObject({ ok: false, code: "credential_mismatch" });
  });
});
