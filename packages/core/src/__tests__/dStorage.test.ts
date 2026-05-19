import { describe, it, expect } from "vitest";
import { DStorage } from "../dStorage.js";
import { MockStorageAdapter } from "@dstorage/storage";
import type { StorageProviderName } from "@dstorage/storage";
import { MockChainAdapter } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import type { DStorageConfig } from "../types.js";

const enc = (s: string) => new TextEncoder().encode(s);

// ── Factory ────────────────────────────────────────────────────────────────────

function makeConfig(address = "0xTestUser"): DStorageConfig {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
    encryptionAdapters: [
      new PasswordEncryptionAdapter({
        password: "dstorage-test-passphrase-v1!",
        salt: address,
        params: { N: 1024, r: 8, p: 1 },
      }),
    ],
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

  it("throws a descriptive error when the configured storage adapter does not match the reference's storageProvider", async () => {
    // Upload with mock storage (name: "mock"), then try to retrieve with an
    // adapter that reports name: "arweave". Without a mismatch guard the SDK
    // silently hands the storageId to the wrong adapter and returns a cryptic
    // "not found" error. The guard must surface the real cause immediately.
    class ArweaveMockStorageAdapter extends MockStorageAdapter {
      override readonly name: StorageProviderName = "arweave";
    }

    const chainAdapter = new MockChainAdapter();
    const encryption = new PasswordEncryptionAdapter({
      password: "dstorage-test-passphrase-v1!",
      salt: "mismatch-test",
      params: { N: 1024, r: 8, p: 1 },
    });

    // Upload via "mock" storage adapter.
    const ds1 = new DStorage({
      storageAdapter: new MockStorageAdapter(),
      chainAdapter,
      encryptionAdapters: [encryption],
    });
    await ds1.init();
    const { chainRefId } = await ds1.upload(enc("hello"));

    // Try to retrieve via "arweave" adapter against the same chain.
    const ds2 = new DStorage({
      storageAdapter: new ArweaveMockStorageAdapter(),
      chainAdapter,
      encryptionAdapters: [encryption],
    });
    await ds2.init();

    await expect(ds2.retrieveByRefId(chainRefId)).rejects.toThrow(
      /storage adapter mismatch|mock.*arweave|arweave.*mock/i,
    );
  });
});

// ── public (isPublic: true) upload / retrieve ─────────────────────────────────

describe("public upload and retrieve", () => {
  it("throws when attempting a public upload without any seed provider", async () => {
    // Public uploads require at least one seed provider to derive a deterministic
    // ownerSecret. Without it the reference could never be removed or updated.
    const ds = new DStorage({
      storageAdapter: new MockStorageAdapter(),
      chainAdapter: new MockChainAdapter(),
      encryptionAdapters: [],
    });
    await ds.init();
    await expect(
      ds.upload(enc("public data"), { isPublic: true }),
    ).rejects.toThrow(
      "[dStorage] Cannot upload public data without at least one encryption seed provider.",
    );
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

// ── listReferences ────────────────────────────────────────────────────────────

describe("listReferences", () => {
  it("returns an array containing the ref after a private upload", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.upload(enc("list me"));
    const refs = await ds.listReferences();
    expect(refs.some((r) => r.refId === chainRefId)).toBe(true);
  });

  it("own private upload: storageId matches upload result and decryptionError is absent", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId, storageId: uploadedStorageId } = await ds.upload(
      enc("mine"),
    );
    const refs = await ds.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry?.storageId).toBe(uploadedStorageId);
    expect(entry?.decryptionError).toBeUndefined();
  });

  it("private upload by another user: storageId is null and decryptionError is set", async () => {
    const sharedStorage = new MockStorageAdapter();
    const sharedChain = new MockChainAdapter();
    const alice = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: sharedChain,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "alice-passphrase-lr",
          salt: "0xAlice_lr",
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    const bob = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: sharedChain,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "bob-passphrase-lr",
          salt: "0xBob_lr",
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    await alice.init();
    await bob.init();

    const { chainRefId, storageId: aliceStorageId } = await alice.upload(
      enc("Alice's secret"),
    );
    const refs = await bob.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry?.storageId).toBeNull();
    expect(entry?.decryptionError).toBeDefined();
    expect(entry?.decryptionError).toBeTypeOf("string");
    // Bob must not be able to see Alice's storageId
    expect(entry?.storageId).not.toBe(aliceStorageId);
  });

  it("own public upload: storageId matches upload result and decryptionError is absent", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId, storageId: uploadedStorageId } = await ds.upload(
      enc("public"),
      { isPublic: true },
    );
    const refs = await ds.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry?.storageId).toBe(uploadedStorageId);
    expect(entry?.decryptionError).toBeUndefined();
  });

  it("public upload by another user: storageId is visible but decryptionError is set", async () => {
    const adapters = {
      storageAdapter: new MockStorageAdapter(),
      chainAdapter: new MockChainAdapter(),
    };
    const alice = new DStorage({
      ...adapters,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "alice-passphrase",
          salt: "alice",
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    const bob = new DStorage({
      ...adapters,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "bob-passphrase",
          salt: "bob",
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    await alice.init();
    await bob.init();

    const { chainRefId, storageId: aliceStorageId } = await alice.upload(
      enc("alice public"),
      { isPublic: true },
    );
    const refs = await bob.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    // storageId is plaintext for public uploads — Bob can see it even though it's not his
    expect(entry?.storageId).toBe(aliceStorageId);
    expect(entry?.decryptionError).toBeDefined();
  });

  it("keyEnvelope is always a non-empty string for every entry in listReferences", async () => {
    const ds = await makeInitedDStorage();
    await ds.upload(enc("private ref"));
    await ds.upload(enc("public ref"), { isPublic: true });

    const refs = await ds.listReferences();
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      expect(typeof ref.keyEnvelope).toBe("string");
      expect(ref.keyEnvelope.length).toBeGreaterThan(0);
      expect(() => JSON.parse(ref.keyEnvelope)).not.toThrow();
    }
  });
});

// ── removeReference ───────────────────────────────────────────────────────────

describe("removeReference", () => {
  it("removed ref no longer appears in listReferences", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.upload(enc("to remove"));
    await ds.removeReference(chainRefId);
    const refs = await ds.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("retrieveByRefId throws after removal", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.upload(enc("to remove 2"));
    await ds.removeReference(chainRefId);
    await expect(ds.retrieveByRefId(chainRefId)).rejects.toThrow();
  });

  it("throws when the refId is not found", async () => {
    const ds = await makeInitedDStorage();
    await expect(ds.removeReference("ref_nonexistent")).rejects.toThrow();
  });

  it("public upload: removed ref no longer appears in listReferences", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.upload(enc("public to remove"), {
      isPublic: true,
    });
    await ds.removeReference(chainRefId);
    const refs = await ds.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("public upload: retrieveByRefId throws after removal", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.upload(enc("public to remove 2"), {
      isPublic: true,
    });
    await ds.removeReference(chainRefId);
    await expect(ds.retrieveByRefId(chainRefId)).rejects.toThrow();
  });
});

// ── estimateCost ──────────────────────────────────────────────────────────────

describe("estimateCost", () => {
  it("returns a CostEstimate with storageCost and chainCost", async () => {
    const ds = new DStorage(makeConfig());
    const result = await ds.estimateCost(enc("some content").byteLength);
    expect(result).toMatchObject({
      storageCost: { amount: expect.any(String), token: expect.any(String) },
      chainCost: { amount: expect.any(String), token: expect.any(String) },
      fileSizeBytes: expect.any(Number),
    });
  });

  it("storageCost amount reflects input byte length for mock adapter", async () => {
    const ds = new DStorage(makeConfig());
    const data = enc("some content");
    const result = await ds.estimateCost(data.byteLength);
    expect(result.storageCost.amount).toBe(`${data.byteLength}`);
    expect(result.fileSizeBytes).toBe(data.byteLength);
  });
});
