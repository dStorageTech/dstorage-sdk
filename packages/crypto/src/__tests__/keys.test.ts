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
    const deriver = new KeyDeriver({ mnemonic: "not a valid mnemonic phrase" });
    await expect(deriver.getSeed()).rejects.toThrow(
      "[dStorage/crypto] Invalid BIP-39 mnemonic phrase.",
    );
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
