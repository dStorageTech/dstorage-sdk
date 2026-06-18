import { describe, it, expect } from "vitest";
import { KeypairEncryptionAdapter } from "../KeypairEncryptionAdapter.js";
import type { MLKemVariant } from "../KeypairEncryptionAdapter.js";
import { EncryptionErrorCode } from "../errors.js";
import { CryptoErrorCode } from "@dstorage/crypto";

const VARIANTS: MLKemVariant[] = ["mlkem512", "mlkem768", "mlkem1024"];
const TEST_DEK = globalThis.crypto.getRandomValues(new Uint8Array(32));
const CTX = "test-context";

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// ── generateKeypair ───────────────────────────────────────────────────────────

describe("generateKeypair", () => {
  for (const variant of VARIANTS) {
    it(`${variant}: returns provider + raw keys`, () => {
      const { adapter, publicKey, secretKey } =
        KeypairEncryptionAdapter.generateKeypair(CTX, variant);
      expect(adapter.name).toBe(variant);
      expect(publicKey).toBeInstanceOf(Uint8Array);
      expect(secretKey).toBeInstanceOf(Uint8Array);
      expect(publicKey.length).toBeGreaterThan(0);
      expect(secretKey.length).toBeGreaterThan(0);
    });
  }

  it("default variant is mlkem768", () => {
    const { adapter } = KeypairEncryptionAdapter.generateKeypair(CTX);
    expect(adapter.name).toBe("mlkem768");
  });

  it("each call produces a different keypair", () => {
    const a = KeypairEncryptionAdapter.generateKeypair(CTX);
    const b = KeypairEncryptionAdapter.generateKeypair(CTX);
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });
});

// ── wrapDek / unwrapDek roundtrip ─────────────────────────────────────────────

describe("wrapDek / unwrapDek roundtrip", () => {
  for (const variant of VARIANTS) {
    it(`${variant}: wrap then unwrap recovers the original DEK`, async () => {
      const { adapter } = KeypairEncryptionAdapter.generateKeypair(
        CTX,
        variant,
      );
      const wrapped = await adapter.wrapDek(TEST_DEK);
      const recovered = await adapter.unwrapDek(wrapped);
      expect(recovered).toEqual(TEST_DEK);
    });
  }

  it("wrapped result contains kemCiphertext and wrappedDek", async () => {
    const { adapter } = KeypairEncryptionAdapter.generateKeypair(CTX);
    const result = await adapter.wrapDek(TEST_DEK);
    expect(typeof result.kemCiphertext).toBe("string");
    expect(result.kemCiphertext!.length).toBeGreaterThan(0);
    expect(typeof result.wrappedDek).toBe("string");
    expect(result.algorithm).toMatch(/^mlkem\d+-xchacha20poly1305-v1$/);
    expect(result.kekDerivation).toBe("mlkem-hkdf-sha256-v1");
  });

  it("PK-only provider can wrapDek, but unwrapDek throws", async () => {
    const { publicKey } = KeypairEncryptionAdapter.generateKeypair(CTX);
    const uploadOnly = KeypairEncryptionAdapter.fromPublicKey(publicKey, CTX);
    const wrapped = await uploadOnly.wrapDek(TEST_DEK);
    await expect(uploadOnly.unwrapDek(wrapped)).rejects.toMatchObject({
      code: EncryptionErrorCode.KEYPAIR_MISSING_SECRET_KEY,
      message: expect.stringContaining("no Secret Key"),
    });
  });

  it("upload-only wraps can be unwrapped by a provider holding the SK", async () => {
    const { publicKey, secretKey } =
      KeypairEncryptionAdapter.generateKeypair(CTX);
    const uploader = KeypairEncryptionAdapter.fromPublicKey(publicKey, CTX);
    const reader = KeypairEncryptionAdapter.fromKeypair(
      publicKey,
      secretKey,
      CTX,
    );

    const wrapped = await uploader.wrapDek(TEST_DEK);
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(TEST_DEK);
  });

  it("wrong SK cannot unwrap (different keypair)", async () => {
    const a = KeypairEncryptionAdapter.generateKeypair(CTX);
    const b = KeypairEncryptionAdapter.generateKeypair(CTX);

    const wrapped = await a.adapter.wrapDek(TEST_DEK);
    await expect(b.adapter.unwrapDek(wrapped)).rejects.toMatchObject({
      code: CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
    });
  });
});

// ── cross-variant unwrap: variant read from key envelope ──────────────────────

describe("cross-variant unwrap (variant auto-detected from key envelope)", () => {
  const VARIANT_PAIRS: [MLKemVariant, MLKemVariant][] = [
    ["mlkem512", "mlkem768"],
    ["mlkem512", "mlkem1024"],
    ["mlkem768", "mlkem512"],
    ["mlkem768", "mlkem1024"],
    ["mlkem1024", "mlkem512"],
    ["mlkem1024", "mlkem768"],
  ];

  for (const [wrapVariant, adapterVariant] of VARIANT_PAIRS) {
    it(`wrapped with ${wrapVariant}, adapter constructed as ${adapterVariant} → unwraps correctly`, async () => {
      const { publicKey, secretKey } = KeypairEncryptionAdapter.generateKeypair(
        CTX,
        wrapVariant,
      );

      // Wrap using wrapVariant keypair
      const wrapper = KeypairEncryptionAdapter.fromKeypair(
        publicKey,
        secretKey,
        CTX,
        wrapVariant,
      );
      const wrapped = await wrapper.wrapDek(TEST_DEK);
      expect(wrapped.algorithm).toBe(`${wrapVariant}-xchacha20poly1305-v1`);

      // Unwrap with adapter whose constructor variant differs — should still work
      // because the variant is read from wrapped.algorithm, not from this.variant.
      const reader = KeypairEncryptionAdapter.fromKeypair(
        publicKey,
        secretKey,
        CTX,
        adapterVariant,
      );
      const recovered = await reader.unwrapDek(wrapped);
      expect(recovered).toEqual(TEST_DEK);
    });
  }

  it("malformed algorithm string → throws with clear message", async () => {
    const { adapter, publicKey, secretKey } =
      KeypairEncryptionAdapter.generateKeypair(CTX);
    const wrapped = await adapter.wrapDek(TEST_DEK);
    const reader = KeypairEncryptionAdapter.fromKeypair(
      publicKey,
      secretKey,
      CTX,
    );

    await expect(
      reader.unwrapDek({ ...wrapped, algorithm: "xchacha20poly1305-v1" }),
    ).rejects.toMatchObject({
      code: CryptoErrorCode.MLKEM_UNKNOWN_ALGORITHM,
      message: expect.stringContaining("unrecognised algorithm"),
    });
  });

  it("unknown variant prefix → throws with clear message", async () => {
    const { adapter, publicKey, secretKey } =
      KeypairEncryptionAdapter.generateKeypair(CTX);
    const wrapped = await adapter.wrapDek(TEST_DEK);
    const reader = KeypairEncryptionAdapter.fromKeypair(
      publicKey,
      secretKey,
      CTX,
    );

    await expect(
      reader.unwrapDek({
        ...wrapped,
        algorithm: "mlkem9999-xchacha20poly1305-v1",
      }),
    ).rejects.toMatchObject({
      code: CryptoErrorCode.MLKEM_UNKNOWN_VARIANT,
      message: expect.stringContaining("unknown ML-KEM variant"),
    });
  });
});

// ── fromPassword — determinism ────────────────────────────────────────────────

describe("fromPassword", () => {
  const FAST_PARAMS = { N: 1024, r: 8, p: 1 };
  const PASSWORD = "Str0ng-PaSSw0rd!XY9";
  const SALT = "dstorage:test:mlkem:v1";

  it("same password + salt + variant → same public key", async () => {
    const a = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      SALT,
      CTX,
      "mlkem768",
      FAST_PARAMS,
    );
    const b = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      SALT,
      CTX,
      "mlkem768",
      FAST_PARAMS,
    );
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it("different salt → different public key", async () => {
    const a = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      "salt-a",
      CTX,
      "mlkem768",
      FAST_PARAMS,
    );
    const b = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      "salt-b",
      CTX,
      "mlkem768",
      FAST_PARAMS,
    );
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it("different password → different public key", async () => {
    const a = await KeypairEncryptionAdapter.fromPassword(
      "Str0ng-PaSSw0rd!XY9",
      SALT,
      CTX,
      "mlkem768",
      FAST_PARAMS,
    );
    const b = await KeypairEncryptionAdapter.fromPassword(
      "An0ther$ecureP@ss!Z",
      SALT,
      CTX,
      "mlkem768",
      FAST_PARAMS,
    );
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it("wrapDek with one instance, unwrapDek with another (same password)", async () => {
    const writerProvider = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      SALT,
      CTX,
      "mlkem768",
      FAST_PARAMS,
    );
    const readerProvider = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      SALT,
      CTX,
      "mlkem768",
      FAST_PARAMS,
    );

    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await writerProvider.wrapDek(dek);
    const recovered = await readerProvider.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("weak password throws", async () => {
    await expect(
      KeypairEncryptionAdapter.fromPassword(
        "weak",
        SALT,
        CTX,
        "mlkem768",
        FAST_PARAMS,
      ),
    ).rejects.toMatchObject({ code: EncryptionErrorCode.PASSWORD_TOO_SHORT });
  });
});

// ── fromMnemonic — determinism ─────────────────────────────────────────────────

describe("fromMnemonic", () => {
  const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const MNEMONIC2 =
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
  const SEED_HEX_64 =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
  const SEED_HEX_32 =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

  it("same mnemonic + variant → same public key", async () => {
    const a = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC },
      CTX,
      "mlkem768",
    );
    const b = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC },
      CTX,
      "mlkem768",
    );
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it("different mnemonic → different public key", async () => {
    const a = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC },
      CTX,
      "mlkem768",
    );
    const b = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC2 },
      CTX,
      "mlkem768",
    );
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it("64-byte seedHex → deterministic", async () => {
    const a = await KeypairEncryptionAdapter.fromMnemonic(
      { seedHex: SEED_HEX_64 },
      CTX,
      "mlkem768",
    );
    const b = await KeypairEncryptionAdapter.fromMnemonic(
      { seedHex: SEED_HEX_64 },
      CTX,
      "mlkem768",
    );
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it("wrapDek + unwrapDek roundtrip (same mnemonic both sides)", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const writer = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC },
      CTX,
      "mlkem768",
    );
    const reader = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC },
      CTX,
      "mlkem768",
    );
    const wrapped = await writer.wrapDek(dek);
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("32-byte seedHex → produces a valid keypair adapter (derivation via HKDF)", async () => {
    const adapter = await KeypairEncryptionAdapter.fromMnemonic(
      { seedHex: SEED_HEX_32 },
      CTX,
    );
    expect(adapter.name).toMatch(/^mlkem/);
  });
});
