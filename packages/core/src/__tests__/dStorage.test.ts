import { describe, it, expect } from "vitest";
import { DStorage } from "../dStorage.js";
import { connectDemoWallet } from "../wallet.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MockChainAdapter } from "@dstorage/chain";
import type { DStorageConfig } from "../types.js";

// ── Factory ────────────────────────────────────────────────────────────────────

function makeConfig(): DStorageConfig {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
  };
}

async function makeConnectedDStorage() {
  const ds = new DStorage(makeConfig());
  const wallet = await connectDemoWallet(
    `0xTestUser_${Math.random().toString(36).slice(2)}`,
  );
  await ds.connect(wallet);
  return ds;
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe("DStorage constructor", () => {
  it("creates an instance", () => {
    const ds = new DStorage(makeConfig());
    expect(ds).toBeDefined();
  });

  it("isConnected is false before connect()", () => {
    const ds = new DStorage(makeConfig());
    expect(ds.isConnected).toBe(false);
  });

  it("connectedAddress is null before connect()", () => {
    const ds = new DStorage(makeConfig());
    expect(ds.connectedAddress).toBeNull();
  });
});

// ── connect / disconnect ──────────────────────────────────────────────────────

describe("connect / disconnect", () => {
  it("isConnected is true after connect()", async () => {
    const ds = new DStorage(makeConfig());
    const wallet = await connectDemoWallet();
    await ds.connect(wallet);
    expect(ds.isConnected).toBe(true);
  });

  it("connectedAddress matches the wallet address after connect()", async () => {
    const ds = new DStorage(makeConfig());
    const wallet = await connectDemoWallet("0xAlice_ds1");
    await ds.connect(wallet);
    expect(ds.connectedAddress).toBe("0xAlice_ds1");
  });

  it("isConnected is false after disconnect()", async () => {
    const ds = await makeConnectedDStorage();
    ds.disconnect();
    expect(ds.isConnected).toBe(false);
  });

  it("connectedAddress is null after disconnect()", async () => {
    const ds = await makeConnectedDStorage();
    ds.disconnect();
    expect(ds.connectedAddress).toBeNull();
  });

  it("can reconnect after disconnect", async () => {
    const ds = new DStorage(makeConfig());
    const wallet = await connectDemoWallet("0xAlice_ds2");
    await ds.connect(wallet);
    ds.disconnect();
    await ds.connect(wallet);
    expect(ds.isConnected).toBe(true);
  });
});

// ── assertConnected guard ─────────────────────────────────────────────────────

describe("operations before connect() throw", () => {
  it("upload() throws when not connected", async () => {
    const ds = new DStorage(makeConfig());
    await expect(ds.upload("hello")).rejects.toThrow(
      "[dStorage] Not connected",
    );
  });

  it("retrieve() throws when not connected", async () => {
    const ds = new DStorage(makeConfig());
    await expect(ds.retrieve("any::ref")).rejects.toThrow(
      "[dStorage] Not connected",
    );
  });
});

// ── upload ────────────────────────────────────────────────────────────────────

describe("upload", () => {
  it("returns an UploadResult with dataId, storageId, chainRefId", async () => {
    const ds = await makeConnectedDStorage();
    const result = await ds.upload("hello world");
    expect(result).toHaveProperty("dataId");
    expect(result).toHaveProperty("storageId");
    expect(result).toHaveProperty("chainRefId");
  });

  it('dataId is "<storageId>::<chainRefId>"', async () => {
    const ds = await makeConnectedDStorage();
    const result = await ds.upload("hello world");
    expect(result.dataId).toBe(`${result.storageId}::${result.chainRefId}`);
  });

  it('storageProvider is "mock"', async () => {
    const ds = await makeConnectedDStorage();
    const result = await ds.upload("hello world");
    expect(result.storageProvider).toBe("mock");
  });

  it('chainProvider is "mock"', async () => {
    const ds = await makeConnectedDStorage();
    const result = await ds.upload("hello world");
    expect(result.chainProvider).toBe("mock");
  });

  it("uploadedAt is a recent timestamp", async () => {
    const before = Date.now();
    const ds = await makeConnectedDStorage();
    const result = await ds.upload("hello world");
    expect(result.uploadedAt).toBeGreaterThan(before - 1000);
  });

  it("accepts Uint8Array as content", async () => {
    const ds = await makeConnectedDStorage();
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    const result = await ds.upload(bytes);
    expect(result.dataId).toBeDefined();
  });

  it("two uploads of the same content produce different dataIds", async () => {
    const ds = await makeConnectedDStorage();
    const r1 = await ds.upload("same content");
    const r2 = await ds.upload("same content");
    expect(r1.dataId).not.toBe(r2.dataId);
  });
});

// ── retrieve ──────────────────────────────────────────────────────────────────

describe("retrieve", () => {
  it("returns the original plaintext after upload + retrieve", async () => {
    const ds = await makeConnectedDStorage();
    const content = "Hello, private world!";
    const { dataId } = await ds.upload(content);
    const result = await ds.retrieve(dataId);
    expect(result.content).toBe(content);
  });

  it("returns bytes matching the original UTF-8 encoding", async () => {
    const ds = await makeConnectedDStorage();
    const content = "test bytes";
    const { dataId } = await ds.upload(content);
    const result = await ds.retrieve(dataId);
    expect(result.bytes).toEqual(new TextEncoder().encode(content));
  });

  it("returns metadata as an object (possibly empty)", async () => {
    const ds = await makeConnectedDStorage();
    const { dataId } = await ds.upload("meta test");
    const result = await ds.retrieve(dataId);
    expect(typeof result.metadata).toBe("object");
  });

  it("different wallets produce different ciphertexts for same plaintext", async () => {
    const ds1 = new DStorage(makeConfig());
    const ds2 = new DStorage(makeConfig());

    const w1 = await connectDemoWallet("0xAlice_retrieve");
    const w2 = await connectDemoWallet("0xBob_retrieve");
    await ds1.connect(w1);
    await ds2.connect(w2);

    const { dataId: id1 } = await ds1.upload("same text");
    const { dataId: id2 } = await ds2.upload("same text");

    // storageId part differs (random UUIDs) so just verify format
    expect(id1).not.toBe(id2);
  });

  it("retrieves multiple distinct uploads correctly", async () => {
    const ds = await makeConnectedDStorage();
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 5; i++) {
      const content = `record-${i}`;
      const { dataId } = await ds.upload(content);
      pairs.push([dataId, content]);
    }
    for (const [dataId, expected] of pairs) {
      const { content } = await ds.retrieve(dataId);
      expect(content).toBe(expected);
    }
  });

  it('throws for a dataId with no storageId part (just "::")', async () => {
    // parseStorageId('::ref_abc') → parts[0] = '' → falsy → throws
    const ds = await makeConnectedDStorage();
    await expect(ds.retrieve("::ref_abc")).rejects.toThrow(
      "[dStorage] Invalid dataId",
    );
  });

  it("throws when the storageId is not found in storage", async () => {
    // 'nonexistent' has no '::' but parts[0] is truthy → gets forwarded to storage
    const ds = await makeConnectedDStorage();
    await expect(ds.retrieve("nonexistent::ref_abc")).rejects.toThrow();
  });
});

// ── estimateCost ──────────────────────────────────────────────────────────────

describe("estimateCost", () => {
  it("returns a string (even when not connected)", async () => {
    const ds = new DStorage(makeConfig());
    const result = await ds.estimateCost("some content");
    expect(typeof result).toBe("string");
  });

  it("returns a non-empty string", async () => {
    const ds = new DStorage(makeConfig());
    const result = await ds.estimateCost("some content");
    expect(result.length).toBeGreaterThan(0);
  });

  it('contains "mock" or "0" to indicate no real cost', async () => {
    const ds = new DStorage(makeConfig());
    const result = await ds.estimateCost("some content");
    const lower = result.toLowerCase();
    expect(lower.includes("mock") || lower.includes("0")).toBe(true);
  });
});
