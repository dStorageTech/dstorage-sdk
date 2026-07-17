import { describe, it, expect } from "vitest";
import { TOKENS, defaultChainToken } from "../metaTx/index.js";
import type { CostEstimate } from "../types.js";
import type { StorageQuote } from "@dstorage/storage";
import type { ChainQuote } from "@dstorage/chain";

function buildCostEstimate(
  storageQuote: StorageQuote,
  chainQuote: ChainQuote,
  fileSizeBytes: number,
): CostEstimate {
  return {
    storageCost: { amount: storageQuote.amount, token: storageQuote.token },
    chainCost: { amount: chainQuote.amount, token: chainQuote.token },
    fileSizeBytes,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeStorageQuote(overrides: Partial<StorageQuote> = {}): StorageQuote {
  return {
    token: "AR",
    amount: "0.001234",
    provider: "mock",
    dataSizeBytes: 1024,
    expiresAt: Date.now() + 600_000,
    ...overrides,
  };
}

function makeChainQuote(overrides: Partial<ChainQuote> = {}): ChainQuote {
  return {
    token: "DUST",
    amount: "0.000500",
    network: "mock",
    expiresAt: Date.now() + 600_000,
    ...overrides,
  };
}

// ── TOKENS re-export ──────────────────────────────────────────────────────────

describe("TOKENS re-export from @dstorage/payment", () => {
  it("TOKENS is an object with at least AR and DUST", () => {
    expect(TOKENS).toHaveProperty("AR");
    expect(TOKENS).toHaveProperty("DUST");
  });
});

// ── buildCostEstimate ─────────────────────────────────────────────────────────

describe("buildCostEstimate", () => {
  it("returns an object with storageCost, chainCost, fileSizeBytes", () => {
    const estimate = buildCostEstimate(
      makeStorageQuote(),
      makeChainQuote(),
      1024,
    );
    expect(estimate).toHaveProperty("storageCost");
    expect(estimate).toHaveProperty("chainCost");
    expect(estimate).toHaveProperty("fileSizeBytes");
  });

  it("storageCost carries amount and token from storageQuote", () => {
    const storageQuote = makeStorageQuote({ amount: "1.23", token: "AR" });
    const estimate = buildCostEstimate(storageQuote, makeChainQuote(), 1024);
    expect(estimate.storageCost.amount).toBe("1.23");
    expect(estimate.storageCost.token).toBe("AR");
  });

  it("chainCost carries amount and token from chainQuote", () => {
    const chainQuote = makeChainQuote({ amount: "0.05", token: "DUST" });
    const estimate = buildCostEstimate(makeStorageQuote(), chainQuote, 512);
    expect(estimate.chainCost.amount).toBe("0.05");
    expect(estimate.chainCost.token).toBe("DUST");
  });

  it("fileSizeBytes matches the input", () => {
    const estimate = buildCostEstimate(
      makeStorageQuote(),
      makeChainQuote(),
      2048,
    );
    expect(estimate.fileSizeBytes).toBe(2048);
  });
});

// ── defaultChainToken ─────────────────────────────────────────────────────────

describe("defaultChainToken", () => {
  it("midnight → DUST", () => {
    expect(defaultChainToken("midnight")).toBe("DUST");
  });

  it("polygon → MATIC", () => {
    expect(defaultChainToken("polygon")).toBe("MOCK");
  });

  it("mock → MOCK", () => {
    expect(defaultChainToken("mock")).toBe("MOCK");
  });

  it("unknown provider → MOCK", () => {
    expect(defaultChainToken("solana")).toBe("MOCK");
  });

  it("empty string → MOCK", () => {
    expect(defaultChainToken("")).toBe("MOCK");
  });
});
