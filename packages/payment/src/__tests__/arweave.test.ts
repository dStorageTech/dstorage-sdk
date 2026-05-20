/**
 * ArweavePaymentAdapter — unit tests
 */
import { describe, it, expect } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
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

// ── Content hash tagging in provideUploadData (M8) ───────────────────────────

function hexOf(data: Uint8Array): string {
  return Array.from(blake3(data))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("ArweavePaymentAdapter — provideUploadData content hash (M8)", () => {
  it("stores X-Content-Hash in metadata matching blake3 of the data", () => {
    const adapter = makeAdapter();
    const data = new TextEncoder().encode("hello arweave");
    adapter.provideUploadData(data, {});
    const pending = (
      adapter as unknown as {
        pendingUpload: { metadata: Record<string, string> };
      }
    ).pendingUpload;
    expect(pending.metadata["X-Content-Hash"]).toBe(hexOf(data));
  });

  it("X-Content-Hash is present even when caller passes no metadata", () => {
    const adapter = makeAdapter();
    const data = new Uint8Array([1, 2, 3, 4]);
    adapter.provideUploadData(data);
    const pending = (
      adapter as unknown as {
        pendingUpload: { metadata: Record<string, string> };
      }
    ).pendingUpload;
    expect(pending.metadata["X-Content-Hash"]).toBeDefined();
  });

  it("caller-supplied metadata is preserved alongside X-Content-Hash", () => {
    const adapter = makeAdapter();
    const data = new TextEncoder().encode("test");
    adapter.provideUploadData(data, { "dstorage-version": "0.1.0" });
    const pending = (
      adapter as unknown as {
        pendingUpload: { metadata: Record<string, string> };
      }
    ).pendingUpload;
    expect(pending.metadata["dstorage-version"]).toBe("0.1.0");
    expect(pending.metadata["X-Content-Hash"]).toBeDefined();
  });
});

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
