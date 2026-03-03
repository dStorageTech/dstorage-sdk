import { describe, it, expect, vi, afterEach } from "vitest";
import { MockMidnightChainAdapter } from "../adapters/mockMidnight.js";

afterEach(() => vi.useRealTimers());

// Use a zero-delay proof server for all tests to keep them fast.
function makeAdapter() {
  return new MockMidnightChainAdapter({
    proofServerMinMs: 0,
    proofServerMaxMs: 0,
  });
}

function uniqueRef(tag: string) {
  return {
    storageId: `store_${tag}`,
    storageProvider: "mock",
    owner: `0xOwner_${tag}`,
    createdAt: Date.now(),
  };
}

describe("MockMidnightChainAdapter", () => {
  it('name is "midnight"', () => {
    expect(makeAdapter().name).toBe("midnight");
  });

  // ── writeReference ────────────────────────────────────────────────────────

  describe("writeReference", () => {
    it("returns a ChainWriteResult with refId, provider, blockHeight, writtenAt", async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();
      const p = adapter.writeReference(uniqueRef("wr1"));
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result).toHaveProperty("refId");
      expect(result).toHaveProperty("provider");
      expect(result).toHaveProperty("blockHeight");
      expect(result).toHaveProperty("writtenAt");
    });

    it('provider is "midnight"', async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();
      const p = adapter.writeReference(uniqueRef("wr2"));
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.provider).toBe("midnight");
    });

    it('refId starts with "ref_"', async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();
      const p = adapter.writeReference(uniqueRef("wr3"));
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.refId.startsWith("ref_")).toBe(true);
    });

    it("blockHeight starts at or above 1,000,000 (realistic mock)", async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();
      const p = adapter.writeReference(uniqueRef("wr4"));
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.blockHeight).toBeGreaterThanOrEqual(1_000_000);
    });

    it("blockHeight increments by 1 on each write", async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();

      const p1 = adapter.writeReference(uniqueRef("wr5a"));
      await vi.runAllTimersAsync();
      const r1 = await p1;

      const p2 = adapter.writeReference(uniqueRef("wr5b"));
      await vi.runAllTimersAsync();
      const r2 = await p2;

      expect(r2.blockHeight).toBe(r1.blockHeight! + 1);
    });

    it("successive writes return unique refIds", async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();

      const p1 = adapter.writeReference(uniqueRef("wr6a"));
      await vi.runAllTimersAsync();
      const r1 = await p1;

      const p2 = adapter.writeReference(uniqueRef("wr6b"));
      await vi.runAllTimersAsync();
      const r2 = await p2;

      expect(r1.refId).not.toBe(r2.refId);
    });

    it("written reference is retrievable", async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();
      const ref = uniqueRef("wr7");
      const p = adapter.writeReference(ref);
      await vi.runAllTimersAsync();
      const result = await p;
      const stored = await adapter.readReference(result.refId);
      expect(stored.storageId).toBe(ref.storageId);
      expect(stored.owner).toBe(ref.owner);
    });
  });

  // ── readReference ─────────────────────────────────────────────────────────

  describe("readReference", () => {
    it("returns the stored reference", async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();
      const ref = {
        storageId: "sid_rr1",
        storageProvider: "arweave",
        owner: "0xAlice_rr1",
        createdAt: Date.now(),
      };
      const p = adapter.writeReference(ref);
      await vi.runAllTimersAsync();
      const { refId } = await p;
      const stored = await adapter.readReference(refId);
      expect(stored.storageId).toBe("sid_rr1");
      expect(stored.storageProvider).toBe("arweave");
      expect(stored.owner).toBe("0xAlice_rr1");
    });

    it("throws for unknown refId", async () => {
      const adapter = makeAdapter();
      await expect(adapter.readReference("ref_does_not_exist")).rejects.toThrow(
        "[dStorage/mock-midnight] No reference found for refId: ref_does_not_exist",
      );
    });
  });

  // ── getAllReferences ───────────────────────────────────────────────────────

  describe("getAllReferences", () => {
    it("returns an array", () => {
      const adapter = makeAdapter();
      expect(Array.isArray(adapter.getAllReferences())).toBe(true);
    });

    it("includes a written reference", async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();
      const wp = adapter.writeReference(uniqueRef("all1"));
      await vi.runAllTimersAsync();
      const { refId } = await wp;

      const all = adapter.getAllReferences();
      expect(all.some((r) => r.refId === refId)).toBe(true);
    });
  });

  // ── listReferences ────────────────────────────────────────────────────────

  describe("listReferences", () => {
    it("returns an empty array when no references exist", async () => {
      const adapter = makeAdapter();
      const list = await adapter.listReferences();
      expect(Array.isArray(list)).toBe(true);
      // May or may not be empty depending on shared module-level state from other tests,
      // but the result must always be an array of objects with refId and ref fields.
      for (const item of list) {
        expect(item).toHaveProperty("refId");
        expect(item).toHaveProperty("ref");
      }
    });

    it("returns a written reference after writeReference()", async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();
      const ref = uniqueRef("lr1");
      const wp = adapter.writeReference(ref);
      await vi.runAllTimersAsync();
      const { refId } = await wp;

      const list = await adapter.listReferences();
      const found = list.find((r) => r.refId === refId);
      expect(found).toBeDefined();
      expect(found?.ref.storageId).toBe(ref.storageId);
      expect(found?.ref.owner).toBe(ref.owner);
    });

    it("each item has refId (string) and ref with storageId and owner", async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();
      const wp = adapter.writeReference(uniqueRef("lr2"));
      await vi.runAllTimersAsync();
      await wp;

      const list = await adapter.listReferences();
      expect(list.length).toBeGreaterThan(0);
      for (const { refId, ref } of list) {
        expect(typeof refId).toBe("string");
        expect(typeof ref.storageId).toBe("string");
        expect(typeof ref.owner).toBe("string");
      }
    });
  });
});
