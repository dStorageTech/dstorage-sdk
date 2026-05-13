import { describe, it, expect } from "vitest";
import { DStorage } from "../dStorage.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import type { DStorageConfig } from "../types.js";

const enc = (s: string) => new TextEncoder().encode(s);

function makeConfig(): DStorageConfig {
  return {
    storageAdapter: new MockStorageAdapter(),
    encryptionAdapters: [
      new PasswordEncryptionAdapter({
        password: "dstorage-test-passphrase-v1!",
        salt: "storage-only-test",
        params: { N: 1024, r: 8, p: 1 },
      }),
    ],
  };
}

function makePublicConfig(): DStorageConfig {
  return { storageAdapter: new MockStorageAdapter() };
}

async function makeInited() {
  const ds = new DStorage(makeConfig());
  await ds.init();
  return ds;
}

// ── init / disconnect ─────────────────────────────────────────────────────────

describe("storage-only: init / disconnect", () => {
  it("init() succeeds without a chain adapter", async () => {
    const ds = new DStorage(makeConfig());
    await ds.init();
    expect(ds.isConnected).toBe(true);
  });

  it("disconnect() sets isConnected to false", async () => {
    const ds = await makeInited();
    ds.disconnect();
    expect(ds.isConnected).toBe(false);
  });
});

// ── upload — private ──────────────────────────────────────────────────────────

describe("storage-only: upload (private)", () => {
  it("returns a storageId", async () => {
    const ds = await makeInited();
    const result = await ds.upload(enc("hello storage-only"));
    expect(typeof result.storageId).toBe("string");
    expect(result.storageId.length).toBeGreaterThan(0);
  });

  it("does not include chainRefId", async () => {
    const ds = await makeInited();
    const result = await ds.upload(enc("hello"));
    expect(result).not.toHaveProperty("chainRefId");
  });

  it("does not include chainProvider", async () => {
    const ds = await makeInited();
    const result = await ds.upload(enc("hello"));
    expect(result).not.toHaveProperty("chainProvider");
  });

  it('storageProvider is "mock"', async () => {
    const ds = await makeInited();
    const result = await ds.upload(enc("hello"));
    expect(result.storageProvider).toBe("mock");
  });

  it('encryptionScheme is "xchacha20poly1305-v1"', async () => {
    const ds = await makeInited();
    const result = await ds.upload(enc("hello"));
    expect(result.encryptionScheme).toBe("xchacha20poly1305-v1");
  });

  it("costEstimate has storageCost but no chainCost", async () => {
    const ds = await makeInited();
    const result = await ds.upload(enc("hello"));
    expect(result.costEstimate).toHaveProperty("storageCost");
    expect(result.costEstimate).not.toHaveProperty("chainCost");
  });

  it("two uploads of the same content produce different storageIds", async () => {
    const ds = await makeInited();
    const r1 = await ds.upload(enc("same"));
    const r2 = await ds.upload(enc("same"));
    expect(r1.storageId).not.toBe(r2.storageId);
  });
});

// ── upload — public ───────────────────────────────────────────────────────────

describe("storage-only: upload (public)", () => {
  it("returns a storageId with no chainRefId", async () => {
    const ds = new DStorage(makePublicConfig());
    await ds.init();
    const result = await ds.upload(enc("public data"), { isPublic: true });
    expect(typeof result.storageId).toBe("string");
    expect(result).not.toHaveProperty("chainRefId");
  });

  it("encryptionScheme is empty string for public data", async () => {
    const ds = new DStorage(makePublicConfig());
    await ds.init();
    const result = await ds.upload(enc("public data"), { isPublic: true });
    expect(result.encryptionScheme).toBe("");
  });
});

// ── retrieveByStorageId ───────────────────────────────────────────────────────

describe("storage-only: retrieveByStorageId", () => {
  it("round-trips private data", async () => {
    const ds = await makeInited();
    const content = "round-trip private content";
    const { storageId, cryptoScheme } = await ds.upload(enc(content));
    const result = await ds.retrieveByStorageId(storageId, cryptoScheme!);
    expect(new TextDecoder().decode(result.bytes)).toBe(content);
  });

  it("round-trips public data", async () => {
    const ds = new DStorage(makePublicConfig());
    await ds.init();
    const content = "round-trip public content";
    const { storageId } = await ds.upload(enc(content), { isPublic: true });
    const result = await ds.retrieveByStorageId(storageId);
    expect(new TextDecoder().decode(result.bytes)).toBe(content);
  });

  it("returns bytes as a Uint8Array", async () => {
    const ds = await makeInited();
    const { storageId } = await ds.upload(enc("type check"));
    const result = await ds.retrieveByStorageId(storageId);
    expect(result.bytes).toBeInstanceOf(Uint8Array);
  });

  it("returns metadata as an object", async () => {
    const ds = await makeInited();
    const { storageId } = await ds.upload(enc("meta check"));
    const result = await ds.retrieveByStorageId(storageId);
    expect(typeof result.metadata).toBe("object");
  });
});

// ── chain-dependent methods throw ─────────────────────────────────────────────

describe("storage-only: chain-dependent methods throw", () => {
  it("retrieveByRefId() throws with a helpful message", async () => {
    const ds = await makeInited();
    await expect(ds.retrieveByRefId("any-ref")).rejects.toThrow(
      "[dStorage] retrieveByRefId() requires a chain adapter.",
    );
  });

  it("listReferences() throws", async () => {
    const ds = await makeInited();
    await expect(ds.listReferences()).rejects.toThrow(
      "[dStorage] listReferences() requires a chain adapter.",
    );
  });

  it("removeReference() throws", async () => {
    const ds = await makeInited();
    await expect(ds.removeReference("any-ref")).rejects.toThrow(
      "[dStorage] removeReference() requires a chain adapter.",
    );
  });
});

// ── estimateCost ──────────────────────────────────────────────────────────────

describe("storage-only: estimateCost", () => {
  it("returns storageCost with amount and token", async () => {
    const ds = await makeInited();
    const estimate = await ds.estimateCost(1024);
    expect(estimate.storageCost).toHaveProperty("amount");
    expect(estimate.storageCost).toHaveProperty("token");
  });

  it("does not include chainCost", async () => {
    const ds = await makeInited();
    const estimate = await ds.estimateCost(1024);
    expect(estimate).not.toHaveProperty("chainCost");
  });

  it("fileSizeBytes matches the argument", async () => {
    const ds = await makeInited();
    const estimate = await ds.estimateCost(4096);
    expect(estimate.fileSizeBytes).toBe(4096);
  });
});
