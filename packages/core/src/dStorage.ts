/**
 * @dstorage/core — dStorage.ts
 *
 * The main SDK class. Orchestrates:
 *   1. Encryption adapter key wrapping (@dstorage/encryption + @dstorage/crypto)
 *   2. Client-side encryption         (@dstorage/crypto)
 *   3. Decentralised storage          (@dstorage/storage)
 *   4. On-chain reference writing     (@dstorage/chain)
 *
 * Developer API:
 *   const ds = new DStorage(config);
 *   await ds.init();
 *   const { chainRefId, storageId } = await ds.store(new TextEncoder().encode("hello"));
 *   const { bytes } = await ds.retrieveByRefId(chainRefId);
 *   await ds.listReferences();
 *   await ds.removeReference(chainRefId);
 */

import {
  XChaChaScheme,
  DStorageError,
  isDStorageError,
  computeBlake3Hex,
  assertValidLogger,
} from "@dstorage/crypto";
import {
  generateDek,
  buildKeyEnvelope,
  serializeKeyEnvelope,
  parseKeyEnvelope,
  deriveOwnerSecret,
  bytesToBase64url,
  base64urlToBytes,
} from "@dstorage/crypto";
import {
  CoreErrorCode,
  StorePartialError,
  isAdapterPolicyError,
} from "./errors.js";
import type { AdapterFailure } from "./errors.js";

import type { CryptoScheme, KeyEnvelope } from "@dstorage/crypto";
import type { StorageAdapter, StorageUploadResult } from "@dstorage/storage";
import type { ChainAdapter, ChainReference } from "@dstorage/chain";
import corePackageJson from "../package.json";

import type {
  AdapterCandidate,
  AdapterKind,
  CostEstimate,
  DStorageConfig,
  Logger,
  ListedDataReference,
  ListReferencesOptions,
  RegisterReferenceOptions,
  RegisterReferenceResult,
  PolicySuccess,
  ReplicaLocation,
  RetrieveResult,
  StoredReplica,
  StoreRecovery,
  UpdateResult,
  UpdateOptions,
  StoreOptions,
  StoreProgress,
  StoreResult,
  WalletInfo,
} from "./types.js";
import {
  PAYLOAD_AAD,
  MANIFEST_AAD,
  METADATA_AAD,
  METADATA_ONLY_OWNER_SECRET_SALT,
  chunkAad,
} from "./types.js";
import type { EncryptionScheme } from "@dstorage/chain";
import { CHUNK_SIZE, ChunkManifest, isManifest } from "./chunked.js";
import { runParallelWithPolicy, runWithPolicy } from "./adapterPolicy.js";
import type { PolicyCandidate } from "./adapterPolicy.js";
import {
  MAX_REPLICAS,
  composeOnChainStorageId,
  decodeReplicas,
  parsePublicStorageId,
  splitOnChainStorageId,
} from "./replicas.js";

// Storage transaction tag keys and values attached to every upload.
const TAG_SDK_VERSION = "dStorage-Version";
const TAG_CONTENT_TYPE = "Content-Type";
const TAG_CONTENT_TYPE_OCTET_STREAM = "application/octet-stream"; // encrypted or unknown binary
const TAG_CONTENT_TYPE_JSON = "application/json"; // public chunk manifests
// Chunk-specific tags written on each piece of a chunked upload.
const TAG_CHUNK_INDEX = "dStorage-Chunk-Index";
const TAG_CHUNK_TOTAL = "dStorage-Chunk-Total";
// Marks the manifest transaction that ties a chunked upload together.
const TAG_MANIFEST_UPLOAD = "dStorage-Manifest-Upload";

function wrapError(err: unknown): never {
  // Check both: `instanceof` still matters for same-bundle subclasses that
  // override `.name` (e.g. StorePartialError, which isDStorageError() won't
  // match since its name isn't "DStorageError"). The duck-typed check catches
  // errors thrown by a *different* package's bundle — each package is bundled
  // independently, so a DStorageError thrown by another package's bundle
  // fails `instanceof DStorageError` here even though it structurally is one.
  if (err instanceof DStorageError || isDStorageError(err)) throw err;
  throw new DStorageError(
    CoreErrorCode.UNKNOWN_ERROR,
    `[dStorage] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}

/** How one operation may use a policy. Omitted rules take the defaults. */
interface PolicyScope<R> {
  kind: AdapterKind;
  operation: string;
  allowContinue?: boolean;
  pinned?: boolean;
  commits?: boolean;
  defaultOnFailure?: "next" | "stop";
  continueHint?: string;
  describe?: (
    result: R,
  ) => Pick<PolicySuccess, "storageId" | "provider" | "refId">;
}

const describeUpload = (result: StorageUploadResult) => ({
  storageId: result.id,
  provider: result.provider,
});

const describeChainWrite = (result: { refId: string; provider: string }) => ({
  refId: result.refId,
  provider: result.provider,
});

function assertValidPolicy(policy: unknown, field: string): void {
  if (policy === undefined) return;
  const isObject = typeof policy === "object" && policy !== null;
  const invalidHook =
    isObject &&
    ["order", "onSuccess", "onFailure", "onComplete"].find((hook) => {
      const value = (policy as Record<string, unknown>)[hook];
      return value !== undefined && typeof value !== "function";
    });
  if (!isObject || invalidHook) {
    throw new DStorageError(
      CoreErrorCode.CONFIG_POLICY_INVALID,
      `[dStorage] DStorageConfig.${field}${invalidHook ? `.${invalidHook} must be a function` : " must be an object"}.`,
    );
  }
}

/**
 * Converts the writes after the first into copies to record. Entries matching
 * an earlier one are dropped, as a content-addressed adapter can return the
 * same ID, and `contentHash` is only kept when it differs from the primary's.
 */
function toStoredReplicas(
  copies: ReadonlyArray<{
    adapter: StorageAdapter;
    upload: StorageUploadResult;
    contentHash?: string;
  }>,
): StoredReplica[] {
  const [primary, ...rest] = copies;
  const seen = new Set(
    primary ? [`${primary.adapter.name}\n${primary.upload.id}`] : [],
  );
  const replicas: StoredReplica[] = [];
  for (const { adapter, upload, contentHash } of rest) {
    const key = `${adapter.name}\n${upload.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    replicas.push({
      provider: adapter.name,
      id: upload.id,
      ...(contentHash !== undefined && contentHash !== primary?.contentHash
        ? { contentHash }
        : {}),
      ...(upload.cost
        ? { cost: { amount: upload.cost.amount, token: upload.cost.token } }
        : {}),
    });
  }
  return replicas;
}

/** The fields of a replica that are recorded, leaving out its cost. */
function toLocations(replicas: readonly StoredReplica[]): ReplicaLocation[] {
  return replicas.map(({ provider, id, contentHash }) => ({
    provider,
    id,
    ...(contentHash !== undefined ? { contentHash } : {}),
  }));
}

/** A chain write that landed mustn't be reported as recoverable by rewriting it. */
function rethrowIfCommitted(err: unknown): void {
  if (isAdapterPolicyError(err) && err.committed) throw err;
}

export class DStorage {
  private config: DStorageConfig;
  private wallet: WalletInfo | null = null;
  /** Encryption adapters — each wraps/unwraps per-upload DEKs using its own algorithm. */
  private _encryptionProviders: import("@dstorage/encryption").EncryptionAdapter[] =
    [];
  private _initialized = false;
  private readonly logger: Logger | undefined;

  constructor(config: DStorageConfig) {
    if (!config.storageAdapters || config.storageAdapters.length === 0) {
      throw new DStorageError(
        CoreErrorCode.CONFIG_STORAGE_ADAPTERS_EMPTY,
        "[dStorage] DStorageConfig.storageAdapters must contain at least one storage adapter.",
      );
    }
    assertValidPolicy(config.storagePolicy, "storagePolicy");
    assertValidPolicy(config.chainPolicy, "chainPolicy");
    if (
      config.storagePolicy?.onSuccess &&
      config.storageAdapters.length > MAX_REPLICAS + 1
    ) {
      throw new DStorageError(
        CoreErrorCode.CONFIG_POLICY_INVALID,
        `[dStorage] A storagePolicy with onSuccess supports at most ${MAX_REPLICAS + 1} storage adapters, because a reference records at most ${MAX_REPLICAS} extra copies.`,
      );
    }
    this.config = config;
    assertValidLogger(config.logger, "DStorage");
    this.logger = config.logger;
  }

  // ── Public accessors ─────────────────────────────────────────────────────

  /** Configured storage adapters, in fallback order. */
  get storageAdapters(): readonly StorageAdapter[] {
    return [...this.config.storageAdapters];
  }

  /** Configured chain adapters, in fallback order. Empty in storage-only mode. */
  get chainAdapters(): readonly ChainAdapter[] {
    return [...(this.config.chainAdapters ?? [])];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize the SDK:
   *   1. Initialize the chain adapter wallet (if supported), and
   *      deploy a new DataRegistry contract, or connect to an existing one.
   *      Tries each configured chain adapter in order, stopping at the first
   *      one that initializes successfully — the rest are never attempted,
   *      unless `chainPolicy.onSuccess` returns "continue". A fallback adapter
   *      that requires init() can't serve requests without that.
   *   2. Derive an encryption key from the chain adapter's credentials (if supported).
   *
   * Returns the address of the DataRegistry contract in use (from whichever
   * chain adapter succeeded), or undefined in storage-only mode.
   * Call this instead of connect() when using MidnightChainAdapter directly.
   */
  async init() {
    try {
      const chainAdapters = this.config.chainAdapters ?? [];
      let contractAddress: string | undefined;

      if (chainAdapters.length > 0) {
        const { result } = await this._tryEachAdapter(
          chainAdapters,
          async (adapter) => {
            if (adapter.init) {
              await adapter.init();
            }
            return adapter.getContractAddress();
          },
          (failures) =>
            new DStorageError(
              CoreErrorCode.INIT_CHAIN_ALL_FAILED,
              `[dStorage] All ${chainAdapters.length} configured chain adapters failed to initialize.`,
              { cause: failures },
            ),
          { kind: "chain", operation: "init", allowContinue: true },
        );
        contractAddress = result;
      }

      // Store encryption adapters — they wrap/unwrap DEKs on demand.
      this._encryptionProviders = this.config.encryptionAdapters ?? [];

      this._initialized = true;
      return contractAddress;
    } catch (err) {
      wrapError(err);
    }
  }

  /** Tear down active state and clear all in-memory key material. */
  destroy(): void {
    for (const provider of this._encryptionProviders) {
      provider.destroy?.();
    }
    this.wallet = null;
    this._encryptionProviders = [];
    this._initialized = false;
    this.logger?.log(
      "dStorage",
      "Destroyed — encryption key cleared from memory.",
    );
  }

  get isConnected(): boolean {
    return this._initialized || this.wallet !== null;
  }

  get connectedAddress(): string | null {
    return this.wallet?.address ?? null;
  }

  // ── Core operations ───────────────────────────────────────────────────────

  /**
   * Encrypt content client-side, store to decentralised storage,
   * and write a cryptographic reference on-chain.
   *
   * Files larger than CHUNK_SIZE (10 MB) are automatically split into chunks,
   * each encrypted and stored independently. A manifest file ties them together.
   * Only the manifest's storageId is written on-chain.
   *
   * @param bytes    Uint8Array to store
   * @param options  Optional StoreOptions (metadata, onProgress, isPublic, refId)
   * @returns        StoreResult containing the chainRefId/storageId needed to retrieve later
   */
  async store(bytes: Uint8Array, options?: StoreOptions): Promise<StoreResult> {
    try {
      this.assertConnected();

      const {
        tags = {},
        metadata: rawMeta,
        onProgress,
        isPublic = false,
        refId,
      } = options ?? {};

      if (rawMeta !== undefined && isPublic) {
        throw new DStorageError(
          CoreErrorCode.METADATA_WITH_PUBLIC_UPLOAD,
          "[dStorage] metadata cannot be used with isPublic uploads — there is no DEK to encrypt it with.",
        );
      }

      // Route large files through the chunked path.
      if (bytes.length > CHUNK_SIZE) {
        return this._uploadChunked(
          bytes,
          tags,
          onProgress,
          isPublic,
          rawMeta,
          refId,
        );
      }

      // ── Single-shot path (files ≤ 10 MB) ───────────────────────────────────

      let uploadData: Uint8Array;
      let onChainStorageId: string;
      const encryptionScheme = isPublic
        ? ("" as const)
        : ("xchacha20poly1305-v1" as const);

      // Per-upload scheme: for private uploads this holds an XChaChaScheme
      // built from a fresh random DEK (not the seed-derived key).
      let uploadScheme: CryptoScheme | null = null;
      let keyEnvelope: string = "";
      let dek: Uint8Array | null = null;
      let ownerSecret: Uint8Array = new Uint8Array(0);

      if (isPublic) {
        // 1a. Public: store raw bytes, write storageId as plaintext on-chain.
        uploadData = bytes;
      } else {
        // 1b. Private: requires at least one provider to wrap the DEK.
        if (this._encryptionProviders.length === 0) {
          throw new DStorageError(
            CoreErrorCode.UPLOAD_NO_PROVIDERS,
            "[dStorage] No encryption providers available. Call init() before uploading.",
          );
        }
        // Generate a fresh random DEK for this upload.
        dek = generateDek();
        uploadScheme = XChaChaScheme.fromKey(dek);
        this.logger?.log(
          "dStorage",
          `Encrypting content using scheme: ${encryptionScheme}`,
        );
        uploadData = await uploadScheme.encryptPayload(bytes, PAYLOAD_AAD);

        // Wrap DEK under every provider (enables decryption and ownerSecret re-derivation).
        const wrapperEntries = await Promise.all(
          this._encryptionProviders.map(async (provider) => ({
            wrapKeyName: provider.name,
            ...(await provider.wrapDek(dek!)),
          })),
        );
        keyEnvelope = serializeKeyEnvelope(buildKeyEnvelope(wrapperEntries));
      }

      // 2. Upload first so we have the storageId for ownerSecret derivation (if needed).
      const sdkVersion = corePackageJson.version;
      const { result: storageResult, successes: storageCopies } =
        await this._tryEachAdapter(
          this.config.storageAdapters,
          (adapter) =>
            adapter.store(uploadData, {
              ...tags,
              [TAG_SDK_VERSION]: sdkVersion,
              [TAG_CONTENT_TYPE]: TAG_CONTENT_TYPE_OCTET_STREAM,
            }),
          (failures) =>
            new DStorageError(
              CoreErrorCode.STORAGE_WRITE_ALL_FAILED,
              `[dStorage] All ${this.config.storageAdapters.length} configured storage adapters failed to store the content.`,
              { cause: failures },
            ),
          {
            kind: "storage",
            operation: "store",
            allowContinue: true,
            describe: describeUpload,
          },
        ).catch((err: unknown) => {
          // Retry delays can keep the DEK in memory for a while, so don't
          // leave it there once the upload has failed for good.
          dek?.fill(0);
          throw err;
        });
      const replicas = toStoredReplicas(
        storageCopies.map(({ adapter, result }) => ({
          adapter,
          upload: result,
        })),
      );
      const replicaLocations = toLocations(replicas);

      const chainAdapters = this.config.chainAdapters ?? [];

      if (isPublic) {
        // 3a. Public: no content DEK needed. Key envelope and ownerSecret are only
        // needed for on-chain reference management — skip in storage-only mode.
        if (chainAdapters.length > 0) {
          if (this._encryptionProviders.length === 0) {
            throw new DStorageError(
              CoreErrorCode.PUBLIC_UPLOAD_REQUIRES_SEED_PROVIDER,
              "[dStorage] Cannot store public data without at least one encryption seed provider. " +
                "Without a provider there is no owner secret, so the reference " +
                "could never be removed or updated.",
            );
          }
          const ownerSeed = generateDek();
          try {
            const ownerSeedWrappers = await Promise.all(
              this._encryptionProviders.map(async (provider) => ({
                wrapKeyName: provider.name,
                ...(await provider.wrapDek(ownerSeed)),
              })),
            );
            keyEnvelope = serializeKeyEnvelope(
              buildKeyEnvelope(ownerSeedWrappers),
            );
            ownerSecret = await deriveOwnerSecret(
              ownerSeed,
              new TextEncoder().encode(storageResult.id),
              "dstorage:owner-secret:public:v1",
            );
          } finally {
            // Never embedded in a returned scheme (public uploads never set
            // uploadScheme), so it's always safe to wipe once used.
            ownerSeed.fill(0);
          }
        }
        // Write storageId as-is on-chain.
        onChainStorageId = await composeOnChainStorageId(
          storageResult.id,
          replicaLocations,
          null,
        );
      } else {
        // 3b. Private: encrypt the storageId with the same per-upload DEK scheme.
        onChainStorageId = await composeOnChainStorageId(
          await uploadScheme!.encryptStorageId(storageResult.id),
          replicaLocations,
          uploadScheme,
        );

        // Derive ownerSecret = HKDF-SHA256(dek, rawStorageId).
        // Deterministic: any KEK holder can unwrap the DEK and re-derive this.
        ownerSecret = await deriveOwnerSecret(
          dek!,
          new TextEncoder().encode(storageResult.id),
        );
      }

      const storageCost = {
        amount: storageResult.cost?.amount ?? "unknown",
        token: storageResult.cost?.token ?? "AR",
      };

      // 4. Write on-chain reference — only the storage pointer, never the data.
      //    Skipped in storage-only mode (no chain adapters configured).
      if (chainAdapters.length > 0) {
        const contentHash = await computeBlake3Hex(uploadData);

        // Emit "stored" before the chain write so callers can persist recovery
        // info proactively (in case the chain write fails or the process crashes).
        const storeRecovery: StoreRecovery = {
          storageId: storageResult.id,
          storageProvider: storageResult.provider,
          keyEnvelope: isPublic ? undefined : keyEnvelope,
          contentHash,
          ...(replicaLocations.length > 0
            ? { replicas: replicaLocations }
            : {}),
        };
        onProgress?.({
          phase: "stored",
          chunksUploaded: 1,
          totalChunks: 1,
          bytesUploaded: bytes.length,
          totalBytes: bytes.length,
          recovery: storeRecovery,
        });

        const encryptedMetadata = rawMeta
          ? bytesToBase64url(
              await uploadScheme!.encryptPayload(
                new TextEncoder().encode(JSON.stringify(rawMeta)),
                METADATA_AAD,
              ),
            )
          : undefined;
        try {
          const { result: chainResult } = await this._tryEachAdapter(
            chainAdapters,
            (adapter) =>
              adapter.writeReference({
                storageId: onChainStorageId,
                encryptionScheme,
                storageProvider: storageResult.provider,
                ...(refId !== undefined ? { refId } : {}),
                ...(encryptedMetadata !== undefined
                  ? { encryptedMetadata }
                  : {}),
                writtenAt: Date.now(),
                keyEnvelope,
                contentHash,
                ownerSecret,
              }),
            (failures) =>
              new DStorageError(
                CoreErrorCode.CHAIN_WRITE_ALL_FAILED,
                `[dStorage] All ${chainAdapters.length} configured chain adapters failed to write the reference.`,
                { cause: failures },
              ),
            {
              kind: "chain",
              operation: "store",
              commits: true,
              describe: describeChainWrite,
            },
          );

          const resultRefId = chainResult.refId;
          this.logger?.log(
            "dStorage",
            `Upload complete → refId: ${resultRefId}`,
          );

          return {
            chainRefId: resultRefId,
            storageId: storageResult.id,
            storageProvider: storageResult.provider,
            chainProvider: chainResult.provider,
            uploadedAt: storageResult.uploadedAt,
            ...(replicas.length > 0 ? { replicas } : {}),
            encryptionScheme,
            costEstimate: {
              storageCost,
              chainCost: {
                amount: chainResult.paymentReceipt?.amount ?? "unknown",
                token: chainResult.paymentReceipt?.token ?? "DUST",
              },
              fileSizeBytes: uploadData.length,
            },
          };
        } catch (err) {
          rethrowIfCommitted(err);
          throw new StorePartialError(storeRecovery, err);
        } finally {
          // Safe unconditionally here: this branch never returns uploadScheme
          // (which would alias the same underlying buffer) to the caller —
          // unlike the storage-only branch below, which hands uploadScheme
          // back as cryptoScheme and must NOT have its key wiped.
          dek?.fill(0);
        }
      }

      // Storage-only mode: return result without chain fields.
      this.logger?.log(
        "dStorage",
        `Upload complete (storage-only) → storageId: ${storageResult.id}`,
      );
      return {
        storageId: storageResult.id,
        storageProvider: storageResult.provider,
        uploadedAt: storageResult.uploadedAt,
        ...(replicas.length > 0 ? { replicas } : {}),
        encryptionScheme,
        ...(uploadScheme ? { cryptoScheme: uploadScheme } : {}),
        costEstimate: { storageCost, fileSizeBytes: uploadData.length },
      };
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * Register a pre-existing storageId as a new on-chain reference.
   *
   * Use this when data has already been uploaded to the storage network by
   * other means (e.g. a third-party tool or a separate pipeline). The content
   * is not touched — only the chain reference is created.
   *
   * A fresh DEK is generated solely to encrypt the storageId and derive the
   * ownerSecret. The resulting reference round-trips through retrieveByRefId()
   * exactly like one created by store().
   *
   * Note: chunked manifests are not handled here. For large pre-existing
   * uploads already split into chunks, register the manifest storageId.
   */
  async registerReference(
    options: RegisterReferenceOptions = {},
  ): Promise<RegisterReferenceResult> {
    try {
      this.assertConnected();
      const chainAdapters = this.config.chainAdapters ?? [];
      if (chainAdapters.length === 0) {
        throw new DStorageError(
          CoreErrorCode.REGISTER_REF_REQUIRES_CHAIN,
          "[dStorage] registerReference requires a chain adapter.",
        );
      }
      if (this._encryptionProviders.length === 0) {
        throw new DStorageError(
          CoreErrorCode.REGISTER_REF_REQUIRES_ENCRYPTION,
          "[dStorage] registerReference requires at least one encryption adapter.",
        );
      }

      // Recovery path: unwrap the existing DEK from the provided envelope so the
      // new chain reference is encrypted with the same key as the original store().
      // Normal path: generate a fresh random DEK.
      let dek: Uint8Array;
      const recoveryEnvelope = options.keyEnvelope;
      const recoveryReplicas = options.replicas ?? [];
      if (
        recoveryReplicas.length > 0 &&
        (options.storageId === undefined || !recoveryEnvelope)
      ) {
        // Public recovery has no envelope, and the reference it produces is
        // marked as encrypted, so recorded copies couldn't be read back.
        throw new DStorageError(
          CoreErrorCode.REPLICAS_REQUIRE_KEY_ENVELOPE,
          "[dStorage] registerReference only records replicas together with storageId and keyEnvelope.",
        );
      }
      if (recoveryEnvelope) {
        dek = await this._unwrapDek(recoveryEnvelope);
      } else {
        dek = generateDek();
      }

      try {
        const scheme = XChaChaScheme.fromKey(dek);

        const { metadata: rawMeta } = options;
        const encryptedMetadata = rawMeta
          ? bytesToBase64url(
              await scheme.encryptPayload(
                new TextEncoder().encode(JSON.stringify(rawMeta)),
                METADATA_AAD,
              ),
            )
          : undefined;

        const onChainStorageId =
          options.storageId !== undefined
            ? await composeOnChainStorageId(
                await scheme.encryptStorageId(options.storageId),
                recoveryReplicas,
                scheme,
              )
            : undefined;

        let keyEnvelope: string;
        if (recoveryEnvelope !== undefined) {
          keyEnvelope = recoveryEnvelope; // re-use original — already wrapped under the user's KEK(s)
        } else {
          const wrapperEntries = await Promise.all(
            this._encryptionProviders.map(async (p) => ({
              wrapKeyName: p.name,
              ...(await p.wrapDek(dek)),
            })),
          );
          keyEnvelope = serializeKeyEnvelope(buildKeyEnvelope(wrapperEntries));
        }

        const ownerSecret = await deriveOwnerSecret(
          dek,
          options.storageId !== undefined
            ? new TextEncoder().encode(options.storageId)
            : METADATA_ONLY_OWNER_SECRET_SALT,
        );
        const { result: chainResult } = await this._tryEachAdapter(
          chainAdapters,
          (adapter) =>
            adapter.writeReference({
              ...(onChainStorageId !== undefined
                ? { storageId: onChainStorageId }
                : {}),
              encryptionScheme: "xchacha20poly1305-v1",
              storageProvider:
                options.storageProvider ?? this.config.storageAdapters[0]!.name,
              ...(options.refId !== undefined ? { refId: options.refId } : {}),
              ...(encryptedMetadata !== undefined ? { encryptedMetadata } : {}),
              writtenAt: Date.now(),
              keyEnvelope,
              ...(options.contentHash !== undefined
                ? { contentHash: options.contentHash }
                : {}),
              ownerSecret,
            }),
          (failures) =>
            new DStorageError(
              CoreErrorCode.CHAIN_WRITE_ALL_FAILED,
              `[dStorage] All ${chainAdapters.length} configured chain adapters failed to write the reference.`,
              { cause: failures },
            ),
          {
            kind: "chain",
            operation: "registerReference",
            commits: true,
            describe: describeChainWrite,
          },
        );
        return { chainRefId: chainResult.refId };
      } finally {
        dek.fill(0);
      }
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * Store new content and update an existing on-chain reference in place.
   *
   * Ownership is proved by re-deriving the ownerSecret from the existing
   * reference — the same mechanism used by removeReference(). A fresh DEK is
   * generated for the new content; the previous version is not modified and remains
   * independently decryptable if the caller retained the old storageId.
   *
   * Note: chunking is not applied here. For large files use store() to get a
   * new chunked reference, then removeReference() on the old one.
   *
   * @param refId    The chain reference to update (returned by a prior store/registerReference).
   * @param bytes    New content to encrypt and store.
   * @param options  Optional UpdateOptions (tags, metadata, onProgress).
   */
  async update(
    refId: string,
    bytes: Uint8Array,
    options?: UpdateOptions,
  ): Promise<UpdateResult> {
    try {
      this.assertConnected();
      const chainAdapters = this.config.chainAdapters ?? [];
      if (chainAdapters.length === 0) {
        throw new DStorageError(
          CoreErrorCode.UPDATE_UPLOAD_REQUIRES_CHAIN,
          "[dStorage] update requires a chain adapter.",
        );
      }
      if (!chainAdapters.some((a) => typeof a.updateReference === "function")) {
        throw new DStorageError(
          CoreErrorCode.UPDATE_UPLOAD_NOT_SUPPORTED,
          "[dStorage] update is not supported by this chain adapter.",
        );
      }
      if (this._encryptionProviders.length === 0) {
        throw new DStorageError(
          CoreErrorCode.UPDATE_UPLOAD_REQUIRES_ENCRYPTION,
          "[dStorage] update requires at least one encryption adapter.",
        );
      }

      const { tags = {}, metadata: rawMeta } = options ?? {};

      // Re-derive ownerSecret from the existing reference (proves ownership),
      // and identify which configured chain adapter actually holds it.
      const { ownerSecret, adapter: targetChainAdapter } =
        await this._computeOwnerSecret(refId);
      if (typeof targetChainAdapter.updateReference !== "function") {
        throw new DStorageError(
          CoreErrorCode.UPDATE_UPLOAD_NOT_SUPPORTED,
          `[dStorage] update is not supported by the "${targetChainAdapter.name}" chain adapter holding reference "${refId}".`,
        );
      }

      const dek = generateDek();
      try {
        const scheme = XChaChaScheme.fromKey(dek);
        const uploadData = await scheme.encryptPayload(bytes, PAYLOAD_AAD);
        const sdkVersion = corePackageJson.version;
        const { result: storageResult, successes: storageCopies } =
          await this._tryEachAdapter(
            this.config.storageAdapters,
            (adapter) =>
              adapter.store(uploadData, {
                ...tags,
                [TAG_SDK_VERSION]: sdkVersion,
                [TAG_CONTENT_TYPE]: TAG_CONTENT_TYPE_OCTET_STREAM,
              }),
            (failures) =>
              new DStorageError(
                CoreErrorCode.STORAGE_WRITE_ALL_FAILED,
                `[dStorage] All ${this.config.storageAdapters.length} configured storage adapters failed to store the content.`,
                { cause: failures },
              ),
            {
              kind: "storage",
              operation: "update",
              allowContinue: true,
              describe: describeUpload,
            },
          );
        const replicas = toStoredReplicas(
          storageCopies.map(({ adapter, result }) => ({
            adapter,
            upload: result,
          })),
        );
        const replicaLocations = toLocations(replicas);
        const onChainStorageId = await composeOnChainStorageId(
          await scheme.encryptStorageId(storageResult.id),
          replicaLocations,
          scheme,
        );
        const wrapperEntries = await Promise.all(
          this._encryptionProviders.map(async (p) => ({
            wrapKeyName: p.name,
            ...(await p.wrapDek(dek)),
          })),
        );
        const keyEnvelope = serializeKeyEnvelope(
          buildKeyEnvelope(wrapperEntries),
        );
        const encryptedMetadata = rawMeta
          ? bytesToBase64url(
              await scheme.encryptPayload(
                new TextEncoder().encode(JSON.stringify(rawMeta)),
                METADATA_AAD,
              ),
            )
          : undefined;
        const contentHash = await computeBlake3Hex(uploadData);
        const rawNewStorageId = new TextEncoder().encode(storageResult.id);
        const newOwnerSecret = await deriveOwnerSecret(dek, rawNewStorageId);

        const storeRecovery: StoreRecovery = {
          storageId: storageResult.id,
          storageProvider: storageResult.provider,
          keyEnvelope,
          contentHash,
          ...(replicaLocations.length > 0
            ? { replicas: replicaLocations }
            : {}),
        };
        options?.onProgress?.({
          phase: "stored",
          chunksUploaded: 1,
          totalChunks: 1,
          bytesUploaded: bytes.length,
          totalBytes: bytes.length,
          recovery: storeRecovery,
        });

        try {
          await this._runPinned("chain", "update", targetChainAdapter, (a) =>
            a.updateReference!(
              refId,
              {
                storageId: onChainStorageId,
                encryptionScheme: "xchacha20poly1305-v1",
                storageProvider: storageResult.provider,
                ...(encryptedMetadata !== undefined
                  ? { encryptedMetadata }
                  : {}),
                writtenAt: Date.now(),
                keyEnvelope,
                contentHash,
              },
              ownerSecret,
              newOwnerSecret,
            ),
          );
        } catch (err) {
          rethrowIfCommitted(err);
          throw new StorePartialError(storeRecovery, err);
        }
        return {
          chainRefId: refId,
          storageId: storageResult.id,
          ...(replicas.length > 0 ? { replicas } : {}),
        };
      } finally {
        dek.fill(0);
      }
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * Retry only the on-chain reference write after a failed `update()` call.
   *
   * Use this when `update()` throws a `StorePartialError` — meaning the new
   * content was stored successfully but the chain write failed. Call with the
   * `refId` you passed to `update()` and the `err.recovery` from the caught
   * error (or the `recovery` emitted via `onProgress` at phase `"stored"`).
   *
   * The new content is already in storage; this method re-derives all chain
   * write parameters from the recovery envelope without re-uploading.
   */
  async retryUpdate(
    refId: string,
    recovery: StoreRecovery,
  ): Promise<UpdateResult> {
    try {
      this.assertConnected();
      const chainAdapters = this.config.chainAdapters ?? [];
      if (chainAdapters.length === 0) {
        throw new DStorageError(
          CoreErrorCode.UPDATE_UPLOAD_REQUIRES_CHAIN,
          "[dStorage] retryUpdate requires a chain adapter.",
        );
      }
      if (!chainAdapters.some((a) => typeof a.updateReference === "function")) {
        throw new DStorageError(
          CoreErrorCode.UPDATE_UPLOAD_NOT_SUPPORTED,
          "[dStorage] retryUpdate is not supported by this chain adapter.",
        );
      }
      if (this._encryptionProviders.length === 0) {
        throw new DStorageError(
          CoreErrorCode.UPDATE_UPLOAD_REQUIRES_ENCRYPTION,
          "[dStorage] retryUpdate requires at least one encryption adapter.",
        );
      }
      if (!recovery.keyEnvelope) {
        throw new DStorageError(
          CoreErrorCode.UNWRAP_DEK_ENVELOPE_EMPTY,
          "[dStorage] retryUpdate requires a key envelope in the recovery object.",
        );
      }

      const dek = await this._unwrapDek(recovery.keyEnvelope);
      try {
        const scheme = XChaChaScheme.fromKey(dek);
        // The failed update() left the chain ref with OLD data, so _computeOwnerSecret
        // reads the old key envelope and derives the old ownerSecret correctly,
        // and identifies which configured chain adapter holds this reference.
        const { ownerSecret, adapter: targetChainAdapter } =
          await this._computeOwnerSecret(refId);
        if (typeof targetChainAdapter.updateReference !== "function") {
          throw new DStorageError(
            CoreErrorCode.UPDATE_UPLOAD_NOT_SUPPORTED,
            `[dStorage] retryUpdate is not supported by the "${targetChainAdapter.name}" chain adapter holding reference "${refId}".`,
          );
        }
        const onChainStorageId = await composeOnChainStorageId(
          await scheme.encryptStorageId(recovery.storageId),
          recovery.replicas ?? [],
          scheme,
        );
        const newOwnerSecret = await deriveOwnerSecret(
          dek,
          new TextEncoder().encode(recovery.storageId),
        );
        const keyEnvelope = recovery.keyEnvelope;
        await this._runPinned("chain", "retryUpdate", targetChainAdapter, (a) =>
          a.updateReference!(
            refId,
            {
              storageId: onChainStorageId,
              encryptionScheme: "xchacha20poly1305-v1",
              storageProvider: recovery.storageProvider,
              writtenAt: Date.now(),
              keyEnvelope,
              ...(recovery.contentHash !== undefined
                ? { contentHash: recovery.contentHash }
                : {}),
            },
            ownerSecret,
            newOwnerSecret,
          ),
        );
        return {
          chainRefId: refId,
          storageId: recovery.storageId,
          ...(recovery.replicas?.length ? { replicas: recovery.replicas } : {}),
        };
      } finally {
        dek.fill(0);
      }
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * Rotate the encryption adapters protecting an existing reference without
   * re-uploading the content.
   *
   * Useful when you want to:
   * - Change a password: configure [newPassword, mnemonic] and call rotateKeys().
   *   The mnemonic unwraps the old DEK, the new envelope is wrapped under both
   *   new adapters, and the old password wrapper is dropped.
   * - Add or remove adapters: any single adapter that matches a wrapper in the
   *   existing key envelope can authorise the rotation. The resulting envelope
   *   is wrapped under exactly the adapters currently configured on this SDK.
   *
   * The content in storage is not touched — only the on-chain key envelope is
   * updated. writtenAt is preserved to reflect the original upload time.
   */
  async rotateKeys(refId: string): Promise<void> {
    try {
      this.assertConnected();
      const chainAdapters = this.config.chainAdapters ?? [];
      if (chainAdapters.length === 0) {
        throw new DStorageError(
          CoreErrorCode.ROTATE_KEYS_REQUIRES_CHAIN,
          "[dStorage] rotateKeys requires a chain adapter.",
        );
      }
      if (!chainAdapters.some((a) => typeof a.updateReference === "function")) {
        throw new DStorageError(
          CoreErrorCode.ROTATE_KEYS_NOT_SUPPORTED,
          "[dStorage] rotateKeys is not supported by this chain adapter.",
        );
      }
      if (this._encryptionProviders.length === 0) {
        throw new DStorageError(
          CoreErrorCode.ROTATE_KEYS_REQUIRES_ENCRYPTION,
          "[dStorage] rotateKeys requires at least one encryption adapter.",
        );
      }

      // Single read locates both the reference and which chain adapter holds
      // it — also proves ownership (any adapter matching an old wrapper suffices).
      const {
        ownerSecret,
        ref,
        adapter: targetChainAdapter,
      } = await this._computeOwnerSecret(refId);
      if (typeof targetChainAdapter.updateReference !== "function") {
        throw new DStorageError(
          CoreErrorCode.ROTATE_KEYS_NOT_SUPPORTED,
          `[dStorage] rotateKeys is not supported by the "${targetChainAdapter.name}" chain adapter holding reference "${refId}".`,
        );
      }
      // Unwrap the existing DEK/ownerSeed to re-wrap under the new adapter set.
      const seed = await this._unwrapDek(ref.keyEnvelope);
      try {
        const wrapperEntries = await Promise.all(
          this._encryptionProviders.map(async (p) => ({
            wrapKeyName: p.name,
            ...(await p.wrapDek(seed)),
          })),
        );
        const newKeyEnvelope = serializeKeyEnvelope(
          buildKeyEnvelope(wrapperEntries),
        );
        // ownerSecret = HKDF(seed, rawStorageId). Since seed and storageId
        // are unchanged, old and new ownerSecret are identical.
        // Pass the existing contentHash through unchanged (content not re-uploaded).
        // The DEK doesn't change, so any recorded replica list stays readable
        // and storageId can be written back unchanged.
        await this._runPinned("chain", "rotateKeys", targetChainAdapter, (a) =>
          a.updateReference!(
            refId,
            {
              storageId: ref.storageId ?? "",
              encryptionScheme: ref.encryptionScheme ?? "",
              storageProvider: ref.storageProvider,
              writtenAt: ref.writtenAt,
              keyEnvelope: newKeyEnvelope,
              ...(ref.encryptedMetadata !== undefined
                ? { encryptedMetadata: ref.encryptedMetadata }
                : {}),
              ...(ref.contentHash !== undefined
                ? { contentHash: ref.contentHash }
                : {}),
            },
            ownerSecret,
            ownerSecret,
          ),
        );
      } finally {
        seed.fill(0);
      }
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * Retrieve and decrypt data by its storageId.
   * Decryption happens locally — the SDK never sends plaintext anywhere.
   *
   * Automatically detects chunked manifests and reassembles the original file.
   *
   * @param storageId  The storageId returned from store()
   */
  async retrieveByStorageId(
    storageId: string,
    dekScheme?: CryptoScheme,
    contentHash?: string,
  ): Promise<RetrieveResult> {
    try {
      this.assertConnected();

      const {
        adapter: sourceAdapter,
        result: { bytes: rawBytes, tags },
      } = await this._tryEachAdapter(
        this.config.storageAdapters,
        (adapter) =>
          adapter.retrieve(
            storageId,
            contentHash !== undefined
              ? { expectedContentHash: contentHash }
              : undefined,
          ),
        (failures) =>
          new DStorageError(
            CoreErrorCode.STORAGE_READ_ALL_FAILED,
            `[dStorage] No configured storage adapter could retrieve storageId "${storageId}".`,
            { cause: failures },
          ),
        { kind: "storage", operation: "retrieve" },
      );

      if (contentHash) {
        const computed = await computeBlake3Hex(rawBytes);
        if (computed !== contentHash) {
          throw new DStorageError(
            CoreErrorCode.CONTENT_HASH_MISMATCH,
            `[dStorage] Content hash mismatch for storageId ${storageId}. ` +
              `Expected ${contentHash}, got ${computed}. ` +
              `The retrieved bytes do not match the hash committed on-chain — ` +
              `the storage content may have been tampered with.`,
          );
        }
      }

      return this._decryptAndReassemble(
        rawBytes,
        storageId,
        tags,
        sourceAdapter,
        dekScheme,
      );
    } catch (err) {
      wrapError(err);
    }
  }

  /** The configured policy for one adapter type. */
  private _policyFor(kind: AdapterKind) {
    return kind === "storage"
      ? this.config.storagePolicy
      : this.config.chainPolicy;
  }

  /** Describes a configured adapter to policy hooks without exposing the instance. */
  private _candidateInfo(
    kind: AdapterKind,
    adapter: StorageAdapter | ChainAdapter,
    location?: AdapterCandidate["location"],
  ): AdapterCandidate {
    const configured: ReadonlyArray<StorageAdapter | ChainAdapter> =
      kind === "storage"
        ? this.config.storageAdapters
        : (this.config.chainAdapters ?? []);
    return Object.freeze({
      adapter: Object.freeze({
        index: configured.indexOf(adapter),
        name: adapter.name,
        providerName: adapter.providerName,
      }),
      ...(location !== undefined ? { location } : {}),
    });
  }

  /**
   * Try each candidate adapter under the configured policy. With no policy
   * this returns the first successful result, falling back in order. Mirrors
   * the encryption-adapter fallback pattern in `_tryUnwrapDek` below,
   * generalized to storage/chain adapters.
   *
   * On total failure: if exactly one candidate was tried, its original error
   * is rethrown verbatim (unwrapped) — this keeps single-adapter configs
   * behaviorally and code-for-code identical to a bare (non-fallback) call.
   * Only when two or more candidates are tried and all of them fail does
   * `buildExhaustedError` get invoked to synthesize an aggregate error.
   *
   * Capability filtering (e.g. only candidates that implement an optional
   * method) is the caller's responsibility — this helper just iterates
   * whatever list it's given.
   */
  private async _tryEachAdapter<T extends StorageAdapter | ChainAdapter, R>(
    candidates: readonly T[],
    attempt: (adapter: T) => Promise<R>,
    buildExhaustedError: (failures: AdapterFailure[]) => DStorageError,
    scope: PolicyScope<R>,
  ): Promise<{
    adapter: T;
    result: R;
    successes: Array<{ adapter: T; result: R }>;
  }> {
    return runWithPolicy(
      {
        kind: scope.kind,
        operation: scope.operation,
        policy: this._policyFor(scope.kind),
        candidates: candidates.map((adapter) => ({
          target: adapter,
          info: this._candidateInfo(scope.kind, adapter),
        })),
        attempt,
        rules: {
          allowContinue: scope.allowContinue ?? false,
          pinned: scope.pinned ?? false,
          commits: scope.commits ?? false,
          defaultOnFailure: scope.defaultOnFailure ?? "next",
          ...(scope.continueHint !== undefined
            ? { continueHint: scope.continueHint }
            : {}),
        },
        ...(scope.describe !== undefined ? { describe: scope.describe } : {}),
      },
      buildExhaustedError,
    );
  }

  /**
   * Run an operation that can only use one adapter, such as a mutation on the
   * chain holding a reference. Retry and abort apply; a failure with no retry
   * surfaces the adapter's own error.
   */
  private async _runPinned<T extends StorageAdapter | ChainAdapter, R>(
    kind: AdapterKind,
    operation: string,
    adapter: T,
    attempt: (adapter: T) => Promise<R>,
  ): Promise<R> {
    const { result } = await this._tryEachAdapter(
      [adapter],
      attempt,
      (failures) =>
        new DStorageError(
          CoreErrorCode.UNKNOWN_ERROR,
          `[dStorage] Operation "${operation}" failed on adapter "${adapter.name}".`,
          { cause: failures },
        ),
      { kind, operation, pinned: true, commits: kind === "chain" },
    );
    return result;
  }

  /**
   * Read an on-chain reference by refId, trying each configured chain
   * adapter in order and falling back on failure. A given refId only
   * actually lives on exactly one configured chain, so this naturally
   * locates the right adapter — used both for plain reads and as the first
   * step of every reference-mutating operation (update/remove/rotate), which
   * then perform the mutation directly on the located adapter rather than
   * attempting a separate write-fallback loop.
   */
  private async _readReferenceFallback(
    refId: string,
  ): Promise<{ ref: ChainReference; adapter: ChainAdapter }> {
    const chainAdapters = this.config.chainAdapters ?? [];
    const { adapter, result: ref } = await this._tryEachAdapter(
      chainAdapters,
      (a) => a.readReference(refId),
      (failures) =>
        new DStorageError(
          CoreErrorCode.CHAIN_READ_ALL_FAILED,
          `[dStorage] No configured chain adapter could read reference "${refId}".`,
          { cause: failures },
        ),
      { kind: "chain", operation: "read" },
    );
    return { ref, adapter };
  }

  /**
   * Try every provider whose name matches a wrapper's wrapKeyName against that
   * wrapper, for every wrapper in the envelope, in order. Multiple configured
   * providers can share the same `.name` (e.g. two MnemonicEncryptionAdapter
   * instances during a seed rotation window) — a name match doesn't guarantee
   * that provider holds the KEK for that specific wrapper, so every same-named
   * candidate must get a chance before moving on to the next wrapper. Returns
   * null if nothing in the envelope could be unwrapped by any provider.
   */
  private async _tryUnwrapDek(
    envelope: KeyEnvelope,
  ): Promise<Uint8Array | null> {
    for (const wrapper of envelope.wrappers) {
      const candidates = this._encryptionProviders.filter(
        (p) => p.name === wrapper.wrapKeyName,
      );
      for (const provider of candidates) {
        try {
          return await provider.unwrapDek(wrapper);
        } catch {
          // This same-named provider didn't match this wrapper — try the next one.
        }
      }
    }
    return null;
  }

  /**
   * Unwrap the data DEK from a key envelope and return an XChaChaScheme built from it.
   * Throws if the KEK is not available or the envelope cannot be parsed.
   * Only valid for private uploads (envelope.wrappers must be present).
   */
  private async _getDekScheme(keyEnvelope: string): Promise<CryptoScheme> {
    if (this._encryptionProviders.length === 0) {
      throw new DStorageError(
        CoreErrorCode.DECRYPT_NO_PROVIDERS,
        "[dStorage] Cannot decrypt: no encryption providers. Call init() before retrieving private data.",
      );
    }
    if (!keyEnvelope) {
      throw new DStorageError(
        CoreErrorCode.DECRYPT_ENVELOPE_EMPTY,
        "[dStorage] Cannot decrypt: key envelope is empty.",
        { cause: { code: "envelope_empty" } },
      );
    }
    const envelope = parseKeyEnvelope(keyEnvelope);
    if (!envelope) {
      throw new DStorageError(
        CoreErrorCode.DECRYPT_ENVELOPE_MALFORMED,
        "[dStorage] Cannot decrypt: key envelope is malformed or has an invalid structure. " +
          "The stored reference may be corrupted or tampered with.",
        { cause: { code: "envelope_malformed" } },
      );
    }
    const dek = await this._tryUnwrapDek(envelope);
    if (dek) {
      return XChaChaScheme.fromKey(dek);
    }
    throw new DStorageError(
      CoreErrorCode.DECRYPT_NO_WRAPPER_MATCHED,
      "[dStorage] Cannot decrypt: this reference was not encrypted with any of your configured keys. " +
        "Check that you are using the correct encryption adapter, password, seed phrase, or keypair.",
      { cause: { code: "no_wrapper_matched" } },
    );
  }

  /**
   * Unwrap the raw DEK bytes from a key envelope using the available KEKs.
   * The ownerSecret for the reference can be re-derived as HKDF(dek, rawStorageId).
   * Throws if no wrapper matches any available KEK.
   */
  private async _unwrapDek(keyEnvelope: string): Promise<Uint8Array> {
    if (this._encryptionProviders.length === 0) {
      throw new DStorageError(
        CoreErrorCode.UNWRAP_DEK_NO_PROVIDERS,
        "[dStorage] Cannot unwrap DEK: no encryption providers. Call init() first.",
      );
    }
    if (!keyEnvelope) {
      throw new DStorageError(
        CoreErrorCode.UNWRAP_DEK_ENVELOPE_EMPTY,
        "[dStorage] Cannot unwrap DEK: key envelope is empty.",
        { cause: { code: "envelope_empty" } },
      );
    }
    const envelope = parseKeyEnvelope(keyEnvelope);
    if (!envelope) {
      throw new DStorageError(
        CoreErrorCode.UNWRAP_DEK_ENVELOPE_MALFORMED,
        "[dStorage] Cannot unwrap DEK: key envelope is malformed or has an invalid structure. " +
          "The stored reference may be corrupted or tampered with.",
        { cause: { code: "envelope_malformed" } },
      );
    }
    const dek = await this._tryUnwrapDek(envelope);
    if (dek) {
      return dek;
    }
    throw new DStorageError(
      CoreErrorCode.UNWRAP_DEK_NO_WRAPPER_MATCHED,
      "[dStorage] Cannot unwrap DEK: this reference was not encrypted with any of your configured keys. " +
        "Check that you are using the correct encryption adapter, password, seed phrase, or keypair.",
      { cause: { code: "no_wrapper_matched" } },
    );
  }

  /**
   * Compute the ownerSecret for an existing on-chain reference, identifying
   * which configured chain adapter actually holds it along the way.
   * Used by removeReference/update/retryUpdate/rotateKeys to derive the ZK
   * witness secret and to target the mutation at the correct adapter without
   * a separate (and semantically wrong) write-fallback loop — a reference
   * only ever lives on one configured chain.
   *
   * Flow:
   *   1. Read the reference from chain (trying each configured adapter in
   *      order) to get keyEnvelope + storageId + which adapter holds it.
   *   2. Unwrap the DEK from keyEnvelope using available KEKs.
   *   3. Recover raw storageId (decrypt with DEK if private, plaintext if public).
   *   4. Return HKDF-SHA256(dek, rawStorageId) for private, or HKDF-SHA256(ownerSeed, rawStorageId) for public.
   */
  private async _computeOwnerSecret(refId: string): Promise<{
    ownerSecret: Uint8Array;
    ref: ChainReference;
    adapter: ChainAdapter;
  }> {
    const { ref, adapter } = await this._readReferenceFallback(refId);
    const isPublic = !ref.encryptionScheme;

    if (isPublic) {
      // Public uploads store a wrapped ownerSeed envelope (any KEK can unwrap it).
      const ownerSeed = await this._unwrapDek(ref.keyEnvelope);
      const primaryId = ref.storageId
        ? (await parsePublicStorageId(ref.storageId)).primary
        : ref.storageId;
      const ownerSecret = await deriveOwnerSecret(
        ownerSeed,
        new TextEncoder().encode(primaryId),
        "dstorage:owner-secret:public:v1",
      );
      return { ownerSecret, ref, adapter };
    }

    // Private: unwrap DEK, decrypt storageId, derive ownerSecret from DEK.
    // Deterministic: any KEK holder can reproduce this.
    // For metadata-only references (no storageId), use a fixed domain sentinel
    // as the HKDF salt — avoids RFC 5869 empty-salt substitution (zeros(32)).
    const dek = await this._unwrapDek(ref.keyEnvelope);
    const dekScheme = XChaChaScheme.fromKey(dek);
    // Only the primary part is decrypted, so a damaged replica list can't stop
    // the owner from updating or removing the reference.
    const rawStorageIdBytes = ref.storageId
      ? new TextEncoder().encode(
          await dekScheme.decryptStorageId(
            splitOnChainStorageId(ref.storageId).primary,
          ),
        )
      : METADATA_ONLY_OWNER_SECRET_SALT;
    const ownerSecret = await deriveOwnerSecret(dek, rawStorageIdBytes);
    return { ownerSecret, ref, adapter };
  }

  // Accepts an optional pre-built CryptoScheme (unwrapped from a key envelope).
  // If no dekScheme is provided, content is treated as public (no decryption).
  // sourceAdapter is the storage adapter that served rawBytes — reused as-is
  // for every chunk fetch if this turns out to be a manifest (see
  // _retrieveChunked: a manifest and its chunks always live on the same
  // adapter, since store() writes them as one whole-operation attempt).
  private async _decryptAndReassemble(
    rawBytes: Uint8Array,
    storageId: string,
    tags: Record<string, string>,
    sourceAdapter: StorageAdapter,
    dekScheme?: CryptoScheme,
  ): Promise<RetrieveResult> {
    const scheme: CryptoScheme | null = dekScheme ?? null;

    // 2. Decrypt and dispatch on content type.
    if (scheme) {
      // Private upload: use AAD to distinguish manifest from raw payload.
      // Try MANIFEST_AAD first — Poly1305 auth failure means it is not a manifest.
      // This is cryptographic, not JSON-shape-based, so a crafted user file whose
      // plaintext looks like a manifest cannot be mistaken for one.
      let manifestBytes: Uint8Array | null = null;
      try {
        manifestBytes = await scheme.decryptPayload(rawBytes, MANIFEST_AAD);
      } catch {
        // Not a manifest — expected for all non-chunked uploads.
      }

      if (manifestBytes !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
        } catch (err) {
          throw new DStorageError(
            CoreErrorCode.MANIFEST_PARSE_FAILED,
            `[dStorage] Payload authenticated as manifest but is not valid JSON: ${err}`,
            { cause: err },
          );
        }
        if (!isManifest(parsed)) {
          throw new DStorageError(
            CoreErrorCode.MANIFEST_INVALID_STRUCTURE,
            "[dStorage] Payload authenticated as manifest but has invalid structure",
          );
        }
        this.logger?.log(
          "dStorage",
          `Manifest detected: reassembling ${parsed.chunkCount} chunks`,
        );
        return this._retrieveChunked(parsed, sourceAdapter, scheme, tags);
      }

      // Not a manifest — decrypt as regular payload.
      let decryptedBytes: Uint8Array;
      try {
        decryptedBytes = await scheme.decryptPayload(rawBytes, PAYLOAD_AAD);
      } catch (err) {
        throw new DStorageError(
          CoreErrorCode.DECRYPT_PAYLOAD_FAILED,
          `[dStorage] Failed to decrypt payload: ${err}`,
          { cause: err },
        );
      }

      this.logger?.log(
        "dStorage",
        `Retrieved by refId → storageId: ${storageId}`,
      );
      return { bytes: decryptedBytes, metadata: {}, tags };
    }

    // Public upload (no encryption): fall back to JSON shape detection for manifests.
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBytes));
      if (isManifest(parsed)) {
        this.logger?.log(
          "dStorage",
          `Manifest detected: reassembling ${parsed.chunkCount} chunks`,
        );
        return this._retrieveChunked(parsed, sourceAdapter, null, tags);
      }
    } catch {
      // Not JSON — treat as raw content, fall through.
    }

    this.logger?.log(
      "dStorage",
      `Retrieved by refId → storageId: ${storageId}`,
    );

    return {
      bytes: rawBytes,
      metadata: {},
      tags,
    };
  }

  /**
   * Read content that has recorded copies. Each attempt covers the fetch, the
   * hash check and the decryption, including any chunks, so a bad or partly
   * missing copy moves on to the next location instead of failing the read.
   * The primary is tried on every adapter; a copy only on adapters whose name
   * matches its provider.
   */
  private async _retrieveFromLocations(
    primaryId: string,
    replicas: readonly ReplicaLocation[],
    dekScheme: CryptoScheme | undefined,
    onChainHash: string | undefined,
  ): Promise<RetrieveResult> {
    type Target = { adapter: StorageAdapter; id: string; hash?: string };
    const adapters = this.config.storageAdapters;
    const hashFields = onChainHash !== undefined ? { hash: onChainHash } : {};

    const candidates: Array<PolicyCandidate<Target>> = adapters.map(
      (adapter) => ({
        target: { adapter, id: primaryId, ...hashFields },
        info: this._candidateInfo("storage", adapter, { kind: "primary" }),
      }),
    );
    replicas.forEach((replica, replicaIndex) => {
      const matching = adapters.filter((a) => a.name === replica.provider);
      if (matching.length === 0) {
        this.logger?.log(
          "dStorage",
          `No configured storage adapter named "${replica.provider}": skipping replica ${replicaIndex}.`,
        );
      }
      for (const adapter of matching) {
        const hash = replica.contentHash ?? onChainHash;
        candidates.push({
          target: {
            adapter,
            id: replica.id,
            ...(hash !== undefined ? { hash } : {}),
          },
          info: this._candidateInfo("storage", adapter, {
            kind: "replica",
            replicaIndex,
            provider: replica.provider,
          }),
        });
      }
    });

    const { result } = await runWithPolicy(
      {
        kind: "storage",
        operation: "retrieve",
        policy: this.config.storagePolicy,
        candidates,
        attempt: async ({ adapter, id, hash }) => {
          const { bytes, tags } = await adapter.retrieve(
            id,
            hash !== undefined ? { expectedContentHash: hash } : undefined,
          );
          if (hash) {
            const computed = await computeBlake3Hex(bytes);
            if (computed !== hash) {
              throw new DStorageError(
                CoreErrorCode.CONTENT_HASH_MISMATCH,
                `[dStorage] Content hash mismatch for storageId ${id}. ` +
                  `Expected ${hash}, got ${computed}.`,
              );
            }
          }
          return await this._decryptAndReassemble(
            bytes,
            id,
            tags,
            adapter,
            dekScheme,
          );
        },
        rules: {
          allowContinue: false,
          pinned: false,
          commits: false,
          defaultOnFailure: "next",
        },
      },
      (failures) =>
        new DStorageError(
          CoreErrorCode.STORAGE_READ_ALL_FAILED,
          `[dStorage] No configured storage adapter could retrieve storageId "${primaryId}" or its replicas.`,
          { cause: failures },
        ),
    );
    return result;
  }

  /** A damaged list only loses the copies: the primary can still be used. */
  private async _decodePrivateReplicas(
    suffix: string | undefined,
    scheme: CryptoScheme,
    refId: string,
  ): Promise<ReplicaLocation[]> {
    if (suffix === undefined) return [];
    try {
      return await decodeReplicas(suffix, scheme);
    } catch {
      this.logger?.log(
        "dStorage",
        `Ignoring an unreadable replica list on reference ${refId}.`,
      );
      return [];
    }
  }

  /**
   * Retrieve and decrypt data using only its on-chain reference ID.
   *
   * Flow:
   *   1. Look up the reference on-chain by refId to obtain the storage network ID.
   *   2. Fetch the blob from the storage network.
   *   3. Decrypt locally if an encryption key is available.
   *
   * Requires the chain adapter to implement readReference() (part of the
   * ChainAdapter interface — shared by MidnightChainAdapter, MockChainAdapter, etc.).
   *
   * @param refId  The chainRefId returned from store()
   */
  async retrieveByRefId(refId: string): Promise<RetrieveResult> {
    try {
      this.assertConnected();

      if ((this.config.chainAdapters ?? []).length === 0) {
        throw new DStorageError(
          CoreErrorCode.RETRIEVE_BY_REF_ID_REQUIRES_CHAIN,
          "[dStorage] retrieveByRefId() requires a chain adapter. " +
            "Configure one in DStorageConfig or use retrieveByStorageId() instead.",
        );
      }

      const { ref } = await this._readReferenceFallback(refId);
      if (!ref)
        throw new DStorageError(
          CoreErrorCode.REF_NOT_FOUND,
          `[dStorage] No on-chain reference found for refId: ${refId}`,
        );

      // No storage-adapter mismatch check: retrieveByStorageId() below tries
      // every configured storage adapter in order regardless of which one
      // ref.storageProvider names — a non-matching adapter simply fails to
      // find the data and fallback proceeds to the next.

      const isPublic = !ref.encryptionScheme;

      // For private data: unwrap the DEK from the key envelope, then use it to
      // decrypt both the on-chain storageId and the stored content.
      // For public data: the storageId is already plaintext.
      // For metadata-only references (no storageId): get the DEK to decrypt
      // encryptedMetadata but skip storage retrieval entirely.
      let storageId: string | undefined;
      let dekScheme: CryptoScheme | undefined;
      let replicas: ReplicaLocation[] = [];

      if (!ref.storageId) {
        // Metadata-only reference — still need the DEK to decrypt encryptedMetadata.
        if (!isPublic && ref.keyEnvelope) {
          dekScheme = await this._getDekScheme(ref.keyEnvelope);
        }
      } else if (isPublic) {
        const parsed = await parsePublicStorageId(ref.storageId);
        storageId = parsed.primary;
        replicas = parsed.replicas;
      } else {
        if (!ref.keyEnvelope) {
          throw new DStorageError(
            CoreErrorCode.RETRIEVE_BY_REF_ID_ENVELOPE_EMPTY,
            `[dStorage] Cannot decrypt refId ${refId}: key envelope is empty.`,
            { cause: { code: "envelope_empty" } },
          );
        }
        dekScheme = await this._getDekScheme(ref.keyEnvelope);
        const { primary, suffix } = splitOnChainStorageId(ref.storageId);
        storageId = await dekScheme.decryptStorageId(primary);
        replicas = await this._decodePrivateReplicas(suffix, dekScheme, refId);
      }

      let contentBytes: Uint8Array;
      let contentTags: Record<string, string>;
      if (storageId !== undefined) {
        const r =
          replicas.length > 0
            ? await this._retrieveFromLocations(
                storageId,
                replicas,
                dekScheme,
                ref.contentHash,
              )
            : await this.retrieveByStorageId(
                storageId,
                dekScheme,
                ref.contentHash,
              );
        contentBytes = r.bytes;
        contentTags = r.tags;
      } else {
        contentBytes = new Uint8Array(0);
        contentTags = {};
      }

      let metadata: Record<string, string> = {};
      if (ref.encryptedMetadata && dekScheme) {
        const raw = await dekScheme.decryptPayload(
          base64urlToBytes(ref.encryptedMetadata),
          METADATA_AAD,
        );
        try {
          metadata = JSON.parse(new TextDecoder().decode(raw)) as Record<
            string,
            string
          >;
        } catch (err) {
          throw new DStorageError(
            CoreErrorCode.METADATA_PARSE_FAILED,
            `[dStorage] Decrypted metadata is not valid JSON: ${err}`,
            { cause: err },
          );
        }
      }

      return { bytes: contentBytes, tags: contentTags, metadata };
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * List references currently available from the configured chain adapters.
   *
   * The no-filter (aggregate) path calls listReferences() on every configured
   * chain adapter that supports it and merges the results — a single failing
   * adapter doesn't abort the call as long as at least one other succeeds,
   * since references may legitimately live on more than one configured chain.
   * The refIds-filter path instead looks up each requested reference
   * individually, trying configured chain adapters in order per refId
   * (a given refId only lives on exactly one chain).
   */
  async listReferences(
    options?: ListReferencesOptions,
  ): Promise<ListedDataReference[]> {
    try {
      const chainAdapters = this.config.chainAdapters ?? [];
      if (chainAdapters.length === 0) {
        throw new DStorageError(
          CoreErrorCode.LIST_REFS_REQUIRES_CHAIN,
          "[dStorage] listReferences() requires a chain adapter.",
        );
      }

      type RawItem = {
        refId: string;
        storageId?: string | null;
        encryptionScheme?: EncryptionScheme | null;
        keyEnvelope: string;
        storageProvider: string;
        ownerCommitment: string;
        encryptedMetadata?: string;
        sourceAdapterIndex?: number;
      };

      // Only tag results with which chain adapter they came from when more
      // than one is actually configured — keeps output shape unchanged for
      // the common single-adapter case (no existing test/consumer needs to
      // account for a new field it never asked for).
      const tagSource = chainAdapters.length > 1;

      let rawItems: RawItem[];

      if (options?.refIds && options.refIds.length > 0) {
        // Fetch each requested ref directly — avoids retrieving the full list.
        // ownerCommitment is not available from readReference; callers that need it
        // should use the no-filter path.
        rawItems = await Promise.all(
          options.refIds.map(async (refId) => {
            const { ref, adapter } = await this._readReferenceFallback(refId);
            return {
              refId,
              storageId: ref.storageId ?? null,
              encryptionScheme: ref.encryptionScheme ?? null,
              keyEnvelope: ref.keyEnvelope,
              storageProvider: ref.storageProvider,
              ownerCommitment: "",
              ...(tagSource
                ? { sourceAdapterIndex: chainAdapters.indexOf(adapter) }
                : {}),
              ...(ref.encryptedMetadata !== undefined
                ? { encryptedMetadata: ref.encryptedMetadata }
                : {}),
            };
          }),
        );
      } else {
        const capable = chainAdapters
          .map((adapter, index) => ({ adapter, index }))
          .filter(
            ({ adapter }) => typeof adapter.listReferences === "function",
          );
        if (capable.length === 0) {
          throw new DStorageError(
            CoreErrorCode.LIST_REFS_NOT_SUPPORTED,
            "[dStorage] listReferences() is not supported by this chain adapter.",
          );
        }

        const { results, failures } = await runParallelWithPolicy({
          kind: "chain",
          operation: "list",
          policy: this.config.chainPolicy,
          candidates: capable.map(({ adapter, index }) => ({
            target: { adapter, index },
            info: this._candidateInfo("chain", adapter),
          })),
          attempt: async ({ adapter, index }) => {
            const items = await adapter.listReferences!();
            const mapped: RawItem[] = items.map((item) => ({
              ...item,
              ...(tagSource ? { sourceAdapterIndex: index } : {}),
            }));
            return mapped;
          },
          rules: {
            allowContinue: false,
            pinned: false,
            commits: false,
            defaultOnFailure: "next",
          },
        });
        if (results.length === 0) {
          throw new DStorageError(
            CoreErrorCode.LIST_REFS_ALL_FAILED,
            `[dStorage] All ${capable.length} configured chain adapters that support listReferences() failed.`,
            { cause: failures },
          );
        }
        if (failures.length > 0) {
          this.logger?.log(
            "dStorage",
            `listReferences() is incomplete: ${failures.length} failed attempt(s) across the configured chain adapters.`,
          );
        }
        rawItems = results.flatMap(({ result }) => result);
      }

      return Promise.all(
        rawItems.map(async (item) => {
          let storageId: string | null = null;
          let decryptionError: string | undefined;
          const isPublic = !item.encryptionScheme;

          let dekScheme: CryptoScheme | undefined;
          let replicas: ReplicaLocation[] = [];

          if (item.storageId) {
            if (isPublic) {
              const parsed = await parsePublicStorageId(item.storageId);
              storageId = parsed.primary;
              replicas = parsed.replicas;
            } else {
              try {
                dekScheme = await this._getDekScheme(item.keyEnvelope);
                const { primary, suffix } = splitOnChainStorageId(
                  item.storageId,
                );
                storageId = await dekScheme.decryptStorageId(primary);
                replicas = await this._decodePrivateReplicas(
                  suffix,
                  dekScheme,
                  item.refId,
                );
              } catch (err) {
                decryptionError =
                  err instanceof Error ? err.message : String(err);
              }
            }
          }

          if (!decryptionError) {
            // For public uploads verify the ownerSeed can be unwrapped; for private
            // this is implicit — if _getDekScheme succeeded above, so would _unwrapDek.
            if (isPublic) {
              try {
                await this._unwrapDek(item.keyEnvelope);
              } catch (err) {
                decryptionError =
                  err instanceof Error ? err.message : String(err);
              }
            }
          }

          let metadata: Record<string, string> | undefined;
          if (item.encryptedMetadata && dekScheme) {
            try {
              const raw = await dekScheme.decryptPayload(
                base64urlToBytes(item.encryptedMetadata),
                METADATA_AAD,
              );
              metadata = JSON.parse(new TextDecoder().decode(raw)) as Record<
                string,
                string
              >;
            } catch {
              // Leave metadata undefined if decryption fails
            }
          }

          return {
            refId: item.refId,
            storageId,
            storageProvider: item.storageProvider,
            encryptionScheme: item.encryptionScheme ?? null,
            keyEnvelope: item.keyEnvelope,
            ownerCommitment: item.ownerCommitment,
            ...(item.sourceAdapterIndex !== undefined
              ? { sourceAdapterIndex: item.sourceAdapterIndex }
              : {}),
            ...(replicas.length > 0 ? { replicas } : {}),
            ...(decryptionError !== undefined ? { decryptionError } : {}),
            ...(metadata !== undefined ? { metadata } : {}),
          };
        }),
      );
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * Remove a reference from the on-chain registry.
   * Only the owner of the reference can successfully call this — the chain
   * enforces ownership via ZK proof using the witness-derived ownerSecret.
   */
  async removeReference(refId: string): Promise<void> {
    try {
      const chainAdapters = this.config.chainAdapters ?? [];
      if (chainAdapters.length === 0) {
        throw new DStorageError(
          CoreErrorCode.REMOVE_REF_REQUIRES_CHAIN,
          "[dStorage] removeReference() requires a chain adapter.",
        );
      }
      if (!chainAdapters.some((a) => typeof a.removeReference === "function")) {
        throw new DStorageError(
          CoreErrorCode.REMOVE_REF_NOT_SUPPORTED,
          "[dStorage] removeReference() is not supported by this chain adapter.",
        );
      }
      const { ownerSecret, adapter: targetChainAdapter } =
        await this._computeOwnerSecret(refId);
      if (typeof targetChainAdapter.removeReference !== "function") {
        throw new DStorageError(
          CoreErrorCode.REMOVE_REF_NOT_SUPPORTED,
          `[dStorage] removeReference() is not supported by the "${targetChainAdapter.name}" chain adapter holding reference "${refId}".`,
        );
      }
      await this._runPinned("chain", "remove", targetChainAdapter, (a) =>
        a.removeReference!(refId, ownerSecret),
      );
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * Estimate the full cost (storage + chain) for a given payload size before committing.
   * Quotes the first configured storage/chain adapter only — the cost that
   * would actually be incurred in the common (non-fallback) case, rather than
   * pre-quoting every configured candidate. A policy can change which adapter
   * is first or fall back on failure. The quote covers one copy, so multiply
   * it when `storagePolicy` writes extra copies.
   */
  async estimateCost(sizeBytes: number): Promise<CostEstimate> {
    try {
      const chainAdapters = this.config.chainAdapters ?? [];
      const buildExhaustedError = (failures: AdapterFailure[]) =>
        new DStorageError(
          CoreErrorCode.ESTIMATE_COST_ALL_FAILED,
          "[dStorage] No configured adapter could estimate the cost.",
          { cause: failures },
        );
      const [{ result: storageQuote }, chainRun] = await Promise.all([
        this._tryEachAdapter(
          this.config.storageAdapters,
          (adapter) => adapter.estimateCost(sizeBytes),
          buildExhaustedError,
          {
            kind: "storage",
            operation: "estimateCost",
            defaultOnFailure: "stop",
          },
        ),
        chainAdapters.length > 0
          ? this._tryEachAdapter(
              chainAdapters,
              (adapter) => adapter.estimateCost(),
              buildExhaustedError,
              {
                kind: "chain",
                operation: "estimateCost",
                defaultOnFailure: "stop",
              },
            )
          : undefined,
      ]);
      const chainQuote = chainRun?.result;

      return {
        storageCost: { amount: storageQuote.amount, token: storageQuote.token },
        ...(chainQuote
          ? {
              chainCost: { amount: chainQuote.amount, token: chainQuote.token },
            }
          : {}),
        fileSizeBytes: sizeBytes,
      };
    } catch (err) {
      wrapError(err);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Upload large content by splitting into CHUNK_SIZE pieces, encrypting each
   * independently, and storing a manifest that ties them together.
   * Only the manifest's storageId is written on-chain.
   */
  private async _uploadChunked(
    bytes: Uint8Array,
    tags: Record<string, string>,
    onProgress?: (p: StoreProgress) => void,
    isPublic = false,
    rawMeta?: Record<string, string>,
    refId?: string,
  ): Promise<StoreResult> {
    if (this._encryptionProviders.length === 0) {
      throw new DStorageError(
        CoreErrorCode.UPLOAD_NO_PROVIDERS,
        "[dStorage] No encryption providers available. Call init() before uploading.",
      );
    }

    const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE);
    const sdkVersion = corePackageJson.version;
    const encryptionScheme = isPublic
      ? ("" as const)
      : ("xchacha20poly1305-v1" as const);

    this.logger?.log(
      "dStorage",
      `Chunked upload: ${bytes.length} bytes → ${totalChunks} chunks${isPublic ? "" : `, encryption scheme: ${encryptionScheme}`}`,
    );

    // For private uploads: generate a fresh DEK, wrap it under all KEKs.
    // For public uploads: generate a random ownerSeed and wrap it under all KEKs
    // (mirrors private DEK handling so any single KEK can re-derive the ownerSecret).
    let uploadScheme: CryptoScheme | null = null;
    let keyEnvelope: string;
    let chunkDek: Uint8Array | undefined;
    let ownerSeed: Uint8Array | undefined;

    if (!isPublic) {
      chunkDek = generateDek();
      uploadScheme = XChaChaScheme.fromKey(chunkDek);
      const wrapperEntries = await Promise.all(
        this._encryptionProviders.map(async (provider) => ({
          wrapKeyName: provider.name,
          ...(await provider.wrapDek(chunkDek!)),
        })),
      );
      keyEnvelope = serializeKeyEnvelope(buildKeyEnvelope(wrapperEntries));
    } else {
      ownerSeed = generateDek();
      const ownerSeedWrappers = await Promise.all(
        this._encryptionProviders.map(async (provider) => ({
          wrapKeyName: provider.name,
          ...(await provider.wrapDek(ownerSeed!)),
        })),
      );
      keyEnvelope = serializeKeyEnvelope(buildKeyEnvelope(ownerSeedWrappers));
    }

    // Whole-operation fallback: each attempt below re-runs the ENTIRE
    // per-chunk loop + manifest upload against one storage adapter candidate.
    // If a candidate fails partway (e.g. chunk 3 of 5), that partial attempt
    // is abandoned outright and the next candidate restarts from chunk 0 —
    // never a per-chunk fallback, since the manifest and on-chain reference
    // each record only a single `provider` and a manifest fetched from
    // adapter A implies its chunks all live on adapter A too. Chunks are
    // re-encrypted from the original plaintext on every retry (not buffered
    // as ciphertext) to preserve chunking's bounded-memory design — trading
    // a small amount of CPU on the rare fallback path for that guarantee.
    //
    // With a storagePolicy returning "continue", each copy is a further whole
    // attempt under the same DEK. Copies run strictly in sequence and keep only
    // their result and hash, so memory stays bounded to one chunk at a time.
    let attemptIndex = -1;
    let completedCopies = 0;
    const { result: primaryUpload, successes: chunkedCopies } =
      await this._tryEachAdapter(
        this.config.storageAdapters,
        async (storageAdapter) => {
          attemptIndex++;
          const copyMeta = this.config.storagePolicy
            ? {
                adapterIndex:
                  this.config.storageAdapters.indexOf(storageAdapter),
                copyIndex: completedCopies,
              }
            : {};
          const chunkEntries: ChunkManifest["chunks"] = [];
          let bytesUploaded = 0;

          for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const chunk = bytes.subarray(start, start + CHUNK_SIZE);

            onProgress?.({
              phase: "encrypting",
              chunksUploaded: i,
              totalChunks,
              bytesUploaded,
              totalBytes: bytes.length,
              attemptIndex,
              ...copyMeta,
            });

            let chunkData: Uint8Array;
            if (isPublic) {
              chunkData = chunk;
            } else {
              chunkData = await uploadScheme!.encryptPayload(
                chunk,
                chunkAad(i, totalChunks),
              );
            }

            onProgress?.({
              phase: "uploading",
              chunksUploaded: i,
              totalChunks,
              bytesUploaded,
              totalBytes: bytes.length,
              attemptIndex,
              ...copyMeta,
            });

            const chunkResult = await storageAdapter.store(chunkData, {
              ...tags,
              [TAG_SDK_VERSION]: sdkVersion,
              [TAG_CONTENT_TYPE]: TAG_CONTENT_TYPE_OCTET_STREAM,
              [TAG_CHUNK_INDEX]: String(i),
              [TAG_CHUNK_TOTAL]: String(totalChunks),
            });

            chunkEntries.push({
              index: i,
              storageId: chunkResult.id,
              size: chunk.length,
            });
            bytesUploaded += chunk.length;

            onProgress?.({
              phase: "uploading",
              chunksUploaded: i + 1,
              totalChunks,
              bytesUploaded,
              totalBytes: bytes.length,
              attemptIndex,
              ...copyMeta,
            });
          }

          // Build and upload the manifest.
          onProgress?.({
            phase: "finalizing",
            chunksUploaded: totalChunks,
            totalChunks,
            bytesUploaded,
            totalBytes: bytes.length,
            attemptIndex,
            ...copyMeta,
          });

          const manifest: ChunkManifest = {
            v: 1,
            type: "dstorage-chunked-manifest",
            totalSize: bytes.length,
            chunkSize: CHUNK_SIZE,
            chunkCount: totalChunks,
            provider: storageAdapter.name,
            chunks: chunkEntries,
          };

          const manifestBytes = new TextEncoder().encode(
            JSON.stringify(manifest),
          );
          const manifestData: Uint8Array = isPublic
            ? manifestBytes
            : await uploadScheme!.encryptPayload(manifestBytes, MANIFEST_AAD);

          const manifestResult = await storageAdapter.store(manifestData, {
            [TAG_SDK_VERSION]: sdkVersion,
            [TAG_CONTENT_TYPE]: isPublic
              ? TAG_CONTENT_TYPE_JSON
              : TAG_CONTENT_TYPE_OCTET_STREAM,
            [TAG_MANIFEST_UPLOAD]: "true",
          });

          completedCopies++;
          return {
            manifestResult,
            contentHash: await computeBlake3Hex(manifestData),
          };
        },
        (failures) =>
          new DStorageError(
            CoreErrorCode.STORAGE_WRITE_ALL_FAILED,
            `[dStorage] All ${this.config.storageAdapters.length} configured storage adapters failed to store the chunked upload.`,
            { cause: failures },
          ),
        {
          kind: "storage",
          operation: "storeChunked",
          // A private chunked upload in storage-only mode has no reference to
          // recover its DEK from, so extra copies would be paid for but unreadable.
          allowContinue:
            isPublic || (this.config.chainAdapters ?? []).length > 0,
          continueHint:
            "private chunked uploads need a chain adapter to record extra copies",
          describe: ({ manifestResult }) => describeUpload(manifestResult),
        },
      ).catch((err: unknown) => {
        chunkDek?.fill(0);
        ownerSeed?.fill(0);
        throw err;
      });
    const { manifestResult } = primaryUpload;
    const replicas = toStoredReplicas(
      chunkedCopies.map(({ adapter, result }) => ({
        adapter,
        upload: result.manifestResult,
        contentHash: result.contentHash,
      })),
    );
    const replicaLocations = toLocations(replicas);

    // For private data: encrypt the manifest storageId with the same per-upload DEK.
    // For public data: write the storageId as plaintext.
    let onChainManifestId: string;
    if (isPublic) {
      onChainManifestId = await composeOnChainStorageId(
        manifestResult.id,
        replicaLocations,
        null,
      );
    } else {
      onChainManifestId = await composeOnChainStorageId(
        await uploadScheme!.encryptStorageId(manifestResult.id),
        replicaLocations,
        uploadScheme,
      );
    }

    // Derive ownerSecret from DEK + raw manifest storageId (private) or ownerSeed + storageId (public).
    const ownerSecret = chunkDek
      ? await deriveOwnerSecret(
          chunkDek,
          new TextEncoder().encode(manifestResult.id),
        )
      : await deriveOwnerSecret(
          ownerSeed!,
          new TextEncoder().encode(manifestResult.id),
          "dstorage:owner-secret:public:v1",
        );

    const chainAdapters = this.config.chainAdapters ?? [];
    if (chainAdapters.length > 0) {
      const { contentHash } = primaryUpload;

      // Emit "stored" before the chain write so callers can persist recovery
      // info proactively (in case the chain write fails or the process crashes).
      const storeRecovery: StoreRecovery = {
        storageId: manifestResult.id,
        storageProvider: manifestResult.provider,
        keyEnvelope: isPublic ? undefined : keyEnvelope,
        contentHash,
        ...(replicaLocations.length > 0 ? { replicas: replicaLocations } : {}),
      };
      onProgress?.({
        phase: "stored",
        chunksUploaded: totalChunks,
        totalChunks,
        bytesUploaded: bytes.length,
        totalBytes: bytes.length,
        recovery: storeRecovery,
      });

      const encryptedMetadata =
        rawMeta && uploadScheme
          ? bytesToBase64url(
              await uploadScheme.encryptPayload(
                new TextEncoder().encode(JSON.stringify(rawMeta)),
                METADATA_AAD,
              ),
            )
          : undefined;
      try {
        const { result: chainResult } = await this._tryEachAdapter(
          chainAdapters,
          (adapter) =>
            adapter.writeReference({
              storageId: onChainManifestId,
              encryptionScheme,
              storageProvider: manifestResult.provider,
              ...(refId !== undefined ? { refId } : {}),
              ...(encryptedMetadata !== undefined ? { encryptedMetadata } : {}),
              writtenAt: Date.now(),
              keyEnvelope,
              contentHash,
              ownerSecret,
            }),
          (failures) =>
            new DStorageError(
              CoreErrorCode.CHAIN_WRITE_ALL_FAILED,
              `[dStorage] All ${chainAdapters.length} configured chain adapters failed to write the reference.`,
              { cause: failures },
            ),
          {
            kind: "chain",
            operation: "store",
            commits: true,
            describe: describeChainWrite,
          },
        );

        const resultRefId = chainResult.refId;
        this.logger?.log(
          "dStorage",
          `Chunked upload complete → ${totalChunks} chunks + manifest, refId: ${resultRefId}`,
        );

        return {
          chainRefId: resultRefId,
          storageId: manifestResult.id,
          storageProvider: manifestResult.provider,
          chainProvider: chainResult.provider,
          uploadedAt: manifestResult.uploadedAt,
          ...(replicas.length > 0 ? { replicas } : {}),
          encryptionScheme,
          costEstimate: {
            storageCost: {
              amount: manifestResult.cost?.amount ?? "unknown",
              token: manifestResult.cost?.token ?? "AR",
            },
            chainCost: {
              amount: chainResult.paymentReceipt?.amount ?? "unknown",
              token: chainResult.paymentReceipt?.token ?? "DUST",
            },
            fileSizeBytes: bytes.length,
          },
        };
      } catch (err) {
        rethrowIfCommitted(err);
        throw new StorePartialError(storeRecovery, err);
      } finally {
        // Safe here: unlike store()'s single-shot path, _uploadChunked never
        // returns uploadScheme (aliasing the same buffer) to the caller in
        // either branch, and this runs after encryptedMetadata — the last
        // use of the key material — has already completed above.
        chunkDek?.fill(0);
        ownerSeed?.fill(0);
      }
    }

    this.logger?.log(
      "dStorage",
      `Chunked upload complete (storage-only) → ${totalChunks} chunks + manifest, storageId: ${manifestResult.id}`,
    );

    chunkDek?.fill(0);
    ownerSeed?.fill(0);

    return {
      storageId: manifestResult.id,
      storageProvider: manifestResult.provider,
      uploadedAt: manifestResult.uploadedAt,
      ...(replicas.length > 0 ? { replicas } : {}),
      encryptionScheme,
      costEstimate: {
        storageCost: {
          amount: manifestResult.cost?.amount ?? "unknown",
          token: manifestResult.cost?.token ?? "AR",
        },
        fileSizeBytes: bytes.length,
      },
    };
  }

  /**
   * Reassemble a chunked file from its manifest.
   * Fetches and decrypts each chunk sequentially to bound memory usage.
   *
   * All chunks are fetched from the same `sourceAdapter` that served the
   * manifest (no per-chunk fallback to a different configured storage
   * adapter) — a manifest and its chunks are always written together in one
   * whole-operation attempt (see `_uploadChunked`), so falling back
   * mid-reassembly to an unrelated adapter would silently return wrong or
   * missing data rather than actually help. When copies are recorded,
   * `_retrieveFromLocations` restarts from the next copy's manifest instead.
   */
  private async _retrieveChunked(
    manifest: ChunkManifest,
    sourceAdapter: StorageAdapter,
    scheme: CryptoScheme | null = null,
    tags: Record<string, string> = {},
  ): Promise<RetrieveResult> {
    // Validate manifest integrity before touching storage.
    if (manifest.chunks.length !== manifest.chunkCount) {
      throw new DStorageError(
        CoreErrorCode.MANIFEST_CHUNK_COUNT_MISMATCH,
        `[dStorage] Manifest declares ${manifest.chunkCount} chunks but contains ${manifest.chunks.length} entries`,
      );
    }
    const sorted = [...manifest.chunks].sort((a, b) => a.index - b.index);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i]!.index !== i) {
        throw new DStorageError(
          CoreErrorCode.MANIFEST_NOT_CONTIGUOUS,
          `[dStorage] Manifest chunk list is not contiguous: expected index ${i}, got ${sorted[i]!.index}`,
        );
      }
    }

    const result = new Uint8Array(manifest.totalSize);
    let offset = 0;

    for (const entry of sorted) {
      const { bytes: rawChunkBytes } = await this._runPinned(
        "storage",
        "retrieveChunk",
        sourceAdapter,
        (adapter) => adapter.retrieve(entry.storageId),
      );

      let chunkBytes = rawChunkBytes;
      if (scheme) {
        try {
          // Bind each chunk to its position: a gateway swapping two chunks will
          // produce an AEAD auth failure because the AAD won't match.
          chunkBytes = await scheme.decryptPayload(
            rawChunkBytes,
            chunkAad(entry.index, manifest.chunkCount),
          );
        } catch (err) {
          throw new DStorageError(
            CoreErrorCode.DECRYPT_CHUNK_FAILED,
            `[dStorage] Failed to decrypt chunk ${entry.index}: ${err}`,
            { cause: err },
          );
        }
      }

      if (offset + chunkBytes.length > manifest.totalSize) {
        throw new DStorageError(
          CoreErrorCode.CHUNK_OVERFLOWS_TOTAL_SIZE,
          `[dStorage] Chunk ${entry.index} overflows manifest totalSize`,
        );
      }
      result.set(chunkBytes, offset);
      offset += chunkBytes.length;

      this.logger?.log(
        "dStorage",
        `Retrieved chunk ${entry.index + 1}/${manifest.chunkCount}: ${chunkBytes.length} bytes`,
      );
    }

    if (offset !== manifest.totalSize) {
      throw new DStorageError(
        CoreErrorCode.REASSEMBLY_SIZE_MISMATCH,
        `[dStorage] Reassembled ${offset} bytes but manifest declares totalSize ${manifest.totalSize}`,
      );
    }

    return {
      bytes: result,
      metadata: {},
      tags,
    };
  }

  private assertConnected(): void {
    if (!this._initialized && this.wallet === null) {
      throw new DStorageError(
        CoreErrorCode.NOT_INITIALIZED,
        "[dStorage] Not connected. Call dStorage.init() first.",
      );
    }
  }
}
