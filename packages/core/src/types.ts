/**
 * @dstorage/core — types.ts
 * Top-level types for the dStorage SDK public API.
 */

import type { StorageAdapter, StorageProviderName } from "@dstorage/storage";
import type { ChainAdapter, ChainProviderName } from "@dstorage/chain";
import type { TokenSymbol } from "@dstorage/payment";
import type { CryptoScheme } from "@dstorage/crypto";
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
  /**
   * Chain adapter to use (MockChainAdapter | MidnightChainAdapter | ...).
   * When omitted the SDK operates in storage-only mode — uploads store to the
   * storage backend but no on-chain reference is written.
   */
  chainAdapter?: ChainAdapter;
  /**
   * Encryption adapters that wrap and unwrap per-upload Data Encryption Keys (DEKs).
   * Each adapter produces an independent wrapped DEK; any of them can independently decrypt.
   *
   * Choose the adapter(s) preferred by the user:
   *   PasswordEncryptionAdapter  — scrypt-derived from a user password + salt
   *   MnemonicEncryptionAdapter  — BIP-39 mnemonic or hex seed (Node.js / facade mode)
   *   KeypairEncryptionAdapter   — post-quantum asymmetric (ML-KEM keypair)
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
  /**
   * Optional key/value tags attached to the on-chain reference.
   *
   * The `"label"` key is written as `dataLabel` on-chain and is **publicly readable**
   * by anyone querying the DataRegistry — do not use it for names, email addresses,
   * medical categories, or anything that could identify a person or reveal what the
   * encrypted content contains.
   */
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
  /** Chain cost. Undefined when no chain adapter is configured. */
  chainCost?: {
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
   * Undefined when no chain adapter is configured (storage-only mode).
   */
  chainRefId?: string;
  /** The storage network content ID */
  storageId: string;
  /** Storage provider used */
  storageProvider: StorageProviderName;
  /** Chain provider used. Undefined when no chain adapter is configured. */
  chainProvider?: ChainProviderName;
  /** Timestamp */
  uploadedAt: number;
  /**
   * Encryption algorithm used for the stored data and on-chain storageId.
   * "xchacha20poly1305-v1" for private (encrypted) uploads.
   * Empty string ("") for public (unencrypted) uploads.
   */
  encryptionScheme: string;
  /**
   * Decryption scheme for the uploaded content.
   * Present only for private uploads in storage-only mode (no chainAdapter).
   * In chain mode the scheme is recoverable from the on-chain key envelope instead.
   * Pass this back to retrieveByStorageId() to decrypt locally.
   */
  cryptoScheme?: CryptoScheme;
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

// ── Protocol-level AAD constants ──────────────────────────────────────────────
// These live in core (not @dstorage/crypto) because they are SDK protocol
// semantics, not crypto primitives. The crypto layer accepts any Uint8Array;
// core defines what values belong in each role.

const _aadEnc = new TextEncoder();

/** AAD for single-shot payload encryption (non-chunked user content). */
export const PAYLOAD_AAD: Uint8Array = _aadEnc.encode("dstorage:payload:v1");

/**
 * AAD for chunked manifest encryption.
 * Using a distinct label from PAYLOAD_AAD means a ciphertext produced for a
 * manifest cannot decrypt successfully under PAYLOAD_AAD and vice versa —
 * manifest detection is cryptographic, not based on JSON shape inspection.
 */
export const MANIFEST_AAD: Uint8Array = _aadEnc.encode("dstorage:manifest:v1");

/**
 * Per-chunk AAD that binds a ciphertext to its position in a chunked upload.
 * A malicious gateway swapping two chunks will produce an AEAD auth failure
 * because the stored AAD won't match the expected index.
 */
export const chunkAad = (index: number, total: number): Uint8Array =>
  _aadEnc.encode(`dstorage:chunk:v1:${index}/${total}`);
