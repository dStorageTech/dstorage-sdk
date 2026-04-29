/**
 * @dstorage/storage — types.ts
 * Core interface every storage adapter must implement.
 * This is the plugin contract.
 */

import type { PaymentAdapter, TokenSymbol } from "@dstorage/payment";

/**
 * Minimal logger interface accepted by every SDK class.
 * Compatible with `console` — pass `logger: console` for zero-boilerplate logging.
 * Omit the field entirely to suppress all SDK output.
 */
export interface StorageAdapterLogger {
  log(component: string, msg: string): void;
  warn(component: string, msg: string): void;
  error(component: string, msg: string): void;
  debug?(component: string, msg: string): void;
}

/** Identifies which storage network an adapter represents. */
export type StorageProviderName =
  | "mock"
  | "arweave"
  | "autonomi"
  | "arweave_turbo";

/**
 * A cost quote returned by StorageAdapter.estimateCost().
 *
 * Quotes have a limited validity window. Real adapters may tighten
 * this window based on network fee volatility.
 */
export interface StorageQuote {
  /** Token this quote is denominated in */
  token: TokenSymbol;
  /** Amount in the provider's native token units (string to preserve precision) */
  amount: string;
  /** The storage provider this quote is for */
  provider: StorageProviderName;
  /** File size used to derive this quote */
  dataSizeBytes: number;
  /** Timestamp after which this quote should be refreshed */
  expiresAt: number;
}

/** Metadata returned after a successful upload. */
export interface StorageUploadResult {
  /** Unique content identifier on the storage network */
  id: string;
  /** Human-readable name of the network used */
  provider: StorageProviderName;
  /** Approximate cost for this upload (informational) */
  cost?: StorageQuote;
  /** URL to view the stored content directly (if available) */
  url?: string;
  /** Timestamp of the upload */
  uploadedAt: number;
}

/** Every storage adapter must implement this interface. */
export interface StorageAdapter {
  readonly name: StorageProviderName;
  readonly providerName: string;
  /** Payment adapter responsible for paying storage network fees for this adapter. */
  readonly paymentAdapter: PaymentAdapter;

  /**
   * Upload bytes to the storage network.
   * Storage adapters do not encrypt data. If the caller chose private storage, `data`
   * must already be encrypted before calling this function. If the caller chose
   * public storage, `data` is expected to be plaintext/unencrypted. The SDK provides
   * the @dstorage/crypto package and public APIs for performing encryption before upload.
   * @returns StorageUploadResult containing the content ID needed to retrieve later
   */
  upload(
    data: Uint8Array,
    metadata?: Record<string, string>,
  ): Promise<StorageUploadResult>;

  /**
   * Retrieve bytes by the content ID returned from upload().
   * Storage adapters do not decrypt data. If encrypted bytes were stored, this returns
   * those encrypted bytes as-is. If plaintext bytes were stored, this returns
   * plaintext bytes as-is. Callers are responsible for decryption when needed and can
   * use the @dstorage/crypto package or public APIs for that purpose.
   * @returns The exact bytes stored by upload()
   */
  retrieve(id: string): Promise<Uint8Array>;

  /**
   * Estimate the cost of storing the given data.
   * @returns A StorageQuote containing the cost in the provider's native token
   */
  estimateCost(dataSizeBytes: number): Promise<StorageQuote>;
}
