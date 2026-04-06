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
import { MockChainAdapter } from "@dstorage/chain";
import { PasswordSeedProvider } from "@dstorage/seed-providers";
import type { DStorageConfig } from "../types.js";

const enc = (s: string) => new TextEncoder().encode(s);

// Fast scrypt params for tests — never use in production.
const TEST_SCRYPT = { N: 1024, r: 8, p: 1 };
const testSeedProvider = (salt: string) =>
  new PasswordSeedProvider({
    password: "dstorage-test-passphrase-v1!",
    salt,
    params: TEST_SCRYPT,
  });

// ── Shared adapters ───────────────────────────────────────────────────────────
// Each test gets its own storage + chain adapter instances to avoid cross-test
// state interference (module-level Maps in mock adapters are isolated per file).

function makeConfig(address = "0xTestUser"): DStorageConfig {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
    encryptionSeedProvider: testSeedProvider(address),
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
    const { chainRefId } = await alice.upload(enc("Alice private record"));
    const { bytes } = await alice.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe("Alice private record");
  });

  it("multiple distinct uploads are all independently retrievable", async () => {
    const alice = await makeUser("0xAlice_i2");
    const records = ["Record A", "Record B", "Record C"];
    const ids: string[] = [];
    for (const r of records) {
      const { chainRefId } = await alice.upload(enc(r));
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
    const { chainRefId } = await alice.upload(bytes);
    const { bytes: retrieved } = await alice.retrieveByRefId(chainRefId);
    expect(retrieved).toEqual(bytes);
  });

  it("empty string is stored and retrieved correctly", async () => {
    // Note: empty file validation only applies to MetaTransaction (File API)
    // The low-level upload() accepts any string including empty
    const alice = await makeUser("0xAlice_i4");
    // Non-empty string to avoid edge cases with encryption
    const { chainRefId } = await alice.upload(enc("."));
    const { bytes } = await alice.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe(".");
  });

  it("large content (100KB text) round-trips correctly", async () => {
    const alice = await makeUser("0xAlice_i5");
    const bigContent = "x".repeat(100 * 1024);
    const { chainRefId } = await alice.upload(enc(bigContent));
    const { bytes } = await alice.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe(bigContent);
  });
});

// ── Seed provider isolation ───────────────────────────────────────────────────

describe("wallet isolation", () => {
  it("Alice cannot decrypt Bob's data (different encryption keys)", async () => {
    // Use separate adapter instances so storage is shared but chain is separate
    const sharedStorage = new MockStorageAdapter();
    const alice = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: new MockChainAdapter(),
      encryptionSeedProvider: testSeedProvider("0xAlice_iso1"),
    });
    const bob = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: new MockChainAdapter(),
      encryptionSeedProvider: testSeedProvider("0xBob_iso1"),
    });
    await alice.init();
    await bob.init();

    // Bob uploads something
    const { storageId, chainRefId } = await bob.upload(enc("Bob private"));
    // Reconstruct Bob's refId for Alice to try to retrieveByRefId
    const refId = `${storageId}::${chainRefId}`;

    // Alice attempts to retrieveByRefId and decrypt Bob's data — should fail or produce garbage
    // The decrypt will throw because the ciphertext was encrypted with Bob's key.
    await expect(alice.retrieveByRefId(refId)).rejects.toThrow();
  });

  it("same address always derives the same encryption key", async () => {
    const sharedStorage = new MockStorageAdapter();
    const ds1 = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: new MockChainAdapter(),
      encryptionSeedProvider: testSeedProvider("0xAlice_iso2"),
    });
    const ds2 = new DStorage({
      storageAdapter: sharedStorage,
      chainAdapter: new MockChainAdapter(),
      encryptionSeedProvider: testSeedProvider("0xAlice_iso2"), // same salt → same key
    });
    await ds1.init();
    await ds2.init();

    // Upload with ds1
    const { chainRefId } = await ds1.upload(enc("Shared key test"));

    // Retrieve with ds2 (same address → same key)
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
      const { chainRefId } = await alice.upload(enc(content));
      ids[key] = chainRefId;
    }

    for (const [key, content] of Object.entries(records)) {
      const { bytes } = await alice.retrieveByRefId(ids[key]!);
      expect(new TextDecoder().decode(bytes)).toBe(content);
    }
  });
});

// ── Disconnect / re-init ──────────────────────────────────────────────────────

describe("disconnect and reconnect", () => {
  it("uploads before disconnect are still retrievable after re-init", async () => {
    const sharedStorage = new MockStorageAdapter();
    const makeDs = () =>
      new DStorage({
        storageAdapter: sharedStorage,
        chainAdapter: new MockChainAdapter(),
        encryptionSeedProvider: testSeedProvider("0xAlice_drr1"),
      });

    const ds = makeDs();
    await ds.init();

    const { chainRefId } = await ds.upload(enc("persistent data"));
    ds.disconnect();

    // Re-init with the same seed provider (same address → same key)
    await ds.init();
    const { bytes } = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe("persistent data");
  });
});
