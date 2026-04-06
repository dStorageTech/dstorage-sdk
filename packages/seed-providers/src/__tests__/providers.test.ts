import { describe, it, expect } from "vitest";
import { MnemonicSeedProvider } from "../MnemonicSeedProvider.js";

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
