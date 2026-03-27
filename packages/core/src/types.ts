/**
 * @dstorage/core — types.ts
 * Top-level types for the dStorage SDK public API.
 */

import type { StorageAdapter, StorageProviderName } from "@dstorage/storage";
import type { ChainAdapter, ChainProviderName } from "@dstorage/chain";
import type { EncryptionSeedProvider } from "@dstorage/seed-providers";
import type { CostEstimate } from "./metaTx/payment.js";

export type { EncryptionSeedProvider };

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
   * Seed provider that supplies the raw bytes used to derive encryption keys.
   * When set, sdk.init() calls provider.getSeed() and sets up crypto automatically.
   *
   * Choose the provider that matches the wallet available in your environment:
   *   MetaMaskSeedProvider            — MetaMask / any EIP-1193 browser wallet
   *   MidnightConnectorSeedProvider   — Midnight Lace browser extension (v4+ signData)
   *   MnemonicSeedProvider            — BIP-39 mnemonic or hex seed (temporary, facade/Node.js only)
   *   DemoSeedProvider                — fixed deterministic seed for testing
   *
   * When omitted, no encryption key is available and all uploaded data will be
   * stored as plaintext (public).
   */
  encryptionSeedProvider?: EncryptionSeedProvider;
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
  /** When true, content is stored unencrypted and the storageId is written on-chain as plaintext. */
  isPublic?: boolean;
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
   * "aes-gcm-v1" for private (encrypted) uploads.
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
