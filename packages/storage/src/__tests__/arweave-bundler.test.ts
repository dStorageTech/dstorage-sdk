import { describe, it, expect } from "vitest";
import { ArweaveBundlerStorageAdapter } from "../adapters/arweave-bundler.js";
import { StorageErrorCode } from "../errors.js";

// 512 zero-bytes encoded as base64url (all 'A's — 170 AAAA groups + AAA).
// Used as the RSA-4096 modulus suffix in compound token test fixtures.
const MODULUS_683 = "A".repeat(683);

const SIGNING_URL = "https://signing.test";

// ── authToken: compound token parsing ──────────────────────────────────────────
//
// The adapter splits on lastIndexOf('.') so the credential part (everything
// before the last dot) may itself contain dots — including a full JWT.

describe("ArweaveBundlerStorageAdapter — authToken parsing", () => {
  it("accepts a plain compound token (<credential>.<modulus>)", () => {
    expect(
      () =>
        new ArweaveBundlerStorageAdapter({
          signingServerUrl: SIGNING_URL,
          authToken: `ds_tok.${MODULUS_683}`,
        }),
    ).not.toThrow();
  });

  it("accepts a compound token whose credential is a JWT (dots in credential)", () => {
    // Simulates: <jwt_header>.<jwt_payload>.<jwt_sig>.<rsa_modulus>
    // lastIndexOf splits at the last dot, so the JWT (three-segment) credential
    // is preserved intact as the Bearer value and the modulus is extracted correctly.
    const jwtCredential = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakeJwtSig";
    expect(
      () =>
        new ArweaveBundlerStorageAdapter({
          signingServerUrl: SIGNING_URL,
          authToken: `${jwtCredential}.${MODULUS_683}`,
        }),
    ).not.toThrow();
  });

  it("throws when the last segment decodes to fewer than 512 bytes (plain JWT, no modulus suffix)", () => {
    // A plain JWT has its signature as the last segment. RS256 produces 256 bytes
    // (344 base64url chars), not 512 — the 512-byte check rejects it at construction.
    const plainJwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.shortSignature";
    let err: unknown;
    try {
      new ArweaveBundlerStorageAdapter({
        signingServerUrl: SIGNING_URL,
        authToken: plainJwt,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_INVALID_AUTH_TOKEN_KEY,
      message: expect.stringContaining("[dStorage/arweave-bundler]"),
    });
  });

  it("throws when authToken has no dot at all", () => {
    let err: unknown;
    try {
      new ArweaveBundlerStorageAdapter({
        signingServerUrl: SIGNING_URL,
        authToken: "nodottoken",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_INVALID_AUTH_TOKEN_FORMAT,
      message: expect.stringContaining("[dStorage/arweave-bundler]"),
    });
  });
});

// ── retrieve: transaction ID format validation ────────────────────────────────

describe("ArweaveBundlerStorageAdapter — retrieve ID validation", () => {
  const TX_VALID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 43 chars

  function adapter() {
    return new ArweaveBundlerStorageAdapter({
      signingServerUrl: SIGNING_URL,
      authToken: `ds_tok.${MODULUS_683}`,
    });
  }

  it("throws before any network call when the id contains path-traversal characters", async () => {
    await expect(adapter().retrieve("../../etc/passwd")).rejects.toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_INVALID_TX_ID,
      message: expect.stringContaining("Invalid transaction ID"),
    });
  });

  it("throws for an id shorter than 43 characters", async () => {
    await expect(adapter().retrieve("shortId")).rejects.toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_INVALID_TX_ID,
      message: expect.stringContaining("Invalid transaction ID"),
    });
  });

  it("throws for an id longer than 43 characters", async () => {
    await expect(adapter().retrieve(TX_VALID + "A")).rejects.toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_INVALID_TX_ID,
      message: expect.stringContaining("Invalid transaction ID"),
    });
  });
});
