import { describe, it, expect } from "vitest";
import { connectDemoWallet, connectMetaMask } from "../wallet.js";

// ── connectDemoWallet ─────────────────────────────────────────────────────────

describe("connectDemoWallet", () => {
  it("returns a WalletInfo with the default address", async () => {
    const info = await connectDemoWallet();
    expect(info.address).toBe("0xDemoWallet1234");
  });

  it("accepts a custom address", async () => {
    const info = await connectDemoWallet("0xCustom");
    expect(info.address).toBe("0xCustom");
  });

  it('chainProvider is "mock"', async () => {
    const info = await connectDemoWallet();
    expect(info.chainProvider).toBe("mock");
  });

  it('_signatureHex starts with "0x"', async () => {
    const info = await connectDemoWallet();
    expect(info._signatureHex.startsWith("0x")).toBe(true);
  });

  it("_signatureHex is a non-empty string", async () => {
    const info = await connectDemoWallet();
    expect(info._signatureHex.length).toBeGreaterThan(2); // more than just "0x"
  });

  it("same address always produces the same _signatureHex (deterministic)", async () => {
    const a = await connectDemoWallet("0xAlice");
    const b = await connectDemoWallet("0xAlice");
    expect(a._signatureHex).toBe(b._signatureHex);
  });

  it("different addresses produce different _signatureHex values", async () => {
    const a = await connectDemoWallet("0xAlice");
    const b = await connectDemoWallet("0xBob");
    expect(a._signatureHex).not.toBe(b._signatureHex);
  });
});

// ── connectMetaMask ───────────────────────────────────────────────────────────

describe("connectMetaMask", () => {
  it("throws when window is not defined (Node.js environment)", async () => {
    // In Node.js, window is undefined — this should throw immediately.
    await expect(connectMetaMask()).rejects.toThrow(
      "[dStorage] MetaMask not detected",
    );
  });

  it("error message includes install link hint", async () => {
    await expect(connectMetaMask()).rejects.toThrow("metamask.io");
  });
});
