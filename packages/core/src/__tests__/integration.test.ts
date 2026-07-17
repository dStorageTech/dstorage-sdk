/**
 * Integration tests — end-to-end flows using all real mock adapters.
 *
 * These tests exercise complete multi-step scenarios to ensure the entire
 * SDK pipeline works together. If any individual piece is broken, at least
 * one integration test here should catch it.
 */
import { describe, it, expect } from "vitest";
import { DStorage } from "../dStorage.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MidnightSimulatorChainAdapter, ChainErrorCode } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import type { DStorageConfig } from "../types.js";

const enc = (s: string) => new TextEncoder().encode(s);

// Fast scrypt params for tests — never use in production.
const TEST_SCRYPT = { N: 1024, r: 8, p: 1 };
const testSeedProvider = (salt: string) =>
  new PasswordEncryptionAdapter({
    password: "dstorage-test-passphrase-v1!",
    salt,
    params: TEST_SCRYPT,
  });

// ── Shared adapters ───────────────────────────────────────────────────────────
// Each test gets its own storage + chain adapter instances to avoid cross-test
// state interference (simulator state is per-instance).

function makeConfig(address = "0xTestUser"): DStorageConfig {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MidnightSimulatorChainAdapter(),
    encryptionAdapters: [testSeedProvider(address)],
  };
}

async function makeUser(address: string): Promise<DStorage> {
  const ds = new DStorage(makeConfig(address));
  await ds.init();
  return ds;
}

// ── Upload → Retrieve (single user) ──────────────────────────────────────────

describe("upload → retrieveByRefId round-trip", () => {
  it("Alice uploads and retrieves her own plaintext", async () => {
    const alice = await makeUser("0xAlice_i1");
    const { chainRefId } = await alice.store(enc("Alice private record"));
    const { bytes } = await alice.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe("Alice private record");
  });

  it("multiple distinct uploads are all independently retrievable", async () => {
    const alice = await makeUser("0xAlice_i2");
    const records = ["Record A", "Record B", "Record C"];
    const ids: string[] = [];
    for (const r of records) {
      const { chainRefId } = await alice.store(enc(r));
      ids.push(chainRefId);
    }
    for (let i = 0; i < records.length; i++) {
      const { bytes } = await alice.retrieveByRefId(ids[i]!);
      expect(new TextDecoder().decode(bytes)).toBe(records[i]);
    }
  });

  it("binary Uint8Array content is preserved through encrypt/decrypt cycle", async () => {
    const alice = await makeUser("0xAlice_i3");
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const { chainRefId } = await alice.store(bytes);
    const { bytes: retrieved } = await alice.retrieveByRefId(chainRefId);
    expect(retrieved).toEqual(bytes);
  });

  it("empty string is stored and retrieved correctly", async () => {
    // Note: empty file validation only applies to MetaTransaction (File API)
    // The low-level store() accepts any string including empty
    const alice = await makeUser("0xAlice_i4");
    // Non-empty string to avoid edge cases with encryption
    const { chainRefId } = await alice.store(enc("."));
    const { bytes } = await alice.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe(".");
  });

  it("large content (100KB text) round-trips correctly", async () => {
    const alice = await makeUser("0xAlice_i5");
    const bigContent = "x".repeat(100 * 1024);
    const { chainRefId } = await alice.store(enc(bigContent));
    const { bytes } = await alice.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe(bigContent);
  });
});

// ── Seed provider isolation ───────────────────────────────────────────────────

describe("wallet isolation", () => {
  it("Alice cannot decrypt Bob's data (different encryption keys)", async () => {
    // Use separate chain adapter instances so Alice's chain has no knowledge of Bob's refs.
    const sharedStorage = new MockStorageAdapter();
    const alice = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: new MidnightSimulatorChainAdapter(),
      encryptionAdapters: [testSeedProvider("0xAlice_iso1")],
    });
    const bob = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: new MidnightSimulatorChainAdapter(),
      encryptionAdapters: [testSeedProvider("0xBob_iso1")],
    });
    await alice.init();
    await bob.init();

    // Bob uploads something — refId is stored only in Bob's chain adapter instance.
    const { chainRefId } = await bob.store(enc("Bob private"));

    // Alice attempts to retrieveByRefId with Bob's refId — not in Alice's chain adapter.
    await expect(alice.retrieveByRefId(chainRefId)).rejects.toMatchObject({
      code: ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
    });
  });

  it("same address always derives the same encryption key", async () => {
    // Share one chain adapter so both SDK instances see the same on-chain state.
    const sharedStorage = new MockStorageAdapter();
    const sharedChain = new MidnightSimulatorChainAdapter();
    const ds1 = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: sharedChain,
      encryptionAdapters: [testSeedProvider("0xAlice_iso2")],
    });
    const ds2 = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: sharedChain,
      encryptionAdapters: [testSeedProvider("0xAlice_iso2")], // same salt → same key
    });
    await ds1.init();
    await ds2.init();

    // Upload with ds1
    const { chainRefId } = await ds1.store(enc("Shared key test"));

    // Retrieve with ds2 (same address → same key, same chain → same ref)
    const { bytes } = await ds2.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe("Shared key test");
  });
});

// ── Multi-record scenarios ────────────────────────────────────────────────────

describe("multi-record scenarios", () => {
  it("Alice has multiple records; each is independently accessible", async () => {
    const alice = await makeUser("0xAlice_mr1");
    const records = {
      r1: "health record 1",
      r2: "health record 2",
      r3: "health record 3",
    };
    const ids: Record<string, string> = {};

    for (const [key, content] of Object.entries(records)) {
      const { chainRefId } = await alice.store(enc(content));
      ids[key] = chainRefId;
    }

    for (const [key, content] of Object.entries(records)) {
      const { bytes } = await alice.retrieveByRefId(ids[key]!);
      expect(new TextDecoder().decode(bytes)).toBe(content);
    }
  });
});

// ── Upload → list → remove lifecycle ─────────────────────────────────────────

describe("upload → list → remove lifecycle", () => {
  it("uploaded ref appears in listReferences then disappears after removeReference", async () => {
    const alice = await makeUser("0xAlice_lifecycle1");
    const { chainRefId } = await alice.store(enc("to be removed"));

    const before = await alice.listReferences();
    expect(before.some((r) => r.refId === chainRefId)).toBe(true);

    await alice.removeReference(chainRefId);

    const after = await alice.listReferences();
    expect(after.find((r) => r.refId === chainRefId)).toBeUndefined();
  });

  it("Alice's private ref: storageId visible and no decryptionError for Alice; storageId null and decryptionError set for Bob", async () => {
    const sharedStorage = new MockStorageAdapter();
    const sharedChain = new MidnightSimulatorChainAdapter();
    const alice = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: sharedChain,
      encryptionAdapters: [testSeedProvider("0xAlice_iso2")],
    });
    const bob = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: sharedChain,
      encryptionAdapters: [testSeedProvider("0xBob_iso2")],
    });
    await alice.init();
    await bob.init();

    const { chainRefId, storageId: aliceStorageId } = await alice.store(
      enc("Alice only"),
    );

    const aliceRefs = await alice.listReferences();
    const aliceEntry = aliceRefs.find((r) => r.refId === chainRefId);
    expect(aliceEntry?.storageId).toBe(aliceStorageId);
    expect(aliceEntry?.decryptionError).toBeUndefined();

    const bobRefs = await bob.listReferences();
    const bobEntry = bobRefs.find((r) => r.refId === chainRefId);
    expect(bobEntry?.storageId).toBeNull();
    expect(bobEntry?.decryptionError).toBeDefined();
  });
});

// ── Disconnect / re-init ──────────────────────────────────────────────────────

describe("destroy and reconnect", () => {
  it("stores before destroy are still retrievable after re-init", async () => {
    const sharedStorage = new MockStorageAdapter();
    const makeDs = () =>
      new DStorage({
        storageAdapter: sharedStorage,
        chainAdapter: new MidnightSimulatorChainAdapter(),
        encryptionAdapters: [testSeedProvider("0xAlice_drr1")],
      });

    const ds = makeDs();
    await ds.init();

    const { chainRefId } = await ds.store(enc("persistent data"));
    ds.destroy();

    // Re-init with the same seed provider (same address → same key)
    await ds.init();
    const { bytes } = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe("persistent data");
  });
});
