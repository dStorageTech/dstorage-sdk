import { describe, it, expect } from "vitest";
import { DStorage } from "../dStorage.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MockChainAdapter } from "@dstorage/chain";
import { DemoSeedProvider } from "@dstorage/seed-providers";
import type { DStorageConfig } from "../types.js";

const enc = (s: string) => new TextEncoder().encode(s);

// ── Factory ────────────────────────────────────────────────────────────────────

function makeConfig(address = "0xTestUser"): DStorageConfig {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
    encryptionSeedProvider: new DemoSeedProvider(address),
  };
}

async function makeInitedDStorage(address?: string) {
  const addr = address ?? `0xTestUser_${Math.random().toString(36).slice(2)}`;
  const ds = new DStorage(makeConfig(addr));
  await ds.init();
  return ds;
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe("DStorage constructor", () => {
  it("creates an instance", () => {
    const ds = new DStorage(makeConfig());
    expect(ds).toBeDefined();
  });

  it("isConnected is false before init()", () => {
    const ds = new DStorage(makeConfig());
    expect(ds.isConnected).toBe(false);
  });

  it("connectedAddress is null before init()", () => {
    const ds = new DStorage(makeConfig());
    expect(ds.connectedAddress).toBeNull();
  });
});

// ── init / disconnect ─────────────────────────────────────────────────────────

describe("init / disconnect", () => {
  it("isConnected is true after init()", async () => {
    const ds = new DStorage(makeConfig());
    await ds.init();
    expect(ds.isConnected).toBe(true);
  });

  it("connectedAddress is null (address not tracked via init flow)", async () => {
    const ds = new DStorage(makeConfig("0xAlice_ds1"));
    await ds.init();
    expect(ds.connectedAddress).toBeNull();
  });

  it("isConnected is false after disconnect()", async () => {
    const ds = await makeInitedDStorage();
    ds.disconnect();
    expect(ds.isConnected).toBe(false);
  });

  it("connectedAddress is null after disconnect()", async () => {
    const ds = await makeInitedDStorage();
    ds.disconnect();
    expect(ds.connectedAddress).toBeNull();
  });

  it("can re-init after disconnect", async () => {
    const ds = new DStorage(makeConfig("0xAlice_ds2"));
    await ds.init();
    ds.disconnect();
    await ds.init();
    expect(ds.isConnected).toBe(true);
  });
});

// ── assertConnected guard ─────────────────────────────────────────────────────

describe("operations before init() throw", () => {
  it("upload() throws when not connected", async () => {
    const ds = new DStorage(makeConfig());
    await expect(ds.upload(enc("hello"))).rejects.toThrow(
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
    const ds = await makeInitedDStorage();
    const result = await ds.upload(enc("hello world"));
    expect(result).toHaveProperty("chainRefId");
    expect(result).toHaveProperty("storageId");
  });

  it('storageProvider is "mock"', async () => {
    const ds = await makeInitedDStorage();
    const result = await ds.upload(enc("hello world"));
    expect(result.storageProvider).toBe("mock");
  });

  it('chainProvider is "mock"', async () => {
    const ds = await makeInitedDStorage();
    const result = await ds.upload(enc("hello world"));
    expect(result.chainProvider).toBe("mock");
  });

  it("uploadedAt is a recent timestamp", async () => {
    const before = Date.now();
    const ds = await makeInitedDStorage();
    const result = await ds.upload(enc("hello world"));
    expect(result.uploadedAt).toBeGreaterThan(before - 1000);
  });

  it("accepts Uint8Array as content", async () => {
    const ds = await makeInitedDStorage();
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    const result = await ds.upload(bytes);
    expect(result.chainRefId).toBeDefined();
  });

  it("two uploads of the same content produce different dataIds", async () => {
    const ds = await makeInitedDStorage();
    const r1 = await ds.upload(enc("same content"));
    const r2 = await ds.upload(enc("same content"));
    expect(r1.chainRefId).not.toBe(r2.chainRefId);
  });
});

// ── retrieveByRefId ──────────────────────────────────────────────────────────────────

describe("retrieveByRefId", () => {
  it("returns the original plaintext after upload + retrieveByRefId", async () => {
    const ds = await makeInitedDStorage();
    const content = "Hello, private world!";
    const { chainRefId } = await ds.upload(enc(content));
    const result = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(result.bytes)).toBe(content);
  });

  it("returns bytes matching the original UTF-8 encoding", async () => {
    const ds = await makeInitedDStorage();
    const content = "test bytes";
    const { chainRefId } = await ds.upload(enc(content));
    const result = await ds.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(new TextEncoder().encode(content));
  });

  it("returns metadata as an object (possibly empty)", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.upload(enc("meta test"));
    const result = await ds.retrieveByRefId(chainRefId);
    expect(typeof result.metadata).toBe("object");
  });

  it("different seed providers produce different ciphertexts for same plaintext", async () => {
    const ds1 = new DStorage(makeConfig("0xAlice_retrieve"));
    const ds2 = new DStorage(makeConfig("0xBob_retrieve"));
    await ds1.init();
    await ds2.init();

    const { storageId: id1 } = await ds1.upload(enc("same text"));
    const { storageId: id2 } = await ds2.upload(enc("same text"));

    expect(id1).not.toBe(id2);
  });

  it("retrieves multiple distinct uploads correctly", async () => {
    const ds = await makeInitedDStorage();
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 5; i++) {
      const content = `record-${i}`;
      const { chainRefId } = await ds.upload(enc(content));
      pairs.push([chainRefId, content]);
    }
    for (const [chainRefId, expected] of pairs) {
      const result = await ds.retrieveByRefId(chainRefId);
      expect(new TextDecoder().decode(result.bytes)).toBe(expected);
    }
  });

  it("throws when the chainRefId is not found in storage", async () => {
    const ds = await makeInitedDStorage();
    await expect(ds.retrieveByRefId("::ref_abc")).rejects.toThrow(
      "[dStorage/mock-chain] No reference found for refId: ::ref_abc",
    );
  });
});

// ── public (isPublic: true) upload / retrieve ─────────────────────────────────

describe("public upload and retrieve", () => {
  it("uploads public content without encryption keys", async () => {
    // init() without a seed provider: _cryptoSchemes is null but isPublic skips encryption
    const ds = new DStorage({
      storageAdapter: new MockStorageAdapter(),
      chainAdapter: new MockChainAdapter(),
    });
    await ds.init();
    const result = await ds.upload(enc("public data"), { isPublic: true });
    expect(result).toHaveProperty("chainRefId");
    expect(result).toHaveProperty("storageId");
  });

  it("retrieves the original content via refId for public upload", async () => {
    const ds = await makeInitedDStorage();
    const content = "hello, public world!";
    const { chainRefId } = await ds.upload(enc(content), { isPublic: true });
    const result = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(result.bytes)).toBe(content);
  });

  it("retrieves the original bytes via refId for public upload", async () => {
    const ds = await makeInitedDStorage();
    const content = "public bytes";
    const { chainRefId } = await ds.upload(enc(content), { isPublic: true });
    const result = await ds.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(new TextEncoder().encode(content));
  });

  it("public storageId on-chain matches the raw storage id", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId, storageId } = await ds.upload(enc("public"), {
      isPublic: true,
    });
    const ref = await ds.chainAdapter.readReference(chainRefId);
    // For public data the storageId on-chain must equal the raw storage id
    expect(ref.storageId).toBe(storageId);
    expect(ref.encryptionScheme).toBe("");
  });

  it("private upload stores an encrypted (different) storageId on-chain", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId, storageId } = await ds.upload(enc("private"));
    const ref = await ds.chainAdapter.readReference(chainRefId);
    expect(ref.storageId).not.toBe(storageId);
    expect(ref.encryptionScheme).toBe("xchacha20poly1305-v1");
  });

  it("two users can both retrieve the same public content by refId", async () => {
    const ds1 = await makeInitedDStorage();
    const ds2 = await makeInitedDStorage();
    const content = "shared public content";
    const { chainRefId } = await ds1.upload(enc(content), { isPublic: true });
    const result = await ds2.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(result.bytes)).toBe(content);
  });
});

// ── estimateCost ──────────────────────────────────────────────────────────────

describe("estimateCost", () => {
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
