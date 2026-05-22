/**
 * @dstorage/storage — types.ts
 * Core interface every storage adapter must implement.
 * This is the plugin contract.
 */

import type { PaymentAdapter, TokenSymbol } from "@dstorage/payment";
import type { MinimalLogger } from "@dstorage/crypto";

/**
 * Minimal logger interface accepted by every SDK class.
 * Compatible with `console` — pass `logger: console` for zero-boilerplate logging.
 * Omit the field entirely to suppress all SDK output.
 */
export type StorageAdapterLogger = MinimalLogger;

/** Identifies which storage network an adapter represents. */
export type StorageProviderName =
  | "mock"
  | "arweave"
  | "arweave_bundler"
  | "lumera";

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

/** Optional parameters accepted by StorageAdapter.retrieve(). */
export interface RetrieveOptions {
  /**
   * Chain-anchored BLAKE3 hash (hex) to verify retrieved bytes against.
   * Adapters that support it MUST verify against this value instead of
   * relying solely on gateway-supplied metadata (e.g. a hash tag returned
   * in the same response as the data) — that anchor is expected to come
   * from an independent, tamper-evident source such as the on-chain
   * ChainReference.contentHash, not from the storage gateway itself.
   */
  expectedContentHash?: string;
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
   * Store bytes on the storage network.
   * Storage adapters do not encrypt data. If the caller chose private storage, `data`
   * must already be encrypted before calling this function. If the caller chose
   * public storage, `data` is expected to be plaintext/unencrypted. The SDK provides
   * the @dstorage/crypto package and public APIs for performing encryption before storing.
   * @returns StorageUploadResult containing the content ID needed to retrieve later
   */
  store(
    data: Uint8Array,
    metadata?: Record<string, string>,
  ): Promise<StorageUploadResult>;

  /**
   * Retrieve bytes by the content ID returned from store().
   * Storage adapters do not decrypt data. If encrypted bytes were stored, this returns
   * those encrypted bytes as-is. If plaintext bytes were stored, this returns
   * plaintext bytes as-is. Callers are responsible for decryption when needed and can
   * use the @dstorage/crypto package or public APIs for that purpose.
   *
   * When `options.expectedContentHash` is supplied, adapters that verify content
   * integrity MUST check retrieved bytes against that anchor rather than trusting
   * gateway-supplied metadata alone — a gateway that controls both the bytes and its
   * own integrity tag can otherwise fabricate an internally-consistent pair. Without
   * an anchor, adapters fall back to whatever gateway-native check they support,
   * which only catches non-adversarial corruption, not a fully malicious gateway.
   *
   * @returns The exact bytes stored by store(), plus any unencrypted tags attached at store time
   */
  retrieve(
    id: string,
    options?: RetrieveOptions,
  ): Promise<{ bytes: Uint8Array; tags: Record<string, string> }>;

  /**
   * Estimate the cost of storing the given data.
   * @returns A StorageQuote containing the cost in the provider's native token
   */
  estimateCost(dataSizeBytes: number): Promise<StorageQuote>;
}
