/**
 * @dstorage/storage — types.ts
 * Core interface every storage adapter must implement.
 * This is the plugin contract — swap Arweave for Autonomi by changing one line.
 */

/** Identifies which storage network an adapter represents. */
export type StorageProviderName = 'mock' | 'arweave' | 'autonomi';

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
  /** Unix timestamp of the upload */
  uploadedAt: number;
}

/** Every storage adapter must implement this interface. */
export interface StorageAdapter {
  readonly name: StorageProviderName;

  /**
   * Upload raw bytes to the storage network.
   * The data passed here is already encrypted — the adapter never sees plaintext.
   * @returns UploadResult containing the content ID needed to retrieve later
   */
  upload(data: string, metadata?: Record<string, string>): Promise<UploadResult>;

  /**
   * Retrieve raw bytes by the content ID returned from upload().
   * @returns The original encrypted bytes — decryption happens in the core layer
   */
  retrieve(id: string): Promise<string>;

  /**
   * Estimate the cost of storing the given data (optional — adapters can throw).
   * @returns Human-readable cost string e.g. "0.0012 AR"
   */
  estimateCost?(data: string): Promise<string>;
}
