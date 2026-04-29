import { describe, it, expect } from "vitest";
import { MockStorageAdapter } from "../adapters/mock.js";

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
      const result = await adapter.upload(enc("hello world"));
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("provider");
      expect(result).toHaveProperty("cost");
      expect(result).toHaveProperty("uploadedAt");
    });

    it("id is a 43-char base64url string", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload(enc("data"));
      expect(result.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('provider is "mock"', async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload(enc("data"));
      expect(result.provider).toBe("mock");
    });

    it("cost is a StorageQuote with amount equal to byte length", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload(enc("data"));
      expect(result.cost).toMatchObject({ token: "MOCK", amount: "4" });
    });

    it("uploadedAt is a recent timestamp", async () => {
      const before = Date.now();
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload(enc("data"));
      const after = Date.now();
      expect(result.uploadedAt).toBeGreaterThanOrEqual(before);
      expect(result.uploadedAt).toBeLessThanOrEqual(after);
    });

    it("each upload returns a unique id", async () => {
      const adapter = new MockStorageAdapter();
      const r1 = await adapter.upload(enc("a"));
      const r2 = await adapter.upload(enc("b"));
      const r3 = await adapter.upload(enc("c"));
      const ids = new Set([r1.id, r2.id, r3.id]);
      expect(ids.size).toBe(3);
    });

    it("works with no metadata argument", async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.upload(enc("data"))).resolves.toBeDefined();
    });

    it("works with empty metadata object", async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.upload(enc("data"), {})).resolves.toBeDefined();
    });

    it("works with metadata key-value pairs", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload(enc("data"), {
        "dstorage-version": "0.1.0",
        "dstorage-owner": "0xAlice",
      });
      expect(result.id).toBeDefined();
    });

    it("uploads empty Uint8Array without error", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload(new Uint8Array(0));
      expect(result.id).toBeDefined();
    });

    it("uploads arbitrary binary data", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload(new Uint8Array([0, 1, 2, 255]));
      expect(result.id).toBeDefined();
    });

    it("uploads JSON bytes", async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload(
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
      const { id } = await adapter.upload(data);
      const retrieved = await adapter.retrieve(id);
      expect(retrieved).toEqual(data);
    });

    it("retrieves arbitrary binary data unchanged", async () => {
      const adapter = new MockStorageAdapter();
      const data = new Uint8Array([0, 1, 2, 128, 255]);
      const { id } = await adapter.upload(data);
      const retrieved = await adapter.retrieve(id);
      expect(retrieved).toEqual(data);
    });

    it("retrieves empty Uint8Array correctly", async () => {
      const adapter = new MockStorageAdapter();
      const { id } = await adapter.upload(new Uint8Array(0));
      const retrieved = await adapter.retrieve(id);
      expect(retrieved).toEqual(new Uint8Array(0));
    });

    it("throws for unknown id with the correct error message", async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.retrieve("mock_nonexistent_id")).rejects.toThrow(
        "[dStorage/mock] No data found for id: mock_nonexistent_id. Was it uploaded in this session?",
      );
    });

    it("throws for completely invalid id", async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.retrieve("garbage")).rejects.toThrow(
        "[dStorage/mock]",
      );
    });

    it("multiple items: each id retrieves its own data", async () => {
      const adapter = new MockStorageAdapter();
      const r1 = await adapter.upload(enc("content A"));
      const r2 = await adapter.upload(enc("content B"));
      const r3 = await adapter.upload(enc("content C"));
      expect(await adapter.retrieve(r1.id)).toEqual(enc("content A"));
      expect(await adapter.retrieve(r2.id)).toEqual(enc("content B"));
      expect(await adapter.retrieve(r3.id)).toEqual(enc("content C"));
    });

    it("retrieve after multiple writes does not corrupt earlier entries", async () => {
      const adapter = new MockStorageAdapter();
      const { id: id1 } = await adapter.upload(enc("first"));
      await adapter.upload(enc("second"));
      await adapter.upload(enc("third"));
      expect(await adapter.retrieve(id1)).toEqual(enc("first"));
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
      const { id } = await adapter.upload(enc("list-test-data"));
      expect(adapter.listAll()).toContain(id);
    });

    it("includes all uploaded ids", async () => {
      const adapter = new MockStorageAdapter();
      const r1 = await adapter.upload(enc("list-a"));
      const r2 = await adapter.upload(enc("list-b"));
      const all = adapter.listAll();
      expect(all).toContain(r1.id);
      expect(all).toContain(r2.id);
    });
  });
});
