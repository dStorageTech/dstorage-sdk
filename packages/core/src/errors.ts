import { DStorageError } from "@dstorage/crypto";
import type { StoreRecovery } from "./types.js";

export const CoreErrorCode = {
  // store — 10001-10009
  METADATA_WITH_PUBLIC_UPLOAD: 10001,
  UPLOAD_NO_PROVIDERS: 10002,
  PUBLIC_UPLOAD_REQUIRES_SEED_PROVIDER: 10003,
  CHAIN_WRITE_FAILED: 10004,
  STORAGE_WRITE_ALL_FAILED: 10005,
  CHAIN_WRITE_ALL_FAILED: 10006,

  // registerReference — 10010-10019
  REGISTER_REF_REQUIRES_CHAIN: 10010,
  REGISTER_REF_REQUIRES_ENCRYPTION: 10011,

  // update — 10020-10022
  UPDATE_UPLOAD_REQUIRES_CHAIN: 10020,
  UPDATE_UPLOAD_NOT_SUPPORTED: 10021,
  UPDATE_UPLOAD_REQUIRES_ENCRYPTION: 10022,

  // rotateKeys — 10023-10025
  ROTATE_KEYS_REQUIRES_CHAIN: 10023,
  ROTATE_KEYS_NOT_SUPPORTED: 10024,
  ROTATE_KEYS_REQUIRES_ENCRYPTION: 10025,

  // decrypt / unwrap DEK — 10030-10049
  DECRYPT_NO_PROVIDERS: 10030,
  DECRYPT_ENVELOPE_EMPTY: 10031,
  DECRYPT_ENVELOPE_MALFORMED: 10032,
  DECRYPT_NO_WRAPPER_MATCHED: 10033,
  UNWRAP_DEK_NO_PROVIDERS: 10034,
  UNWRAP_DEK_ENVELOPE_EMPTY: 10035,
  UNWRAP_DEK_ENVELOPE_MALFORMED: 10036,
  UNWRAP_DEK_NO_WRAPPER_MATCHED: 10037,
  DECRYPT_PAYLOAD_FAILED: 10038,

  // retrieveByRefId — 10050-10059
  RETRIEVE_BY_REF_ID_REQUIRES_CHAIN: 10050,
  REF_NOT_FOUND: 10051,
  // 10052 retired (was STORAGE_ADAPTER_MISMATCH) — retrieval now tries every
  // configured storage adapter in order instead of hard-failing on a mismatch.
  RETRIEVE_BY_REF_ID_ENVELOPE_EMPTY: 10053,
  CONTENT_HASH_MISMATCH: 10054,
  METADATA_PARSE_FAILED: 10055,
  STORAGE_READ_ALL_FAILED: 10056,
  CHAIN_READ_ALL_FAILED: 10057,

  // listReferences — 10060-10069
  LIST_REFS_REQUIRES_CHAIN: 10060,
  LIST_REFS_NOT_SUPPORTED: 10061,
  LIST_REFS_ALL_FAILED: 10062,

  // removeReference — 10070-10079
  REMOVE_REF_REQUIRES_CHAIN: 10070,
  REMOVE_REF_NOT_SUPPORTED: 10071,

  // manifest / chunking — 10090-10099
  MANIFEST_INVALID_STRUCTURE: 10090,
  MANIFEST_CHUNK_COUNT_MISMATCH: 10091,
  MANIFEST_NOT_CONTIGUOUS: 10092,
  DECRYPT_CHUNK_FAILED: 10093,
  CHUNK_OVERFLOWS_TOTAL_SIZE: 10094,
  REASSEMBLY_SIZE_MISMATCH: 10095,
  MANIFEST_PARSE_FAILED: 10096,

  // init state — 10100-10109
  NOT_INITIALIZED: 10100,

  // config validation — 10110-10119
  CONFIG_STORAGE_ADAPTERS_EMPTY: 10110,

  // init() — 10120-10129
  INIT_CHAIN_ALL_FAILED: 10120,

  // generic catch-all — 10999
  UNKNOWN_ERROR: 10999,
} as const;

export type CoreErrorCode = (typeof CoreErrorCode)[keyof typeof CoreErrorCode];

/**
 * One configured adapter's failed attempt, collected when every candidate in
 * a `storageAdapters`/`chainAdapters` fallback list fails and the SDK
 * synthesizes an aggregate "all adapters failed" error.
 */
export interface AdapterFailure {
  adapterName: string;
  error: unknown;
}

/**
 * Thrown when `store()` succeeds at the storage layer but fails to write the
 * on-chain reference. The content is permanently on the storage network — use
 * `err.recovery` with `registerReference()` to retry only the chain write.
 *
 * `.cause` is either the raw error thrown by the single configured chain
 * adapter (when only one is configured), or a `DStorageError` with code
 * `CHAIN_WRITE_ALL_FAILED` whose own `.cause` is an `AdapterFailure[]` — one
 * entry per configured chain adapter that was tried (when two or more are
 * configured and all of them failed).
 */
export class StorePartialError extends DStorageError {
  readonly recovery: StoreRecovery;

  constructor(recovery: StoreRecovery, cause?: unknown) {
    const causeMsg =
      cause !== undefined
        ? `: ${cause instanceof Error ? cause.message : String(cause)}`
        : "";
    super(
      CoreErrorCode.CHAIN_WRITE_FAILED,
      `[dStorage] Content stored (storageId: ${recovery.storageId}) but the on-chain reference write failed${causeMsg}. ` +
        `Use err.recovery with registerReference() to retry without re-uploading.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "StorePartialError";
    this.recovery = recovery;
  }
}

export function isStorePartialError(err: unknown): err is StorePartialError {
  return err instanceof StorePartialError;
}
