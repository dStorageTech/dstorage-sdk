import { describe, it, expect } from "vitest";
import { MockChainAdapter } from "../adapters/mock.js";
import type { ChainReferenceUpdate } from "../types.js";
import { ChainErrorCode } from "../errors.js";

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

function makeUpdate(
  partial: Partial<ChainReferenceUpdate> = {},
): ChainReferenceUpdate {
  return {
    storageId: "updated-store-id",
    encryptionScheme: "xchacha20poly1305-v1",
    storageProvider: "mock",
    writtenAt: Date.now(),
    keyEnvelope: "{}",
    ...partial,
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

    it("writes a reference with optional encryptedMetadata", async () => {
      const adapter = new MockChainAdapter();
      const ref = {
        ...uniqueRef("wr7"),
        encryptedMetadata: "base64urlciphertext",
      };
      const result = await adapter.writeReference(ref);
      const stored = await adapter.readReference(result.refId);
      expect(stored.encryptedMetadata).toBe("base64urlciphertext");
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
      await expect(
        adapter.readReference("ref_nonexistent"),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MOCK_REF_NOT_FOUND,
        message: expect.stringContaining(
          "No reference found for refId: ref_nonexistent",
        ),
      });
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

  // ── removeReference ───────────────────────────────────────────────────────

  describe("removeReference", () => {
    it("removes the reference so it no longer appears in listReferences", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(uniqueRef("del1"));
      await adapter.removeReference!(refId);
      const all = await adapter.listReferences();
      expect(all.find((r) => r.refId === refId)).toBeUndefined();
    });

    it("throws for an unknown refId", async () => {
      const adapter = new MockChainAdapter();
      await expect(
        adapter.removeReference!("ref_nonexistent"),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MOCK_REF_NOT_FOUND_REMOVE,
        message: expect.stringContaining(
          "No reference found for refId: ref_nonexistent",
        ),
      });
    });

    it("does not affect other references", async () => {
      const adapter = new MockChainAdapter();
      const { refId: id1 } = await adapter.writeReference(uniqueRef("del3a"));
      const { refId: id2 } = await adapter.writeReference(uniqueRef("del3b"));
      await adapter.removeReference!(id1);
      const all = await adapter.listReferences();
      expect(all.find((r) => r.refId === id1)).toBeUndefined();
      expect(all.find((r) => r.refId === id2)).toBeDefined();
    });

    it("readReference throws after removal", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(uniqueRef("del4"));
      await adapter.removeReference!(refId);
      await expect(adapter.readReference(refId)).rejects.toThrow();
    });
  });

  // ── updateReference ───────────────────────────────────────────────────────

  describe("updateReference", () => {
    it("updates the stored fields", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(uniqueRef("upd1"));
      await adapter.updateReference!(
        refId,
        makeUpdate({ encryptedMetadata: "updated-ciphertext" }),
      );
      const ref = await adapter.readReference(refId);
      expect(ref.encryptedMetadata).toBe("updated-ciphertext");
    });

    it("preserves fields not included in the update", async () => {
      const adapter = new MockChainAdapter();
      const original = uniqueRef("upd2");
      const { refId } = await adapter.writeReference(original);
      await adapter.updateReference!(
        refId,
        makeUpdate({ storageId: original.storageId }),
      );
      const ref = await adapter.readReference(refId);
      expect(ref.storageId).toBe(original.storageId);
      expect(ref.storageProvider).toBe(original.storageProvider);
    });

    it("throws for an unknown refId", async () => {
      const adapter = new MockChainAdapter();
      await expect(
        adapter.updateReference!("ref_nonexistent", makeUpdate()),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MOCK_REF_NOT_FOUND_UPDATE,
        message: expect.stringContaining(
          "No reference found for refId: ref_nonexistent",
        ),
      });
    });

    it("does not affect other references", async () => {
      const adapter = new MockChainAdapter();
      const { refId: id1 } = await adapter.writeReference(uniqueRef("upd4a"));
      const { refId: id2 } = await adapter.writeReference(uniqueRef("upd4b"));
      await adapter.updateReference!(
        id1,
        makeUpdate({ encryptedMetadata: "changed-ciphertext" }),
      );
      const ref2 = await adapter.readReference(id2);
      expect(ref2.encryptedMetadata).not.toBe("changed-ciphertext");
    });
  });

  // ── ownership validation ───────────────────────────────────────────────────

  describe("ownership validation", () => {
    const ownerSecret = new Uint8Array(32).fill(42);
    const wrongSecret = new Uint8Array(32).fill(99);

    function refWithSecret(suffix: string) {
      return {
        storageId: `store_${suffix}`,
        storageProvider: "mock",
        writtenAt: Date.now(),
        keyEnvelope: "{}",
        ownerSecret,
      };
    }

    it("removeReference succeeds with correct ownerSecret", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(refWithSecret("own1"));
      await expect(
        adapter.removeReference!(refId, ownerSecret),
      ).resolves.toBeUndefined();
    });

    it("removeReference rejects wrong ownerSecret", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(refWithSecret("own2"));
      await expect(
        adapter.removeReference!(refId, wrongSecret),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MOCK_OWNER_SECRET_MISMATCH,
        message: expect.stringContaining(
          "[dStorage/mock-chain] ownerSecret mismatch",
        ),
      });
    });

    it("removeReference rejects missing ownerSecret when commitment exists", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(refWithSecret("own3"));
      await expect(adapter.removeReference!(refId)).rejects.toMatchObject({
        code: ChainErrorCode.MOCK_OWNER_SECRET_REQUIRED,
        message: expect.stringContaining(
          "[dStorage/mock-chain] ownerSecret required",
        ),
      });
    });

    it("updateReference succeeds with correct ownerSecret", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(refWithSecret("own4"));
      await expect(
        adapter.updateReference!(refId, makeUpdate(), ownerSecret),
      ).resolves.toBeUndefined();
    });

    it("updateReference rejects wrong ownerSecret", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(refWithSecret("own5"));
      await expect(
        adapter.updateReference!(refId, makeUpdate(), wrongSecret),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MOCK_OWNER_SECRET_MISMATCH,
        message: expect.stringContaining(
          "[dStorage/mock-chain] ownerSecret mismatch",
        ),
      });
    });

    it("updateReference rejects missing ownerSecret when commitment exists", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(refWithSecret("own6"));
      await expect(
        adapter.updateReference!(refId, makeUpdate()),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MOCK_OWNER_SECRET_REQUIRED,
        message: expect.stringContaining(
          "[dStorage/mock-chain] ownerSecret required",
        ),
      });
    });

    it("public reference (no ownerSecret) can be removed without a secret", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(uniqueRef("own7"));
      await expect(adapter.removeReference!(refId)).resolves.toBeUndefined();
    });

    it("public reference (no ownerSecret) can be updated without a secret", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(uniqueRef("own8"));
      await expect(
        adapter.updateReference!(refId, makeUpdate()),
      ).resolves.toBeUndefined();
    });

    it("listReferences returns 64-char hex ownerCommitment for private references", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(refWithSecret("own9"));
      const all = await adapter.listReferences();
      const found = all.find((r) => r.refId === refId);
      expect(found?.ownerCommitment).toMatch(/^[0-9a-f]{64}$/);
    });

    it("listReferences returns empty ownerCommitment for public references", async () => {
      const adapter = new MockChainAdapter();
      const { refId } = await adapter.writeReference(uniqueRef("own10"));
      const all = await adapter.listReferences();
      const found = all.find((r) => r.refId === refId);
      expect(found?.ownerCommitment).toBe("");
    });
  });
});
