import { describe, it, expect } from "vitest";
import { MnemonicSeedProvider } from "../MnemonicSeedProvider.js";

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// MnemonicSeedProvider
// ---------------------------------------------------------------------------

describe("MnemonicSeedProvider", () => {
  const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const SEED_HEX =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";

  it("same mnemonic → same seed (determinism)", async () => {
    const a = await new MnemonicSeedProvider({ mnemonic: MNEMONIC }).getSeed();
    const b = await new MnemonicSeedProvider({ mnemonic: MNEMONIC }).getSeed();
    expect(a).toEqual(b);
  });

  it("same seedHex → same seed (determinism)", async () => {
    const a = await new MnemonicSeedProvider({ seedHex: SEED_HEX }).getSeed();
    const b = await new MnemonicSeedProvider({ seedHex: SEED_HEX }).getSeed();
    expect(a).toEqual(b);
  });

  it("different mnemonic → different seed", async () => {
    const MNEMONIC2 = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
    const a = await new MnemonicSeedProvider({ mnemonic: MNEMONIC }).getSeed();
    const b = await new MnemonicSeedProvider({ mnemonic: MNEMONIC2 }).getSeed();
    expect(a).not.toEqual(b);
  });
});

// ── MnemonicSeedProvider — intoMLKemEncryptionProvider ────────────────────────

describe("MnemonicSeedProvider — intoMLKemEncryptionProvider", () => {
  const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const MNEMONIC2 = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
  // 64-byte hex seed (128 hex chars)
  const SEED_HEX_64 =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
  // 32-byte hex seed (64 hex chars)
  const SEED_HEX_32 =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

  it("same mnemonic + variant → same public key (determinism)", async () => {
    const a = await new MnemonicSeedProvider({
      mnemonic: MNEMONIC,
    }).intoMLKemEncryptionProvider("mlkem768");
    const b = await new MnemonicSeedProvider({
      mnemonic: MNEMONIC,
    }).intoMLKemEncryptionProvider("mlkem768");
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it("different mnemonic → different public key", async () => {
    const a = await new MnemonicSeedProvider({
      mnemonic: MNEMONIC,
    }).intoMLKemEncryptionProvider("mlkem768");
    const b = await new MnemonicSeedProvider({
      mnemonic: MNEMONIC2,
    }).intoMLKemEncryptionProvider("mlkem768");
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it("64-byte seedHex → same public key (determinism)", async () => {
    const a = await new MnemonicSeedProvider({
      seedHex: SEED_HEX_64,
    }).intoMLKemEncryptionProvider("mlkem768");
    const b = await new MnemonicSeedProvider({
      seedHex: SEED_HEX_64,
    }).intoMLKemEncryptionProvider("mlkem768");
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it("wrapDek on one instance, unwrapDek on another with same mnemonic → roundtrip", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const writer = await new MnemonicSeedProvider({
      mnemonic: MNEMONIC,
    }).intoMLKemEncryptionProvider("mlkem768");
    const reader = await new MnemonicSeedProvider({
      mnemonic: MNEMONIC,
    }).intoMLKemEncryptionProvider("mlkem768");
    const wrapped = await writer.wrapDek(dek);
    const recovered = await reader.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("32-byte seedHex → throws with helpful error", async () => {
    await expect(
      new MnemonicSeedProvider({
        seedHex: SEED_HEX_32,
      }).intoMLKemEncryptionProvider(),
    ).rejects.toThrow("64-byte seed");
  });
});
