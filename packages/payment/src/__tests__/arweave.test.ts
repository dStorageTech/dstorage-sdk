/**
 * ArweavePaymentAdapter — unit tests
 */
import { describe, it, expect } from "vitest";
import { ArweavePaymentAdapter } from "../adapters/arweave.js";
import type { PaymentQuote } from "../types.js";

function makeAdapter() {
  return new ArweavePaymentAdapter();
}

function makeQuote(overrides: Partial<PaymentQuote> = {}): PaymentQuote {
  return {
    token: "AR",
    amount: "0.000001",
    network: "arweave",
    type: "storage",
    dataSizeBytes: 1024,
    expiresAt: Date.now() + 120_000,
    ...overrides,
  };
}

// ── Quote TTL enforcement (M11) ───────────────────────────────────────────────

describe("ArweavePaymentAdapter — quote TTL", () => {
  it("pay() throws when the quote has already expired", async () => {
    const adapter = makeAdapter();
    const expiredQuote = makeQuote({ expiresAt: Date.now() - 1 });
    await expect(adapter.pay(expiredQuote)).rejects.toThrow(
      "[dStorage/payment]",
    );
  });

  it("pay() error message mentions expiry", async () => {
    const adapter = makeAdapter();
    const expiredAt = Date.now() - 5_000;
    const expiredQuote = makeQuote({ expiresAt: expiredAt });
    await expect(adapter.pay(expiredQuote)).rejects.toThrow(/expir/i);
  });

  it("pay() does not throw for a quote that is still valid", async () => {
    const adapter = makeAdapter();
    const validQuote = makeQuote({ expiresAt: Date.now() + 60_000 });
    // pay() will fail later (no Arweave client / no wallet key) — that's fine;
    // the important assertion is that it does NOT throw an expiry error.
    const result = await adapter.pay(validQuote).catch((err: unknown) => err);
    if (result instanceof Error) {
      expect(result.message).not.toMatch(/expir/i);
    }
  });
});
