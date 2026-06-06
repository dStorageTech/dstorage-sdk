/**
 * @dstorage/core — chunked.ts
 *
 * Defines the manifest shape and helpers for large-file (chunked) uploads.
 * SDK-level chunking splits files into CHUNK_SIZE pieces before encryption,
 * bounding peak memory usage to ~2× the chunk size regardless of file size.
 */

import type { StorageProviderName } from "@dstorage/storage";

/**
 * Nominal SDK chunk size: 10 MB per piece.
 *
 * Each chunk becomes one independent Arweave transaction, so larger chunks
 * mean fewer transactions and therefore less total base-fee overhead.
 * 10 MB sits comfortably below the arweave.net gateway POST limit (~12 MB)
 * while halving transaction count compared to 5 MB.
 *
 * The Arweave adapter uses getUploader() which sends each transaction's data
 * in 256 KB network slices, so 10 MB chunks upload reliably without hitting
 * any HTTP body size limit.
 */
export const CHUNK_SIZE = 10 * 1024 * 1024;

/**
 * Maximum number of chunks accepted from an untrusted manifest.
 * 10,000 chunks × 10 MB = 100 GB — generous enough for legitimate large files
 * while bounding iteration cost when processing a public (unauthenticated) manifest.
 */
export const MAX_CHUNK_COUNT = 10_000;

/**
 * Maximum total reassembled byte count accepted from an untrusted manifest.
 * Guards the `new Uint8Array(manifest.totalSize)` allocation in `_retrieveChunked`
 * against a hostile gateway returning a manifest with an inflated totalSize.
 */
export const MAX_REASSEMBLY_BYTES = MAX_CHUNK_COUNT * CHUNK_SIZE; // 100 GB

export interface ChunkEntry {
  index: number;
  storageId: string;
  /** Actual byte count in this chunk (last chunk may be smaller). */
  size: number;
}

export interface ChunkManifest {
  v: 1;
  type: "dstorage-chunked-manifest";
  totalSize: number;
  chunkSize: number;
  chunkCount: number;
  provider: StorageProviderName;
  chunks: ChunkEntry[];
}

export function isManifest(payload: unknown): payload is ChunkManifest {
  if (typeof payload !== "object" || payload === null) return false;
  const m = payload as Record<string, unknown>;
  if (m["type"] !== "dstorage-chunked-manifest") return false;
  // Validate that all numeric fields are finite non-negative integers within
  // safe bounds so downstream code (especially `new Uint8Array(totalSize)`)
  // cannot be driven into OOM by a hostile public-manifest gateway.
  return (
    Number.isInteger(m["totalSize"]) &&
    (m["totalSize"] as number) >= 0 &&
    (m["totalSize"] as number) <= MAX_REASSEMBLY_BYTES &&
    Number.isInteger(m["chunkSize"]) &&
    (m["chunkSize"] as number) > 0 &&
    Number.isInteger(m["chunkCount"]) &&
    (m["chunkCount"] as number) >= 0 &&
    (m["chunkCount"] as number) <= MAX_CHUNK_COUNT
  );
}
