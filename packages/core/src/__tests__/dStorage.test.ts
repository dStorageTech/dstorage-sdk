import { describe, it, expect, vi } from "vitest";
import { DStorage } from "../dStorage.js";
import { MockStorageAdapter } from "@dstorage/storage";
import type { StorageProviderName } from "@dstorage/storage";
import {
  MidnightSimulatorChainAdapter,
  MockChainAdapter,
  ChainErrorCode,
} from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import type { DStorageConfig } from "../types.js";
import {
  MANIFEST_AAD,
  METADATA_AAD,
  METADATA_ONLY_OWNER_SECRET_SALT,
} from "../types.js";
import {
  CoreErrorCode,
  StorePartialError,
  isStorePartialError,
} from "../errors.js";
import {
  generateDek,
  buildKeyEnvelope,
  serializeKeyEnvelope,
  deriveOwnerSecret,
  XChaChaScheme,
  bytesToBase64url,
} from "@dstorage/crypto";

const enc = (s: string) => new TextEncoder().encode(s);

// ── Factory ────────────────────────────────────────────────────────────────────

function makeConfig(address = "0xTestUser"): DStorageConfig {
  return {
    storageAdapters: [new MockStorageAdapter()],
    chainAdapters: [new MidnightSimulatorChainAdapter()],
    encryptionAdapters: [
      new PasswordEncryptionAdapter({
        password: "dstorage-test-passphrase-v1!",
        salt: address,
        params: { N: 32768, r: 8, p: 1 },
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

// ── init / destroy ─────────────────────────────────────────────────────────

describe("init / destroy", () => {
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

  it("isConnected is false after destroy()", async () => {
    const ds = await makeInitedDStorage();
    ds.destroy();
    expect(ds.isConnected).toBe(false);
  });

  it("connectedAddress is null after destroy()", async () => {
    const ds = await makeInitedDStorage();
    ds.destroy();
    expect(ds.connectedAddress).toBeNull();
  });

  it("can re-init after destroy", async () => {
    const ds = new DStorage(makeConfig("0xAlice_ds2"));
    await ds.init();
    ds.destroy();
    await ds.init();
    expect(ds.isConnected).toBe(true);
  });

  it("destroy() calls destroy() on every encryption adapter that implements it", async () => {
    const destroySpy = vi.fn();
    const mockAdapter = {
      name: "mock-destroyable",
      wrapDek: vi.fn(),
      unwrapDek: vi.fn(),
      destroy: destroySpy,
    };
    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [new MidnightSimulatorChainAdapter()],
      encryptionAdapters: [mockAdapter],
    });
    await ds.init();
    ds.destroy();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("destroy() does not throw when an adapter has no destroy() method", async () => {
    const ds = await makeInitedDStorage("0xAlice_ds3");
    expect(() => ds.destroy()).not.toThrow();
  });
});

// ── assertConnected guard ─────────────────────────────────────────────────────

describe("operations before init() throw", () => {
  it("store() throws when not connected", async () => {
    const ds = new DStorage(makeConfig());
    await expect(ds.store(enc("hello"))).rejects.toMatchObject({
      code: CoreErrorCode.NOT_INITIALIZED,
      message: expect.stringContaining("[dStorage] Not connected"),
    });
  });

  it("retrieveByRefId() throws when not connected", async () => {
    const ds = new DStorage(makeConfig());
    await expect(ds.retrieveByRefId("any::ref")).rejects.toMatchObject({
      code: CoreErrorCode.NOT_INITIALIZED,
      message: expect.stringContaining("[dStorage] Not connected"),
    });
  });
});

// ── upload ────────────────────────────────────────────────────────────────────

describe("store", () => {
  it("returns a StoreResult with chainRefId and storageId", async () => {
    const ds = await makeInitedDStorage();
    const result = await ds.store(enc("hello world"));
    expect(result).toHaveProperty("chainRefId");
    expect(result).toHaveProperty("storageId");
  });

  it('storageProvider is "mock"', async () => {
    const ds = await makeInitedDStorage();
    const result = await ds.store(enc("hello world"));
    expect(result.storageProvider).toBe("mock");
  });

  it('chainProvider is "midnight"', async () => {
    const ds = await makeInitedDStorage();
    const result = await ds.store(enc("hello world"));
    expect(result.chainProvider).toBe("midnight");
  });

  it("uploadedAt is a recent timestamp", async () => {
    const before = Date.now();
    const ds = await makeInitedDStorage();
    const result = await ds.store(enc("hello world"));
    expect(result.uploadedAt).toBeGreaterThan(before - 1000);
  });

  it("accepts Uint8Array as content", async () => {
    const ds = await makeInitedDStorage();
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    const result = await ds.store(bytes);
    expect(result.chainRefId).toBeDefined();
  });

  it("two uploads of the same content produce different dataIds", async () => {
    const ds = await makeInitedDStorage();
    const r1 = await ds.store(enc("same content"));
    const r2 = await ds.store(enc("same content"));
    expect(r1.chainRefId).not.toBe(r2.chainRefId);
  });
});

// ── retrieveByRefId ──────────────────────────────────────────────────────────────────

describe("retrieveByRefId", () => {
  it("returns the original plaintext after store + retrieveByRefId", async () => {
    const ds = await makeInitedDStorage();
    const content = "Hello, private world!";
    const { chainRefId } = await ds.store(enc(content));
    const result = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(result.bytes)).toBe(content);
  });

  it("returns bytes matching the original UTF-8 encoding", async () => {
    const ds = await makeInitedDStorage();
    const content = "test bytes";
    const { chainRefId } = await ds.store(enc(content));
    const result = await ds.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(new TextEncoder().encode(content));
  });

  it("returns metadata as an object (possibly empty)", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("meta test"));
    const result = await ds.retrieveByRefId(chainRefId);
    expect(typeof result.metadata).toBe("object");
  });

  it("different seed providers produce different ciphertexts for same plaintext", async () => {
    const ds1 = new DStorage(makeConfig("0xAlice_retrieve"));
    const ds2 = new DStorage(makeConfig("0xBob_retrieve"));
    await ds1.init();
    await ds2.init();

    const { storageId: id1 } = await ds1.store(enc("same text"));
    const { storageId: id2 } = await ds2.store(enc("same text"));

    expect(id1).not.toBe(id2);
  });

  it("retrieves multiple distinct uploads correctly", async () => {
    const ds = await makeInitedDStorage();
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 5; i++) {
      const content = `record-${i}`;
      const { chainRefId } = await ds.store(enc(content));
      pairs.push([chainRefId, content]);
    }
    for (const [chainRefId, expected] of pairs) {
      const result = await ds.retrieveByRefId(chainRefId);
      expect(new TextDecoder().decode(result.bytes)).toBe(expected);
    }
  });

  it("throws when the chainRefId is not found in storage", async () => {
    const ds = await makeInitedDStorage();
    await expect(ds.retrieveByRefId("a".repeat(64))).rejects.toMatchObject({
      code: ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
      message: expect.stringContaining(
        "No reference found for refId: " + "a".repeat(64),
      ),
    });
  });

  // A storage adapter that reports a different provider name (e.g. "arweave")
  // but is otherwise a fully independent MockStorageAdapter instance (its own
  // in-memory store) — used below to simulate a configured adapter that
  // doesn't hold the content being retrieved.
  class ArweaveMockStorageAdapter extends MockStorageAdapter {
    override readonly name: StorageProviderName = "arweave";
  }

  it("falls back to the next configured storage adapter when an earlier one fails", async () => {
    // MockStorageAdapter's backing store is module-level (shared across every
    // instance), so a genuine "doesn't hold the content" failure has to be
    // forced via a spy rather than relying on separate instances/providers.
    const failingStorage = new ArweaveMockStorageAdapter();
    vi.spyOn(failingStorage, "retrieve").mockRejectedValue(
      new Error("simulated network failure"),
    );
    const workingStorage = new MockStorageAdapter();
    const chainAdapter = new MidnightSimulatorChainAdapter();
    const encryption = new PasswordEncryptionAdapter({
      password: "dstorage-test-passphrase-v1!",
      salt: "fallback-test",
      params: { N: 32768, r: 8, p: 1 },
    });

    const uploader = new DStorage({
      storageAdapters: [workingStorage],
      chainAdapters: [chainAdapter],
      encryptionAdapters: [encryption],
    });
    await uploader.init();
    const { chainRefId } = await uploader.store(enc("hello"));

    const retriever = new DStorage({
      storageAdapters: [failingStorage, workingStorage],
      chainAdapters: [chainAdapter],
      encryptionAdapters: [encryption],
    });
    await retriever.init();

    const { bytes } = await retriever.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(failingStorage.retrieve).toHaveBeenCalled();
  });

  it("throws STORAGE_READ_ALL_FAILED with a per-adapter cause when every configured storage adapter fails", async () => {
    const chainAdapter = new MidnightSimulatorChainAdapter();
    const encryption = new PasswordEncryptionAdapter({
      password: "dstorage-test-passphrase-v1!",
      salt: "all-failed-test",
      params: { N: 32768, r: 8, p: 1 },
    });

    const uploader = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [chainAdapter],
      encryptionAdapters: [encryption],
    });
    await uploader.init();
    const { chainRefId } = await uploader.store(enc("hello"));

    // Both configured adapters fail — neither actually resolves the retrieve.
    const failingA = new ArweaveMockStorageAdapter();
    const failingB = new ArweaveMockStorageAdapter();
    vi.spyOn(failingA, "retrieve").mockRejectedValue(new Error("fail A"));
    vi.spyOn(failingB, "retrieve").mockRejectedValue(new Error("fail B"));

    const retriever = new DStorage({
      storageAdapters: [failingA, failingB],
      chainAdapters: [chainAdapter],
      encryptionAdapters: [encryption],
    });
    await retriever.init();

    const err = await retriever
      .retrieveByRefId(chainRefId)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: CoreErrorCode.STORAGE_READ_ALL_FAILED });
    expect((err as { cause?: unknown[] }).cause).toHaveLength(2);
  });
});

// ── keyEnvelope error codes ───────────────────────────────────────────────────
// _getDekScheme must distinguish three structurally different failure modes so
// callers can tell corruption/tampering apart from a simple wrong-password case.

describe("keyEnvelope error codes on retrieveByRefId", () => {
  // Helper: a chain adapter that overrides readReference to inject a bad envelope.
  class TamperedChainAdapter extends MidnightSimulatorChainAdapter {
    constructor(private readonly badEnvelope: string) {
      super();
    }
    override async readReference(
      refId: string,
    ): Promise<import("@dstorage/chain").ChainReference> {
      const ref = await super.readReference(refId);
      return { ...ref, keyEnvelope: this.badEnvelope };
    }
    override async listReferences(): Promise<
      import("@dstorage/chain").DataReferenceSummary[]
    > {
      const refs = await super.listReferences();
      return refs.map((r) => ({ ...r, keyEnvelope: this.badEnvelope }));
    }
  }

  async function makeWithTamperedEnvelope(badEnvelope: string) {
    const chain = new TamperedChainAdapter(badEnvelope);
    // Upload with a normal adapter so a valid ref exists in the mock store.
    const uploader = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [chain],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-test-passphrase-v1!",
          salt: "envelope-test",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await uploader.init();
    const { chainRefId } = await uploader.store(enc("tamper test"));
    return { ds: uploader, chainRefId };
  }

  it("throws with cause.code 'envelope_empty' when keyEnvelope is empty", async () => {
    const { ds, chainRefId } = await makeWithTamperedEnvelope("");
    const err = await ds.retrieveByRefId(chainRefId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(
      (err as Error & { code?: number; cause?: { code?: string } }).code,
    ).toBe(CoreErrorCode.RETRIEVE_BY_REF_ID_ENVELOPE_EMPTY);
    expect((err as Error & { cause?: { code?: string } }).cause?.code).toBe(
      "envelope_empty",
    );
  });

  it("throws with cause.code 'envelope_malformed' when keyEnvelope is invalid JSON", async () => {
    const { ds, chainRefId } = await makeWithTamperedEnvelope("not-valid-json");
    const err = await ds.retrieveByRefId(chainRefId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(
      (err as Error & { code?: number; cause?: { code?: string } }).code,
    ).toBe(CoreErrorCode.DECRYPT_ENVELOPE_MALFORMED);
    expect((err as Error & { cause?: { code?: string } }).cause?.code).toBe(
      "envelope_malformed",
    );
  });

  it("throws with cause.code 'envelope_malformed' when keyEnvelope JSON has wrong structure", async () => {
    const { ds, chainRefId } = await makeWithTamperedEnvelope(
      JSON.stringify({ v: 1, wrappers: [] }),
    );
    const err = await ds.retrieveByRefId(chainRefId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(
      (err as Error & { code?: number; cause?: { code?: string } }).code,
    ).toBe(CoreErrorCode.DECRYPT_ENVELOPE_MALFORMED);
    expect((err as Error & { cause?: { code?: string } }).cause?.code).toBe(
      "envelope_malformed",
    );
  });

  it("throws with cause.code 'no_wrapper_matched' when the envelope is valid but the key is wrong", async () => {
    const chain = new MidnightSimulatorChainAdapter();
    const alice = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [chain],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "alice-passphrase-ec",
          salt: "0xAlice_ec",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    const bob = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [chain],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "bob-passphrase-ec",
          salt: "0xBob_ec",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await alice.init();
    await bob.init();
    const { chainRefId } = await alice.store(enc("alice secret ec"));
    const err = await bob.retrieveByRefId(chainRefId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(
      (err as Error & { code?: number; cause?: { code?: string } }).code,
    ).toBe(CoreErrorCode.DECRYPT_NO_WRAPPER_MATCHED);
    expect((err as Error & { cause?: { code?: string } }).cause?.code).toBe(
      "no_wrapper_matched",
    );
  });

  it("decryptionError in listReferences reflects the error code in its message", async () => {
    const { ds, chainRefId } = await makeWithTamperedEnvelope("bad{json");
    const refs = await ds.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry?.decryptionError).toBeDefined();
    expect(entry?.decryptionError).toMatch(/malformed/i);
  });
});

// ── public (isPublic: true) upload / retrieve ─────────────────────────────────

describe("public store and retrieve", () => {
  it("throws when attempting a public store without any seed provider", async () => {
    // Public uploads require at least one seed provider to derive a deterministic
    // ownerSecret. Without it the reference could never be removed or updated.
    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [new MidnightSimulatorChainAdapter()],
      encryptionAdapters: [],
    });
    await ds.init();
    await expect(
      ds.store(enc("public data"), { isPublic: true }),
    ).rejects.toMatchObject({
      code: CoreErrorCode.PUBLIC_UPLOAD_REQUIRES_SEED_PROVIDER,
      message: expect.stringContaining(
        "[dStorage] Cannot store public data without at least one encryption seed provider.",
      ),
    });
  });

  it("retrieves the original content via refId for public store", async () => {
    const ds = await makeInitedDStorage();
    const content = "hello, public world!";
    const { chainRefId } = await ds.store(enc(content), { isPublic: true });
    const result = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(result.bytes)).toBe(content);
  });

  it("retrieves the original bytes via refId for public store", async () => {
    const ds = await makeInitedDStorage();
    const content = "public bytes";
    const { chainRefId } = await ds.store(enc(content), { isPublic: true });
    const result = await ds.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(new TextEncoder().encode(content));
  });

  it("public storageId on-chain matches the raw storage id", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId, storageId } = await ds.store(enc("public"), {
      isPublic: true,
    });
    const ref = await ds.chainAdapters[0]!.readReference(chainRefId);
    // For public data the storageId on-chain must equal the raw storage id
    expect(ref.storageId).toBe(storageId);
    expect(ref.encryptionScheme).toBe("");
  });

  it("private store stores an encrypted (different) storageId on-chain", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId, storageId } = await ds.store(enc("private"));
    const ref = await ds.chainAdapters[0]!.readReference(chainRefId);
    expect(ref.storageId).not.toBe(storageId);
    expect(ref.encryptionScheme).toBe("xchacha20poly1305-v1");
  });

  it("private store: bytes stored in storage are not the original plaintext", async () => {
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const plaintext = enc("sensitive patient data");
    const { storageId } = await ds.store(plaintext);

    const rawStored = storage.get(storageId)!;
    // Raw bytes in storage must differ from the original plaintext
    expect(rawStored).not.toEqual(plaintext);
    // And must not contain the plaintext as a substring
    expect(Buffer.from(rawStored).toString()).not.toContain(
      "sensitive patient data",
    );
  });

  it("private store: metadata stored on-chain is not the plaintext JSON", async () => {
    const config = makeConfig();
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const meta = { name: "Alice", doctor: "Dr Smith" };
    const { chainRefId } = await ds.store(enc("record"), { metadata: meta });

    const ref = await chain.readReference(chainRefId!);
    // encryptedMetadata must be set and must not equal the plain JSON
    expect(ref.encryptedMetadata).toBeDefined();
    expect(ref.encryptedMetadata).not.toBe(JSON.stringify(meta));
    // Must not contain the plaintext values as readable strings
    expect(ref.encryptedMetadata).not.toContain("Alice");
    expect(ref.encryptedMetadata).not.toContain("Dr Smith");
  });

  it("tampered ciphertext in storage is caught by on-chain hash check before decryption", async () => {
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId, storageId } = await ds.store(enc("original content"));

    // Flip a byte in the middle of the ciphertext. With contentHash stored on-chain,
    // the hash check fires before decryption and throws CONTENT_HASH_MISMATCH.
    const raw = storage.get(storageId)!;
    const tampered = new Uint8Array(raw);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    storage.set(storageId, tampered);

    await expect(ds.retrieveByRefId(chainRefId!)).rejects.toMatchObject({
      code: CoreErrorCode.CONTENT_HASH_MISMATCH,
    });
  });

  it("two users can both retrieve the same public content by refId", async () => {
    const sharedStorage = new MockStorageAdapter();
    const sharedChain = new MidnightSimulatorChainAdapter();
    const makePublicUser = (address: string) =>
      new DStorage({
        storageAdapters: [sharedStorage],
        chainAdapters: [sharedChain],
        encryptionAdapters: [
          new PasswordEncryptionAdapter({
            password: "dstorage-test-passphrase-v1!",
            salt: address,
            params: { N: 32768, r: 8, p: 1 },
          }),
        ],
      });
    const ds1 = makePublicUser("0xUserA");
    const ds2 = makePublicUser("0xUserB");
    await ds1.init();
    await ds2.init();
    const content = "shared public content";
    const { chainRefId } = await ds1.store(enc(content), { isPublic: true });
    const result = await ds2.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(result.bytes)).toBe(content);
  });
});

// ── listReferences ────────────────────────────────────────────────────────────

describe("listReferences", () => {
  it("returns an array containing the ref after a private store", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("list me"));
    const refs = await ds.listReferences();
    expect(refs.some((r) => r.refId === chainRefId)).toBe(true);
  });

  it("own private store: storageId matches upload result and decryptionError is absent", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId, storageId: uploadedStorageId } = await ds.store(
      enc("mine"),
    );
    const refs = await ds.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry?.storageId).toBe(uploadedStorageId);
    expect(entry?.decryptionError).toBeUndefined();
  });

  it("private store by another user: storageId is null and decryptionError is set", async () => {
    const sharedStorage = new MockStorageAdapter();
    const sharedChain = new MidnightSimulatorChainAdapter();
    const alice = new DStorage({
      storageAdapters: [sharedStorage],
      chainAdapters: [sharedChain],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "alice-passphrase-lr",
          salt: "0xAlice_lr",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    const bob = new DStorage({
      storageAdapters: [sharedStorage],
      chainAdapters: [sharedChain],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "bob-passphrase-lr",
          salt: "0xBob_lr",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await alice.init();
    await bob.init();

    const { chainRefId, storageId: aliceStorageId } = await alice.store(
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

  it("own public store: storageId matches upload result and decryptionError is absent", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId, storageId: uploadedStorageId } = await ds.store(
      enc("public"),
      { isPublic: true },
    );
    const refs = await ds.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry?.storageId).toBe(uploadedStorageId);
    expect(entry?.decryptionError).toBeUndefined();
  });

  it("public store by another user: storageId is visible but decryptionError is set", async () => {
    const adapters = {
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [new MidnightSimulatorChainAdapter()],
    };
    const alice = new DStorage({
      ...adapters,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "alice-passphrase",
          salt: "alice",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    const bob = new DStorage({
      ...adapters,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "bob-passphrase",
          salt: "bob",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await alice.init();
    await bob.init();

    const { chainRefId, storageId: aliceStorageId } = await alice.store(
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
    await ds.store(enc("private ref"));
    await ds.store(enc("public ref"), { isPublic: true });

    const refs = await ds.listReferences();
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      expect(typeof ref.keyEnvelope).toBe("string");
      expect(ref.keyEnvelope.length).toBeGreaterThan(0);
      expect(() => JSON.parse(ref.keyEnvelope)).not.toThrow();
    }
  });
});

// ── metadata and tags ─────────────────────────────────────────────────────────

describe("store metadata option", () => {
  it("metadata is returned by retrieveByRefId after store", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("with metadata"), {
      metadata: { title: "My File", category: "test" },
    });
    const result = await ds.retrieveByRefId(chainRefId!);
    expect(result.metadata).toEqual({ title: "My File", category: "test" });
  });

  it("metadata is empty object when none was provided at store", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("no metadata"));
    const result = await ds.retrieveByRefId(chainRefId!);
    expect(result.metadata).toEqual({});
  });

  it("metadata is decrypted in listReferences for own uploads", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("listed with metadata"), {
      metadata: { source: "test-suite" },
    });
    const refs = await ds.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry?.metadata).toEqual({ source: "test-suite" });
  });

  it("metadata is absent in listReferences when none was provided", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("no meta listed"));
    const refs = await ds.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry?.metadata).toBeUndefined();
  });

  it("another user cannot decrypt metadata from listReferences", async () => {
    const sharedStorage = new MockStorageAdapter();
    const sharedChain = new MidnightSimulatorChainAdapter();
    const alice = new DStorage({
      storageAdapters: [sharedStorage],
      chainAdapters: [sharedChain],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "alice-passphrase-meta",
          salt: "alice-meta",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    const bob = new DStorage({
      storageAdapters: [sharedStorage],
      chainAdapters: [sharedChain],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "bob-passphrase-meta",
          salt: "bob-meta",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await alice.init();
    await bob.init();

    const { chainRefId } = await alice.store(enc("alice secret"), {
      metadata: { secret: "alice-only" },
    });
    const refs = await bob.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    // Bob cannot decrypt Alice's metadata — field is absent
    expect(entry?.metadata).toBeUndefined();
  });

  it("throws when metadata is used with isPublic store", async () => {
    const ds = await makeInitedDStorage();
    await expect(
      ds.store(enc("public with meta"), {
        metadata: { key: "val" },
        isPublic: true,
      }),
    ).rejects.toMatchObject({
      code: CoreErrorCode.METADATA_WITH_PUBLIC_UPLOAD,
      message: expect.stringContaining("[dStorage]"),
    });
  });

  it("refIds filter returns only the requested reference", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: id1 } = await ds.store(enc("ref-one"));
    const { chainRefId: id2 } = await ds.store(enc("ref-two"));
    const refs = await ds.listReferences({ refIds: [id1!] });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.refId).toBe(id1);
    expect(refs.some((r) => r.refId === id2)).toBe(false);
  });

  it("refIds filter with multiple ids returns only matched references", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: id1 } = await ds.store(enc("multi-one"));
    const { chainRefId: id2 } = await ds.store(enc("multi-two"));
    const { chainRefId: id3 } = await ds.store(enc("multi-three"));
    const refs = await ds.listReferences({ refIds: [id1!, id3!] });
    expect(refs).toHaveLength(2);
    expect(refs.some((r) => r.refId === id1)).toBe(true);
    expect(refs.some((r) => r.refId === id3)).toBe(true);
    expect(refs.some((r) => r.refId === id2)).toBe(false);
  });
});

describe("store tags option", () => {
  it("tags are forwarded to the storage adapter", async () => {
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const storeSpy = vi.spyOn(storage, "store");
    await ds.store(enc("tagged content"), {
      tags: { "App-Name": "dstorage-test" },
    });

    expect(storeSpy).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ "App-Name": "dstorage-test" }),
    );
  });

  it("tags are returned in RetrieveResult.tags from retrieveByRefId", async () => {
    const config = makeConfig();
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId } = await ds.store(enc("tagged"), {
      tags: { "App-Name": "my-app" },
    });
    const result = await ds.retrieveByRefId(chainRefId!);
    expect(result.tags).toMatchObject({ "App-Name": "my-app" });
  });

  it("tags and metadata can both be provided; metadata is encrypted, tags are not", async () => {
    const config = makeConfig();
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId } = await ds.store(enc("both"), {
      tags: { "App-Name": "app" },
      metadata: { title: "My Doc" },
    });
    const result = await ds.retrieveByRefId(chainRefId!);
    expect(result.tags).toMatchObject({ "App-Name": "app" });
    expect(result.metadata).toEqual({ title: "My Doc" });
  });
});

describe("dStorage-Version tag", () => {
  it("store() tags the upload with dStorage-Version", async () => {
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const storeSpy = vi.spyOn(storage, "store");
    await ds.store(enc("versioned content"));

    expect(storeSpy).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ "dStorage-Version": expect.any(String) }),
    );
  });

  it("update() tags the upload with dStorage-Version", async () => {
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId: refId } = await ds.store(enc("v1 content"));

    const storeSpy = vi.spyOn(storage, "store");
    await ds.update(refId!, enc("v2 content"));

    expect(storeSpy).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ "dStorage-Version": expect.any(String) }),
    );
  });
});

// ── removeReference ───────────────────────────────────────────────────────────

describe("removeReference", () => {
  it("removed ref no longer appears in listReferences", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("to remove"));
    await ds.removeReference(chainRefId);
    const refs = await ds.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("retrieveByRefId throws after removal", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("to remove 2"));
    await ds.removeReference(chainRefId);
    await expect(ds.retrieveByRefId(chainRefId)).rejects.toMatchObject({
      code: ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
    });
  });

  it("throws when the refId is not found", async () => {
    const ds = await makeInitedDStorage();
    await expect(ds.removeReference("b".repeat(64))).rejects.toMatchObject({
      code: ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
    });
  });

  it("public store: removed ref no longer appears in listReferences", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("public to remove"), {
      isPublic: true,
    });
    await ds.removeReference(chainRefId);
    const refs = await ds.listReferences();
    expect(refs.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("public store: retrieveByRefId throws after removal", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("public to remove 2"), {
      isPublic: true,
    });
    await ds.removeReference(chainRefId);
    await expect(ds.retrieveByRefId(chainRefId)).rejects.toMatchObject({
      code: ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
    });
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

// ── registerReference ─────────────────────────────────────────────────────────

describe("registerReference", () => {
  it("returns a chainRefId", async () => {
    const ds = await makeInitedDStorage();
    const result = await ds.registerReference({
      storageId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(typeof result.chainRefId).toBe("string");
    expect(result.chainRefId.length).toBeGreaterThan(0);
  });

  it("ref appears in listReferences after registerReference", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.registerReference({
      storageId: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    const refs = await ds.listReferences();
    expect(refs.some((r) => r.refId === chainRefId)).toBe(true);
  });

  it("throws when no chain adapter is configured", async () => {
    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-test-passphrase-v1!",
          salt: "s",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await ds.init();
    await expect(
      ds.registerReference({ storageId: "someId" }),
    ).rejects.toMatchObject({
      code: CoreErrorCode.REGISTER_REF_REQUIRES_CHAIN,
      message: expect.stringContaining("requires a chain adapter"),
    });
  });

  it("throws when no encryption adapters are configured", async () => {
    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [new MidnightSimulatorChainAdapter()],
    });
    await ds.init();
    await expect(
      ds.registerReference({ storageId: "someId" }),
    ).rejects.toMatchObject({
      code: CoreErrorCode.REGISTER_REF_REQUIRES_ENCRYPTION,
      message: expect.stringContaining(
        "requires at least one encryption adapter",
      ),
    });
  });

  it("forwards storageProvider option to the chain reference", async () => {
    const config = makeConfig();
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId } = await ds.registerReference({
      storageId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      storageProvider: "arweave" as StorageProviderName,
    });

    const refs = await chain.listReferences();
    const entry = refs.find((r) => r.refId === chainRefId);
    expect(entry?.storageProvider).toBe("arweave");
  });

  it("metadata is returned by retrieveByRefId after registerReference with no content", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.registerReference({
      metadata: { type: "profile", name: "Alice" },
    });
    const result = await ds.retrieveByRefId(chainRefId);
    expect(result.metadata).toEqual({ type: "profile", name: "Alice" });
    expect(result.bytes).toEqual(new Uint8Array(0));
    expect(result.tags).toEqual({});
  });

  it("retrieveByRefId returns empty bytes when registerReference had no storageId and no metadata", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.registerReference();
    const result = await ds.retrieveByRefId(chainRefId);
    expect(result.bytes).toEqual(new Uint8Array(0));
    expect(result.metadata).toEqual({});
  });
});

// ── updateUpload ──────────────────────────────────────────────────────────────

describe("update", () => {
  it("returns { chainRefId, storageId }", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: refId } = await ds.store(enc("v1 content"));
    const result = await ds.update(refId!, enc("v2 content"));
    expect(result.chainRefId).toBe(refId);
    expect(typeof result.storageId).toBe("string");
  });

  it("round-trip: retrieveByRefId returns v2 bytes after update", async () => {
    const ds = await makeInitedDStorage();
    const v1 = enc("version one content");
    const v2 = enc("version two content — updated");
    const { chainRefId: refId } = await ds.store(v1);
    await ds.update(refId!, v2);
    const { bytes } = await ds.retrieveByRefId(refId!);
    expect(bytes).toEqual(v2);
  });

  it("throws when no chain adapter is configured", async () => {
    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-test-passphrase-v1!",
          salt: "s",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await ds.init();
    await expect(ds.update("refId", enc("data"))).rejects.toMatchObject({
      code: CoreErrorCode.UPDATE_UPLOAD_REQUIRES_CHAIN,
      message: expect.stringContaining("requires a chain adapter"),
    });
  });

  it("throws when the chain adapter does not support updateReference", async () => {
    class NoUpdateChain extends MidnightSimulatorChainAdapter {
      override updateReference =
        undefined as unknown as MidnightSimulatorChainAdapter["updateReference"];
    }
    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [new NoUpdateChain()],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-test-passphrase-v1!",
          salt: "s",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await ds.init();
    const { chainRefId: refId } = await ds.store(enc("v1"));
    await expect(ds.update(refId!, enc("v2"))).rejects.toMatchObject({
      code: CoreErrorCode.UPDATE_UPLOAD_NOT_SUPPORTED,
      message: expect.stringContaining("not supported by this chain adapter"),
    });
  });

  it("throws when no encryption adapters are configured", async () => {
    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [new MidnightSimulatorChainAdapter()],
    });
    await ds.init();
    await expect(ds.update("refId", enc("data"))).rejects.toMatchObject({
      code: CoreErrorCode.UPDATE_UPLOAD_REQUIRES_ENCRYPTION,
      message: expect.stringContaining(
        "requires at least one encryption adapter",
      ),
    });
  });

  it("removeReference succeeds after update", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("v1 content"));
    await ds.update(chainRefId!, enc("v2 content"));
    await expect(ds.removeReference(chainRefId!)).resolves.toBeUndefined();
  });

  it("second update succeeds after first update", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("v1 content"));
    await ds.update(chainRefId!, enc("v2 content"));
    await ds.update(chainRefId!, enc("v3 content"));
    const { bytes } = await ds.retrieveByRefId(chainRefId!);
    expect(bytes).toEqual(enc("v3 content"));
  });

  it("preserves a chain adapter's own error code instead of rewrapping it as UNKNOWN_ERROR", async () => {
    // Simulates an error thrown by a *different* package's independently
    // bundled DStorageError class — same duck-typed shape (name + numeric
    // code), but a distinct class reference, so `instanceof DStorageError`
    // fails inside core's wrapError() even though it structurally is one.
    class FakeBundledDStorageError extends Error {
      readonly code: number;
      constructor(code: number, message: string) {
        super(message);
        this.name = "DStorageError";
        this.code = code;
      }
    }

    class ReadFailsChain extends MidnightSimulatorChainAdapter {
      override readReference = vi
        .fn()
        .mockRejectedValue(
          new FakeBundledDStorageError(
            ChainErrorCode.GATEWAY_READ_HTTP_ERROR,
            "[dStorage/http-gateway-chain] readReference failed: HTTP 404 Not Found",
          ),
        );
    }

    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [new ReadFailsChain()],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-test-passphrase-v1!",
          salt: "s",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await ds.init();

    // update() calls _computeOwnerSecret(refId), which calls
    // chainAdapter.readReference(refId) — the exact call path that
    // originally surfaced this bug.
    await expect(ds.update("some-ref-id", enc("v2"))).rejects.toMatchObject({
      code: ChainErrorCode.GATEWAY_READ_HTTP_ERROR,
    });
  });
});

// ── store() refId option ──────────────────────────────────────────────────────

describe("store() refId option", () => {
  it("honors a caller-supplied refId when the chain adapter supports it", async () => {
    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [new MockChainAdapter()],
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-test-passphrase-v1!",
          salt: "s",
          params: { N: 32768, r: 8, p: 1 },
        }),
      ],
    });
    await ds.init();

    const result = await ds.store(enc("hello"), { refId: "my-custom-ref-id" });
    expect(result.chainRefId).toBe("my-custom-ref-id");

    // Round-trips too — the reference really was stored under that ID.
    const { bytes } = await ds.retrieveByRefId("my-custom-ref-id");
    expect(bytes).toEqual(enc("hello"));
  });

  it("is ignored by chain adapters whose refId is protocol-determined", async () => {
    // MidnightSimulatorChainAdapter derives refId from the ZK circuit/ledger
    // call itself — it never reads ChainReference.refId — mirroring the same
    // documented best-effort contract already established for
    // registerReference()'s refId option.
    const ds = await makeInitedDStorage();
    const result = await ds.store(enc("hello"), {
      refId: "requested-but-ignored",
    });
    expect(result.chainRefId).not.toBe("requested-but-ignored");
  });
});

// ── update() StorePartialError recovery ───────────────────────────────────────

describe("update() StorePartialError recovery", () => {
  it("update() throws StorePartialError when chain write fails", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: refId } = await ds.store(enc("v1"));
    vi.spyOn(ds.chainAdapters[0]!, "updateReference").mockRejectedValueOnce(
      new Error("chain down"),
    );
    await expect(ds.update(refId!, enc("v2"))).rejects.toBeInstanceOf(
      StorePartialError,
    );
  });

  it("isStorePartialError() returns true for the error thrown by update()", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: refId } = await ds.store(enc("v1"));
    vi.spyOn(ds.chainAdapters[0]!, "updateReference").mockRejectedValueOnce(
      new Error("chain down"),
    );
    const err = await ds.update(refId!, enc("v2")).catch((e: unknown) => e);
    expect(isStorePartialError(err)).toBe(true);
  });

  it("StorePartialError from update() has code CHAIN_WRITE_FAILED", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: refId } = await ds.store(enc("v1"));
    vi.spyOn(ds.chainAdapters[0]!, "updateReference").mockRejectedValueOnce(
      new Error("timeout"),
    );
    const err = await ds.update(refId!, enc("v2")).catch((e: unknown) => e);
    expect((err as StorePartialError).code).toBe(
      CoreErrorCode.CHAIN_WRITE_FAILED,
    );
  });

  it("StorePartialError from update() carries the underlying error as cause and in its message", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: refId } = await ds.store(enc("v1"));
    const underlying = new Error(
      "[dStorage/managed-payment] POST /api/service/sign-tx failed: HTTP 500 — insufficient funds",
    );
    vi.spyOn(ds.chainAdapters[0]!, "updateReference").mockRejectedValueOnce(
      underlying,
    );
    const err = await ds.update(refId!, enc("v2")).catch((e: unknown) => e);
    expect((err as StorePartialError).cause).toBe(underlying);
    expect((err as StorePartialError).message).toContain(underlying.message);
  });

  it("StorePartialError.recovery.storageId is a non-empty string", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: refId } = await ds.store(enc("v1"));
    vi.spyOn(ds.chainAdapters[0]!, "updateReference").mockRejectedValueOnce(
      new Error("net"),
    );
    const err = await ds.update(refId!, enc("v2")).catch((e: unknown) => e);
    const { storageId } = (err as StorePartialError).recovery;
    expect(typeof storageId).toBe("string");
    expect(storageId.length).toBeGreaterThan(0);
  });

  it("StorePartialError.recovery.keyEnvelope is a non-empty string", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: refId } = await ds.store(enc("v1"));
    vi.spyOn(ds.chainAdapters[0]!, "updateReference").mockRejectedValueOnce(
      new Error("net"),
    );
    const err = await ds.update(refId!, enc("v2")).catch((e: unknown) => e);
    const { keyEnvelope } = (err as StorePartialError).recovery;
    expect(typeof keyEnvelope).toBe("string");
    expect((keyEnvelope as string).length).toBeGreaterThan(0);
  });

  it("retryUpdate() returns { chainRefId, storageId }", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: refId } = await ds.store(enc("v1"));
    vi.spyOn(ds.chainAdapters[0]!, "updateReference").mockRejectedValueOnce(
      new Error("chain down"),
    );
    const err = await ds.update(refId!, enc("v2")).catch((e: unknown) => e);
    expect(isStorePartialError(err)).toBe(true);

    const result = await ds.retryUpdate(
      refId!,
      (err as StorePartialError).recovery,
    );
    expect(result.chainRefId).toBe(refId);
    expect(typeof result.storageId).toBe("string");
    expect(result.storageId.length).toBeGreaterThan(0);
  });

  it("full round-trip: update() chain write fails → retryUpdate() → retrieveByRefId() returns new bytes", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: refId } = await ds.store(enc("v1 content"));
    vi.spyOn(ds.chainAdapters[0]!, "updateReference").mockRejectedValueOnce(
      new Error("chain temporarily down"),
    );

    const err = await ds
      .update(refId!, enc("v2 content"))
      .catch((e: unknown) => e);
    expect(isStorePartialError(err)).toBe(true);

    await ds.retryUpdate(refId!, (err as StorePartialError).recovery);
    const { bytes } = await ds.retrieveByRefId(refId!);
    expect(bytes).toEqual(enc("v2 content"));
  });

  it("proactive path: onProgress recovery → retryUpdate() → retrieveByRefId() returns new bytes", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId: refId } = await ds.store(enc("v1 content"));

    let capturedRecovery: StorePartialError["recovery"] | undefined;
    vi.spyOn(ds.chainAdapters[0]!, "updateReference").mockRejectedValueOnce(
      new Error("chain down"),
    );

    await ds
      .update(refId!, enc("v2 content"), {
        onProgress: (p) => {
          if (p.phase === "stored" && p.recovery) {
            capturedRecovery = p.recovery;
          }
        },
      })
      .catch(() => {});

    expect(capturedRecovery).toBeDefined();
    await ds.retryUpdate(refId!, capturedRecovery!);
    const { bytes } = await ds.retrieveByRefId(refId!);
    expect(bytes).toEqual(enc("v2 content"));
  });
});

// ── StorePartialError recovery ─────────────────────────────────────────────────

describe("StorePartialError recovery", () => {
  // ── reactive path (catch the error) ─────────────────────────────────────────

  it("store() throws StorePartialError (not generic DStorageError) when chain write fails", async () => {
    const ds = await makeInitedDStorage();
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("chain down"),
    );
    await expect(ds.store(enc("hello"))).rejects.toBeInstanceOf(
      StorePartialError,
    );
  });

  it("StorePartialError has code CHAIN_WRITE_FAILED", async () => {
    const ds = await makeInitedDStorage();
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("timeout"),
    );
    const err = await ds.store(enc("hello")).catch((e: unknown) => e);
    expect((err as StorePartialError).code).toBe(
      CoreErrorCode.CHAIN_WRITE_FAILED,
    );
  });

  it("StorePartialError from store() carries the underlying error as cause and in its message", async () => {
    const ds = await makeInitedDStorage();
    const underlying = new Error(
      "[dStorage/managed-payment] POST /api/service/sign-tx failed: HTTP 500 — insufficient funds",
    );
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      underlying,
    );
    const err = await ds.store(enc("hello")).catch((e: unknown) => e);
    expect((err as StorePartialError).cause).toBe(underlying);
    expect((err as StorePartialError).message).toContain(underlying.message);
  });

  it("StorePartialError.recovery.storageId is a non-empty string", async () => {
    const ds = await makeInitedDStorage();
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("net"),
    );
    const err = await ds.store(enc("content")).catch((e: unknown) => e);
    expect(typeof (err as StorePartialError).recovery.storageId).toBe("string");
    expect(
      (err as StorePartialError).recovery.storageId.length,
    ).toBeGreaterThan(0);
  });

  it("StorePartialError.recovery.storageProvider matches the configured adapter", async () => {
    const ds = await makeInitedDStorage();
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("net"),
    );
    const err = await ds.store(enc("content")).catch((e: unknown) => e);
    expect((err as StorePartialError).recovery.storageProvider).toBe("mock");
  });

  it("StorePartialError.recovery.keyEnvelope is a non-empty string for private uploads", async () => {
    const ds = await makeInitedDStorage();
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("net"),
    );
    const err = await ds.store(enc("private")).catch((e: unknown) => e);
    const recovery = (err as StorePartialError).recovery;
    expect(typeof recovery.keyEnvelope).toBe("string");
    expect((recovery.keyEnvelope as string).length).toBeGreaterThan(0);
  });

  it("StorePartialError.recovery.keyEnvelope is undefined for public uploads", async () => {
    const ds = await makeInitedDStorage();
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("net"),
    );
    const err = await ds
      .store(enc("public"), { isPublic: true })
      .catch((e: unknown) => e);
    expect((err as StorePartialError).recovery.keyEnvelope).toBeUndefined();
  });

  it("isStorePartialError() returns true for StorePartialError", async () => {
    const ds = await makeInitedDStorage();
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("net"),
    );
    const err = await ds.store(enc("x")).catch((e: unknown) => e);
    expect(isStorePartialError(err)).toBe(true);
  });

  it("isStorePartialError() returns false for plain Error", () => {
    expect(isStorePartialError(new Error("plain"))).toBe(false);
  });

  it("full round-trip: chain write fails → StorePartialError → registerReference → retrieveByRefId", async () => {
    const ds = await makeInitedDStorage();
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("chain temporarily down"),
    );

    const content = "recovery round-trip test";
    const err = await ds.store(enc(content)).catch((e: unknown) => e);
    expect(isStorePartialError(err)).toBe(true);

    const { storageId, storageProvider, keyEnvelope } = (
      err as StorePartialError
    ).recovery;

    const { chainRefId } = await ds.registerReference({
      storageId,
      storageProvider,
      keyEnvelope,
    });
    const { bytes } = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe(content);
  });

  // ── proactive path (onProgress "stored" phase) ───────────────────────────────

  it("onProgress receives a 'stored' phase event after storage but before chain write", async () => {
    const ds = await makeInitedDStorage();
    const phases: string[] = [];
    let storedFiredBeforeChain = false;

    const originalWrite = ds.chainAdapters[0]!.writeReference.bind(
      ds.chainAdapters[0]!,
    );
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockImplementation(
      async (...args) => {
        storedFiredBeforeChain = phases.includes("stored");
        return originalWrite(...args);
      },
    );

    await ds.store(enc("progress test"), {
      onProgress: (p) => phases.push(p.phase),
    });

    expect(phases).toContain("stored");
    expect(storedFiredBeforeChain).toBe(true);
  });

  it("onProgress 'stored' event includes recovery with storageId, storageProvider and keyEnvelope", async () => {
    const ds = await makeInitedDStorage();
    let capturedRecovery: import("../types.js").StoreRecovery | undefined;

    await ds.store(enc("proactive"), {
      onProgress: (p) => {
        if (p.phase === "stored") capturedRecovery = p.recovery;
      },
    });

    expect(capturedRecovery).toBeDefined();
    expect(typeof capturedRecovery!.storageId).toBe("string");
    expect(capturedRecovery!.storageProvider).toBe("mock");
    expect(typeof capturedRecovery!.keyEnvelope).toBe("string");
    expect((capturedRecovery!.keyEnvelope as string).length).toBeGreaterThan(0);
  });

  it("onProgress 'stored' recovery.keyEnvelope is undefined for public uploads", async () => {
    const ds = await makeInitedDStorage();
    let capturedRecovery: import("../types.js").StoreRecovery | undefined;

    await ds.store(enc("public proactive"), {
      isPublic: true,
      onProgress: (p) => {
        if (p.phase === "stored") capturedRecovery = p.recovery;
      },
    });

    expect(capturedRecovery).toBeDefined();
    expect(capturedRecovery!.keyEnvelope).toBeUndefined();
  });

  it("recovery from onProgress 'stored' event works with registerReference", async () => {
    const ds = await makeInitedDStorage();
    let capturedRecovery: import("../types.js").StoreRecovery | undefined;

    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("chain down"),
    );

    await ds
      .store(enc("proactive recovery"), {
        onProgress: (p) => {
          if (p.phase === "stored") capturedRecovery = p.recovery;
        },
      })
      .catch(() => {});

    expect(capturedRecovery).toBeDefined();

    const { chainRefId } = await ds.registerReference({
      storageId: capturedRecovery!.storageId,
      storageProvider: capturedRecovery!.storageProvider,
      keyEnvelope: capturedRecovery!.keyEnvelope,
    });
    const { bytes } = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe("proactive recovery");
  });

  // ── registerReference() with keyEnvelope ─────────────────────────────────────

  it("registerReference() with keyEnvelope returns a chainRefId", async () => {
    const ds = await makeInitedDStorage();
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("net"),
    );

    const err = await ds
      .store(enc("ref-with-envelope"))
      .catch((e: unknown) => e);
    const { storageId, storageProvider, keyEnvelope } = (
      err as StorePartialError
    ).recovery;

    const result = await ds.registerReference({
      storageId,
      storageProvider,
      keyEnvelope,
    });
    expect(typeof result.chainRefId).toBe("string");
  });

  it("registerReference() with keyEnvelope produces a reference that decrypts correctly", async () => {
    const ds = await makeInitedDStorage();
    vi.spyOn(ds.chainAdapters[0]!, "writeReference").mockRejectedValueOnce(
      new Error("net"),
    );

    const content = "encrypt-verify";
    const err = await ds.store(enc(content)).catch((e: unknown) => e);
    const { storageId, storageProvider, keyEnvelope } = (
      err as StorePartialError
    ).recovery;

    const { chainRefId } = await ds.registerReference({
      storageId,
      storageProvider,
      keyEnvelope,
    });
    const { bytes } = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe(content);
  });
});

// ── contentHash integrity ─────────────────────────────────────────────────────

describe("contentHash", () => {
  it("store() writes a 64-char hex contentHash to the chain adapter", async () => {
    const config = makeConfig();
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId } = await ds.store(enc("integrity test"));
    const ref = await chain.readReference(chainRefId!);
    expect(typeof ref.contentHash).toBe("string");
    expect(ref.contentHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(ref.contentHash!)).toBe(true);
  });

  it("contentHash is the BLAKE3 hex of the raw ciphertext bytes in storage", async () => {
    const { computeBlake3Hex } = await import("@dstorage/crypto");
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId, storageId } = await ds.store(enc("hash verification"));
    const raw = storage.get(storageId)!;
    const expected = await computeBlake3Hex(raw);
    const ref = await chain.readReference(chainRefId!);
    expect(ref.contentHash).toBe(expected);
  });

  it("retrieveByRefId() succeeds when contentHash matches", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("matching hash"));
    const result = await ds.retrieveByRefId(chainRefId!);
    expect(new TextDecoder().decode(result.bytes)).toBe("matching hash");
  });

  it("retrieveByRefId() passes the on-chain contentHash as an expectedContentHash anchor to storageAdapter.retrieve()", async () => {
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const retrieveSpy = vi.spyOn(storage, "retrieve");
    const { chainRefId, storageId } = await ds.store(enc("anchor threading"));
    const ref = await chain.readReference(chainRefId!);

    await ds.retrieveByRefId(chainRefId!);

    expect(retrieveSpy).toHaveBeenCalledWith(storageId, {
      expectedContentHash: ref.contentHash,
    });
  });

  it("retrieveByRefId() throws CONTENT_HASH_MISMATCH when storage bytes are tampered", async () => {
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId, storageId } = await ds.store(enc("tamper me"));
    const raw = storage.get(storageId)!;
    const tampered = new Uint8Array(raw);
    tampered[0] ^= 0xff;
    storage.set(storageId, tampered);

    await expect(ds.retrieveByRefId(chainRefId!)).rejects.toMatchObject({
      code: CoreErrorCode.CONTENT_HASH_MISMATCH,
      message: expect.stringContaining("[dStorage] Content hash mismatch"),
    });
  });

  it("contentHash is preserved unchanged through rotateKeys()", async () => {
    const config = makeConfig();
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId } = await ds.store(enc("stable content"));
    const refBefore = await chain.readReference(chainRefId!);
    const hashBefore = refBefore.contentHash;

    await ds.rotateKeys(chainRefId!);

    const refAfter = await chain.readReference(chainRefId!);
    expect(refAfter.contentHash).toBe(hashBefore);
  });

  it("contentHash changes after update() with new content", async () => {
    const config = makeConfig();
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId } = await ds.store(enc("original"));
    const refBefore = await chain.readReference(chainRefId!);
    const hashBefore = refBefore.contentHash;

    await ds.update(chainRefId!, enc("updated content"));

    const refAfter = await chain.readReference(chainRefId!);
    expect(refAfter.contentHash).toBeDefined();
    expect(refAfter.contentHash).not.toBe(hashBefore);
  });

  it("update() followed by retrieveByRefId() returns updated content with no hash error", async () => {
    const ds = await makeInitedDStorage();
    const { chainRefId } = await ds.store(enc("before update"));
    await ds.update(chainRefId!, enc("after update"));
    const result = await ds.retrieveByRefId(chainRefId!);
    expect(new TextDecoder().decode(result.bytes)).toBe("after update");
  });

  it("StorePartialError.recovery includes a 64-char hex contentHash", async () => {
    const config = makeConfig();
    const ds = new DStorage(config);
    await ds.init();
    vi.spyOn(config.chainAdapters![0]!, "writeReference").mockRejectedValueOnce(
      new Error("chain down"),
    );

    const err = await ds.store(enc("recovery hash")).catch((e: unknown) => e);
    expect(isStorePartialError(err)).toBe(true);
    const { contentHash } = (err as StorePartialError).recovery;
    expect(typeof contentHash).toBe("string");
    expect(contentHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(contentHash!)).toBe(true);
  });

  it("registerReference() with contentHash stores it on chain", async () => {
    const config = makeConfig();
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const ds = new DStorage(config);
    await ds.init();
    vi.spyOn(config.chainAdapters![0]!, "writeReference").mockRejectedValueOnce(
      new Error("net"),
    );

    const err = await ds.store(enc("reg-hash")).catch((e: unknown) => e);
    const { storageId, storageProvider, keyEnvelope, contentHash } = (
      err as StorePartialError
    ).recovery;

    const { chainRefId } = await ds.registerReference({
      storageId,
      storageProvider,
      keyEnvelope,
      contentHash,
    });
    const ref = await chain.readReference(chainRefId);
    expect(ref.contentHash).toBe(contentHash);
  });

  it("recovery round-trip with contentHash: registerReference → retrieveByRefId verifies hash", async () => {
    const config = makeConfig();
    const ds = new DStorage(config);
    await ds.init();
    vi.spyOn(config.chainAdapters![0]!, "writeReference").mockRejectedValueOnce(
      new Error("net"),
    );

    const content = "recovery with hash verification";
    const err = await ds.store(enc(content)).catch((e: unknown) => e);
    expect(isStorePartialError(err)).toBe(true);

    const { storageId, storageProvider, keyEnvelope, contentHash } = (
      err as StorePartialError
    ).recovery;

    const { chainRefId } = await ds.registerReference({
      storageId,
      storageProvider,
      keyEnvelope,
      contentHash,
    });

    const { bytes } = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe(content);
  });

  it("tampered storage after recovery triggers CONTENT_HASH_MISMATCH via retrieveByRefId", async () => {
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const ds = new DStorage(config);
    await ds.init();
    vi.spyOn(config.chainAdapters![0]!, "writeReference").mockRejectedValueOnce(
      new Error("net"),
    );

    const err = await ds
      .store(enc("tamper after recovery"))
      .catch((e: unknown) => e);
    expect(isStorePartialError(err)).toBe(true);

    const { storageId, storageProvider, keyEnvelope, contentHash } = (
      err as StorePartialError
    ).recovery;

    const { chainRefId } = await ds.registerReference({
      storageId,
      storageProvider,
      keyEnvelope,
      contentHash,
    });

    const raw = storage.get(storageId!)!;
    const tampered = new Uint8Array(raw);
    tampered[0] ^= 0xff;
    storage.set(storageId!, tampered);

    await expect(ds.retrieveByRefId(chainRefId)).rejects.toMatchObject({
      code: CoreErrorCode.CONTENT_HASH_MISMATCH,
      message: expect.stringContaining("[dStorage] Content hash mismatch"),
    });
  });

  // ── public uploads ────────────────────────────────────────────────────────────

  it("public store() writes a 64-char hex contentHash to chain", async () => {
    const config = makeConfig();
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId } = await ds.store(enc("public hash test"), {
      isPublic: true,
    });
    const ref = await chain.readReference(chainRefId!);
    expect(typeof ref.contentHash).toBe("string");
    expect(ref.contentHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(ref.contentHash!)).toBe(true);
  });

  it("public contentHash equals BLAKE3 of the raw plaintext bytes (no encryption layer)", async () => {
    const { computeBlake3Hex } = await import("@dstorage/crypto");
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const content = enc("public blake3 check");
    const { chainRefId, storageId } = await ds.store(content, {
      isPublic: true,
    });
    // Public: what's in storage is raw plaintext — same as the input bytes
    const raw = storage.get(storageId)!;
    const expected = await computeBlake3Hex(raw);
    const ref = await chain.readReference(chainRefId!);
    expect(ref.contentHash).toBe(expected);
    // The stored bytes are also the original plaintext (no encryption for public uploads)
    expect(raw).toEqual(content);
  });

  it("retrieveByRefId() succeeds for public upload when contentHash matches", async () => {
    const ds = await makeInitedDStorage();
    const content = "public retrieve with hash";
    const { chainRefId } = await ds.store(enc(content), { isPublic: true });
    const result = await ds.retrieveByRefId(chainRefId!);
    expect(new TextDecoder().decode(result.bytes)).toBe(content);
  });

  it("tampered public upload triggers CONTENT_HASH_MISMATCH (no AEAD fallback for public data)", async () => {
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const { chainRefId, storageId } = await ds.store(enc("public tamper"), {
      isPublic: true,
    });
    // Flip a byte — public data has no AEAD protection, so only the on-chain hash catches this
    const raw = storage.get(storageId)!;
    const tampered = new Uint8Array(raw);
    tampered[0] ^= 0xff;
    storage.set(storageId, tampered);

    await expect(ds.retrieveByRefId(chainRefId!)).rejects.toMatchObject({
      code: CoreErrorCode.CONTENT_HASH_MISMATCH,
      message: expect.stringContaining("[dStorage] Content hash mismatch"),
    });
  });
});

// ── JSON.parse error handling on authenticated data ───────────────────────────
//
// AEAD authentication proves the bytes are exactly what was encrypted — but
// that doesn't guarantee they're valid JSON (e.g. a corrupted-but-authentic
// blob). These construct that scenario directly using exported crypto
// primitives, bypassing the SDK's own encryption so the ciphertext is
// authentic garbage rather than a real manifest/metadata payload.

describe("JSON.parse error handling on authenticated data", () => {
  it("retrieveByStorageId() throws MANIFEST_PARSE_FAILED for authenticated-but-invalid-JSON manifest bytes", async () => {
    const config = makeConfig();
    const storage = config.storageAdapters[0] as MockStorageAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const dek = generateDek();
    const scheme = XChaChaScheme.fromKey(dek);
    const garbage = enc("not valid json {");
    const ciphertext = await scheme.encryptPayload(garbage, MANIFEST_AAD);
    const { id: storageId } = await storage.store(ciphertext);

    await expect(
      ds.retrieveByStorageId(storageId, scheme),
    ).rejects.toMatchObject({
      code: CoreErrorCode.MANIFEST_PARSE_FAILED,
      message: expect.stringContaining("[dStorage]"),
    });
  });

  it("retrieveByRefId() throws METADATA_PARSE_FAILED for authenticated-but-invalid-JSON metadata", async () => {
    const config = makeConfig();
    const chain = config.chainAdapters![0] as MidnightSimulatorChainAdapter;
    const passwordAdapter = config
      .encryptionAdapters![0] as PasswordEncryptionAdapter;
    const ds = new DStorage(config);
    await ds.init();

    const dek = generateDek();
    const wrapped = await passwordAdapter.wrapDek(dek);
    const keyEnvelope = serializeKeyEnvelope(
      buildKeyEnvelope([{ wrapKeyName: passwordAdapter.name, ...wrapped }]),
    );
    const scheme = XChaChaScheme.fromKey(dek);
    const garbage = enc("not valid json {");
    const encryptedMetadata = bytesToBase64url(
      await scheme.encryptPayload(garbage, METADATA_AAD),
    );
    const ownerSecret = await deriveOwnerSecret(
      dek,
      METADATA_ONLY_OWNER_SECRET_SALT,
    );

    const { refId } = await chain.writeReference({
      refId: `ref_metadata_parse_${Math.random().toString(36).slice(2)}`,
      storageProvider: "mock",
      encryptionScheme: "xchacha20poly1305-v1",
      writtenAt: Date.now(),
      keyEnvelope,
      encryptedMetadata,
      ownerSecret,
    });

    await expect(ds.retrieveByRefId(refId!)).rejects.toMatchObject({
      code: CoreErrorCode.METADATA_PARSE_FAILED,
      message: expect.stringContaining("[dStorage]"),
    });
  });
});
