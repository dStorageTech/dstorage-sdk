/**
 * @dstorage/storage — types.ts
 * Core interface every storage adapter must implement.
 * This is the plugin contract.
 */

/**
 * Minimal logger interface accepted by every SDK class.
 * Compatible with `console` — pass `logger: console` for zero-boilerplate logging.
 * Omit the field entirely to suppress all SDK output.
 */
export interface Logger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

/** Identifies which storage network an adapter represents. */
export type StorageProviderName = "mock" | "arweave" | "autonomi";

/** Metadata returned after a successful upload. */
export interface UploadResult {
  /** Unique content identifier on the storage network */
  id: string;
  /** Human-readable name of the network used */
  provider: StorageProviderName;
  /** Approximate cost in the provider's native token (informational) */
  cost?: string;
  /** URL to view the stored content directly (if available) */
  url?: string;
  /** Timestamp of the upload */
  uploadedAt: number;
}

/** Every storage adapter must implement this interface. */
export interface StorageAdapter {
  readonly name: StorageProviderName;
  readonly providerName: string;

  /**
   * Upload bytes to the storage network.
   * Storage adapters do not encrypt data. If the caller chose private storage, `data`
   * must already be encrypted before calling this function. If the caller chose
   * public storage, `data` is expected to be plaintext/unencrypted. The SDK provides
   * the @dstorage/crypto package and public APIs for performing encryption before upload.
   * @returns UploadResult containing the content ID needed to retrieve later
   */
  upload(
    data: Uint8Array,
    metadata?: Record<string, string>,
  ): Promise<UploadResult>;

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
   * Estimate the cost of storing the given data (optional — adapters can throw).
   * @returns Approximate cost in the provider's native token units
   */
  estimateCost?(data: Uint8Array): Promise<string>;
}
