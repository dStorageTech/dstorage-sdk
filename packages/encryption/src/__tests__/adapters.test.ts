import { describe, it, expect } from "vitest";
import { MnemonicEncryptionAdapter } from "../MnemonicEncryptionAdapter.js";
import { EncryptionErrorCode } from "../errors.js";
import { CryptoErrorCode } from "@dstorage/crypto";

// ---------------------------------------------------------------------------
// MnemonicEncryptionAdapter
// ---------------------------------------------------------------------------

describe("MnemonicEncryptionAdapter", () => {
  // Standard BIP-39 256-bit (24-word) test vectors
  const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const MNEMONIC2 =
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
  const SEED_HEX =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";

  it("same mnemonic → same encryption key (determinism via roundtrip)", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = new MnemonicEncryptionAdapter({ mnemonic: MNEMONIC });
    const b = new MnemonicEncryptionAdapter({ mnemonic: MNEMONIC });
    const wrapped = await a.wrapDek(dek);
    const recovered = await b.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("same seedHex → same encryption key (determinism via roundtrip)", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = new MnemonicEncryptionAdapter({ seedHex: SEED_HEX });
    const b = new MnemonicEncryptionAdapter({ seedHex: SEED_HEX });
    const wrapped = await a.wrapDek(dek);
    const recovered = await b.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("12-word mnemonic → throws at construction", () => {
    let err: unknown;
    try {
      new MnemonicEncryptionAdapter({
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.MNEMONIC_TOO_SHORT,
      message: expect.stringContaining("24-word BIP-39 mnemonic is required"),
    });
  });

  it("different mnemonic → cannot unwrap (different key)", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = new MnemonicEncryptionAdapter({ mnemonic: MNEMONIC });
    const b = new MnemonicEncryptionAdapter({ mnemonic: MNEMONIC2 });
    const wrapped = await a.wrapDek(dek);
    await expect(b.unwrapDek(wrapped)).rejects.toMatchObject({
      code: CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
    });
  });
});

// ── MnemonicEncryptionAdapter — intoKeypairEncryptionAdapter ────────────────────────

describe("MnemonicEncryptionAdapter — intoKeypairEncryptionAdapter", () => {
  const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const MNEMONIC2 =
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
  // 64-byte hex seed (128 hex chars)
  const SEED_HEX_64 =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
  // 32-byte hex seed (64 hex chars)
  const SEED_HEX_32 =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

  it("same mnemonic + variant → same public key (determinism)", async () => {
    const a = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).intoKeypairEncryptionAdapter("test-context", "mlkem768");
    const b = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).intoKeypairEncryptionAdapter("test-context", "mlkem768");
    const toHex = (u: Uint8Array) =>
      Array.from(u)
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    expect(toHex(a.publicKey)).toBe(toHex(b.publicKey));
  });

  it("different mnemonic → different public key", async () => {
    const a = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).intoKeypairEncryptionAdapter("test-context", "mlkem768");
    const b = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC2,
    }).intoKeypairEncryptionAdapter("test-context", "mlkem768");
    const toHex = (u: Uint8Array) =>
      Array.from(u)
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    expect(toHex(a.publicKey)).not.toBe(toHex(b.publicKey));
  });

  it("64-byte seedHex → same public key (determinism)", async () => {
    const a = await new MnemonicEncryptionAdapter({
      seedHex: SEED_HEX_64,
    }).intoKeypairEncryptionAdapter("test-context", "mlkem768");
    const b = await new MnemonicEncryptionAdapter({
      seedHex: SEED_HEX_64,
    }).intoKeypairEncryptionAdapter("test-context", "mlkem768");
    const toHex = (u: Uint8Array) =>
      Array.from(u)
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    expect(toHex(a.publicKey)).toBe(toHex(b.publicKey));
  });

  it("wrapDek on one instance, unwrapDek on another with same mnemonic → roundtrip", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const writer = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).intoKeypairEncryptionAdapter("test-context", "mlkem768");
    const reader = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).intoKeypairEncryptionAdapter("test-context", "mlkem768");
    const wrapped = await writer.wrapDek(dek);
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("32-byte seedHex → produces a valid keypair adapter (via HKDF)", async () => {
    const adapter = await new MnemonicEncryptionAdapter({
      seedHex: SEED_HEX_32,
    }).intoKeypairEncryptionAdapter("test-context");
    expect(adapter.name).toMatch(/^mlkem/);
    // Verify it can perform a roundtrip
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await adapter.wrapDek(dek);
    const recovered = await adapter.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });
});
