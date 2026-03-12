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
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as ChunkManifest).type === "dstorage-chunked-manifest"
  );
}
