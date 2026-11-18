/**
 * @dstorage/core — storage replication tests
 *
 * Covers writing extra copies through storagePolicy, recording them in the
 * on-chain storageId, and falling back to them on read.
 *
 * CHUNK_SIZE is mocked to 512 bytes (same technique as chunked.test.ts).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../chunked.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chunked.js")>();
  return { ...actual, CHUNK_SIZE: 512 };
});

import { DStorage } from "../dStorage.js";
import {
  MAX_REPLICAS,
  composeOnChainStorageId,
  decodeReplicas,
  encodeReplicas,
  parsePublicStorageId,
  splitOnChainStorageId,
} from "../replicas.js";
import { MockStorageAdapter } from "@dstorage/storage";
import type { StorageProviderName } from "@dstorage/storage";
import { MidnightSimulatorChainAdapter } from "@dstorage/chain";
import type { ChainReference } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import { XChaChaScheme, generateDek } from "@dstorage/crypto";
import { CoreErrorCode, StorePartialError } from "../errors.js";
import type { DStorageConfig, StoragePolicy } from "../types.js";

const CHUNK_SIZE = 512;
const HASH = "a".repeat(64);

const enc = (s: string) => new TextEncoder().encode(s);

const encryption = () =>
  new PasswordEncryptionAdapter({
    password: "dstorage-test-passphrase-v1!",
    salt: "replicas",
    params: { N: 32768, r: 8, p: 1 },
  });

function makeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;
  return bytes;
}

/**
 * MockStorageAdapter shares one module-level store, so a "down" adapter would
 * still be readable through another mock. This one keeps its own data.
 */
class IsolatedStorage extends MockStorageAdapter {
  override readonly name: StorageProviderName;
  readonly data = new Map<string, Uint8Array>();
  down = false;
  private nextId = 0;

  constructor(name: string) {
    super();
    this.name = name as StorageProviderName;
  }

  override async store(bytes: Uint8Array) {
    if (this.down) throw new Error(`${this.name} down`);
    const id = `${this.name}-${this.nextId++}`;
    this.data.set(id, new Uint8Array(bytes));
    return { id, provider: this.name, uploadedAt: Date.now() };
  }

  override async retrieve(id: string) {
    if (this.down) throw new Error(`${this.name} down`);
    const bytes = this.data.get(id);
    if (!bytes) throw new Error(`${this.name} has no ${id}`);
    return { bytes: new Uint8Array(bytes), tags: {} };
  }
}

const replicateAll: StoragePolicy = { onSuccess: () => "continue" };

/** Records what reaches the chain so the on-chain format can be checked. */
function capturingChain() {
  const chain = new MidnightSimulatorChainAdapter();
  const written: ChainReference[] = [];
  const write = chain.writeReference.bind(chain);
  vi.spyOn(chain, "writeReference").mockImplementation(async (ref) => {
    written.push(ref);
    return write(ref);
  });
  return { chain, written };
}

async function setup(config: Partial<DStorageConfig> = {}) {
  const a = new IsolatedStorage("alpha");
  const b = new IsolatedStorage("beta");
  const { chain, written } = capturingChain();
  const ds = new DStorage({
    storageAdapters: [a, b],
    chainAdapters: [chain],
    encryptionAdapters: [encryption()],
    storagePolicy: replicateAll,
    ...config,
  });
  await ds.init();
  return { ds, a, b, chain, written };
}

describe("replica codec", () => {
  const scheme = () => XChaChaScheme.fromKey(generateDek());
  const list = [
    { provider: "beta", id: "beta-1" },
    { provider: "gamma", id: "gamma-1", contentHash: HASH },
  ];

  it("round-trips a public list", async () => {
    const composed = await composeOnChainStorageId("primary", list, null);
    expect(await parsePublicStorageId(composed)).toEqual({
      primary: "primary",
      replicas: list,
    });
  });

  it("round-trips a private list next to a real encrypted primary", async () => {
    const s = scheme();
    const encrypted = await s.encryptStorageId("a".repeat(43));
    const composed = await composeOnChainStorageId(encrypted, list, s);
    const { primary, suffix } = splitOnChainStorageId(composed);
    expect(primary).toBe(encrypted);
    expect(await s.decryptStorageId(primary)).toBe("a".repeat(43));
    expect(await decodeReplicas(suffix!, s)).toEqual(list);
  });

  it("leaves the value unchanged with no copies", async () => {
    const composed = await composeOnChainStorageId("primary", [], null);
    expect(composed).toBe("primary");
    expect(splitOnChainStorageId(composed)).toEqual({ primary: "primary" });
  });

  it("doesn't reveal a private list", async () => {
    const composed = await composeOnChainStorageId("x", list, scheme());
    const { suffix } = splitOnChainStorageId(composed);
    expect(Buffer.from(suffix!, "base64url").toString()).not.toContain("beta");
  });

  it("rejects a private list under another key", async () => {
    const suffix = await encodeReplicas(list, scheme());
    await expect(decodeReplicas(suffix, scheme())).rejects.toMatchObject({
      code: CoreErrorCode.REPLICA_LIST_INVALID,
    });
  });

  it("rejects a tampered private list", async () => {
    const s = scheme();
    const suffix = await encodeReplicas(list, s);
    const flipped = (suffix[0] === "A" ? "B" : "A") + suffix.slice(1);
    await expect(decodeReplicas(flipped, s)).rejects.toMatchObject({
      code: CoreErrorCode.REPLICA_LIST_INVALID,
    });
  });

  it.each([
    ["an entry with no id", [{ provider: "x" }]],
    ["an entry with no provider", [{ id: "x" }]],
    ["a malformed hash", [{ provider: "x", id: "y", contentHash: "zz" }]],
    ["a non-array", { provider: "x", id: "y" }],
    [
      "too many entries",
      Array.from({ length: MAX_REPLICAS + 1 }, () => ({
        provider: "x",
        id: "y",
      })),
    ],
  ])("rejects a list with %s", async (_label, value) => {
    const suffix = Buffer.from(JSON.stringify(value)).toString("base64url");
    await expect(decodeReplicas(suffix, null)).rejects.toMatchObject({
      code: CoreErrorCode.REPLICA_LIST_INVALID,
    });
  });

  it("treats a public ID containing the marker as one whole ID", async () => {
    const legacy = "custom~r1~not-a-list";
    expect(await parsePublicStorageId(legacy)).toEqual({
      primary: legacy,
      replicas: [],
    });
  });

  it("refuses to record copies when the primary contains the marker", async () => {
    await expect(
      composeOnChainStorageId("custom~r1~id", list, null),
    ).rejects.toMatchObject({ code: CoreErrorCode.REPLICA_LIST_INVALID });
  });
});

describe("store() with replication", () => {
  it("writes the same bytes to every adapter, with the first as primary", async () => {
    const { ds, a, b } = await setup();
    const res = await ds.store(enc("hello"));
    expect(res.storageId).toBe("alpha-0");
    expect(res.storageProvider).toBe("alpha");
    expect(res.replicas).toEqual([{ provider: "beta", id: "beta-0" }]);
    expect(a.data.get("alpha-0")).toEqual(b.data.get("beta-0"));
  });

  it("encrypts the copy list in the on-chain value", async () => {
    const { ds, written } = await setup();
    await ds.store(enc("hello"));
    const { primary, suffix } = splitOnChainStorageId(written[0]!.storageId!);
    expect(suffix).toBeDefined();
    expect(primary).not.toContain("alpha");
    expect(written[0]!.storageId).not.toContain("beta");
  });

  it("writes a readable list in the on-chain value for public content", async () => {
    const { ds, written } = await setup();
    await ds.store(enc("hello"), { isPublic: true });
    expect(await parsePublicStorageId(written[0]!.storageId!)).toEqual({
      primary: "alpha-0",
      replicas: [{ provider: "beta", id: "beta-0" }],
    });
  });

  it("keeps the on-chain format unchanged when only one copy is written", async () => {
    const { ds, a, b, written } = await setup();
    b.down = true;
    const res = await ds.store(enc("hello"), { isPublic: true });
    expect(res.replicas).toBeUndefined();
    expect(written[0]!.storageId).toBe("alpha-0");
    expect(a.data.size).toBe(1);
  });

  it("keeps the on-chain format unchanged with no policy", async () => {
    const { ds, b, written } = await setup({
      storagePolicy: undefined as never,
    });
    await ds.store(enc("hello"), { isPublic: true });
    expect(written[0]!.storageId).toBe("alpha-0");
    expect(b.data.size).toBe(0);
  });

  it("drops a copy that duplicates the primary", async () => {
    const twin = new IsolatedStorage("alpha");
    const primary = new IsolatedStorage("alpha");
    const { ds } = await setup({ storageAdapters: [primary, twin] });
    const res = await ds.store(enc("hello"));
    expect(res.storageId).toBe("alpha-0");
    expect(res.replicas).toBeUndefined();
  });

  it("makes the primary whichever adapter succeeds first", async () => {
    const { ds, a } = await setup();
    a.down = true;
    const res = await ds.store(enc("hello"));
    expect(res.storageId).toBe("beta-0");
    expect(res.replicas).toBeUndefined();
  });

  it("lists paid copies when onComplete rejects too few", async () => {
    const { ds, b, chain } = await setup({
      storagePolicy: {
        onSuccess: () => "continue",
        onComplete: ({ successes }) =>
          successes.length >= 2 ? "accept" : "fail",
      },
    });
    b.down = true;
    const write = vi.mocked(chain.writeReference);
    await expect(ds.store(enc("hello"))).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_REJECTED,
      committed: false,
      successes: [expect.objectContaining({ storageId: "alpha-0" })],
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("returns copies in storage-only mode, each readable by ID", async () => {
    const a = new IsolatedStorage("alpha");
    const b = new IsolatedStorage("beta");
    const ds = new DStorage({
      storageAdapters: [a, b],
      encryptionAdapters: [encryption()],
      storagePolicy: replicateAll,
    });
    await ds.init();
    const res = await ds.store(enc("hello"));
    expect(res.replicas).toEqual([{ provider: "beta", id: "beta-0" }]);
    const fromCopy = await ds.retrieveByStorageId(
      res.replicas![0]!.id,
      res.cryptoScheme,
    );
    expect(fromCopy.bytes).toEqual(enc("hello"));
  });
});

describe("retrieveByRefId() with copies", () => {
  it.each([false, true])(
    "falls back to a copy when the primary is down (public: %s)",
    async (isPublic) => {
      const { ds, a } = await setup();
      const { chainRefId } = await ds.store(enc("hello"), { isPublic });
      a.down = true;
      const { bytes } = await ds.retrieveByRefId(chainRefId!);
      expect(bytes).toEqual(enc("hello"));
    },
  );

  it("falls back to a copy when the primary's bytes were tampered with", async () => {
    const { ds, a } = await setup();
    const { chainRefId, storageId } = await ds.store(enc("hello"));
    a.data.set(storageId, enc("tampered"));
    const { bytes } = await ds.retrieveByRefId(chainRefId!);
    expect(bytes).toEqual(enc("hello"));
  });

  it("rejects a tampered copy too, reporting every location", async () => {
    const { ds, a, b } = await setup();
    const { chainRefId, storageId, replicas } = await ds.store(enc("hello"));
    a.data.set(storageId, enc("tampered"));
    b.data.set(replicas![0]!.id, enc("tampered"));
    const err = await ds
      .retrieveByRefId(chainRefId!)
      .catch(
        (e: { code: number; cause: Array<{ error: { code?: number } }> }) => e,
      );
    expect(err).toMatchObject({ code: CoreErrorCode.STORAGE_READ_ALL_FAILED });
    const failures = (err as { cause: Array<{ error: { code?: number } }> })
      .cause;
    expect(
      failures.filter(
        (f) => f.error.code === CoreErrorCode.CONTENT_HASH_MISMATCH,
      ),
    ).toHaveLength(2);
  });

  it("only tries a copy on adapters with a matching provider name", async () => {
    const { ds, chain } = await setup();
    const { chainRefId } = await ds.store(enc("hello"));
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const a2 = new IsolatedStorage("alpha");
    const retrieve = vi.spyOn(a2, "retrieve");
    const reader = new DStorage({
      storageAdapters: [a2],
      chainAdapters: [chain],
      encryptionAdapters: [encryption()],
      logger,
    });
    await reader.init();
    await expect(reader.retrieveByRefId(chainRefId!)).rejects.toThrow(
      "alpha has no alpha-0",
    );
    expect(retrieve).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith(
      "dStorage",
      expect.stringContaining('named "beta"'),
    );
  });

  it("lets a policy read a copy first", async () => {
    const seen: string[] = [];
    const { ds, a } = await setup({
      storagePolicy: {
        onSuccess: () => "continue",
        order: ({ candidates, operation }) => {
          if (operation !== "retrieve") return candidates;
          seen.push(...candidates.map((c) => c.location?.kind ?? "none"));
          return [...candidates].reverse();
        },
      },
    });
    const { chainRefId } = await ds.store(enc("hello"));
    const retrieveA = vi.spyOn(a, "retrieve");
    await ds.retrieveByRefId(chainRefId!);
    expect(seen).toEqual(["primary", "primary", "replica"]);
    expect(retrieveA).not.toHaveBeenCalled();
  });

  it("stops at the first readable copy even if onSuccess returns continue", async () => {
    const { ds, b } = await setup();
    const { chainRefId } = await ds.store(enc("hello"));
    const retrieveB = vi.spyOn(b, "retrieve");
    await ds.retrieveByRefId(chainRefId!);
    expect(retrieveB).not.toHaveBeenCalled();
  });

  it("still fails hard on a hash mismatch with no copies recorded", async () => {
    const { ds, a, b } = await setup({ storagePolicy: undefined as never });
    const { chainRefId, storageId } = await ds.store(enc("hello"));
    a.data.set(storageId, enc("tampered"));
    const retrieveB = vi.spyOn(b, "retrieve");
    await expect(ds.retrieveByRefId(chainRefId!)).rejects.toMatchObject({
      code: CoreErrorCode.CONTENT_HASH_MISMATCH,
    });
    expect(retrieveB).not.toHaveBeenCalled();
  });
});

describe("ownership with copies", () => {
  it.each([false, true])(
    "removes a reference with copies (public: %s)",
    async (isPublic) => {
      const { ds } = await setup();
      const { chainRefId } = await ds.store(enc("hello"), { isPublic });
      await ds.removeReference(chainRefId!);
      await expect(ds.retrieveByRefId(chainRefId!)).rejects.toBeDefined();
    },
  );

  it("updates a reference, recording the new copies", async () => {
    const { ds, a } = await setup();
    const { chainRefId } = await ds.store(enc("v1"));
    const res = await ds.update(chainRefId!, enc("v2"));
    expect(res.storageId).toBe("alpha-1");
    expect(res.replicas).toEqual([{ provider: "beta", id: "beta-1" }]);
    a.down = true;
    expect((await ds.retrieveByRefId(chainRefId!)).bytes).toEqual(enc("v2"));
    a.down = false;
    await ds.update(chainRefId!, enc("v3"));
    await ds.removeReference(chainRefId!);
  });

  it("keeps copies readable after rotating keys", async () => {
    const { ds, a, chain } = await setup();
    const { chainRefId } = await ds.store(enc("hello"));
    const before = (await chain.readReference(chainRefId!)).storageId;
    await ds.rotateKeys(chainRefId!);
    expect((await chain.readReference(chainRefId!)).storageId).toBe(before);
    a.down = true;
    expect((await ds.retrieveByRefId(chainRefId!)).bytes).toEqual(enc("hello"));
  });

  it("doesn't let a damaged list block reads or removal", async () => {
    const { ds, chain } = await setup();
    const write = chain.writeReference;
    vi.mocked(write).mockImplementationOnce(async function (ref) {
      vi.mocked(write).mockRestore();
      return chain.writeReference({
        ...ref,
        storageId: `${splitOnChainStorageId(ref.storageId!).primary}~r1~damaged`,
      });
    });
    const { chainRefId } = await ds.store(enc("hello"));
    expect((await ds.retrieveByRefId(chainRefId!)).bytes).toEqual(enc("hello"));
    const [listed] = await ds.listReferences({ refIds: [chainRefId!] });
    expect(listed!.storageId).toBe("alpha-0");
    expect(listed!.replicas).toBeUndefined();
    expect(listed!.decryptionError).toBeUndefined();
    await ds.removeReference(chainRefId!);
  });
});

describe("listReferences() with copies", () => {
  it.each([false, true])(
    "returns the primary and its copies, never the raw value (public: %s)",
    async (isPublic) => {
      const { ds } = await setup();
      const { chainRefId } = await ds.store(enc("hello"), { isPublic });
      const listed = await ds.listReferences({ refIds: [chainRefId!] });
      expect(listed[0]).toMatchObject({
        storageId: "alpha-0",
        replicas: [{ provider: "beta", id: "beta-0" }],
      });
    },
  );

  it("adds no field for a reference without copies", async () => {
    const { ds } = await setup({ storagePolicy: undefined as never });
    const { chainRefId } = await ds.store(enc("hello"));
    const [listed] = await ds.listReferences({ refIds: [chainRefId!] });
    expect(listed).not.toHaveProperty("replicas");
  });
});

describe("recovery with copies", () => {
  it("keeps copies through StorePartialError and registerReference", async () => {
    const { ds, a, chain } = await setup();
    vi.mocked(chain.writeReference).mockRejectedValueOnce(new Error("down"));
    const err = (await ds
      .store(enc("hello"))
      .catch((e: unknown) => e)) as StorePartialError;
    expect(err).toBeInstanceOf(StorePartialError);
    expect(err.recovery.replicas).toEqual([{ provider: "beta", id: "beta-0" }]);

    const { chainRefId } = await ds.registerReference({
      storageId: err.recovery.storageId,
      storageProvider: err.recovery.storageProvider,
      keyEnvelope: err.recovery.keyEnvelope!,
      contentHash: err.recovery.contentHash!,
      replicas: err.recovery.replicas!,
    });
    a.down = true;
    expect((await ds.retrieveByRefId(chainRefId)).bytes).toEqual(enc("hello"));
  });

  it("reports copies in the stored progress event", async () => {
    const { ds } = await setup();
    const onProgress = vi.fn();
    await ds.store(enc("hello"), { onProgress });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "stored",
        recovery: expect.objectContaining({
          replicas: [{ provider: "beta", id: "beta-0" }],
        }),
      }),
    );
  });

  it("keeps copies through retryUpdate", async () => {
    const { ds, a, chain } = await setup();
    const { chainRefId } = await ds.store(enc("v1"));
    vi.spyOn(chain, "updateReference").mockRejectedValueOnce(new Error("down"));
    const err = (await ds
      .update(chainRefId!, enc("v2"))
      .catch((e: unknown) => e)) as StorePartialError;
    expect(err).toBeInstanceOf(StorePartialError);
    const res = await ds.retryUpdate(chainRefId!, err.recovery);
    expect(res.replicas).toEqual([{ provider: "beta", id: "beta-1" }]);
    a.down = true;
    expect((await ds.retrieveByRefId(chainRefId!)).bytes).toEqual(enc("v2"));
  });

  it.each([
    ["no keyEnvelope", { storageId: "alpha-0" }],
    ["no storageId", { keyEnvelope: "{}" }],
  ])("rejects replicas with %s", async (_label, options) => {
    const { ds } = await setup();
    await expect(
      ds.registerReference({
        ...options,
        replicas: [{ provider: "beta", id: "beta-0" }],
      }),
    ).rejects.toMatchObject({
      code: CoreErrorCode.REPLICAS_REQUIRE_KEY_ENVELOPE,
    });
  });
});

describe("chunked uploads with copies", () => {
  const bytes = makeBytes(CHUNK_SIZE * 2 + 10); // 3 chunks + 1 manifest

  it.each([false, true])(
    "writes a whole upload per adapter, each with its own hash (public: %s)",
    async (isPublic) => {
      const { ds, a, b } = await setup();
      const res = await ds.store(bytes, { isPublic });
      expect(a.data.size).toBe(4);
      expect(b.data.size).toBe(4);
      expect(res.storageId).toBe("alpha-3");
      expect(res.replicas).toEqual([
        {
          provider: "beta",
          id: "beta-3",
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]);
    },
  );

  it.each([false, true])(
    "reads from a copy when the primary is down (public: %s)",
    async (isPublic) => {
      const { ds, a } = await setup();
      const { chainRefId } = await ds.store(bytes, { isPublic });
      a.down = true;
      expect((await ds.retrieveByRefId(chainRefId!)).bytes).toEqual(bytes);
    },
  );

  it("restarts from the next copy's manifest when a chunk is missing", async () => {
    const { ds, a, b } = await setup();
    const { chainRefId } = await ds.store(bytes);
    a.data.delete("alpha-1");
    const retrieveB = vi.spyOn(b, "retrieve");
    expect((await ds.retrieveByRefId(chainRefId!)).bytes).toEqual(bytes);
    // The primary's ID on beta, then the copy's manifest and 3 chunks.
    expect(retrieveB).toHaveBeenCalledTimes(5);
  });

  it("restarts a failed copy from chunk 0 under a retry", async () => {
    const a = new IsolatedStorage("alpha");
    const b = new IsolatedStorage("beta");
    const store = b.store.bind(b);
    let calls = 0;
    vi.spyOn(b, "store").mockImplementation(async (data) => {
      if (++calls === 2) throw new Error("blip");
      return store(data);
    });
    const { ds } = await setup({
      storageAdapters: [a, b],
      storagePolicy: {
        onSuccess: () => "continue",
        onFailure: ({ attempt }) =>
          attempt === 1 ? { action: "retry" } : "next",
      },
    });
    const res = await ds.store(bytes);
    // One chunk from the failed attempt, then 3 chunks + 1 manifest.
    expect(b.store).toHaveBeenCalledTimes(6);
    expect(res.replicas).toHaveLength(1);
    a.down = true;
    const { chainRefId } = res;
    expect((await ds.retrieveByRefId(chainRefId!)).bytes).toEqual(bytes);
  });

  it("reports attempts and copies in progress events only with a policy", async () => {
    const { ds } = await setup();
    const events: Array<{
      attemptIndex?: number;
      copyIndex?: number;
      adapterIndex?: number;
    }> = [];
    await ds.store(bytes, { onProgress: (p) => void events.push(p) });
    const uploading = events.filter((e) => e.attemptIndex !== undefined);
    expect(new Set(uploading.map((e) => e.copyIndex))).toEqual(new Set([0, 1]));
    expect(uploading[uploading.length - 1]).toMatchObject({
      attemptIndex: 1,
      adapterIndex: 1,
      copyIndex: 1,
    });

    const plain = await setup({ storagePolicy: undefined as never });
    const plainEvents: object[] = [];
    await plain.ds.store(bytes, {
      onProgress: (p) => void plainEvents.push(p),
    });
    expect(plainEvents[0]).not.toHaveProperty("copyIndex");
    expect(plainEvents[0]).not.toHaveProperty("adapterIndex");
  });

  it("rejects private copies in storage-only mode, which can't be read back", async () => {
    const a = new IsolatedStorage("alpha");
    const b = new IsolatedStorage("beta");
    const store = vi.spyOn(b, "store");
    const ds = new DStorage({
      storageAdapters: [a, b],
      encryptionAdapters: [encryption()],
      storagePolicy: replicateAll,
    });
    await ds.init();
    await expect(ds.store(bytes)).rejects.toMatchObject({
      code: CoreErrorCode.ADAPTER_POLICY_INVALID_DECISION,
      message: expect.stringContaining("need a chain adapter"),
    });
    expect(store).not.toHaveBeenCalled();
  });

  it("allows public copies in storage-only mode", async () => {
    const a = new IsolatedStorage("alpha");
    const b = new IsolatedStorage("beta");
    const ds = new DStorage({
      storageAdapters: [a, b],
      encryptionAdapters: [encryption()],
      storagePolicy: replicateAll,
    });
    await ds.init();
    const res = await ds.store(bytes, { isPublic: true });
    expect(res.replicas).toHaveLength(1);
    expect((await ds.retrieveByStorageId(res.replicas![0]!.id)).bytes).toEqual(
      bytes,
    );
  });
});
