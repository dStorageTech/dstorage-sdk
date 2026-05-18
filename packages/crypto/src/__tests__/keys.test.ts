import { describe, it, expect } from "vitest";
import { KeyDeriver } from "../keys.js";

// ── KeyDeriver ────────────────────────────────────────────────────────────────

describe("KeyDeriver", () => {
  it("throws if neither mnemonic nor seedHex is provided", () => {
    expect(() => new KeyDeriver({})).toThrow(
      "[dStorage/crypto] Either mnemonic or seedHex must be provided.",
    );
  });

  it("getSeed() returns a Uint8Array from a 32-byte hex seed", async () => {
    const SEED_HEX =
      "0000000000000000000000000000000000000000000000000000000000000001";
    const deriver = new KeyDeriver({ seedHex: SEED_HEX });
    const seed = await deriver.getSeed();
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.length).toBe(32);
  });

  it("getSeed() returns a Uint8Array from a valid BIP-39 mnemonic", async () => {
    const MNEMONIC =
      "credit pool deputy saddle drama govern plug cradle today skate wise like " +
      "bronze tackle normal split panel rabbit soldier join dragon dwarf foil humor";
    const deriver = new KeyDeriver({ mnemonic: MNEMONIC });
    const seed = await deriver.getSeed();
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.length).toBeGreaterThan(0);
  });

  it("rejects an invalid BIP-39 mnemonic", async () => {
    // 24 words but not a valid BIP-39 mnemonic — passes word-count check,
    // fails validateMnemonic inside getSeed().
    const invalid24 = Array(24).fill("notaword").join(" ");
    const deriver = new KeyDeriver({ mnemonic: invalid24 });
    await expect(deriver.getSeed()).rejects.toThrow(
      "[dStorage/crypto] Invalid BIP-39 mnemonic phrase.",
    );
  });

  // ── Security: mnemonic word-count enforcement ────────────────────────────────
  //
  // A 12-word BIP-39 mnemonic provides only 128-bit classical / 64-bit
  // post-quantum security — below NIST's 128-bit PQ minimum. KeyDeriver is
  // the lowest-level entry point for mnemonic-based key material (used by
  // the chain adapter for wallet keys as well as by MnemonicEncryptionAdapter).
  // Enforcing 24 words here ensures no caller can bypass the check regardless
  // of which code path they use.

  it("throws at construction when mnemonic has fewer than 24 words", () => {
    // Valid BIP-39 12-word mnemonic — would pass validateMnemonic but must be
    // rejected because of insufficient entropy for post-quantum security.
    const mnemonic12 =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(() => new KeyDeriver({ mnemonic: mnemonic12 })).toThrow(
      /24.word|mnemonic/i,
    );
  });

  it("throws at construction when mnemonic has exactly 23 words", () => {
    const mnemonic23 = Array(23).fill("abandon").join(" ");
    expect(() => new KeyDeriver({ mnemonic: mnemonic23 })).toThrow(
      /24.word|mnemonic/i,
    );
  });

  it("accepts a mnemonic with exactly 24 words", () => {
    const mnemonic24 = Array(23).fill("abandon").join(" ") + " art";
    expect(() => new KeyDeriver({ mnemonic: mnemonic24 })).not.toThrow();
  });

  it("rejects a seedHex that is not 32 or 64 bytes", async () => {
    const deriver = new KeyDeriver({ seedHex: "deadbeef" }); // 4 bytes
    await expect(deriver.getSeed()).rejects.toThrow(
      "[dStorage/crypto] seedHex must be 32 bytes",
    );
  });

  it("getSeed() is deterministic for the same hex seed", async () => {
    const SEED_HEX =
      "0000000000000000000000000000000000000000000000000000000000000001";
    const a = await new KeyDeriver({ seedHex: SEED_HEX }).getSeed();
    const b = await new KeyDeriver({ seedHex: SEED_HEX }).getSeed();
    expect(a).toEqual(b);
  });
});
