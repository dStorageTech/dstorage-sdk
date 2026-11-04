/**
 * @dstorage/core — types.ts
 * Top-level types for the dStorage SDK public API.
 */

import type { StorageAdapter, StorageProviderName } from "@dstorage/storage";
import type {
  ChainAdapter,
  ChainProviderName,
  DataReferenceSummary,
} from "@dstorage/chain";
import type { TokenSymbol } from "@dstorage/payment";
import type { CryptoScheme } from "@dstorage/crypto";
import type { EncryptionAdapter } from "@dstorage/encryption";
import type { MinimalLogger } from "@dstorage/crypto";

/**
 * Minimal logger interface accepted by every SDK class.
 * Compatible with `console` — pass `logger: console` for zero-boilerplate logging.
 * Omit the field entirely to suppress all SDK output.
 */
export type Logger = MinimalLogger;

/** Wallet connection info returned after connecting */
export interface WalletInfo {
  address: string;
  chainProvider: ChainProviderName;
  /** The raw signature (or PBKDF2 seed) used to derive the encryption key (kept in memory only) */
  _signatureHex: string;
}

/** Configuration passed to dStorage constructor */
export interface DStorageConfig {
  /**
   * Storage adapters to use, in priority order (MockStorageAdapter | ArweaveStorageAdapter | ...).
   * Must contain at least one. Reads try each configured adapter in order,
   * falling back to the next on failure, succeeding on the first that
   * retrieves the content. Writes try each in order, falling back on
   * failure, succeeding as soon as one adapter's write succeeds.
   *
   * @example
   * // Single adapter (most common)
   * storageAdapters: [new ArweaveStorageAdapter({ ... })]
   *
   * @example
   * // Fall back to a mirror if the primary gateway is unreachable
   * storageAdapters: [primaryArweaveAdapter, mirrorArweaveAdapter]
   */
  storageAdapters: StorageAdapter[];
  /**
   * Chain adapters to use, in priority order (MockChainAdapter | MidnightChainAdapter | ...).
   * When omitted or empty the SDK operates in storage-only mode — uploads
   * store to the storage backend but no on-chain reference is written.
   * Same try-in-order fallback semantics as `storageAdapters` for reads and
   * writes. `listReferences()` is the exception — it aggregates results from
   * every configured chain adapter rather than stopping at the first success,
   * since references may legitimately live on more than one configured chain.
   */
  chainAdapters?: ChainAdapter[];
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
  /**
   * Overrides how `storageAdapters` are used, per operation and outcome.
   * Omit to keep the default: try in order, stop at the first success.
   * Returning `"continue"` from `onSuccess` on a write stores further copies,
   * which `retrieveByRefId()` falls back to automatically.
   *
   * @example
   * // Store on every adapter and require at least two copies
   * storagePolicy: {
   *   onSuccess: () => "continue",
   *   onComplete: ({ successes }) => (successes.length >= 2 ? "accept" : "fail"),
   * }
   */
  storagePolicy?: StoragePolicy;
  /**
   * Overrides how `chainAdapters` are used, per operation and outcome.
   * A reference always lives on one chain, so `onSuccess` only runs for the
   * `"init"` operation, where `"continue"` initializes the remaining adapters.
   *
   * @example
   * // Retry a failed read once, then fall back
   * chainPolicy: {
   *   onFailure: ({ operation, attempt }) =>
   *     operation === "read" && attempt === 1
   *       ? { action: "retry", delayMs: 500 }
   *       : "next",
   * }
   */
  chainPolicy?: ChainPolicy;
}

// ── Adapter policies ──────────────────────────────────────────────────────────

export type AdapterKind = "storage" | "chain";

export type StorageOperation =
  | "store"
  | "storeChunked"
  | "update"
  | "retrieve"
  | "retrieveChunk"
  | "estimateCost";

export type ChainOperation =
  | "init"
  | "store"
  | "registerReference"
  | "read"
  | "update"
  | "retryUpdate"
  | "rotateKeys"
  | "remove"
  | "list"
  | "estimateCost";

/**
 * Identifies a configured adapter to a policy hook. Hooks get this rather than
 * the instance because adapters can hold payment credentials.
 * `index` is the only reliable identity: names aren't unique per instance.
 */
export interface AdapterInfo {
  readonly index: number;
  readonly name: string;
  readonly providerName: string;
}

/** Which copy of the content a `retrieve` attempt is reading. */
export type ReplicaLocationRef =
  | { readonly kind: "primary" }
  | {
      readonly kind: "replica";
      readonly replicaIndex: number;
      readonly provider: string;
    };

export interface AdapterCandidate {
  readonly adapter: AdapterInfo;
  readonly location?: ReplicaLocationRef;
}

/** A successful attempt. Never includes content bytes or key envelopes. */
export interface PolicySuccess {
  readonly adapter: AdapterInfo;
  readonly attempt: number;
  readonly location?: ReplicaLocationRef;
  readonly storageId?: string;
  readonly provider?: string;
  readonly refId?: string;
}

export interface PolicyFailure {
  readonly adapter: AdapterInfo;
  readonly attempt: number;
  readonly location?: ReplicaLocationRef;
  readonly error: unknown;
}

interface PolicyContextBase<K extends AdapterKind, O extends string> {
  readonly kind: K;
  readonly operation: O;
}

export interface PolicyOrderContext<
  K extends AdapterKind,
  O extends string,
> extends PolicyContextBase<K, O> {
  readonly candidates: readonly AdapterCandidate[];
}

export interface PolicySuccessContext<K extends AdapterKind, O extends string>
  extends PolicyContextBase<K, O>, AdapterCandidate {
  /** 1-based attempt number on this adapter. */
  readonly attempt: number;
  /** Every success so far in this operation, including this one. */
  readonly successes: readonly PolicySuccess[];
  readonly failures: readonly PolicyFailure[];
}

export interface PolicyFailureContext<
  K extends AdapterKind,
  O extends string,
> extends PolicySuccessContext<K, O> {
  /** Unfiltered adapter error. May contain endpoint URLs or other adapter details. */
  readonly error: unknown;
}

export interface PolicyCompleteContext<
  K extends AdapterKind,
  O extends string,
> extends PolicyContextBase<K, O> {
  readonly successes: readonly PolicySuccess[];
  readonly failures: readonly PolicyFailure[];
}

export type PolicyFailureDecision =
  "next" | "abort" | { action: "retry"; delayMs?: number };

type MaybePromise<T> = T | Promise<T>;

/**
 * Decision hooks for one adapter type. Every hook is optional, and omitting one
 * keeps the default for that decision. Hooks can run concurrently, and throwing
 * from one ends the operation with `ADAPTER_POLICY_HOOK_FAILED`.
 *
 * Retrying isn't free: a retried write can pay twice, a chunked retry restarts
 * from chunk 0, and a chain write that timed out may still have landed.
 */
export interface AdapterPolicy<K extends AdapterKind, O extends string> {
  /**
   * Reorder or filter candidates. Must return a non-empty subset of the objects
   * in `ctx.candidates`. Not called for operations pinned to one adapter.
   * Filtering `"read"` also affects update/remove/rotate, which use it to find
   * the adapter holding a reference.
   */
  order?(
    ctx: PolicyOrderContext<K, O>,
  ): MaybePromise<readonly AdapterCandidate[]>;
  /**
   * Default `"stop"`. Only runs where `"continue"` can apply: storage writes
   * (`store`, `storeChunked`, `update`) and chain `init`. Use `onComplete` to
   * observe other operations.
   */
  onSuccess?(
    ctx: PolicySuccessContext<K, O>,
  ): MaybePromise<"stop" | "continue">;
  /**
   * Default `"next"`, except `estimateCost`, which stops at the first failure.
   * Retries are limited to 32 attempts per candidate. `"abort"` is invalid for
   * chain `list`, whose calls run in parallel.
   */
  onFailure?(
    ctx: PolicyFailureContext<K, O>,
  ): MaybePromise<PolicyFailureDecision>;
  /**
   * Runs once when the operation finishes naturally, not after an abort or a
   * hook error. `"fail"` throws `ADAPTER_POLICY_REJECTED`. If nothing succeeded,
   * the usual adapter error is thrown whichever value is returned.
   */
  onComplete?(
    ctx: PolicyCompleteContext<K, O>,
  ): MaybePromise<"accept" | "fail">;
}

export type StoragePolicy = AdapterPolicy<"storage", StorageOperation>;
export type ChainPolicy = AdapterPolicy<"chain", ChainOperation>;

// ── Storage replicas ──────────────────────────────────────────────────────────

/** An extra copy of the content, recorded with the on-chain reference. */
export interface ReplicaLocation {
  /** `name` of the storage adapter that holds this copy. */
  provider: string;
  /** Storage network ID of this copy. */
  id: string;
  /**
   * BLAKE3 hash of this copy, hex-encoded. Only set when it differs from the
   * on-chain `contentHash`, as with chunked uploads, where each copy has its
   * own manifest.
   */
  contentHash?: string;
}

/** A `ReplicaLocation` as reported after a write, with its cost. */
export interface StoredReplica extends ReplicaLocation {
  cost?: { amount: string; token: TokenSymbol };
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
  /**
   * Extra copies stored by a `storagePolicy`. Pass to `registerReference()`
   * (`retryUpdate()` reads it from here), or the reference won't record them.
   */
  replicas?: ReplicaLocation[];
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
  /**
   * Zero-based count of whole-upload attempts so far. Only set for chunked
   * uploads (>10 MB): if an attempt fails partway through, the whole upload
   * restarts from scratch, so `chunksUploaded`/`bytesUploaded` will visibly
   * rewind to 0 — a bump in `attemptIndex` distinguishes that rewind from data
   * corruption. Matches the adapter's position only when no `storagePolicy`
   * changes the order or retries.
   */
  attemptIndex?: number;
  /** Chunked uploads with a `storagePolicy`: position of the adapter being written. */
  adapterIndex?: number;
  /** Chunked uploads with a `storagePolicy`: copies completed before this attempt. */
  copyIndex?: number;
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
  /**
   * Optional caller-supplied reference ID, forwarded to the chain adapter as
   * {@link ChainReference.refId}. Adapters that control their own ID generation
   * (e.g. mock, HTTP gateway) use this as the stored and returned identifier.
   * Adapters where the on-chain protocol determines the ID (e.g. Midnight)
   * ignore this field — the chain-assigned ID is returned instead.
   */
  refId?: string;
}

/** Options for dStorage.update() */
export interface UpdateOptions {
  /**
   * Unencrypted key/value tags forwarded to the storage layer (e.g. Arweave tx tags).
   * Never written on-chain.
   */
  tags?: Record<string, string>;
  /**
   * Encrypted key/value metadata stored on-chain alongside the key envelope.
   * Encrypted with the content DEK — only holders of a valid KEK can read it.
   * Returned in `RetrieveResult.metadata` after decryption.
   */
  metadata?: Record<string, string>;
  onProgress?: (progress: StoreProgress) => void;
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
  /**
   * Estimated cost of the store operation. Covers the primary copy only; see
   * `replicas` for the cost of each extra copy.
   */
  costEstimate: CostEstimate;
  /**
   * Extra copies written because `storagePolicy.onSuccess` returned `"continue"`.
   * `storageId` remains the primary copy. Absent when there are none.
   */
  replicas?: StoredReplica[];
}

/** Options for dStorage.listReferences() */
export interface ListReferencesOptions {
  /** When provided, only references whose refId appears in this array are returned. */
  refIds?: string[];
}

/**
 * A `DataReferenceSummary` returned by `dStorage.listReferences()`, tagged
 * with which configured chain adapter it came from.
 */
export type ListedDataReference = DataReferenceSummary & {
  /**
   * Zero-based index into the configured `chainAdapters` array identifying
   * which chain adapter this reference was retrieved from. Only populated by
   * the no-filter (aggregate) path of `listReferences()` when multiple chain
   * adapters are configured — `ChainAdapter.name`/`.providerName` are not
   * guaranteed unique per instance (e.g. two Midnight configs pointed at
   * different networks both report `"midnight"`), so the index is the only
   * reliable way to disambiguate which chain a result came from.
   */
  sourceAdapterIndex?: number;
  /** Extra copies recorded with this reference, when the caller can read them. */
  replicas?: ReplicaLocation[];
};

/** Options for dStorage.registerReference() */
export interface RegisterReferenceOptions {
  /** The pre-existing storage network ID to register. Omit for metadata-only references. */
  storageId?: string;
  /**
   * Storage provider name recorded in the chain reference.
   * Defaults to the first configured `storageAdapters[0].name`. This is
   * informational metadata only — retrieval tries every configured storage
   * adapter in order regardless of this value, so pass it explicitly only
   * when you want the on-chain record to reflect a specific adapter.
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
  /**
   * Recovery: `replicas` from `StorePartialError.recovery`, so the new reference
   * records the extra copies. Requires `storageId` and `keyEnvelope`.
   */
  replicas?: ReplicaLocation[];
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
  /** Extra copies of the new content. Absent when there are none. */
  replicas?: StoredReplica[];
}

/** Result returned from dStorage.retrieveByRefId() / retrieveByStorageId() */
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

/** AAD for the encrypted list of extra copies stored in the on-chain storageId. */
export const REPLICAS_AAD: Uint8Array = _aadEnc.encode("dstorage:replicas:v1");

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
