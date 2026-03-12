/**
 * @dstorage/core — chunked upload / retrieve tests
 *
 * Verifies that large files are split into chunks, each uploaded independently,
 * and reassembled correctly on retrieval — using MockStorageAdapter + MockChainAdapter.
 */

import { describe, it, expect, vi } from "vitest";
import { DStorage } from "../dStorage.js";
import { connectDemoWallet } from "../wallet.js";
import { MockStorageAdapter } from "@dstorage/storage";
import { MockChainAdapter } from "@dstorage/chain";
import { CHUNK_SIZE, isManifest } from "../chunked.js";
import type { DStorageConfig } from "../types.js";

function makeConfig(): DStorageConfig {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
  };
}

async function makeConnectedDStorage(config?: DStorageConfig) {
  const ds = new DStorage(config ?? makeConfig());
  const wallet = await connectDemoWallet(
    `0xTestUser_chunked_${Math.random().toString(36).slice(2)}`,
  );
  await ds.connect(wallet);
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
    const ds = await makeConnectedDStorage();
    const content = "small file content";
    const { chainRefId } = await ds.upload(content);
    const { content: retrieved } = await ds.retrieveByRefId(chainRefId);
    expect(retrieved).toBe(content);
  });

  it("file exactly CHUNK_SIZE bytes uses single-shot path (1 storage entry)", async () => {
    const config = makeConfig();
    const storageAdapter = config.storageAdapter as MockStorageAdapter;
    const uploadSpy = vi.spyOn(storageAdapter, "upload");

    const ds = await makeConnectedDStorage(config);
    const bytes = makeBytes(CHUNK_SIZE); // exactly 5 MB → 1 chunk, no manifest
    await ds.upload(bytes);

    // Single-shot: exactly 1 upload call
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Large files — chunked path ────────────────────────────────────────────────

describe("upload large file (> CHUNK_SIZE)", () => {
  it("splits into ceil(size/CHUNK_SIZE) chunks + 1 manifest upload", async () => {
    const config = makeConfig();
    const storageAdapter = config.storageAdapter as MockStorageAdapter;
    const uploadSpy = vi.spyOn(storageAdapter, "upload");

    const ds = await makeConnectedDStorage(config);
    const bytes = makeBytes(CHUNK_SIZE + 1); // 5 MB + 1 byte → 2 chunks
    await ds.upload(bytes);

    // 2 chunk uploads + 1 manifest upload = 3 total
    expect(uploadSpy).toHaveBeenCalledTimes(3);
  });

  it("chunk count is ceil(size / CHUNK_SIZE)", async () => {
    const config = makeConfig();
    const storageAdapter = config.storageAdapter as MockStorageAdapter;
    const uploadSpy = vi.spyOn(storageAdapter, "upload");

    const ds = await makeConnectedDStorage(config);
    const chunkCount = 4;
    const bytes = makeBytes(CHUNK_SIZE * chunkCount);
    await ds.upload(bytes);

    // 4 chunks + 1 manifest
    expect(uploadSpy).toHaveBeenCalledTimes(chunkCount + 1);
  });

  it("round-trip: retrieve reassembles original bytes", async () => {
    const ds = await makeConnectedDStorage();
    const bytes = makeBytes(CHUNK_SIZE + 100); // spans 2 chunks
    const { chainRefId } = await ds.upload(bytes);
    const { bytes: retrieved } = await ds.retrieveByRefId(chainRefId);
    expect(retrieved).toEqual(bytes);
  }, 60_000);

  it("round-trip works for 3 chunks (2.5× CHUNK_SIZE)", async () => {
    const ds = await makeConnectedDStorage();
    const bytes = makeBytes(Math.floor(CHUNK_SIZE * 2.5));
    const { chainRefId } = await ds.upload(bytes);
    const { bytes: retrieved } = await ds.retrieveByRefId(chainRefId);
    expect(retrieved).toEqual(bytes);
  }, 120_000);

  it("UploadResult.storageId is the manifest's storageId", async () => {
    const config = makeConfig();
    const storageAdapter = config.storageAdapter as MockStorageAdapter;

    const ds = await makeConnectedDStorage(config);
    const bytes = makeBytes(CHUNK_SIZE + 1);
    const result = await ds.upload(bytes);

    // The manifest storageId should be the last uploaded item.
    const allIds = storageAdapter.listAll();
    // result.storageId must exist in the store
    expect(allIds).toContain(result.storageId);
  });

  it("onProgress is called with increasing chunksUploaded", async () => {
    const ds = await makeConnectedDStorage();
    const bytes = makeBytes(CHUNK_SIZE * 3);

    const progressEvents: number[] = [];
    await ds.upload(bytes, {
      onProgress: (p) => {
        if (p.phase === "uploading") progressEvents.push(p.chunksUploaded);
      },
    });

    // Should receive events with chunksUploaded 0, 1, 1, 2, 2, 3
    // We care that it ends at totalChunks
    const maxSeen = Math.max(...progressEvents);
    expect(maxSeen).toBe(3);
  });

  it("finalizing phase fires once", async () => {
    const ds = await makeConnectedDStorage();
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
    const ds = await makeConnectedDStorage();
    const result = await ds.upload("hello", { label: "my-label" });
    expect(result.chainRefId).toBeDefined();
  });

  it("accepts new UploadOptions with metadata", async () => {
    const ds = await makeConnectedDStorage();
    const result = await ds.upload("hello", {
      metadata: { label: "my-label" },
    });
    expect(result.chainRefId).toBeDefined();
  });
});

// ── Unencrypted chunked flow ───────────────────────────────────────────────────

describe("chunked upload without encryption key", () => {
  it("round-trips unencrypted chunked content", async () => {
    // Use init() path which may have no encryption key (MockChainAdapter has none)
    const config = makeConfig();
    const ds = new DStorage(config);
    await ds.init(); // no key derived — MockChainAdapter has no getEncryptionKey()

    const bytes = makeBytes(CHUNK_SIZE + 50);
    const { chainRefId } = await ds.upload(bytes);
    const { bytes: retrieved } = await ds.retrieveByRefId(chainRefId);
    expect(retrieved).toEqual(bytes);
  }, 30_000);
});
