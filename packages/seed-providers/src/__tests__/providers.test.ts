import { describe, it, expect, vi, beforeEach } from "vitest";
import { DemoSeedProvider } from "../DemoSeedProvider.js";
import { MnemonicSeedProvider } from "../MnemonicSeedProvider.js";
import { MidnightConnectorSeedProvider } from "../MidnightConnectorSeedProvider.js";

// ---------------------------------------------------------------------------
// DemoSeedProvider
// ---------------------------------------------------------------------------

describe("DemoSeedProvider", () => {
  it("same address → same seed (determinism)", async () => {
    const p = new DemoSeedProvider("0xTestAddress");
    const a = await p.getSeed();
    const b = await p.getSeed();
    expect(a).toEqual(b);
  });

  it("different address → different seed", async () => {
    const a = await new DemoSeedProvider("0xAddress1").getSeed();
    const b = await new DemoSeedProvider("0xAddress2").getSeed();
    expect(a).not.toEqual(b);
  });

  it("default address → produces a 32-byte Uint8Array", async () => {
    const seed = await new DemoSeedProvider().getSeed();
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.byteLength).toBe(32);
  });
});

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

// ---------------------------------------------------------------------------
// MidnightConnectorSeedProvider
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("MidnightConnectorSeedProvider", () => {
  const VERIFYING_KEY_HEX = "0xdeadbeefcafe0102030405060708090a";

  function mockMidnight(verifyingKeyHex: string) {
    const api = {
      signData: vi.fn().mockResolvedValue({ verifyingKey: verifyingKeyHex }),
    };
    const wallet = {
      connect: vi.fn().mockResolvedValue(api),
    };
    vi.stubGlobal("window", {
      midnight: { mnLace: wallet },
    });
    return { wallet, api };
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("same verifyingKey → same seed (determinism)", async () => {
    mockMidnight(VERIFYING_KEY_HEX);
    const a = await new MidnightConnectorSeedProvider().getSeed();

    mockMidnight(VERIFYING_KEY_HEX);
    const b = await new MidnightConnectorSeedProvider().getSeed();

    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it("throws if window.midnight is undefined", async () => {
    vi.stubGlobal("window", {});
    await expect(new MidnightConnectorSeedProvider().getSeed()).rejects.toThrow(
      "Midnight wallet not detected",
    );
  });

  it("throws if no compatible wallets found", async () => {
    vi.stubGlobal("window", { midnight: {} });
    await expect(new MidnightConnectorSeedProvider().getSeed()).rejects.toThrow(
      "No compatible Midnight wallets found",
    );
  });

  it("error from signData() propagates", async () => {
    const api = {
      signData: vi.fn().mockRejectedValue(new Error("user rejected")),
    };
    vi.stubGlobal("window", {
      midnight: {
        mnLace: { connect: vi.fn().mockResolvedValue(api) },
      },
    });
    await expect(new MidnightConnectorSeedProvider().getSeed()).rejects.toThrow(
      "user rejected",
    );
  });
});
