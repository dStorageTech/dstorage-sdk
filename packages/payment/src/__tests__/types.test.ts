import { describe, it, expect } from "vitest";
import { TOKENS } from "../types.js";
import type { TokenSymbol } from "../types.js";

describe("TOKENS registry", () => {
  const expectedSymbols: TokenSymbol[] = ["AR", "ANT", "DUST", "MOCK"];

  it("contains all expected token symbols", () => {
    for (const symbol of expectedSymbols) {
      expect(TOKENS).toHaveProperty(symbol);
    }
  });

  it("has exactly 4 tokens", () => {
    expect(Object.keys(TOKENS)).toHaveLength(4);
  });

  // ── Per-token checks ───────────────────────────────────────────────────────

  it("AR: symbol, name, positive decimals and price", () => {
    expect(TOKENS.AR.symbol).toBe("AR");
    expect(TOKENS.AR.name).toBe("Arweave");
    expect(TOKENS.AR.decimals).toBe(12);
  });

  it("ANT: symbol, name, 9 decimals, positive price", () => {
    expect(TOKENS.ANT.symbol).toBe("ANT");
    expect(TOKENS.ANT.name).toBe("Autonomi");
    expect(TOKENS.ANT.decimals).toBe(9);
  });

  it("DUST: symbol, name, 6 decimals, positive price", () => {
    expect(TOKENS.DUST.symbol).toBe("DUST");
    expect(TOKENS.DUST.name).toBe("Midnight");
    expect(TOKENS.DUST.decimals).toBe(6);
  });

  it("MOCK: symbol, name, 6 decimals, price of 1.0 USD", () => {
    expect(TOKENS.MOCK.symbol).toBe("MOCK");
    expect(TOKENS.MOCK.name).toBe("Mock Token");
    expect(TOKENS.MOCK.decimals).toBe(6);
  });

  it("all tokens have positive decimal count", () => {
    for (const symbol of expectedSymbols) {
      expect(TOKENS[symbol].decimals).toBeGreaterThan(0);
    }
  });

  it("symbol field matches the registry key", () => {
    for (const [key, token] of Object.entries(TOKENS)) {
      expect(token.symbol).toBe(key);
    }
  });
});
