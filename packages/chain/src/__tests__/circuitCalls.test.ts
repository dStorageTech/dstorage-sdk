/**
 * Additional writeReference tests for MidnightSimulatorChainAdapter.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { MidnightSimulatorChainAdapter } from "../adapters/midnightSimulator.js";
import { ChainErrorCode } from "../errors.js";
import type { ChainReferenceUpdate } from "../types.js";

afterEach(() => vi.useRealTimers());

const NONEXISTENT_REF_ID = "b".repeat(64);
const TEST_OWNER_SECRET = new Uint8Array(32).fill(1);

function makeRef(tag: string) {
  return {
    storageId: `store_${tag}`,
    storageProvider: "mock",
    writtenAt: Date.now(),
    keyEnvelope:
      '{"v":1,"wrappers":[{"wrapKeyName":"test","algorithm":"xchacha20poly1305-v1","kekDerivation":"hkdf-sha256-v1","wrappedDek":"AAAA"}]}',
    ownerSecret: TEST_OWNER_SECRET,
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
    keyEnvelope: '{"v":1,"wrappers":[]}',
    ...partial,
  };
}

// ── MidnightSimulatorChainAdapter ─────────────────────────────────────────────────

describe("MidnightSimulatorChainAdapter.writeReference", () => {
  it("returns a ChainWriteResult with refId, blockHeight, and writtenAt", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const result = await adapter.writeReference(makeRef("cc1"));
    expect(result).toHaveProperty("refId");
    expect(result).toHaveProperty("blockHeight");
    expect(result).toHaveProperty("writtenAt");
  });

  it("refId is a 64-char lowercase hex string (circuit-derived)", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const result = await adapter.writeReference(makeRef("cc2"));
    expect(result.refId).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result.refId)).toBe(true);
  });

  it("blockHeight is a number at or above 1,000,000", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const result = await adapter.writeReference(makeRef("cc3"));
    expect(typeof result.blockHeight).toBe("number");
    expect(result.blockHeight!).toBeGreaterThanOrEqual(1_000_000);
  });

  it("writtenAt is a Unix timestamp (number)", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const result = await adapter.writeReference(makeRef("cc4"));
    expect(typeof result.writtenAt).toBe("number");
  });

  it("successive calls return different refIds", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const r1 = await adapter.writeReference(makeRef("cc5a"));
    const r2 = await adapter.writeReference(makeRef("cc5b"));
    expect(r1.refId).not.toBe(r2.refId);
  });

  it("blockHeight increments on each write call", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const r1 = await adapter.writeReference(makeRef("cc6a"));
    const r2 = await adapter.writeReference(makeRef("cc6b"));
    expect(r2.blockHeight).toBe(r1.blockHeight! + 1);
  });

  it("accepts references with various storage providers", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    await expect(
      adapter.writeReference({
        storageId: "ref_abc",
        storageProvider: "arweave",
        writtenAt: Date.now(),
        keyEnvelope:
          '{"v":1,"wrappers":[{"wrapKeyName":"test","algorithm":"xchacha20poly1305-v1","kekDerivation":"hkdf-sha256-v1","wrappedDek":"AAAA"}]}',
        ownerSecret: TEST_OWNER_SECRET,
      }),
    ).resolves.not.toThrow();
  });

  it("throws MIDNIGHT_OWNER_SECRET_REQUIRED_WRITE when ownerSecret is absent", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const { ownerSecret: _omit, ...refWithoutOwner } = makeRef("cc_nosecret");
    await expect(adapter.writeReference(refWithoutOwner)).rejects.toMatchObject(
      {
        code: ChainErrorCode.MIDNIGHT_OWNER_SECRET_REQUIRED_WRITE,
      },
    );
  });
});

// ── MidnightSimulatorChainAdapter.removeReference ──────────────────────────────────

describe("MidnightSimulatorChainAdapter.removeReference", () => {
  it("removes a written reference so it no longer appears in listReferences", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const { refId } = await adapter.writeReference(makeRef("rm1"));
    await adapter.removeReference!(refId, TEST_OWNER_SECRET);
    const all = await adapter.listReferences();
    expect(all.find((r) => r.refId === refId)).toBeUndefined();
  });

  it("throws MIDNIGHT_REF_NOT_FOUND for an unknown refId", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    await expect(
      adapter.removeReference!(NONEXISTENT_REF_ID, TEST_OWNER_SECRET),
    ).rejects.toMatchObject({
      code: ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
    });
  });

  it("throws MIDNIGHT_OWNER_SECRET_REQUIRED_REMOVE when ownerSecret is absent", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const { refId } = await adapter.writeReference(makeRef("rm_nosecret"));
    await expect(adapter.removeReference!(refId)).rejects.toMatchObject({
      code: ChainErrorCode.MIDNIGHT_OWNER_SECRET_REQUIRED_REMOVE,
    });
  });

  it("does not affect other references", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const { refId: id1 } = await adapter.writeReference(makeRef("rm3a"));
    const { refId: id2 } = await adapter.writeReference(makeRef("rm3b"));
    await adapter.removeReference!(id1, TEST_OWNER_SECRET);
    const all = await adapter.listReferences();
    expect(all.find((r) => r.refId === id1)).toBeUndefined();
    expect(all.find((r) => r.refId === id2)).toBeDefined();
  });
});

// ── MidnightSimulatorChainAdapter.updateReference ──────────────────────────────────

describe("MidnightSimulatorChainAdapter.updateReference", () => {
  it("updates the stored fields of a written reference", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const { refId } = await adapter.writeReference(makeRef("upd1"));
    await adapter.updateReference!(
      refId,
      makeUpdate({ encryptedMetadata: "updated-ciphertext" }),
      TEST_OWNER_SECRET,
    );
    const ref = await adapter.readReference(refId);
    expect(ref.encryptedMetadata).toBe("updated-ciphertext");
  });

  it("preserves fields not included in the update", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const original = makeRef("upd2");
    const { refId } = await adapter.writeReference(original);
    await adapter.updateReference!(
      refId,
      makeUpdate({ storageId: original.storageId }),
      TEST_OWNER_SECRET,
    );
    const ref = await adapter.readReference(refId);
    expect(ref.storageId).toBe(original.storageId);
    expect(ref.storageProvider).toBe(original.storageProvider);
  });

  it("throws MIDNIGHT_REF_NOT_FOUND for an unknown refId", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    await expect(
      adapter.updateReference!(
        NONEXISTENT_REF_ID,
        makeUpdate(),
        TEST_OWNER_SECRET,
      ),
    ).rejects.toMatchObject({
      code: ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
    });
  });

  it("throws MIDNIGHT_OWNER_SECRET_REQUIRED_UPDATE when ownerSecret is absent", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const { refId } = await adapter.writeReference(makeRef("upd_nosecret"));
    await expect(
      adapter.updateReference!(refId, makeUpdate()),
    ).rejects.toMatchObject({
      code: ChainErrorCode.MIDNIGHT_OWNER_SECRET_REQUIRED_UPDATE,
    });
  });

  it("does not affect other references", async () => {
    const adapter = new MidnightSimulatorChainAdapter();
    const { refId: id1 } = await adapter.writeReference(makeRef("upd4a"));
    const { refId: id2 } = await adapter.writeReference(makeRef("upd4b"));
    await adapter.updateReference!(
      id1,
      makeUpdate({ encryptedMetadata: "changed-ciphertext" }),
      TEST_OWNER_SECRET,
    );
    const ref2 = await adapter.readReference(id2);
    expect(ref2.encryptedMetadata).not.toBe("changed-ciphertext");
  });
});
