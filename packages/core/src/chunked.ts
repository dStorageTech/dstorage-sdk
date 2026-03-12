/**
 * @dstorage/core — chunked.ts
 *
 * Defines the manifest shape and helpers for large-file (chunked) uploads.
 * SDK-level chunking splits files into CHUNK_SIZE pieces before encryption,
 * bounding peak memory usage to ~2× the chunk size regardless of file size.
 */

import type { StorageProviderName } from "@dstorage/storage";

/** Nominal chunk size: 5 MB per piece. */
export const CHUNK_SIZE = 5 * 1024 * 1024;

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
