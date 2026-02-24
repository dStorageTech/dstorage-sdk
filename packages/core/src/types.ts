/**
 * @dstorage/core — types.ts
 * Top-level types for the dStorage SDK public API.
 */

import type { StorageAdapter, StorageProviderName } from '@dstorage/storage';
import type { ChainAdapter, ChainProviderName } from '@dstorage/chain';
import type { PaymentAdapter } from '@dstorage/payment';

/** Wallet connection info returned after connecting */
export interface WalletInfo {
  address: string;
  chainProvider: ChainProviderName;
  /** The raw signature used to derive the encryption key (kept in memory only) */
  _signatureHex: string;
}

/** Configuration passed to dStorage.init() */
export interface DStorageConfig {
  /** Storage adapter to use (MockStorageAdapter | ArweaveStorageAdapter | ...) */
  storageAdapter: StorageAdapter;
  /** Chain adapter to use (MockChainAdapter | MidnightChainAdapter | ...) */
  chainAdapter: ChainAdapter;
  /**
   * Payment adapter for storage network fees (AR, ANT, or MOCK).
   * Defaults to MockPaymentAdapter with the token matching the storageAdapter.
   */
  storagePaymentAdapter?: PaymentAdapter;
  /**
   * Payment adapter for blockchain transaction fees (DUST, ETH, or MOCK).
   * Defaults to MockPaymentAdapter with the token matching the chainAdapter.
   */
  chainPaymentAdapter?: PaymentAdapter;
  /** Optional label for the type of data being stored */
  defaultDataLabel?: string;
}

/** Result returned from dStorage.upload() */
export interface UploadResult {
  /**
   * The dStorage dataId — pass this to retrieve() or grant().
   * Format: "<storageId>::<chainRefId>"
   */
  dataId: string;
  /** The storage network content ID */
  storageId: string;
  /** The on-chain reference ID */
  chainRefId: string;
  /** Storage provider used */
  storageProvider: StorageProviderName;
  /** Chain provider used */
  chainProvider: ChainProviderName;
  /** Timestamp */
  uploadedAt: number;
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
