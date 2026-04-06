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
import { MockChainAdapter } from "@dstorage/chain";
import { PasswordSeedProvider } from "@dstorage/seed-providers";
import { isManifest } from "../chunked.js";
import type { DStorageConfig } from "../types.js";

// Must match the mocked value above.
const CHUNK_SIZE = 512;

function makeConfig(address = "0xTestUser"): DStorageConfig {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
    encryptionSeedProvider: new PasswordSeedProvider({
      password: "dstorage-test-passphrase-v1!",
      salt: address,
      params: { N: 1024, r: 8, p: 1 },
    }),
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
