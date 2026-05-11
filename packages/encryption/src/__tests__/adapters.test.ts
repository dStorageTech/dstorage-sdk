import { describe, it, expect } from "vitest";
import { MnemonicEncryptionAdapter } from "../MnemonicEncryptionAdapter.js";

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// MnemonicEncryptionAdapter
// ---------------------------------------------------------------------------

describe("MnemonicEncryptionAdapter", () => {
  // Standard BIP-39 256-bit (24-word) test vectors
  const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const SEED_HEX =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";

  it("same mnemonic → same seed (determinism)", async () => {
    const a = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).getSeed();
    const b = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).getSeed();
    expect(a).toEqual(b);
  });

  it("same seedHex → same seed (determinism)", async () => {
    const a = await new MnemonicEncryptionAdapter({
      seedHex: SEED_HEX,
    }).getSeed();
    const b = await new MnemonicEncryptionAdapter({
      seedHex: SEED_HEX,
    }).getSeed();
    expect(a).toEqual(b);
  });

  it("12-word mnemonic → throws at construction", () => {
    expect(
      () =>
        new MnemonicEncryptionAdapter({
          mnemonic:
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        }),
    ).toThrow("24-word BIP-39 mnemonic is required");
  });

  it("different mnemonic → different seed", async () => {
    const MNEMONIC2 =
      "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
    const a = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).getSeed();
    const b = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC2,
    }).getSeed();
    expect(a).not.toEqual(b);
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
    }).intoKeypairEncryptionAdapter("mlkem768");
    const b = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).intoKeypairEncryptionAdapter("mlkem768");
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it("different mnemonic → different public key", async () => {
    const a = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).intoKeypairEncryptionAdapter("mlkem768");
    const b = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC2,
    }).intoKeypairEncryptionAdapter("mlkem768");
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it("64-byte seedHex → same public key (determinism)", async () => {
    const a = await new MnemonicEncryptionAdapter({
      seedHex: SEED_HEX_64,
    }).intoKeypairEncryptionAdapter("mlkem768");
    const b = await new MnemonicEncryptionAdapter({
      seedHex: SEED_HEX_64,
    }).intoKeypairEncryptionAdapter("mlkem768");
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it("wrapDek on one instance, unwrapDek on another with same mnemonic → roundtrip", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const writer = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).intoKeypairEncryptionAdapter("mlkem768");
    const reader = await new MnemonicEncryptionAdapter({
      mnemonic: MNEMONIC,
    }).intoKeypairEncryptionAdapter("mlkem768");
    const wrapped = await writer.wrapDek(dek);
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("32-byte seedHex → throws with helpful error", async () => {
    await expect(
      new MnemonicEncryptionAdapter({
        seedHex: SEED_HEX_32,
      }).intoKeypairEncryptionAdapter(),
    ).rejects.toThrow("64-byte seed");
  });
});
