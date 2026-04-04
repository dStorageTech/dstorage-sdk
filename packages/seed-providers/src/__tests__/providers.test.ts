import { describe, it, expect, vi, beforeEach } from "vitest";
import { DemoSeedProvider } from "../DemoSeedProvider.js";
import { MnemonicSeedProvider } from "../MnemonicSeedProvider.js";
import { MetaMaskSeedProvider } from "../MetaMaskSeedProvider.js";
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
// MetaMaskSeedProvider
// ---------------------------------------------------------------------------

// secp256k1 curve order
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);

/** Build a 65-byte signature: r(32) || s(32) || v(1) */
function buildSig(r: bigint, s: bigint, v: number): string {
  const buf = new Uint8Array(65);
  // write r (bytes 0–31, big-endian)
  let tmp = r;
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  // write s (bytes 32–63, big-endian)
  tmp = s;
  for (let i = 63; i >= 32; i--) {
    buf[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  buf[64] = v;
  return (
    "0x" +
    Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("MetaMaskSeedProvider", () => {
  // Arbitrary r and v values for test signatures
  const R = BigInt(
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  );
  const V = 27;

  // A low-s value (s ≤ n/2)
  const S_LOW = BigInt(
    "0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0",
  ); // = (n-1)/2, definitely ≤ n/2
  // The corresponding high-s value
  const S_HIGH = SECP256K1_N - S_LOW;

  const LOW_SIG_HEX = buildSig(R, S_LOW, V);
  const HIGH_SIG_HEX = buildSig(R, S_HIGH, V);

  function mockEthereum(signatureHex: string) {
    const ethereum = {
      request: vi.fn().mockImplementation(({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") return Promise.resolve(["0xAbc"]);
        if (method === "personal_sign") return Promise.resolve(signatureHex);
        return Promise.reject(new Error(`Unknown method: ${method}`));
      }),
    };
    vi.stubGlobal("window", { ethereum });
    return ethereum;
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("high-s signature produces the same seed as the low-s signature", async () => {
    mockEthereum(LOW_SIG_HEX);
    const seedLow = await new MetaMaskSeedProvider().getSeed();

    mockEthereum(HIGH_SIG_HEX);
    const seedHigh = await new MetaMaskSeedProvider().getSeed();

    expect(bytesToHex(seedLow)).toBe(bytesToHex(seedHigh));
  });

  it("already-canonical (low-s) signature passes through unchanged", async () => {
    mockEthereum(LOW_SIG_HEX);
    const seed = await new MetaMaskSeedProvider().getSeed();

    // The s bytes in the output should equal S_LOW
    let s = 0n;
    for (let i = 32; i < 64; i++) {
      s = (s << 8n) | BigInt(seed[i]!);
    }
    expect(s).toBe(S_LOW);
  });

  it("throws if window.ethereum is undefined", async () => {
    vi.stubGlobal("window", {});
    await expect(new MetaMaskSeedProvider().getSeed()).rejects.toThrow(
      "MetaMask not detected",
    );
  });

  it("throws if no accounts are returned", async () => {
    vi.stubGlobal("window", {
      ethereum: {
        request: vi
          .fn()
          .mockImplementation(({ method }: { method: string }) => {
            if (method === "eth_requestAccounts") return Promise.resolve([]);
            return Promise.resolve("0xdeadbeef");
          }),
      },
    });
    await expect(new MetaMaskSeedProvider().getSeed()).rejects.toThrow(
      "No accounts returned",
    );
  });
});

// ---------------------------------------------------------------------------
// MidnightConnectorSeedProvider
// ---------------------------------------------------------------------------

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
