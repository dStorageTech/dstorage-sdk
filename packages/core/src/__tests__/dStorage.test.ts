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

  it("retrieveByRefId() throws when not connected", async () => {
    const ds = new DStorage(makeConfig());
    await expect(ds.retrieveByRefId("any::ref")).rejects.toThrow(
      "[dStorage] Not connected",
    );
  });
});

// ── upload ────────────────────────────────────────────────────────────────────

describe("upload", () => {
  it("returns an UploadResult with chainRefId and storageId", async () => {
    const ds = await makeConnectedDStorage();
    const result = await ds.upload("hello world");
    expect(result).toHaveProperty("chainRefId");
    expect(result).toHaveProperty("storageId");
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
    expect(result.chainRefId).toBeDefined();
  });

  it("two uploads of the same content produce different dataIds", async () => {
    const ds = await makeConnectedDStorage();
    const r1 = await ds.upload("same content");
    const r2 = await ds.upload("same content");
    expect(r1.chainRefId).not.toBe(r2.chainRefId);
  });
});

// ── retrieveByRefId ──────────────────────────────────────────────────────────────────

describe("retrieveByRefId", () => {
  it("returns the original plaintext after upload + retrieveByRefId", async () => {
    const ds = await makeConnectedDStorage();
    const content = "Hello, private world!";
    const { chainRefId } = await ds.upload(content);
    const result = await ds.retrieveByRefId(chainRefId);
    expect(result.content).toBe(content);
  });

  it("returns bytes matching the original UTF-8 encoding", async () => {
    const ds = await makeConnectedDStorage();
    const content = "test bytes";
    const { chainRefId } = await ds.upload(content);
    const result = await ds.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(new TextEncoder().encode(content));
  });

  it("returns metadata as an object (possibly empty)", async () => {
    const ds = await makeConnectedDStorage();
    const { chainRefId } = await ds.upload("meta test");
    const result = await ds.retrieveByRefId(chainRefId);
    expect(typeof result.metadata).toBe("object");
  });

  it("different wallets produce different ciphertexts for same plaintext", async () => {
    const ds1 = new DStorage(makeConfig());
    const ds2 = new DStorage(makeConfig());

    const w1 = await connectDemoWallet("0xAlice_retrieve");
    const w2 = await connectDemoWallet("0xBob_retrieve");
    await ds1.connect(w1);
    await ds2.connect(w2);

    const { storageId: id1 } = await ds1.upload("same text");
    const { storageId: id2 } = await ds2.upload("same text");

    expect(id1).not.toBe(id2);
  });

  it("retrieves multiple distinct uploads correctly", async () => {
    const ds = await makeConnectedDStorage();
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 5; i++) {
      const content = `record-${i}`;
      const { chainRefId } = await ds.upload(content);
      pairs.push([chainRefId, content]);
    }
    for (const [chainRefId, expected] of pairs) {
      const { content } = await ds.retrieveByRefId(chainRefId);
      expect(content).toBe(expected);
    }
  });

  it("throws when the chainRefId is not found in storage", async () => {
    const ds = await makeConnectedDStorage();
    await expect(ds.retrieveByRefId("::ref_abc")).rejects.toThrow(
      "[dStorage/mock-chain] No reference found for refId: ::ref_abc",
    );
  });
});

// ── public (isPublic: true) upload / retrieve ─────────────────────────────────

describe("public upload and retrieve", () => {
  it("uploads public content without requiring a wallet connection", async () => {
    const ds = new DStorage(makeConfig());
    // connect so assertConnected passes, but no encryption keys involved for public data
    const wallet = await connectDemoWallet("0xPublicUser");
    await ds.connect(wallet);
    const result = await ds.upload("public data", { isPublic: true });
    expect(result).toHaveProperty("chainRefId");
    expect(result).toHaveProperty("storageId");
  });

  it("retrieves the original content via refId for public upload", async () => {
    const ds = await makeConnectedDStorage();
    const content = "hello, public world!";
    const { chainRefId } = await ds.upload(content, { isPublic: true });
    const result = await ds.retrieveByRefId(chainRefId);
    expect(result.content).toBe(content);
  });

  it("retrieves the original bytes via refId for public upload", async () => {
    const ds = await makeConnectedDStorage();
    const content = "public bytes";
    const { chainRefId } = await ds.upload(content, { isPublic: true });
    const result = await ds.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(new TextEncoder().encode(content));
  });

  it("public storageId on-chain matches the raw storage id", async () => {
    const ds = await makeConnectedDStorage();
    const { chainRefId, storageId } = await ds.upload("public", {
      isPublic: true,
    });
    const ref = await ds.chainAdapter.readReference(chainRefId);
    // For public data the storageId on-chain must equal the raw storage id
    expect(ref.storageId).toBe(storageId);
    expect(ref.encryptionScheme).toBe("");
  });

  it("private upload stores an encrypted (different) storageId on-chain", async () => {
    const ds = await makeConnectedDStorage();
    const { chainRefId, storageId } = await ds.upload("private");
    const ref = await ds.chainAdapter.readReference(chainRefId);
    expect(ref.storageId).not.toBe(storageId);
    expect(ref.encryptionScheme).toBe("aes-gcm-v1");
  });

  it("two users can both retrieve the same public content by refId", async () => {
    const ds1 = await makeConnectedDStorage();
    const ds2 = await makeConnectedDStorage();
    const content = "shared public content";
    const { chainRefId } = await ds1.upload(content, { isPublic: true });
    const result = await ds2.retrieveByRefId(chainRefId);
    expect(result.content).toBe(content);
  });
});

// ── estimateCost ──────────────────────────────────────────────────────────────

describe("estimateCost", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("returns a string (even when not connected)", async () => {
    const ds = new DStorage(makeConfig());
    const result = await ds.estimateCost(enc("some content"));
    expect(typeof result).toBe("string");
  });

  it("returns a non-empty string", async () => {
    const ds = new DStorage(makeConfig());
    const result = await ds.estimateCost(enc("some content"));
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns cost equal to the byte length of the input", async () => {
    const ds = new DStorage(makeConfig());
    const data = enc("some content");
    const result = await ds.estimateCost(data);
    expect(result).toBe(`${data.byteLength}`);
  });
});
