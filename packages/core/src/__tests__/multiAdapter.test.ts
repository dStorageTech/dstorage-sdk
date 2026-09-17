/**
 * @dstorage/core — multi-adapter fallback tests
 *
 * Covers the try-in-order fallback semantics for `storageAdapters`/`chainAdapters`
 * arrays: reads/writes fall back to the next configured adapter on failure and
 * succeed on the first that works; `listReferences()` aggregates across every
 * configured chain adapter instead of stopping at the first success;
 * single-reference mutations (update/retryUpdate/rotateKeys/removeReference)
 * locate whichever configured chain adapter actually holds the reference;
 * `init()` stops trying chain adapters as soon as one succeeds; chunked
 * uploads retry the WHOLE operation (not per-chunk) against the next storage
 * adapter candidate.
 *
 * CHUNK_SIZE is mocked to 512 bytes (same technique as chunked.test.ts) so the
 * whole-operation-fallback tests run fast. Non-chunked tests in this file use
 * small payloads well under that threshold, so the mock doesn't affect them.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../chunked.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chunked.js")>();
  return { ...actual, CHUNK_SIZE: 512 };
});

import { DStorage } from "../dStorage.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import { CoreErrorCode, StorePartialError } from "../errors.js";

// Must match the mocked value above.
const CHUNK_SIZE = 512;

const enc = (s: string) => new TextEncoder().encode(s);

const testEncryption = (salt: string) =>
  new PasswordEncryptionAdapter({
    password: "dstorage-test-passphrase-v1!",
    salt,
    params: { N: 32768, r: 8, p: 1 },
  });

/** Create a Uint8Array of `size` bytes filled with a repeating pattern. */
function makeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;
  return bytes;
}

// ── retrieveByStorageId / retrieveByRefId: storage read fallback ──────────────
// (write fallback + total-failure coverage for reads already lives in
// dStorage.test.ts's "retrieveByRefId" describe block, alongside the retired
// STORAGE_ADAPTER_MISMATCH test it replaced.)

describe("store() storage adapter write fallback", () => {
  it("falls back to the next storage adapter when the first fails to write", async () => {
    const failing = new MockStorageAdapter();
    vi.spyOn(failing, "store").mockRejectedValue(new Error("network down"));
    const working = new MockStorageAdapter();

    const ds = new DStorage({
      storageAdapters: [failing, working],
      chainAdapters: [new MidnightSimulatorChainAdapter()],
      encryptionAdapters: [testEncryption("write-fallback")],
    });
    await ds.init();

    const { chainRefId } = await ds.store(enc("hello"));
    expect(failing.store).toHaveBeenCalled();

    const { bytes } = await ds.retrieveByRefId(chainRefId!);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("throws STORAGE_WRITE_ALL_FAILED with a per-adapter cause when every storage adapter fails to write", async () => {
    const failingA = new MockStorageAdapter();
    const failingB = new MockStorageAdapter();
    vi.spyOn(failingA, "store").mockRejectedValue(new Error("fail A"));
    vi.spyOn(failingB, "store").mockRejectedValue(new Error("fail B"));

    const ds = new DStorage({
      storageAdapters: [failingA, failingB],
      chainAdapters: [new MidnightSimulatorChainAdapter()],
      encryptionAdapters: [testEncryption("write-all-failed")],
    });
    await ds.init();

    const err = await ds.store(enc("hello")).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: CoreErrorCode.STORAGE_WRITE_ALL_FAILED });
    expect((err as { cause?: unknown[] }).cause).toHaveLength(2);
  });
});

describe("store() chain adapter write fallback", () => {
  it("falls back to the next chain adapter when the first fails to write", async () => {
    const failing = new MidnightSimulatorChainAdapter();
    vi.spyOn(failing, "writeReference").mockRejectedValue(
      new Error("chain down"),
    );
    const working = new MidnightSimulatorChainAdapter();

    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [failing, working],
      encryptionAdapters: [testEncryption("chain-write-fallback")],
    });
    await ds.init();

    const { chainRefId } = await ds.store(enc("hello"));
    expect(failing.writeReference).toHaveBeenCalled();

    // Confirm the reference actually landed on the second (working) adapter.
    const ref = await working.readReference(chainRefId!);
    expect(ref).toBeDefined();
  });

  it("StorePartialError.cause is an aggregate DStorageError when every chain adapter fails to write", async () => {
    const failingA = new MidnightSimulatorChainAdapter();
    const failingB = new MidnightSimulatorChainAdapter();
    vi.spyOn(failingA, "writeReference").mockRejectedValue(new Error("fail A"));
    vi.spyOn(failingB, "writeReference").mockRejectedValue(new Error("fail B"));

    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [failingA, failingB],
      encryptionAdapters: [testEncryption("chain-write-all-failed")],
    });
    await ds.init();

    const err = await ds.store(enc("hello")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorePartialError);
    const cause = (err as StorePartialError).cause as {
      code?: number;
      cause?: unknown[];
    };
    expect(cause.code).toBe(CoreErrorCode.CHAIN_WRITE_ALL_FAILED);
    expect(cause.cause).toHaveLength(2);
  });
});

describe("registerReference() chain adapter write fallback", () => {
  it("falls back to the next chain adapter when the first fails to write", async () => {
    const failing = new MidnightSimulatorChainAdapter();
    vi.spyOn(failing, "writeReference").mockRejectedValue(
      new Error("chain down"),
    );
    const working = new MidnightSimulatorChainAdapter();

    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [failing, working],
      encryptionAdapters: [testEncryption("register-chain-write-fallback")],
    });
    await ds.init();

    const { chainRefId } = await ds.registerReference({
      storageId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(failing.writeReference).toHaveBeenCalled();

    const ref = await working.readReference(chainRefId);
    expect(ref).toBeDefined();
  });

  it("throws CHAIN_WRITE_ALL_FAILED directly (not StorePartialError) when every chain adapter fails to write", async () => {
    const failingA = new MidnightSimulatorChainAdapter();
    const failingB = new MidnightSimulatorChainAdapter();
    vi.spyOn(failingA, "writeReference").mockRejectedValue(new Error("fail A"));
    vi.spyOn(failingB, "writeReference").mockRejectedValue(new Error("fail B"));

    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [failingA, failingB],
      encryptionAdapters: [testEncryption("register-chain-write-all-failed")],
    });
    await ds.init();

    const err = await ds
      .registerReference({
        storageId: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StorePartialError);
    expect(err).toMatchObject({ code: CoreErrorCode.CHAIN_WRITE_ALL_FAILED });
    expect((err as { cause?: unknown[] }).cause).toHaveLength(2);
  });
});

describe("init() chain adapter fallback", () => {
  it("stops trying chain adapters as soon as the first one succeeds", async () => {
    const a = new MidnightSimulatorChainAdapter();
    const b = new MidnightSimulatorChainAdapter();
    const bAddressSpy = vi.spyOn(b, "getContractAddress");

    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [a, b],
      encryptionAdapters: [testEncryption("init-stop")],
    });
    const address = await ds.init();

    expect(address).toBe(a.getContractAddress());
    expect(bAddressSpy).not.toHaveBeenCalled();
  });

  it("throws INIT_CHAIN_ALL_FAILED and stays disconnected when every chain adapter fails to init", async () => {
    const a = new MidnightSimulatorChainAdapter();
    const b = new MidnightSimulatorChainAdapter();
    vi.spyOn(a, "getContractAddress").mockImplementation(() => {
      throw new Error("fail A");
    });
    vi.spyOn(b, "getContractAddress").mockImplementation(() => {
      throw new Error("fail B");
    });

    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [a, b],
      encryptionAdapters: [testEncryption("init-all-failed")],
    });

    const err = await ds.init().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: CoreErrorCode.INIT_CHAIN_ALL_FAILED });
    expect(ds.isConnected).toBe(false);
  });
});

describe("listReferences() chain adapter aggregation", () => {
  it("aggregates references from every configured chain adapter, tagged with sourceAdapterIndex", async () => {
    const chainA = new MidnightSimulatorChainAdapter();
    const chainB = new MidnightSimulatorChainAdapter();
    const storage = new MockStorageAdapter();
    const encryption = testEncryption("list-aggregate");

    const dsA = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainA],
      encryptionAdapters: [encryption],
    });
    await dsA.init();
    const { chainRefId: refA } = await dsA.store(enc("on chain A"));

    const dsB = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainB],
      encryptionAdapters: [encryption],
    });
    await dsB.init();
    const { chainRefId: refB } = await dsB.store(enc("on chain B"));

    const combined = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainA, chainB],
      encryptionAdapters: [encryption],
    });
    await combined.init();

    const refs = await combined.listReferences();
    const entryA = refs.find((r) => r.refId === refA);
    const entryB = refs.find((r) => r.refId === refB);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(entryA?.sourceAdapterIndex).toBe(0);
    expect(entryB?.sourceAdapterIndex).toBe(1);
  });

  it("still returns results from working adapters when one configured adapter's listReferences() throws", async () => {
    const chainA = new MidnightSimulatorChainAdapter();
    const chainB = new MidnightSimulatorChainAdapter();
    vi.spyOn(chainA, "listReferences").mockRejectedValue(
      new Error("chain A down"),
    );
    const storage = new MockStorageAdapter();
    const encryption = testEncryption("list-partial-fail");

    const dsB = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainB],
      encryptionAdapters: [encryption],
    });
    await dsB.init();
    const { chainRefId: refB } = await dsB.store(enc("still here"));

    const combined = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainA, chainB],
      encryptionAdapters: [encryption],
    });
    await combined.init();

    const refs = await combined.listReferences();
    expect(refs.some((r) => r.refId === refB)).toBe(true);
  });

  it("throws LIST_REFS_ALL_FAILED when every configured chain adapter's listReferences() fails", async () => {
    const chainA = new MidnightSimulatorChainAdapter();
    const chainB = new MidnightSimulatorChainAdapter();
    vi.spyOn(chainA, "listReferences").mockRejectedValue(new Error("fail A"));
    vi.spyOn(chainB, "listReferences").mockRejectedValue(new Error("fail B"));

    const ds = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [chainA, chainB],
      encryptionAdapters: [testEncryption("list-all-failed")],
    });
    await ds.init();

    const err = await ds.listReferences().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: CoreErrorCode.LIST_REFS_ALL_FAILED });
  });

  it("refIds filter locates each requested ref on whichever configured chain adapter holds it", async () => {
    const chainA = new MidnightSimulatorChainAdapter();
    const chainB = new MidnightSimulatorChainAdapter();
    const storage = new MockStorageAdapter();
    const encryption = testEncryption("list-refids-locate");

    const dsA = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainA],
      encryptionAdapters: [encryption],
    });
    await dsA.init();
    const { chainRefId: refA } = await dsA.store(enc("refids on chain A"));

    const dsB = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainB],
      encryptionAdapters: [encryption],
    });
    await dsB.init();
    const { chainRefId: refB } = await dsB.store(enc("refids on chain B"));

    const combined = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainA, chainB],
      encryptionAdapters: [encryption],
    });
    await combined.init();

    const refs = await combined.listReferences({ refIds: [refA!, refB!] });
    expect(refs).toHaveLength(2);
    expect(refs.some((r) => r.refId === refA)).toBe(true);
    expect(refs.some((r) => r.refId === refB)).toBe(true);
  });
});

describe("locate-the-holder fallback for single-reference operations", () => {
  it("removeReference() targets only the chain adapter that actually holds the ref", async () => {
    const chainA = new MidnightSimulatorChainAdapter();
    const chainB = new MidnightSimulatorChainAdapter();
    const removeSpyA = vi.spyOn(chainA, "removeReference");
    const removeSpyB = vi.spyOn(chainB, "removeReference");
    const storage = new MockStorageAdapter();
    const encryption = testEncryption("locate-holder-remove");

    const dsB = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainB],
      encryptionAdapters: [encryption],
    });
    await dsB.init();
    const { chainRefId } = await dsB.store(enc("holder test"));

    const ds = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainA, chainB],
      encryptionAdapters: [encryption],
    });
    await ds.init();

    await ds.removeReference(chainRefId!);

    expect(removeSpyB).toHaveBeenCalled();
    expect(removeSpyA).not.toHaveBeenCalled();
  });

  it("update() targets only the chain adapter that actually holds the ref", async () => {
    const chainA = new MidnightSimulatorChainAdapter();
    const chainB = new MidnightSimulatorChainAdapter();
    const updateSpyA = vi.spyOn(chainA, "updateReference");
    const updateSpyB = vi.spyOn(chainB, "updateReference");
    const storage = new MockStorageAdapter();
    const encryption = testEncryption("locate-holder-update");

    const dsB = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainB],
      encryptionAdapters: [encryption],
    });
    await dsB.init();
    const { chainRefId } = await dsB.store(enc("v1"));

    const ds = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainA, chainB],
      encryptionAdapters: [encryption],
    });
    await ds.init();

    await ds.update(chainRefId!, enc("v2"));

    expect(updateSpyB).toHaveBeenCalled();
    expect(updateSpyA).not.toHaveBeenCalled();

    const { bytes } = await ds.retrieveByRefId(chainRefId!);
    expect(new TextDecoder().decode(bytes)).toBe("v2");
  });

  it("rotateKeys() targets only the chain adapter that actually holds the ref", async () => {
    const chainA = new MidnightSimulatorChainAdapter();
    const chainB = new MidnightSimulatorChainAdapter();
    const updateSpyA = vi.spyOn(chainA, "updateReference");
    const updateSpyB = vi.spyOn(chainB, "updateReference");
    const storage = new MockStorageAdapter();
    const encryption = testEncryption("locate-holder-rotate");

    const dsB = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainB],
      encryptionAdapters: [encryption],
    });
    await dsB.init();
    const { chainRefId } = await dsB.store(enc("rotate me"));

    const ds = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainA, chainB],
      encryptionAdapters: [encryption],
    });
    await ds.init();

    await ds.rotateKeys(chainRefId!);

    expect(updateSpyB).toHaveBeenCalled();
    expect(updateSpyA).not.toHaveBeenCalled();
  });

  it("retryUpdate() targets only the chain adapter that actually holds the ref", async () => {
    const chainA = new MidnightSimulatorChainAdapter();
    const chainB = new MidnightSimulatorChainAdapter();
    const updateSpyA = vi.spyOn(chainA, "updateReference");
    const storage = new MockStorageAdapter();
    const encryption = testEncryption("locate-holder-retry-update");

    const dsB = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainB],
      encryptionAdapters: [encryption],
    });
    await dsB.init();
    const { chainRefId } = await dsB.store(enc("v1"));

    const ds = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainA, chainB],
      encryptionAdapters: [encryption],
    });
    await ds.init();

    // Force update()'s chain write to fail once so we get a StorePartialError
    // recovery payload to retry.
    vi.spyOn(chainB, "updateReference").mockRejectedValueOnce(
      new Error("chain down"),
    );
    const err = await ds
      .update(chainRefId!, enc("v2"))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorePartialError);

    await ds.retryUpdate(chainRefId!, (err as StorePartialError).recovery);

    expect(updateSpyA).not.toHaveBeenCalled();

    const { bytes } = await ds.retrieveByRefId(chainRefId!);
    expect(new TextDecoder().decode(bytes)).toBe("v2");
  });

  it("update() reports the specific holder adapter when the fast pre-check passes but the holder itself lacks updateReference", async () => {
    class NoUpdateChain extends MidnightSimulatorChainAdapter {
      override updateReference =
        undefined as unknown as MidnightSimulatorChainAdapter["updateReference"];
    }
    const chainA = new MidnightSimulatorChainAdapter(); // supports updateReference
    const chainB = new NoUpdateChain(); // holds the ref, does NOT support updateReference
    const storage = new MockStorageAdapter();
    const encryption = testEncryption("locate-holder-capability-mismatch");

    const dsB = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainB],
      encryptionAdapters: [encryption],
    });
    await dsB.init();
    const { chainRefId } = await dsB.store(enc("v1"));

    const ds = new DStorage({
      storageAdapters: [storage],
      chainAdapters: [chainA, chainB],
      encryptionAdapters: [encryption],
    });
    await ds.init();

    // The fast pre-check passes (chainA supports updateReference), but the
    // ref actually lives on chainB, which doesn't — the error must name
    // chainB specifically ("holding reference"), not just report the
    // generic "not supported by any configured adapter" pre-check message.
    await expect(ds.update(chainRefId!, enc("v2"))).rejects.toMatchObject({
      code: CoreErrorCode.UPDATE_UPLOAD_NOT_SUPPORTED,
      message: expect.stringContaining(`holding reference "${chainRefId}"`),
    });
  });
});

describe("chunked upload: whole-operation storage adapter fallback", () => {
  class FlakyStorageAdapter extends MockStorageAdapter {
    callCount = 0;
    constructor(private readonly failOnCall: number) {
      super();
    }
    override async store(data: Uint8Array, metadata?: Record<string, string>) {
      this.callCount++;
      if (this.callCount === this.failOnCall) {
        throw new Error(`simulated failure on call ${this.failOnCall}`);
      }
      return super.store(data, metadata);
    }
  }

  it("retries the WHOLE chunked upload against the next adapter, not per-chunk, when the first fails partway", async () => {
    // 3 chunks + 1 manifest = 4 store() calls per full attempt.
    const bytes = makeBytes(CHUNK_SIZE * 2 + 10);
    const failing = new FlakyStorageAdapter(3); // fails on the 3rd call (2nd chunk)
    const working = new MockStorageAdapter();
    const workingStoreSpy = vi.spyOn(working, "store");

    const ds = new DStorage({
      storageAdapters: [failing, working],
      chainAdapters: [new MidnightSimulatorChainAdapter()],
      encryptionAdapters: [testEncryption("chunked-fallback")],
    });
    await ds.init();

    const { chainRefId } = await ds.store(bytes);

    // The failing adapter's partial attempt: 2 successful chunk calls, then
    // the 3rd call that throws — never got to the manifest.
    expect(failing.callCount).toBe(3);
    // The working adapter restarted from scratch: all 3 chunks + manifest.
    expect(workingStoreSpy).toHaveBeenCalledTimes(4);

    const { bytes: retrieved } = await ds.retrieveByRefId(chainRefId!);
    expect(retrieved).toEqual(bytes);
  });

  it("throws STORAGE_WRITE_ALL_FAILED when every storage adapter fails the chunked upload", async () => {
    const bytes = makeBytes(CHUNK_SIZE + 10); // 2 chunks + 1 manifest
    const failingA = new FlakyStorageAdapter(1);
    const failingB = new FlakyStorageAdapter(1);

    const ds = new DStorage({
      storageAdapters: [failingA, failingB],
      chainAdapters: [new MidnightSimulatorChainAdapter()],
      encryptionAdapters: [testEncryption("chunked-all-failed")],
    });
    await ds.init();

    const err = await ds.store(bytes).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: CoreErrorCode.STORAGE_WRITE_ALL_FAILED });
  });
});

describe("chunked retrieval: pinned to the manifest's storage adapter", () => {
  it("propagates a chunk-level failure directly instead of silently falling back to a different configured storage adapter", async () => {
    const primary = new MockStorageAdapter();
    const secondary = new MockStorageAdapter();
    const chainAdapter = new MidnightSimulatorChainAdapter();
    const encryption = testEncryption("chunk-pin");

    const uploaderDs = new DStorage({
      storageAdapters: [primary],
      chainAdapters: [chainAdapter],
      encryptionAdapters: [encryption],
    });
    await uploaderDs.init();
    const bytes = makeBytes(CHUNK_SIZE * 2 + 10);
    const { chainRefId } = await uploaderDs.store(bytes);

    // 1st retrieve() call on primary = the manifest (succeeds). 2nd call =
    // the first chunk — force it to fail.
    let callCount = 0;
    const realRetrieve = primary.retrieve.bind(primary);
    vi.spyOn(primary, "retrieve").mockImplementation(async (id: string) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("simulated chunk fetch failure");
      }
      return realRetrieve(id);
    });
    const secondaryRetrieveSpy = vi.spyOn(secondary, "retrieve");

    const retrieverDs = new DStorage({
      storageAdapters: [primary, secondary],
      chainAdapters: [chainAdapter],
      encryptionAdapters: [encryption],
    });
    await retrieverDs.init();

    await expect(retrieverDs.retrieveByRefId(chainRefId!)).rejects.toThrow(
      "simulated chunk fetch failure",
    );
    expect(secondaryRetrieveSpy).not.toHaveBeenCalled();
  });
});

describe("constructor validation", () => {
  it("throws CONFIG_STORAGE_ADAPTERS_EMPTY synchronously when storageAdapters is empty", () => {
    expect(() => {
      new DStorage({
        storageAdapters: [],
        encryptionAdapters: [testEncryption("empty-storage")],
      });
    }).toThrowError(
      expect.objectContaining({
        code: CoreErrorCode.CONFIG_STORAGE_ADAPTERS_EMPTY,
      }),
    );
  });
});

describe("chainAdapters omitted vs. empty array", () => {
  it("both produce identical storage-only-mode behavior", async () => {
    const omitted = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      encryptionAdapters: [testEncryption("chain-omitted")],
    });
    const empty = new DStorage({
      storageAdapters: [new MockStorageAdapter()],
      chainAdapters: [],
      encryptionAdapters: [testEncryption("chain-empty")],
    });
    await omitted.init();
    await empty.init();

    expect(omitted.isConnected).toBe(true);
    expect(empty.isConnected).toBe(true);
    expect(omitted.chainAdapters).toEqual([]);
    expect(empty.chainAdapters).toEqual([]);

    for (const ds of [omitted, empty]) {
      const result = await ds.store(enc("storage-only"));
      expect(result).not.toHaveProperty("chainRefId");
      await expect(ds.retrieveByRefId("any-ref")).rejects.toMatchObject({
        code: CoreErrorCode.RETRIEVE_BY_REF_ID_REQUIRES_CHAIN,
      });
    }
  });
});

describe("estimateCost() uses only the first configured adapter of each type", () => {
  it("does not query non-first storage/chain adapters", async () => {
    const storageA = new MockStorageAdapter();
    const storageB = new MockStorageAdapter();
    const chainA = new MidnightSimulatorChainAdapter();
    const chainB = new MidnightSimulatorChainAdapter();
    const storageBSpy = vi.spyOn(storageB, "estimateCost");
    const chainBSpy = vi.spyOn(chainB, "estimateCost");

    const ds = new DStorage({
      storageAdapters: [storageA, storageB],
      chainAdapters: [chainA, chainB],
      encryptionAdapters: [testEncryption("estimate-first")],
    });
    await ds.init();

    await ds.estimateCost(1024);

    expect(storageBSpy).not.toHaveBeenCalled();
    expect(chainBSpy).not.toHaveBeenCalled();
  });
});
