import { describe, it, expect, vi } from "vitest";
import { MockStorageAdapter } from "../adapters/mock.js";
import { StorageErrorCode } from "../errors.js";

// Each test uses a fresh adapter instance.
// The module-level memoryStore is shared within this file but tests use
// unique IDs (from upload) so they don't interfere with each other.

describe("MockStorageAdapter", () => {
  it('name is "mock"', () => {
    const adapter = new MockStorageAdapter();
    expect(adapter.name).toBe("mock");
  });

  // ── upload ───────────────────────────────────────────────────────────────

  const enc = (s: string) => new TextEncoder().encode(s);

  describe("upload", () => {
    it("returns an UploadResult with all required fields", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.store(enc("hello world"));
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("provider");
      expect(result).toHaveProperty("cost");
      expect(result).toHaveProperty("uploadedAt");
    });

    it("id is a 43-char base64url string", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.store(enc("data"));
      expect(result.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('provider is "mock"', async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.store(enc("data"));
      expect(result.provider).toBe("mock");
    });

    it("cost is a StorageQuote with amount equal to byte length", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.store(enc("data"));
      expect(result.cost).toMatchObject({ token: "MOCK", amount: "4" });
    });

    it("uploadedAt is a recent timestamp", async () => {
      const before = Date.now();
      const adapter = new MockStorageAdapter();
      const result = await adapter.store(enc("data"));
      const after = Date.now();
      expect(result.uploadedAt).toBeGreaterThanOrEqual(before);
      expect(result.uploadedAt).toBeLessThanOrEqual(after);
    });

    it("each upload returns a unique id", async () => {
      const adapter = new MockStorageAdapter();
      const r1 = await adapter.store(enc("a"));
      const r2 = await adapter.store(enc("b"));
      const r3 = await adapter.store(enc("c"));
      const ids = new Set([r1.id, r2.id, r3.id]);
      expect(ids.size).toBe(3);
    });

    it("works with no metadata argument", async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.store(enc("data"))).resolves.toBeDefined();
    });

    it("works with empty metadata object", async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.store(enc("data"), {})).resolves.toBeDefined();
    });

    it("works with metadata key-value pairs", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.store(enc("data"), {
        "dstorage-version": "0.1.0",
        "dstorage-owner": "0xAlice",
      });
      expect(result.id).toBeDefined();
    });

    it("uploads empty Uint8Array without error", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.store(new Uint8Array(0));
      expect(result.id).toBeDefined();
    });

    it("uploads arbitrary binary data", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.store(new Uint8Array([0, 1, 2, 255]));
      expect(result.id).toBeDefined();
    });

    it("uploads JSON bytes", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.store(
        enc(JSON.stringify({ key: "value", nested: [1, 2, 3] })),
      );
      expect(result.id).toBeDefined();
    });
  });

  // ── retrieve ─────────────────────────────────────────────────────────────

  describe("retrieve", () => {
    it("returns the exact bytes that were uploaded", async () => {
      const adapter = new MockStorageAdapter();
      const data = enc("exact content match test");
      const { id } = await adapter.store(data);
      const { bytes } = await adapter.retrieve(id);
      expect(bytes).toEqual(data);
    });

    it("retrieves arbitrary binary data unchanged", async () => {
      const adapter = new MockStorageAdapter();
      const data = new Uint8Array([0, 1, 2, 128, 255]);
      const { id } = await adapter.store(data);
      const { bytes } = await adapter.retrieve(id);
      expect(bytes).toEqual(data);
    });

    it("retrieves empty Uint8Array correctly", async () => {
      const adapter = new MockStorageAdapter();
      const { id } = await adapter.store(new Uint8Array(0));
      const { bytes } = await adapter.retrieve(id);
      expect(bytes).toEqual(new Uint8Array(0));
    });

    it("throws for unknown id with the correct error message", async () => {
      const adapter = new MockStorageAdapter();
      await expect(
        adapter.retrieve("mock_nonexistent_id"),
      ).rejects.toMatchObject({
        code: StorageErrorCode.MOCK_DATA_NOT_FOUND,
        message: expect.stringContaining(
          "No data found for id: mock_nonexistent_id",
        ),
      });
    });

    it("throws for completely invalid id", async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.retrieve("garbage")).rejects.toMatchObject({
        code: StorageErrorCode.MOCK_DATA_NOT_FOUND,
        message: expect.stringContaining("[dStorage/mock]"),
      });
    });

    it("multiple items: each id retrieves its own data", async () => {
      const adapter = new MockStorageAdapter();
      const r1 = await adapter.store(enc("content A"));
      const r2 = await adapter.store(enc("content B"));
      const r3 = await adapter.store(enc("content C"));
      expect((await adapter.retrieve(r1.id)).bytes).toEqual(enc("content A"));
      expect((await adapter.retrieve(r2.id)).bytes).toEqual(enc("content B"));
      expect((await adapter.retrieve(r3.id)).bytes).toEqual(enc("content C"));
    });

    it("retrieve after multiple writes does not corrupt earlier entries", async () => {
      const adapter = new MockStorageAdapter();
      const { id: id1 } = await adapter.store(enc("first"));
      await adapter.store(enc("second"));
      await adapter.store(enc("third"));
      expect((await adapter.retrieve(id1)).bytes).toEqual(enc("first"));
    });
  });

  // ── estimateCost ──────────────────────────────────────────────────────────

  describe("estimateCost", () => {
    it("returns a StorageQuote with amount equal to byte length", async () => {
      const adapter = new MockStorageAdapter();
      const data = enc("any data");
      const quote = await adapter.estimateCost(data.byteLength);
      expect(quote).toMatchObject({
        token: "MOCK",
        amount: `${data.byteLength}`,
        provider: "mock",
      });
    });

    it("returns different amounts for different data sizes", async () => {
      const adapter = new MockStorageAdapter();
      const small = await adapter.estimateCost(enc("x").byteLength);
      const large = await adapter.estimateCost(1_000_000);
      expect(small.amount).not.toBe(large.amount);
    });

    it("returns '0' amount for empty input", async () => {
      const adapter = new MockStorageAdapter();
      const quote = await adapter.estimateCost(0);
      expect(quote.amount).toBe("0");
    });
  });

  // ── listAll ───────────────────────────────────────────────────────────────

  describe("listAll", () => {
    it("returns an array", async () => {
      const adapter = new MockStorageAdapter();
      expect(Array.isArray(adapter.listAll())).toBe(true);
    });

    it("includes the id of an uploaded item", async () => {
      const adapter = new MockStorageAdapter();
      const { id } = await adapter.store(enc("list-test-data"));
      expect(adapter.listAll()).toContain(id);
    });

    it("includes all uploaded ids", async () => {
      const adapter = new MockStorageAdapter();
      const r1 = await adapter.store(enc("list-a"));
      const r2 = await adapter.store(enc("list-b"));
      const all = adapter.listAll();
      expect(all).toContain(r1.id);
      expect(all).toContain(r2.id);
    });
  });

  describe("managed payment", () => {
    it("defaults to a local MockPaymentAdapter with network mock", () => {
      const adapter = new MockStorageAdapter();
      expect(adapter.paymentAdapter.network).toBe("mock");
      expect(adapter.paymentAdapter.type).toBe("storage");
    });

    it("signingServerUrl + authToken switches to ManagedPaymentAdapter with network managedmock", () => {
      const adapter = new MockStorageAdapter({
        managedPayment: {
          signingServerUrl: "https://signing.example.com",
          authToken: "tok_abc123",
        },
      });
      expect(adapter.paymentAdapter.network).toBe("managedmock");
      expect(adapter.paymentAdapter.type).toBe("storage");
    });

    it("signingServerUrl without authToken throws MOCK_AUTH_TOKEN_REQUIRED", () => {
      expect(
        () =>
          new MockStorageAdapter({
            // @ts-expect-error — intentionally omitting required authToken to test runtime guard
            managedPayment: { signingServerUrl: "https://signing.example.com" },
          }),
      ).toThrow(
        expect.objectContaining({
          code: StorageErrorCode.MOCK_AUTH_TOKEN_REQUIRED,
        }),
      );
    });

    it("store() passes a BLAKE3 hash of the content as txData", async () => {
      const adapter = new MockStorageAdapter();
      const paySpy = vi.spyOn(adapter.paymentAdapter, "pay");
      await adapter.store(enc("hello world"));
      expect(paySpy).toHaveBeenCalledTimes(1);
      const txData = paySpy.mock.calls[0]?.[0].txData;
      expect(typeof txData).toBe("string");
      expect(txData).toMatch(/^[0-9a-f]{64}$/);
    });

    it("store() sends the same txData for identical content", async () => {
      const adapter = new MockStorageAdapter();
      const paySpy = vi.spyOn(adapter.paymentAdapter, "pay");
      await adapter.store(enc("same content"));
      await adapter.store(enc("same content"));
      const [first, second] = paySpy.mock.calls.map((call) => call[0].txData);
      expect(first).toBe(second);
    });

    it("store() sends different txData for different content", async () => {
      const adapter = new MockStorageAdapter();
      const paySpy = vi.spyOn(adapter.paymentAdapter, "pay");
      await adapter.store(enc("content A"));
      await adapter.store(enc("content B"));
      const [first, second] = paySpy.mock.calls.map((call) => call[0].txData);
      expect(first).not.toBe(second);
    });
  });
});
