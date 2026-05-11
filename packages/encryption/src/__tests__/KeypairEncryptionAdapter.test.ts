import { describe, it, expect } from "vitest";
import { KeypairEncryptionAdapter } from "../KeypairEncryptionAdapter.js";
import type { MLKemVariant } from "../KeypairEncryptionAdapter.js";

const VARIANTS: MLKemVariant[] = ["mlkem512", "mlkem768", "mlkem1024"];
const TEST_DEK = globalThis.crypto.getRandomValues(new Uint8Array(32));

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
        KeypairEncryptionAdapter.generateKeypair(variant);
      expect(adapter.name).toBe(variant);
      expect(publicKey).toBeInstanceOf(Uint8Array);
      expect(secretKey).toBeInstanceOf(Uint8Array);
      expect(publicKey.length).toBeGreaterThan(0);
      expect(secretKey.length).toBeGreaterThan(0);
    });
  }

  it("default variant is mlkem768", () => {
    const { adapter } = KeypairEncryptionAdapter.generateKeypair();
    expect(adapter.name).toBe("mlkem768");
  });

  it("each call produces a different keypair", () => {
    const a = KeypairEncryptionAdapter.generateKeypair();
    const b = KeypairEncryptionAdapter.generateKeypair();
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });
});

// ── wrapDek / unwrapDek roundtrip ─────────────────────────────────────────────

describe("wrapDek / unwrapDek roundtrip", () => {
  for (const variant of VARIANTS) {
    it(`${variant}: wrap then unwrap recovers the original DEK`, async () => {
      const { adapter } = KeypairEncryptionAdapter.generateKeypair(variant);
      const wrapped = await adapter.wrapDek(TEST_DEK);
      const recovered = await adapter.unwrapDek(wrapped);
      expect(recovered).toEqual(TEST_DEK);
    });
  }

  it("wrapped result contains kemCiphertext and wrappedDek", async () => {
    const { adapter } = KeypairEncryptionAdapter.generateKeypair();
    const result = await adapter.wrapDek(TEST_DEK);
    expect(typeof result.kemCiphertext).toBe("string");
    expect(result.kemCiphertext!.length).toBeGreaterThan(0);
    expect(typeof result.wrappedDek).toBe("string");
    expect(result.algorithm).toMatch(/^mlkem\d+-xchacha20poly1305-v1$/);
    expect(result.kekDerivation).toBe("mlkem-hkdf-sha256-v1");
  });

  it("PK-only provider can wrapDek, but unwrapDek throws", async () => {
    const { publicKey } = KeypairEncryptionAdapter.generateKeypair();
    const uploadOnly = KeypairEncryptionAdapter.fromPublicKey(publicKey);
    const wrapped = await uploadOnly.wrapDek(TEST_DEK);
    await expect(uploadOnly.unwrapDek(wrapped)).rejects.toThrow(
      "no Secret Key",
    );
  });

  it("upload-only wraps can be unwrapped by a provider holding the SK", async () => {
    const { publicKey, secretKey } = KeypairEncryptionAdapter.generateKeypair();
    const uploader = KeypairEncryptionAdapter.fromPublicKey(publicKey);
    const reader = KeypairEncryptionAdapter.fromKeypair(publicKey, secretKey);

    const wrapped = await uploader.wrapDek(TEST_DEK);
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(TEST_DEK);
  });

  it("wrong SK cannot unwrap (different keypair)", async () => {
    const a = KeypairEncryptionAdapter.generateKeypair();
    const b = KeypairEncryptionAdapter.generateKeypair();

    const wrapped = await a.adapter.wrapDek(TEST_DEK);
    await expect(b.adapter.unwrapDek(wrapped)).rejects.toThrow();
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
      const { publicKey, secretKey } =
        KeypairEncryptionAdapter.generateKeypair(wrapVariant);

      // Wrap using wrapVariant keypair
      const wrapper = KeypairEncryptionAdapter.fromKeypair(
        publicKey,
        secretKey,
        wrapVariant,
      );
      const wrapped = await wrapper.wrapDek(TEST_DEK);
      expect(wrapped.algorithm).toBe(`${wrapVariant}-xchacha20poly1305-v1`);

      // Unwrap with adapter whose constructor variant differs — should still work
      // because the variant is read from wrapped.algorithm, not from this.variant.
      const reader = KeypairEncryptionAdapter.fromKeypair(
        publicKey,
        secretKey,
        adapterVariant,
      );
      const recovered = await reader.unwrapDek(wrapped);
      expect(recovered).toEqual(TEST_DEK);
    });
  }

  it("malformed algorithm string → throws with clear message", async () => {
    const { adapter, publicKey, secretKey } =
      KeypairEncryptionAdapter.generateKeypair();
    const wrapped = await adapter.wrapDek(TEST_DEK);
    const reader = KeypairEncryptionAdapter.fromKeypair(publicKey, secretKey);

    await expect(
      reader.unwrapDek({ ...wrapped, algorithm: "xchacha20poly1305-v1" }),
    ).rejects.toThrow("unrecognised algorithm");
  });

  it("unknown variant prefix → throws with clear message", async () => {
    const { adapter, publicKey, secretKey } =
      KeypairEncryptionAdapter.generateKeypair();
    const wrapped = await adapter.wrapDek(TEST_DEK);
    const reader = KeypairEncryptionAdapter.fromKeypair(publicKey, secretKey);

    await expect(
      reader.unwrapDek({
        ...wrapped,
        algorithm: "mlkem9999-xchacha20poly1305-v1",
      }),
    ).rejects.toThrow("unknown ML-KEM variant");
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
      "mlkem768",
      FAST_PARAMS,
    );
    const b = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      SALT,
      "mlkem768",
      FAST_PARAMS,
    );
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it("different salt → different public key", async () => {
    const a = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      "salt-a",
      "mlkem768",
      FAST_PARAMS,
    );
    const b = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      "salt-b",
      "mlkem768",
      FAST_PARAMS,
    );
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it("different password → different public key", async () => {
    const a = await KeypairEncryptionAdapter.fromPassword(
      "Str0ng-PaSSw0rd!XY9",
      SALT,
      "mlkem768",
      FAST_PARAMS,
    );
    const b = await KeypairEncryptionAdapter.fromPassword(
      "An0ther$ecureP@ss!Z",
      SALT,
      "mlkem768",
      FAST_PARAMS,
    );
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it("wrapDek with one instance, unwrapDek with another (same password)", async () => {
    const writerProvider = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      SALT,
      "mlkem768",
      FAST_PARAMS,
    );
    const readerProvider = await KeypairEncryptionAdapter.fromPassword(
      PASSWORD,
      SALT,
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
        "mlkem768",
        FAST_PARAMS,
      ),
    ).rejects.toThrow();
  });
});

// ── fromMnemonic — determinism ─────────────────────────────────────────────────

describe("fromMnemonic", () => {
  const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const MNEMONIC2 = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
  const SEED_HEX_64 =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
  const SEED_HEX_32 =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

  it("same mnemonic + variant → same public key", async () => {
    const a = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC },
      "mlkem768",
    );
    const b = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC },
      "mlkem768",
    );
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it("different mnemonic → different public key", async () => {
    const a = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC },
      "mlkem768",
    );
    const b = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC2 },
      "mlkem768",
    );
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it("64-byte seedHex → deterministic", async () => {
    const a = await KeypairEncryptionAdapter.fromMnemonic(
      { seedHex: SEED_HEX_64 },
      "mlkem768",
    );
    const b = await KeypairEncryptionAdapter.fromMnemonic(
      { seedHex: SEED_HEX_64 },
      "mlkem768",
    );
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it("wrapDek + unwrapDek roundtrip (same mnemonic both sides)", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const writer = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC },
      "mlkem768",
    );
    const reader = await KeypairEncryptionAdapter.fromMnemonic(
      { mnemonic: MNEMONIC },
      "mlkem768",
    );
    const wrapped = await writer.wrapDek(dek);
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("32-byte seedHex → throws", async () => {
    await expect(
      KeypairEncryptionAdapter.fromMnemonic({ seedHex: SEED_HEX_32 }),
    ).rejects.toThrow("64-byte seed");
  });
});
