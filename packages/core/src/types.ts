/**
 * @dstorage/core — types.ts
 * Top-level types for the dStorage SDK public API.
 */

import type { StorageAdapter, StorageProviderName } from "@dstorage/storage";
import type { ChainAdapter, ChainProviderName } from "@dstorage/chain";
import { CostEstimate } from "./payment";

/**
 * Minimal logger interface accepted by every SDK class.
 * Compatible with `console` — pass `logger: console` for zero-boilerplate logging.
 * Omit the field entirely to suppress all SDK output.
 */
export interface Logger {
  log(component: string, msg: string): void;
  warn(component: string, msg: string): void;
  error(component: string, msg: string): void;
  debug?(component: string, msg: string): void;
}

/** Wallet connection info returned after connecting */
export interface WalletInfo {
  address: string;
  chainProvider: ChainProviderName;
  /** The raw signature (or PBKDF2 seed) used to derive the encryption key (kept in memory only) */
  _signatureHex: string;
  /**
   * The raw DApp Connector API object returned by the wallet.
   * Passed through to MidnightChainAdapter so it can balance and submit transactions
   * without re-connecting. Present only when using connectMidnightWallet().
   */
  walletApi?: unknown;
}

/** Configuration passed to dStorage constructor */
export interface DStorageConfig {
  /** Storage adapter to use (MockStorageAdapter | ArweaveStorageAdapter | ...) */
  storageAdapter: StorageAdapter;
  /** Chain adapter to use (MockChainAdapter | MidnightChainAdapter | ...) */
  chainAdapter: ChainAdapter;
  /** Optional label for the type of data being stored */
  defaultDataLabel?: string;
  /**
   * On-chain address of an already-deployed DataRegistry contract.
   * If omitted, sdk.init() will deploy a new contract and return its address.
   */
  dataRegistryAddress?: string;
  /**
   * Optional logger for SDK operational output.
   * Pass `logger: console` to see all output, or inject your own logger.
   * Omit to suppress all SDK log output.
   */
  logger?: Logger;
}

export interface UploadProgress {
  phase: "encrypting" | "uploading" | "finalizing";
  chunksUploaded: number;
  totalChunks: number;
  bytesUploaded: number;
  totalBytes: number;
}

export interface UploadOptions {
  metadata?: Record<string, string>;
  onProgress?: (progress: UploadProgress) => void;
}

/** Result returned from dStorage.upload() */
export interface UploadResult {
  /**
   * The primary on-chain reference ID.
   * Use this to retrieve or share the stored data.
   */
  chainRefId: string;
  /** The storage network content ID */
  storageId: string;
  /** Storage provider used */
  storageProvider: StorageProviderName;
  /** Chain provider used */
  chainProvider: ChainProviderName;
  /** Timestamp */
  uploadedAt: number;
  /** Estimated cost of upload */
  costEstimate: CostEstimate;
}

/** Result returned from dStorage.retrieve() */
export interface RetrieveResult {
  /** The decrypted content as a UTF-8 string */
  content: string;
  /** The raw decrypted bytes */
  bytes: Uint8Array;
  /** Metadata attached at upload time */
  metadata: Record<string, string>;
}
