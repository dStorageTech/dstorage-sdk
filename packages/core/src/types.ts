/**
 * @dstorage/core — types.ts
 * Top-level types for the dStorage SDK public API.
 */

import type { StorageAdapter, StorageProviderName } from "@dstorage/storage";
import type { ChainAdapter, ChainProviderName } from "@dstorage/chain";
import type { TokenSymbol } from "@dstorage/payment";
import type { EncryptionAdapter } from "./index.js";

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
}

/** Configuration passed to dStorage constructor */
export interface DStorageConfig {
  /** Storage adapter to use (MockStorageAdapter | ArweaveStorageAdapter | ...) */
  storageAdapter: StorageAdapter;
  /** Chain adapter to use (MockChainAdapter | MidnightChainAdapter | ...) */
  chainAdapter: ChainAdapter;
  /**
   * Encryption adapters that wrap and unwrap per-upload Data Encryption Keys (DEKs).
   * Each adapter produces an independent wrapped DEK; any of them can independently decrypt.
   *
   * Choose the adapter(s) preferred by the user:
   *   PasswordEncryptionAdapter  — scrypt-derived from a user password + salt
   *   MnemonicEncryptionAdapter  — BIP-39 mnemonic or hex seed (Node.js / facade mode)
   *   MLKemEncryptionAdapter     — post-quantum asymmetric (ML-KEM keypair)
   *
   * When omitted or empty, no encryption key is available and all uploaded data
   * will be stored as plaintext (public).
   *
   * @example
   * // Single adapter (most common)
   * encryptionAdapters: [new PasswordEncryptionAdapter({ password, salt })]
   *
   * @example
   * // Two adapters — data accessible by either password or mnemonic
   * encryptionAdapters: [
   *   new PasswordEncryptionAdapter({ password, salt }),
   *   new MnemonicEncryptionAdapter({ mnemonic }),
   * ]
   */
  encryptionAdapters?: EncryptionAdapter[];
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
  /** When true, content is stored unencrypted and the storageId is written on-chain as plaintext. */
  isPublic?: boolean;
}

/**
 * Aggregated cost estimate for a complete upload operation.
 * Built from two quotes — one from the storage adapter and one from the chain adapter.
 */
export interface CostEstimate {
  storageCost: {
    amount: string;
    token: TokenSymbol;
  };
  chainCost: {
    amount: string;
    token: TokenSymbol;
  };
  /** File size in bytes */
  fileSizeBytes: number;
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
  /**
   * Encryption algorithm used for the stored data and on-chain storageId.
   * "xchacha20poly1305-v1" for private (encrypted) uploads.
   * Empty string ("") for public (unencrypted) uploads.
   */
  encryptionScheme: string;
  /** Estimated cost of upload */
  costEstimate: CostEstimate;
}

/** Result returned from dStorage.retrieve() */
export interface RetrieveResult {
  /** The raw decrypted bytes */
  bytes: Uint8Array;
  /** Metadata attached at upload time */
  metadata: Record<string, string>;
}
