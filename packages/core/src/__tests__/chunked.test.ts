/**
 * @dstorage/core — chunked upload / retrieve tests
 *
 * CHUNK_SIZE is mocked to 512 bytes so round-trip tests run fast without
 * hitting real encryption on tens of megabytes. The logic under test is
 * identical regardless of the chunk size value.
 */

import { describe, it, expect, vi } from "vitest";

// Override CHUNK_SIZE before any module that imports it resolves.
// Must be 512 — a literal, not a variable reference — because vi.mock is hoisted.
vi.mock("../chunked.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chunked.js")>();
  return { ...actual, CHUNK_SIZE: 512 };
});

import { DStorage } from "../dStorage.js";
import { MockStorageAdapter } from "@dstorage/storage";
import type { StorageProviderName } from "@dstorage/storage";
import { MockChainAdapter } from "@dstorage/chain";
import { PasswordEncryptionAdapter } from "@dstorage/encryption";
import {
  isManifest,
  MAX_CHUNK_COUNT,
  MAX_REASSEMBLY_BYTES,
  type ChunkManifest,
} from "../chunked.js";
import type { DStorageConfig } from "../types.js";

// Must match the mocked value above.
const CHUNK_SIZE = 512;

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

async function makeInitedDStorage(config?: DStorageConfig) {
  const addr = `0xTestUser_chunked_${Math.random().toString(36).slice(2)}`;
  const ds = new DStorage(config ?? makeConfig(addr));
  await ds.init();
  return ds;
}

/** Create a Uint8Array of `size` bytes filled with a repeating pattern. */
function makeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;
  return bytes;
}

// ── isManifest helper ────────────────────────────────────────────────────────

describe("isManifest", () => {
  it("returns true for a valid manifest object", () => {
    const manifest = {
      v: 1,
      type: "dstorage-chunked-manifest",
      totalSize: 100,
      chunkSize: CHUNK_SIZE,
      chunkCount: 1,
      provider: "mock",
      chunks: [{ index: 0, storageId: "abc", size: 100 }],
    };
    expect(isManifest(manifest)).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(isManifest("hello")).toBe(false);
  });

  it("returns false for an object missing the type field", () => {
    expect(isManifest({ v: 1, totalSize: 100 })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isManifest(null)).toBe(false);
  });

  it("returns false when totalSize exceeds MAX_REASSEMBLY_BYTES (OOM guard)", () => {
    expect(
      isManifest({
        v: 1,
        type: "dstorage-chunked-manifest",
        totalSize: MAX_REASSEMBLY_BYTES + 1,
        chunkSize: CHUNK_SIZE,
        chunkCount: 1,
        provider: "mock",
        chunks: [],
      }),
    ).toBe(false);
  });

  it("returns false when chunkCount exceeds MAX_CHUNK_COUNT (iteration guard)", () => {
    expect(
      isManifest({
        v: 1,
        type: "dstorage-chunked-manifest",
        totalSize: 0,
        chunkSize: CHUNK_SIZE,
        chunkCount: MAX_CHUNK_COUNT + 1,
        provider: "mock",
        chunks: [],
      }),
    ).toBe(false);
  });

  it("returns false when totalSize is not an integer", () => {
    expect(
      isManifest({
        v: 1,
        type: "dstorage-chunked-manifest",
        totalSize: 1.5,
        chunkSize: CHUNK_SIZE,
        chunkCount: 1,
        provider: "mock",
        chunks: [],
      }),
    ).toBe(false);
  });

  it("returns false when chunkSize is zero or negative", () => {
    expect(
      isManifest({
        v: 1,
        type: "dstorage-chunked-manifest",
        totalSize: 0,
        chunkSize: 0,
        chunkCount: 0,
        provider: "mock",
        chunks: [],
      }),
    ).toBe(false);
  });
});

// ── Small files — single-shot path unchanged ─────────────────────────────────

describe("upload small file (≤ CHUNK_SIZE)", () => {
  it("single-shot path: upload returns a storageId, retrieve round-trips", async () => {
    const ds = await makeInitedDStorage();
    const content = "small file content";
    const { chainRefId } = await ds.upload(new TextEncoder().encode(content));
    const { bytes } = await ds.retrieveByRefId(chainRefId);
    expect(new TextDecoder().decode(bytes)).toBe(content);
  });

  it("file exactly CHUNK_SIZE bytes uses single-shot path (1 storage entry)", async () => {
    const config = makeConfig();
    const storageAdapter = config.storageAdapter as MockStorageAdapter;
    const uploadSpy = vi.spyOn(storageAdapter, "upload");

    const ds = await makeInitedDStorage(config);
    const bytes = makeBytes(CHUNK_SIZE); // exactly at threshold → single-shot
    await ds.upload(bytes);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Large files — chunked path ────────────────────────────────────────────────

describe("upload large file (> CHUNK_SIZE)", () => {
  it("splits into ceil(size/CHUNK_SIZE) chunks + 1 manifest upload", async () => {
    const config = makeConfig();
    const storageAdapter = config.storageAdapter as MockStorageAdapter;
    const uploadSpy = vi.spyOn(storageAdapter, "upload");

    const ds = await makeInitedDStorage(config);
    const bytes = makeBytes(CHUNK_SIZE + 1); // 2 chunks
    await ds.upload(bytes);

    // 2 chunk uploads + 1 manifest upload = 3 total
    expect(uploadSpy).toHaveBeenCalledTimes(3);
  });

  it("chunk count is ceil(size / CHUNK_SIZE)", async () => {
    const config = makeConfig();
    const storageAdapter = config.storageAdapter as MockStorageAdapter;
    const uploadSpy = vi.spyOn(storageAdapter, "upload");

    const ds = await makeInitedDStorage(config);
    const chunkCount = 4;
    const bytes = makeBytes(CHUNK_SIZE * chunkCount);
    await ds.upload(bytes);

    // 4 chunks + 1 manifest
    expect(uploadSpy).toHaveBeenCalledTimes(chunkCount + 1);
  });

  it("round-trip: retrieve reassembles original bytes (2 chunks)", async () => {
    const ds = await makeInitedDStorage();
    const bytes = makeBytes(CHUNK_SIZE + 100);
    const { chainRefId } = await ds.upload(bytes);
    const { bytes: retrieved } = await ds.retrieveByRefId(chainRefId);
    expect(retrieved).toEqual(bytes);
  });

  it("round-trip works for 3 chunks (2.5× CHUNK_SIZE)", async () => {
    const ds = await makeInitedDStorage();
    const bytes = makeBytes(Math.floor(CHUNK_SIZE * 2.5));
    const { chainRefId } = await ds.upload(bytes);
    const { bytes: retrieved } = await ds.retrieveByRefId(chainRefId);
    expect(retrieved).toEqual(bytes);
  });

  it("UploadResult.storageId is the manifest's storageId", async () => {
    const config = makeConfig();
    const storageAdapter = config.storageAdapter as MockStorageAdapter;

    const ds = await makeInitedDStorage(config);
    const bytes = makeBytes(CHUNK_SIZE + 1);
    const result = await ds.upload(bytes);

    const allIds = storageAdapter.listAll();
    expect(allIds).toContain(result.storageId);
  });

  it("onProgress is called with increasing chunksUploaded", async () => {
    const ds = await makeInitedDStorage();
    const bytes = makeBytes(CHUNK_SIZE * 3);

    const progressEvents: number[] = [];
    await ds.upload(bytes, {
      onProgress: (p) => {
        if (p.phase === "uploading") progressEvents.push(p.chunksUploaded);
      },
    });

    const maxSeen = Math.max(...progressEvents);
    expect(maxSeen).toBe(3);
  });

  it("finalizing phase fires once", async () => {
    const ds = await makeInitedDStorage();
    const bytes = makeBytes(CHUNK_SIZE + 1);

    let finalizingCount = 0;
    await ds.upload(bytes, {
      onProgress: (p) => {
        if (p.phase === "finalizing") finalizingCount++;
      },
    });

    expect(finalizingCount).toBe(1);
  });
});

// ── Manifest field correctness ───────────────────────────────────────────────
//
// The manifest stored on the network must reflect the real state of the upload:
// correct provider name, total size, chunk count, chunk sizes, and chunk indices.
// Using a public upload so the manifest JSON is readable without decryption.

describe("chunked manifest fields are correct in storage", () => {
  // Use a non-"mock" name so the provider test detects the hardcoded "mock"
  // placeholder rather than coincidentally matching the adapter name.
  class ArweaveMockStorageAdapter extends MockStorageAdapter {
    override readonly name: StorageProviderName = "arweave";
  }

  async function getStoredManifest(
    bytes: Uint8Array,
  ): Promise<ReturnType<typeof JSON.parse>> {
    const storageAdapter = new ArweaveMockStorageAdapter();
    // Encryption adapters are required even for public chunked uploads (ownerSeed
    // wrapping). isPublic: true ensures the manifest JSON is stored in plaintext
    // so we can parse it without decryption.
    const ds = new DStorage({
      storageAdapter,
      encryptionAdapters: [
        new PasswordEncryptionAdapter({
          password: "dstorage-test-passphrase-v1!",
          salt: "manifest-field-test",
          params: { N: 1024, r: 8, p: 1 },
        }),
      ],
    });
    await ds.init();
    const result = await ds.upload(bytes, { isPublic: true });
    // For public uploads storageId is the plaintext manifest storage ID.
    const raw = await storageAdapter.retrieve(result.storageId);
    return JSON.parse(new TextDecoder().decode(raw));
  }

  it("manifest type and version fields are correct", async () => {
    const manifest = await getStoredManifest(makeBytes(CHUNK_SIZE + 1));
    expect(manifest.type).toBe("dstorage-chunked-manifest");
    expect(manifest.v).toBe(1);
  });

  it("manifest.provider matches the storage adapter name", async () => {
    const manifest = await getStoredManifest(makeBytes(CHUNK_SIZE + 1));
    expect(manifest.provider).toBe("arweave");
  });

  it("manifest.totalSize matches the uploaded byte count", async () => {
    const size = CHUNK_SIZE + 77;
    const manifest = await getStoredManifest(makeBytes(size));
    expect(manifest.totalSize).toBe(size);
  });

  it("manifest.chunkCount is ceil(size / CHUNK_SIZE)", async () => {
    const manifest = await getStoredManifest(makeBytes(CHUNK_SIZE * 3));
    expect(manifest.chunkCount).toBe(3);
  });

  it("manifest.chunks has one entry per chunk with correct index and size", async () => {
    const size = CHUNK_SIZE + 100; // 2 chunks: full + partial
    const manifest = await getStoredManifest(makeBytes(size));
    expect(manifest.chunks).toHaveLength(2);
    expect(manifest.chunks[0].index).toBe(0);
    expect(manifest.chunks[0].size).toBe(CHUNK_SIZE);
    expect(manifest.chunks[1].index).toBe(1);
    expect(manifest.chunks[1].size).toBe(100);
  });

  it("each chunk entry has a non-empty storageId", async () => {
    const manifest = await getStoredManifest(makeBytes(CHUNK_SIZE + 1));
    for (const chunk of manifest.chunks) {
      expect(typeof chunk.storageId).toBe("string");
      expect(chunk.storageId.length).toBeGreaterThan(0);
    }
  });
});

// ── Backward compatibility: old-style metadata second argument ─────────────────

describe("upload backward compatibility", () => {
  it("accepts old-style metadata Record as second arg", async () => {
    const ds = await makeInitedDStorage();
    const result = await ds.upload(new TextEncoder().encode("hello"), {
      label: "my-label",
    });
    expect(result.chainRefId).toBeDefined();
  });

  it("accepts new UploadOptions with metadata", async () => {
    const ds = await makeInitedDStorage();
    const result = await ds.upload(new TextEncoder().encode("hello"), {
      metadata: { label: "my-label" },
    });
    expect(result.chainRefId).toBeDefined();
  });
});

// ── Encrypted chunked flow ─────────────────────────────────────────────────────

describe("chunked upload via init() with encryptionSeedProvider", () => {
  it("round-trips chunked content using XChaCha20 encryption via init()", async () => {
    const ds = await makeInitedDStorage();

    const bytes = makeBytes(CHUNK_SIZE + 50);
    const { chainRefId } = await ds.upload(bytes);
    const { bytes: retrieved } = await ds.retrieveByRefId(chainRefId);
    expect(retrieved).toEqual(bytes);
  });
});

// ── Security: chunk-index AAD binding ─────────────────────────────────────────
//
// A malicious gateway that swaps the bytes stored at two chunk storageIds must
// be detected. With per-chunk AAD (chunkAad(i, n)), decrypting chunk i with
// the ciphertext that was encrypted for chunk j (i≠j) fails the Poly1305 auth
// check and throws — silently corrupt data cannot reach the caller.

describe("security: chunk AAD binding catches gateway swap", () => {
  it("swapping two chunks in storage causes decryption to throw", async () => {
    const config = makeConfig();
    const storage = config.storageAdapter as MockStorageAdapter;

    // Spy on upload to record IDs in upload order (chunks first, manifest last).
    const uploadedIds: string[] = [];
    const origUpload = storage.upload.bind(storage);
    vi.spyOn(storage, "upload").mockImplementation(async (data, meta) => {
      const result = await origUpload(data, meta);
      uploadedIds.push(result.id);
      return result;
    });

    const ds = await makeInitedDStorage(config);
    const bytes = makeBytes(CHUNK_SIZE * 3); // 3 chunks + 1 manifest
    await ds.upload(bytes);

    // uploadedIds = [chunk0, chunk1, chunk2, manifest]
    // Swap chunk0 and chunk1 bytes — same DEK, wrong position.
    const [id0, id1] = uploadedIds;
    if (!id0 || !id1) throw new Error("expected at least 2 uploaded blobs");

    const bytes0 = storage.get(id0)!;
    const bytes1 = storage.get(id1)!;
    storage.set(id0, bytes1);
    storage.set(id1, bytes0);

    // Re-create ds from the same config so it uses the tampered storage.
    const ds2 = new DStorage(config);
    await ds2.init();
    const refs = await ds2.listReferences();
    const refId = refs[0]?.refId;
    if (!refId) throw new Error("no reference found");

    // Retrieval must fail with an auth error, not return silently corrupted data.
    await expect(ds2.retrieveByRefId(refId)).rejects.toThrow(
      /Failed to decrypt chunk|decrypt/i,
    );
  });
});

// ── Security: manifest structural validation ───────────────────────────────────
//
// _retrieveChunked must reject manifests that are structurally invalid:
// wrong count, duplicate indices, missing indices, totalSize overflow.
// Uses public uploads so the manifest is stored as plaintext for easy tampering.
// The manifest storageId is known from the upload result, so we tamper it
// directly without needing to search the shared memoryStore.

describe("security: manifest structural validation", () => {
  /** Upload a public chunked file, tamper its manifest blob in-place, return
   *  a fresh DStorage instance pointing at the tampered storage. */
  async function uploadAndTamperManifest(
    tamper: (m: ChunkManifest) => ChunkManifest,
  ) {
    const config = makeConfig();
    const storage = config.storageAdapter as MockStorageAdapter;
    const ds = await makeInitedDStorage(config);

    // Public upload — manifest stored as plaintext, easy to tamper.
    const bytes = makeBytes(CHUNK_SIZE * 2 + 10);
    // storageId is the manifest's storageId (the on-chain pointer).
    const { chainRefId, storageId } = await ds.upload(bytes, {
      isPublic: true,
    });

    const raw = storage.get(storageId)!;
    const manifest = JSON.parse(new TextDecoder().decode(raw)) as ChunkManifest;
    const tampered = tamper(manifest);
    storage.set(storageId, new TextEncoder().encode(JSON.stringify(tampered)));

    return { ds, chainRefId };
  }

  it("rejects manifest where chunks.length < chunkCount", async () => {
    const { ds, chainRefId } = await uploadAndTamperManifest((m) => ({
      ...m,
      chunkCount: m.chunks.length + 1, // claim one more chunk than present
    }));
    await expect(ds.retrieveByRefId(chainRefId)).rejects.toThrow(
      /declares.*chunks.*contains|contains.*entries/i,
    );
  });

  it("rejects manifest with duplicate chunk index", async () => {
    const { ds, chainRefId } = await uploadAndTamperManifest((m) => ({
      ...m,
      chunks: m.chunks.map((c, i) => (i === 1 ? { ...c, index: 0 } : c)),
    }));
    await expect(ds.retrieveByRefId(chainRefId)).rejects.toThrow(
      /not contiguous|expected index/i,
    );
  });

  it("rejects manifest with a missing chunk index (gap)", async () => {
    const { ds, chainRefId } = await uploadAndTamperManifest((m) => ({
      ...m,
      // shift last chunk index to leave a gap: 0, 2 instead of 0, 1
      chunks: m.chunks.map((c, i) =>
        i === m.chunks.length - 1 ? { ...c, index: c.index + 1 } : c,
      ),
    }));
    await expect(ds.retrieveByRefId(chainRefId)).rejects.toThrow(
      /not contiguous|expected index/i,
    );
  });

  it("rejects manifest where chunk data overflows declared totalSize", async () => {
    const { ds, chainRefId } = await uploadAndTamperManifest((m) => ({
      ...m,
      totalSize: 1, // shrink so real chunks overflow it
    }));
    await expect(ds.retrieveByRefId(chainRefId)).rejects.toThrow(
      /overflows|Reassembled|totalSize/i,
    );
  });
});

// ── Security: manifest detection by JSON shape ────────────────────────────────
//
// The SDK must not misinterpret a user file as a chunked manifest just because
// its plaintext happens to parse as JSON with the manifest shape. An attacker
// who uploads a crafted payload (or tricks a victim into uploading one) could
// redirect retrieval to attacker-controlled storageIds. The SDK must distinguish
// "this is a manifest produced by _uploadChunked" from "this is a user file that
// looks like a manifest".

describe("security: manifest shape in user content is not misinterpreted", () => {
  /** Build a valid-looking manifest JSON as raw bytes. */
  function craftedManifestBytes(storageId: string): Uint8Array {
    const manifest = {
      v: 1,
      type: "dstorage-chunked-manifest",
      totalSize: 10,
      chunkSize: CHUNK_SIZE,
      chunkCount: 1,
      provider: "mock",
      chunks: [{ index: 0, storageId, size: 10 }],
    };
    return new TextEncoder().encode(JSON.stringify(manifest));
  }

  it("uploading a file whose content is a manifest JSON round-trips as raw bytes", async () => {
    const ds = await makeInitedDStorage();

    // Upload a file whose plaintext looks exactly like a manifest.
    const payload = craftedManifestBytes("attacker-controlled-id");
    const { chainRefId } = await ds.upload(payload);

    // Retrieval must return the original bytes, not attempt chunk reassembly.
    const { bytes: retrieved } = await ds.retrieveByRefId(chainRefId);
    expect(retrieved).toEqual(payload);
  });

  it("manifest-shaped content does not trigger a fetch to the embedded storageId", async () => {
    const config = makeConfig();
    const storage = config.storageAdapter as MockStorageAdapter;
    const ds = await makeInitedDStorage(config);

    const sentinelId = "attacker-controlled-id-sentinel";
    const payload = craftedManifestBytes(sentinelId);
    const { chainRefId } = await ds.upload(payload);

    const retrieveSpy = vi.spyOn(storage, "retrieve");
    await ds.retrieveByRefId(chainRefId);

    // The sentinel ID must never have been passed to retrieve().
    const calledIds = retrieveSpy.mock.calls.map((c) => c[0]);
    expect(calledIds).not.toContain(sentinelId);
  });
});
