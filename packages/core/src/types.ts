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

/**
 * Payload included in both `StorePartialError.recovery` and the `"stored"`
 * phase of `StoreProgress`. Contains enough information to retry a failed
 * chain write via `registerReference()` without re-uploading.
 *
 * `keyEnvelope` is the DEK encrypted under the user's KEK — safe to persist
 * (e.g. in localStorage or a database). It is `undefined` for public uploads
 * since their on-chain reference does not depend on a content DEK.
 */
export interface StoreRecovery {
  storageId: string;
  /** Storage provider that holds the content — required by registerReference(). */
  storageProvider: StorageProviderName;
  keyEnvelope: string | undefined;
  /**
   * BLAKE3 hash of the ciphertext bytes stored at `storageId`, hex-encoded (64 chars).
   * Pass to `registerReference()` to preserve the on-chain integrity check on the recovered reference.
   */
  contentHash?: string;
}

export interface StoreProgress {
  phase: "encrypting" | "uploading" | "stored" | "finalizing";
  chunksUploaded: number;
  totalChunks: number;
  bytesUploaded: number;
  totalBytes: number;
  /**
   * Present when `phase === "stored"`. Fired after the storage write succeeds
   * and before the chain write begins — persist this to recover from a partial
   * failure without re-uploading.
   */
  recovery?: StoreRecovery;
}

export interface StoreOptions {
  /**
   * Unencrypted key/value tags forwarded to the storage layer (e.g. Arweave tx tags).
   * Never written on-chain.
   */
  tags?: Record<string, string>;
  /**
   * Encrypted key/value metadata stored on-chain alongside the key envelope.
   * Encrypted with the content DEK — only holders of a valid KEK can read it.
   * Returned in `RetrieveResult.metadata` after decryption.
   * Not supported for public (`isPublic: true`) stores.
   */
  metadata?: Record<string, string>;
  onProgress?: (progress: StoreProgress) => void;
  /** When true, content is stored unencrypted and the storageId is written on-chain as plaintext. */
  isPublic?: boolean;
}

/**
 * Aggregated cost estimate for a complete store operation.
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

/** Result returned from dStorage.store() */
export interface StoreResult {
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
   * "xchacha20poly1305-v1" for private (encrypted) stores.
   * Empty string ("") for public (unencrypted) stores.
   */
  encryptionScheme: string;
  /**
   * Decryption scheme for the stored content.
   * Present only for private stores in storage-only mode (no chainAdapter).
   * In chain mode the scheme is recoverable from the on-chain key envelope instead.
   * Pass this back to retrieveByStorageId() to decrypt locally.
   */
  cryptoScheme?: CryptoScheme;
  /** Estimated cost of the store operation */
  costEstimate: CostEstimate;
}

/** Options for dStorage.listReferences() */
export interface ListReferencesOptions {
  /** When provided, only references whose refId appears in this array are returned. */
  refIds?: string[];
}

/** Options for dStorage.registerReference() */
export interface RegisterReferenceOptions {
  /** The pre-existing storage network ID to register. Omit for metadata-only references. */
  storageId?: string;
  /**
   * Storage provider name recorded in the chain reference.
   * Defaults to the configured `storageAdapter.name`.
   */
  storageProvider?: StorageProviderName;
  /**
   * Optional caller-supplied reference ID, forwarded to the chain adapter as
   * {@link ChainReference.refId}. Adapters that control their own ID generation
   * (e.g. mock, HTTP gateway) use this as the stored and returned identifier.
   * Adapters where the on-chain protocol determines the ID (e.g. Midnight)
   * ignore this field — the chain-assigned ID is returned instead.
   */
  refId?: string;
  /**
   * Encrypted key/value metadata stored on-chain alongside the key envelope.
   * Encrypted with the content DEK — only holders of a valid KEK can read it.
   * Returned in `RetrieveResult.metadata` after decryption via retrieveByRefId().
   */
  metadata?: Record<string, string>;
  /**
   * Recovery: the `keyEnvelope` from a `StorePartialError` (or from the
   * `"stored"` phase of `onProgress`). When provided, the DEK is unwrapped
   * from this envelope and used to encrypt the storageId and derive the
   * ownerSecret — producing a reference identical to what `store()` would have
   * written, without requiring a re-upload.
   */
  keyEnvelope?: string;
  /**
   * BLAKE3 hash of the ciphertext bytes at `storageId`, hex-encoded (64 chars).
   * When passed from `StorePartialError.recovery.contentHash`, this ensures the
   * recovered reference carries the same on-chain hash as a normal `store()` write.
   */
  contentHash?: string;
}

/** Result returned from dStorage.registerReference() */
export interface RegisterReferenceResult {
  /** The on-chain reference ID — use with retrieveByRefId(). */
  chainRefId: string;
}

/** Result returned from dStorage.update() */
export interface UpdateResult {
  /** Same refId as the input — updated in place. */
  chainRefId: string;
  /** StorageId of the newly stored content. */
  storageId: string;
}

/** Result returned from dStorage.retrieve() */
export interface RetrieveResult {
  /** The raw decrypted bytes */
  bytes: Uint8Array;
  /** Decrypted on-chain metadata (empty when none was provided at upload time or when retrieved without a chain reference) */
  metadata: Record<string, string>;
  /** Unencrypted tags attached to the storage-layer upload (e.g. Arweave tx tags) */
  tags: Record<string, string>;
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

/** AAD for encrypted on-chain metadata (stored in ChainReference.encryptedMetadata). */
export const METADATA_AAD: Uint8Array = _aadEnc.encode("dstorage:metadata:v1");

/**
 * HKDF salt for ownerSecret derivation in metadata-only references (no storageId).
 * Using a fixed non-empty sentinel avoids RFC 5869's empty-salt substitution
 * (which silently substitutes zeros(32)) and creates a clear domain boundary
 * from normal-upload ownerSecrets whose salt is the plaintext storageId.
 */
export const METADATA_ONLY_OWNER_SECRET_SALT: Uint8Array = _aadEnc.encode(
  "dstorage:metadata-only:v1",
);

/**
 * Per-chunk AAD that binds a ciphertext to its position in a chunked upload.
 * A malicious gateway swapping two chunks will produce an AEAD auth failure
 * because the stored AAD won't match the expected index.
 */
export const chunkAad = (index: number, total: number): Uint8Array =>
  _aadEnc.encode(`dstorage:chunk:v1:${index}/${total}`);
