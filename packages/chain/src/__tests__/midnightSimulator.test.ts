import { describe, it, expect, vi, afterEach } from "vitest";
import { MidnightSimulatorChainAdapter } from "../adapters/midnightSimulator.js";
import { ChainErrorCode } from "../errors.js";

afterEach(() => vi.useRealTimers());

function makeAdapter() {
  return new MidnightSimulatorChainAdapter();
}

const TEST_OWNER_SECRET = new Uint8Array(32).fill(1);

function uniqueRef(tag: string) {
  return {
    storageId: `store_${tag}`,
    storageProvider: "mock",
    writtenAt: Date.now(),
    keyEnvelope:
      '{"v":1,"wrappers":[{"wrapKeyName":"test","algorithm":"xchacha20poly1305-v1","kekDerivation":"hkdf-sha256-v1","wrappedDek":"AAAA"}]}',
    ownerSecret: TEST_OWNER_SECRET,
  };
}

const NONEXISTENT_REF_ID = "a".repeat(64);

describe("MidnightSimulatorChainAdapter", () => {
  it('name is "midnight"', () => {
    expect(makeAdapter().name).toBe("midnight");
  });

  describe("logger validation", () => {
    it("accepts logger: console", () => {
      expect(
        () => new MidnightSimulatorChainAdapter({ logger: console }),
      ).not.toThrow();
    });

    it("rejects logger: console.log (common typo for logger: console)", () => {
      expect(
        () =>
          new MidnightSimulatorChainAdapter({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            logger: console.log as any,
          }),
      ).toThrow(/logger must be an object/);
    });
  });

  describe("managed payment", () => {
    it("defaults to a local MockPaymentAdapter with network mock", () => {
      const adapter = makeAdapter();
      expect(adapter.paymentAdapter.network).toBe("mock");
      expect(adapter.paymentAdapter.type).toBe("chain");
    });

    it("signingServerUrl + authToken switches to ManagedPaymentAdapter with network managedmock", () => {
      const adapter = new MidnightSimulatorChainAdapter({
        signingServerUrl: "https://signing.example.com",
        authToken: "tok_abc123",
      });
      expect(adapter.paymentAdapter.network).toBe("managedmock");
      expect(adapter.paymentAdapter.type).toBe("chain");
    });

    it("signingServerUrl without authToken throws MIDNIGHT_SIMULATOR_AUTH_TOKEN_REQUIRED", () => {
      expect(
        () =>
          new MidnightSimulatorChainAdapter({
            signingServerUrl: "https://signing.example.com",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any),
      ).toThrow(
        expect.objectContaining({
          code: ChainErrorCode.MIDNIGHT_SIMULATOR_AUTH_TOKEN_REQUIRED,
        }),
      );
    });
  });

  // ── writeReference ────────────────────────────────────────────────────────

  describe("writeReference", () => {
    it("returns a ChainWriteResult with refId, provider, blockHeight, writtenAt", async () => {
      const adapter = makeAdapter();
      const result = await adapter.writeReference(uniqueRef("wr1"));
      expect(result).toHaveProperty("refId");
      expect(result).toHaveProperty("provider");
      expect(result).toHaveProperty("blockHeight");
      expect(result).toHaveProperty("writtenAt");
    });

    it('provider is "midnight"', async () => {
      const adapter = makeAdapter();
      const result = await adapter.writeReference(uniqueRef("wr2"));
      expect(result.provider).toBe("midnight");
    });

    it("refId is a 64-char lowercase hex string (circuit-derived)", async () => {
      const adapter = makeAdapter();
      const result = await adapter.writeReference(uniqueRef("wr3"));
      expect(result.refId).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(result.refId)).toBe(true);
    });

    it("blockHeight starts at or above 1,000,000 (realistic mock)", async () => {
      const adapter = makeAdapter();
      const result = await adapter.writeReference(uniqueRef("wr4"));
      expect(result.blockHeight).toBeGreaterThanOrEqual(1_000_000);
    });

    it("blockHeight increments by 1 on each write", async () => {
      const adapter = makeAdapter();
      const r1 = await adapter.writeReference(uniqueRef("wr5a"));
      const r2 = await adapter.writeReference(uniqueRef("wr5b"));
      expect(r2.blockHeight).toBe(r1.blockHeight! + 1);
    });

    it("successive writes return unique refIds", async () => {
      const adapter = makeAdapter();
      const r1 = await adapter.writeReference(uniqueRef("wr6a"));
      const r2 = await adapter.writeReference(uniqueRef("wr6b"));
      expect(r1.refId).not.toBe(r2.refId);
    });

    it("written reference is retrievable", async () => {
      const adapter = makeAdapter();
      const ref = uniqueRef("wr7");
      const result = await adapter.writeReference(ref);
      const stored = await adapter.readReference(result.refId);
      expect(stored.storageId).toBe(ref.storageId);
    });
  });

  // ── readReference ─────────────────────────────────────────────────────────

  describe("readReference", () => {
    it("returns the stored reference", async () => {
      const adapter = makeAdapter();
      const ref = {
        storageId: "sid_rr1",
        storageProvider: "arweave",
        writtenAt: Date.now(),
        keyEnvelope:
          '{"v":1,"wrappers":[{"wrapKeyName":"test","algorithm":"xchacha20poly1305-v1","kekDerivation":"hkdf-sha256-v1","wrappedDek":"AAAA"}]}',
        ownerSecret: TEST_OWNER_SECRET,
      };
      const { refId } = await adapter.writeReference(ref);
      const stored = await adapter.readReference(refId);
      expect(stored.storageId).toBe("sid_rr1");
      expect(stored.storageProvider).toBe("arweave");
    });

    it("throws for unknown refId", async () => {
      const adapter = makeAdapter();
      await expect(
        adapter.readReference(NONEXISTENT_REF_ID),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
        message: expect.stringContaining(
          "[dStorage/midnight] No reference found for refId:",
        ),
      });
    });
  });

  // ── listReferences ────────────────────────────────────────────────────────

  describe("listReferences", () => {
    it("returns an array", async () => {
      const adapter = makeAdapter();
      const list = await adapter.listReferences();
      expect(Array.isArray(list)).toBe(true);
    });

    it("includes a written reference", async () => {
      const adapter = makeAdapter();
      const { refId } = await adapter.writeReference(uniqueRef("all1"));
      const list = await adapter.listReferences();
      expect(list.some((r) => r.refId === refId)).toBe(true);
    });

    it("returns a written reference after writeReference()", async () => {
      const adapter = makeAdapter();
      const ref = uniqueRef("lr1");
      const { refId } = await adapter.writeReference(ref);
      const list = await adapter.listReferences();
      const found = list.find((r) => r.refId === refId);
      expect(found).toBeDefined();
      expect(found?.storageId).toBe(ref.storageId);
    });

    it("each item has refId, storageId, and storageProvider", async () => {
      const adapter = makeAdapter();
      await adapter.writeReference(uniqueRef("lr2"));
      const list = await adapter.listReferences();
      expect(list.length).toBeGreaterThan(0);
      for (const item of list) {
        expect(typeof item.refId).toBe("string");
        expect(typeof item.storageId).toBe("string");
        expect(typeof item.storageProvider).toBe("string");
      }
    });

    it("ownerCommitment is a non-empty hex string", async () => {
      const adapter = makeAdapter();
      await adapter.writeReference(uniqueRef("lr3"));
      const list = await adapter.listReferences();
      for (const item of list) {
        expect(item.ownerCommitment.length).toBeGreaterThan(0);
        expect(/^[0-9a-f]+$/.test(item.ownerCommitment)).toBe(true);
      }
    });
  });
});
