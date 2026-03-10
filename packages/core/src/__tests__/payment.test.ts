import { describe, it, expect } from "vitest";
import { buildCostEstimate, defaultChainToken, TOKENS } from "../payment.js";
import type { PaymentQuote } from "../payment.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeStorageQuote(overrides: Partial<PaymentQuote> = {}): PaymentQuote {
  return {
    token: "AR",
    amount: "0.001234",
    type: "storage",
    dataSizeBytes: 1024,
    expiresAt: Date.now() + 600_000,
    ...overrides,
  };
}

function makeChainQuote(overrides: Partial<PaymentQuote> = {}): PaymentQuote {
  return {
    token: "DUST",
    amount: "0.000500",
    type: "chain",
    dataSizeBytes: 1024,
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
  it("returns an object with storageCost, chainCost, fileSizeBytes, fileSizeDisplay", () => {
    const estimate = buildCostEstimate(
      makeStorageQuote(),
      makeChainQuote(),
      1024,
    );
    expect(estimate).toHaveProperty("storageCost");
    expect(estimate).toHaveProperty("chainCost");
    expect(estimate).toHaveProperty("fileSizeBytes");
    expect(estimate).toHaveProperty("fileSizeDisplay");
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

  it("fileSizeDisplay uses KB for files smaller than 1 MB", () => {
    const estimate = buildCostEstimate(
      makeStorageQuote(),
      makeChainQuote(),
      512 * 1024,
    ); // 512 KB
    expect(estimate.fileSizeDisplay).toMatch(/KB$/);
  });

  it("fileSizeDisplay uses MB for files >= 1 MB", () => {
    const estimate = buildCostEstimate(
      makeStorageQuote(),
      makeChainQuote(),
      1024 * 1024,
    ); // 1 MB
    expect(estimate.fileSizeDisplay).toMatch(/MB$/);
  });

  it('fileSizeDisplay shows "1.0 KB" for 1024 bytes', () => {
    const estimate = buildCostEstimate(
      makeStorageQuote(),
      makeChainQuote(),
      1024,
    );
    expect(estimate.fileSizeDisplay).toBe("1.0 KB");
  });

  it('fileSizeDisplay shows "1.00 MB" for 1 MB exactly', () => {
    const estimate = buildCostEstimate(
      makeStorageQuote(),
      makeChainQuote(),
      1024 * 1024,
    );
    expect(estimate.fileSizeDisplay).toBe("1.00 MB");
  });

  it('fileSizeDisplay shows "500.0 KB" for 512000 bytes', () => {
    const estimate = buildCostEstimate(
      makeStorageQuote(),
      makeChainQuote(),
      512_000,
    );
    // 512000 / 1024 = 500.0 KB
    expect(estimate.fileSizeDisplay).toBe("500.0 KB");
  });
});

// ── defaultChainToken ─────────────────────────────────────────────────────────

describe("defaultChainToken", () => {
  it("midnight → DUST", () => {
    expect(defaultChainToken("midnight")).toBe("DUST");
  });

  it("ethereum → ETH", () => {
    expect(defaultChainToken("ethereum")).toBe("ETH");
  });

  it("polygon → MATIC", () => {
    expect(defaultChainToken("polygon")).toBe("MATIC");
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
