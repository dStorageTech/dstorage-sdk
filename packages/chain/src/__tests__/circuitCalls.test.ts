/**
 * Additional writeReference tests for MockMidnightChainAdapter.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { MockMidnightChainAdapter } from "../adapters/mockMidnight.js";

afterEach(() => vi.useRealTimers());

function makeRef(tag: string) {
  return {
    storageId: `store_${tag}`,
    storageProvider: "mock",
    owner: `0xOwner_${tag}`,
    writtenAt: Date.now(),
    keyEnvelope:
      '{"v":1,"wrappers":[{"wrapKeyName":"test","algorithm":"xchacha20poly1305-v1","kekDerivation":"hkdf-sha256-v1","wrappedDek":"AAAA"}]}',
  };
}

// ── MockMidnightChainAdapter ─────────────────────────────────────────────────

describe("MockMidnightChainAdapter.writeReference", () => {
  it("returns a ChainWriteResult with refId, blockHeight, and writtenAt", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const p = adapter.writeReference(makeRef("cc1"));
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result).toHaveProperty("refId");
    expect(result).toHaveProperty("blockHeight");
    expect(result).toHaveProperty("writtenAt");
  });

  it('refId starts with "ref_"', async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const p = adapter.writeReference(makeRef("cc2"));
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.refId.startsWith("ref_")).toBe(true);
  });

  it("blockHeight is a number at or above 1,000,000", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const p = adapter.writeReference(makeRef("cc3"));
    await vi.runAllTimersAsync();
    const result = await p;

    expect(typeof result.blockHeight).toBe("number");
    expect(result.blockHeight!).toBeGreaterThanOrEqual(1_000_000);
  });

  it("writtenAt is a Unix timestamp (number)", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const p = adapter.writeReference(makeRef("cc4"));
    await vi.runAllTimersAsync();
    const result = await p;

    expect(typeof result.writtenAt).toBe("number");
  });

  it("successive calls return different refIds", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const p1 = adapter.writeReference(makeRef("cc5a"));
    await vi.runAllTimersAsync();
    const r1 = await p1;

    vi.advanceTimersByTime(1); // ensure Date.now() differs
    const p2 = adapter.writeReference(makeRef("cc5b"));
    await vi.runAllTimersAsync();
    const r2 = await p2;

    expect(r1.refId).not.toBe(r2.refId);
  });

  it("blockHeight increments on each write call", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const p1 = adapter.writeReference(makeRef("cc6a"));
    await vi.runAllTimersAsync();
    const r1 = await p1;

    const p2 = adapter.writeReference(makeRef("cc6b"));
    await vi.runAllTimersAsync();
    const r2 = await p2;

    expect(r2.blockHeight).toBe(r1.blockHeight! + 1);
  });

  it("accepts references with various storage providers", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const p = adapter.writeReference({
      storageId: "ref_abc",
      storageProvider: "arweave",
      owner: "0xAlice",
      writtenAt: Date.now(),
      keyEnvelope:
        '{"v":1,"wrappers":[{"wrapKeyName":"test","algorithm":"xchacha20poly1305-v1","kekDerivation":"hkdf-sha256-v1","wrappedDek":"AAAA"}]}',
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.not.toThrow();
  });
});

// ── MockMidnightChainAdapter.removeReference ──────────────────────────────────

describe("MockMidnightChainAdapter.removeReference", () => {
  it("removes a written reference so it no longer appears in listReferences", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const wp = adapter.writeReference(makeRef("rm1"));
    await vi.runAllTimersAsync();
    const { refId } = await wp;

    const rp = adapter.removeReference!(refId);
    await vi.runAllTimersAsync();
    await rp;

    const all = await adapter.listReferences();
    expect(all.find((r) => r.refId === refId)).toBeUndefined();
  });

  it("throws for an unknown refId", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const p = adapter.removeReference!("ref_nonexistent");
    const assertion = expect(p).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("does not affect other references", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const wp1 = adapter.writeReference(makeRef("rm3a"));
    await vi.runAllTimersAsync();
    const { refId: id1 } = await wp1;

    const wp2 = adapter.writeReference(makeRef("rm3b"));
    await vi.runAllTimersAsync();
    const { refId: id2 } = await wp2;

    const rp = adapter.removeReference!(id1);
    await vi.runAllTimersAsync();
    await rp;

    const all = await adapter.listReferences();
    expect(all.find((r) => r.refId === id1)).toBeUndefined();
    expect(all.find((r) => r.refId === id2)).toBeDefined();
  });
});

// ── MockMidnightChainAdapter.updateReference ──────────────────────────────────

describe("MockMidnightChainAdapter.updateReference", () => {
  it("updates the stored fields of a written reference", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const wp = adapter.writeReference(makeRef("upd1"));
    await vi.runAllTimersAsync();
    const { refId } = await wp;

    const up = adapter.updateReference!(refId, { dataLabel: "updated-label" });
    await vi.runAllTimersAsync();
    await up;

    const ref = await adapter.readReference(refId);
    expect(ref.dataLabel).toBe("updated-label");
  });

  it("preserves fields not included in the update", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const original = makeRef("upd2");
    const wp = adapter.writeReference(original);
    await vi.runAllTimersAsync();
    const { refId } = await wp;

    const up = adapter.updateReference!(refId, { dataLabel: "new-label" });
    await vi.runAllTimersAsync();
    await up;

    const ref = await adapter.readReference(refId);
    expect(ref.storageId).toBe(original.storageId);
    expect(ref.storageProvider).toBe(original.storageProvider);
  });

  it("throws for an unknown refId", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const p = adapter.updateReference!("ref_nonexistent", { dataLabel: "x" });
    const assertion = expect(p).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("does not affect other references", async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({
      proofServerMinMs: 0,
      proofServerMaxMs: 0,
    });

    const wp1 = adapter.writeReference(makeRef("upd4a"));
    await vi.runAllTimersAsync();
    const { refId: id1 } = await wp1;

    const wp2 = adapter.writeReference(makeRef("upd4b"));
    await vi.runAllTimersAsync();
    const { refId: id2 } = await wp2;

    const up = adapter.updateReference!(id1, { dataLabel: "changed" });
    await vi.runAllTimersAsync();
    await up;

    const ref2 = await adapter.readReference(id2);
    expect(ref2.dataLabel).not.toBe("changed");
  });
});
