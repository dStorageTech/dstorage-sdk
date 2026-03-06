import { describe, it, expect } from "vitest";
import { MockChainAdapter } from "../adapters/mock.js";

// Module-level refs/permissions Maps are shared within this file but fresh
// per test file (vitest isolates module state between files).
// Tests use unique owner addresses and refIds to avoid interference.

function uniqueRef(suffix: string) {
  return {
    storageId: `store_${suffix}`,
    storageProvider: "mock",
    owner: `0xOwner_${suffix}`,
    writtenAt: Date.now(),
  };
}

describe("MockChainAdapter", () => {
  it('name is "mock"', () => {
    const adapter = new MockChainAdapter();
    expect(adapter.name).toBe("mock");
  });

  // ── writeReference ────────────────────────────────────────────────────────

  describe("writeReference", () => {
    it("returns a ChainWriteResult with refId, provider, writtenAt", async () => {
      const adapter = new MockChainAdapter();
      const result = await adapter.writeReference(uniqueRef("wr1"));
      expect(result).toHaveProperty("refId");
      expect(result).toHaveProperty("provider");
      expect(result).toHaveProperty("writtenAt");
    });

    it('refId starts with "ref_"', async () => {
      const adapter = new MockChainAdapter();
      const result = await adapter.writeReference(uniqueRef("wr2"));
      expect(result.refId.startsWith("ref_")).toBe(true);
    });

    it('provider is "mock"', async () => {
      const adapter = new MockChainAdapter();
      const result = await adapter.writeReference(uniqueRef("wr3"));
      expect(result.provider).toBe("mock");
    });

    it("writtenAt is a recent timestamp", async () => {
      const before = Date.now();
      const adapter = new MockChainAdapter();
      const result = await adapter.writeReference(uniqueRef("wr4"));
      const after = Date.now();
      expect(result.writtenAt).toBeGreaterThanOrEqual(before);
      expect(result.writtenAt).toBeLessThanOrEqual(after);
    });

    it("successive writes return unique refIds", async () => {
      const adapter = new MockChainAdapter();
      const r1 = await adapter.writeReference(uniqueRef("wr5a"));
      const r2 = await adapter.writeReference(uniqueRef("wr5b"));
      const r3 = await adapter.writeReference(uniqueRef("wr5c"));
      const ids = new Set([r1.refId, r2.refId, r3.refId]);
      expect(ids.size).toBe(3);
    });

    it("overrides writtenAt with current timestamp", async () => {
      const adapter = new MockChainAdapter();
      const ref = { ...uniqueRef("wr6"), writtenAt: 1 }; // old timestamp
      const before = Date.now();
      await adapter.writeReference(ref);
      const stored = await adapter.readReference(
        (await adapter.writeReference(uniqueRef("wr6b"))).refId,
      );
      expect(stored.writtenAt).toBeGreaterThanOrEqual(before);
    });

    it("writes a reference with optional dataLabel", async () => {
      const adapter = new MockChainAdapter();
      const ref = { ...uniqueRef("wr7"), dataLabel: "insurance-card" };
      const result = await adapter.writeReference(ref);
      const stored = await adapter.readReference(result.refId);
      expect(stored.dataLabel).toBe("insurance-card");
    });
  });

  // ── readReference ─────────────────────────────────────────────────────────

  describe("readReference", () => {
    it("returns the stored ChainReference", async () => {
      const adapter = new MockChainAdapter();
      const ref = uniqueRef("rr1");
      const { refId } = await adapter.writeReference(ref);
      const stored = await adapter.readReference(refId);
      expect(stored.storageId).toBe(ref.storageId);
      expect(stored.storageProvider).toBe(ref.storageProvider);
      expect(stored.owner).toBe(ref.owner);
    });

    it("throws for unknown refId with descriptive message", async () => {
      const adapter = new MockChainAdapter();
      await expect(adapter.readReference("ref_nonexistent")).rejects.toThrow(
        "[dStorage/mock-chain] No reference found for refId: ref_nonexistent",
      );
    });

    it("returns the exact reference data (no mutation)", async () => {
      const adapter = new MockChainAdapter();
      const ref = {
        storageId: "sid_rr3",
        storageProvider: "arweave",
        owner: "0xOwner_rr3",
        writtenAt: Date.now(),
      };
      const { refId } = await adapter.writeReference(ref);
      const stored = await adapter.readReference(refId);
      expect(stored.storageId).toBe("sid_rr3");
      expect(stored.storageProvider).toBe("arweave");
      expect(stored.owner).toBe("0xOwner_rr3");
    });
  });

  // ── listReferences ────────────────────────────────────────────────────────

  describe("listReferences", () => {
    it("returns an array", async () => {
      const adapter = new MockChainAdapter();
      const all = await adapter.listReferences();
      expect(Array.isArray(all)).toBe(true);
    });

    it("includes a newly written reference", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(uniqueRef("all1"));
      const all = await adapter.listReferences();
      const found = all.find((r) => r.refId === refId);
      expect(found).toBeDefined();
      expect(found?.storageId).toBe("store_all1");
    });

    it("includes all written references", async () => {
      const adapter = new MockChainAdapter();
      const r1 = await adapter.writeReference(uniqueRef("all2a"));
      const r2 = await adapter.writeReference(uniqueRef("all2b"));
      const all = await adapter.listReferences();
      expect(all.some((r) => r.refId === r1.refId)).toBe(true);
      expect(all.some((r) => r.refId === r2.refId)).toBe(true);
    });
  });
});
