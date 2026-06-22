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
import { CoreErrorCode, StorePartialError } from "./errors.js";

import type { CryptoScheme } from "@dstorage/crypto";
import type { UploadCrypto } from "./metaTx/index.js";
import type { StorageAdapter } from "@dstorage/storage";
import type { ChainAdapter } from "@dstorage/chain";
import corePackageJson from "../package.json";

import type {
  CostEstimate,
  DStorageConfig,
  Logger,
  ListReferencesOptions,
  RegisterReferenceOptions,
  RegisterReferenceResult,
  RetrieveResult,
  StoreRecovery,
  UpdateResult,
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
import { MetaTx } from "./metaTx/index.js";
import type {
  DStorageContext,
  MetaTxConfig,
  MetaTxProgress,
  MetaTxReceipt,
} from "./metaTx/index.js";
import type { DataReferenceSummary, EncryptionScheme } from "@dstorage/chain";
import { CHUNK_SIZE, ChunkManifest, isManifest } from "./chunked.js";

function wrapError(err: unknown): never {
  if (err instanceof DStorageError) throw err;
  throw new DStorageError(
    CoreErrorCode.UNKNOWN_ERROR,
    `[dStorage] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}

export class DStorage implements DStorageContext {
  private config: DStorageConfig;
  private wallet: WalletInfo | null = null;
  /** Encryption adapters — each wraps/unwraps per-upload DEKs using its own algorithm. */
  private _encryptionProviders: import("@dstorage/encryption").EncryptionAdapter[] =
    [];
  private _initialized = false;
  private readonly logger: Logger | undefined;

  constructor(config: DStorageConfig) {
    this.config = config;
    this.logger = config.logger;
  }

  // ── DStorageContext interface — public accessors ───────────────────────────

  get storageAdapter(): StorageAdapter {
    return this.config.storageAdapter;
  }

  get chainAdapter(): ChainAdapter | undefined {
    return this.config.chainAdapter;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize the SDK:
   *   1. Initialize the chain adapter wallet (if supported), and
   *      deploy a new DataRegistry contract, or connect to an existing one.
   *   2. Derive an encryption key from the chain adapter's credentials (if supported).
   *
   * Returns the address of the DataRegistry contract in use.
   * Call this instead of connect() when using MidnightChainAdapter directly.
   */
  async init() {
    try {
      // 1. Initialize chain adapter wallet (syncs wallet, etc.)
      if (this.config.chainAdapter?.init) {
        await this.config.chainAdapter.init();
      }

      // 2. Store encryption adapters — they wrap/unwrap DEKs on demand.
      this._encryptionProviders = this.config.encryptionAdapters ?? [];

      this._initialized = true;
      return this.config.chainAdapter?.getContractAddress();
    } catch (err) {
      wrapError(err);
    }
  }

  /** Tear down active state and clear all in-memory key material. */
  destroy(): void {
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
   * Files larger than CHUNK_SIZE (5 MB) are automatically split into chunks,
   * each encrypted and stored independently. A manifest file ties them together.
   * Only the manifest's storageId is written on-chain.
   *
   * @param content  Uint8Array to store
   * @param options  Optional StoreOptions (metadata, onProgress, isPublic)
   * @returns        StoreResult containing the dataId needed to retrieve later
   */
  async store(bytes: Uint8Array, options?: StoreOptions): Promise<StoreResult> {
    try {
      this.assertConnected();

      const {
        tags = {},
        metadata: rawMeta,
        onProgress,
        isPublic = false,
      } = options ?? {};

      if (rawMeta !== undefined && isPublic) {
        throw new DStorageError(
          CoreErrorCode.METADATA_WITH_PUBLIC_UPLOAD,
          "[dStorage] metadata cannot be used with isPublic uploads — there is no DEK to encrypt it with.",
        );
      }

      // Route large files through the chunked path.
      if (bytes.length > CHUNK_SIZE) {
        return this._uploadChunked(bytes, tags, onProgress, isPublic, rawMeta);
      }

      // ── Single-shot path (files ≤ 5 MB) ────────────────────────────────────

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
      const sdkVersion = corePackageJson.version ?? "unknown";
      const storageResult = await this.config.storageAdapter.store(uploadData, {
        ...tags,
        "dStorage-version": sdkVersion,
        "Content-Type": "application/octet-stream",
      });

      if (isPublic) {
        // 3a. Public: no content DEK needed. Key envelope and ownerSecret are only
        // needed for on-chain reference management — skip in storage-only mode.
        if (this.config.chainAdapter) {
          if (this._encryptionProviders.length === 0) {
            throw new DStorageError(
              CoreErrorCode.PUBLIC_UPLOAD_REQUIRES_SEED_PROVIDER,
              "[dStorage] Cannot store public data without at least one encryption seed provider. " +
                "Without a provider there is no owner secret, so the reference " +
                "could never be removed or updated.",
            );
          }
          const ownerSeed = generateDek();
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
        }
        // Write storageId as-is on-chain.
        onChainStorageId = storageResult.id;
      } else {
        // 3b. Private: encrypt the storageId with the same per-upload DEK scheme.
        onChainStorageId = await uploadScheme!.encryptStorageId(
          storageResult.id,
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
      //    Skipped in storage-only mode (no chain adapter).
      if (this.config.chainAdapter) {
        const contentHash = await computeBlake3Hex(uploadData);

        // Emit "stored" before the chain write so callers can persist recovery
        // info proactively (in case the chain write fails or the process crashes).
        const storeRecovery: StoreRecovery = {
          storageId: storageResult.id,
          storageProvider: storageResult.provider,
          keyEnvelope: isPublic ? undefined : keyEnvelope,
          contentHash,
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
          const chainResult = await this.config.chainAdapter.writeReference({
            storageId: onChainStorageId,
            encryptionScheme,
            storageProvider: storageResult.provider,
            ...(encryptedMetadata !== undefined ? { encryptedMetadata } : {}),
            writtenAt: Date.now(),
            keyEnvelope,
            contentHash,
            ownerSecret,
          });

          const refId = chainResult.refId;
          this.logger?.log("dStorage", `Upload complete → refId: ${refId}`);

          return {
            chainRefId: refId,
            storageId: storageResult.id,
            storageProvider: storageResult.provider,
            chainProvider: chainResult.provider,
            uploadedAt: storageResult.uploadedAt,
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
        } catch (chainErr) {
          throw new StorePartialError(storeRecovery);
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
      if (!this.config.chainAdapter) {
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
            ? await scheme.encryptStorageId(options.storageId)
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
        const chainResult = await this.config.chainAdapter.writeReference({
          ...(onChainStorageId !== undefined
            ? { storageId: onChainStorageId }
            : {}),
          encryptionScheme: "xchacha20poly1305-v1",
          storageProvider:
            options.storageProvider ?? this.config.storageAdapter.name,
          ...(options.refId !== undefined ? { refId: options.refId } : {}),
          ...(encryptedMetadata !== undefined ? { encryptedMetadata } : {}),
          writtenAt: Date.now(),
          keyEnvelope,
          ...(options.contentHash !== undefined
            ? { contentHash: options.contentHash }
            : {}),
          ownerSecret,
        });
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
   * @param options  Optional StoreOptions. isPublic is ignored.
   */
  async update(
    refId: string,
    bytes: Uint8Array,
    options?: StoreOptions,
  ): Promise<UpdateResult> {
    try {
      this.assertConnected();
      if (!this.config.chainAdapter) {
        throw new DStorageError(
          CoreErrorCode.UPDATE_UPLOAD_REQUIRES_CHAIN,
          "[dStorage] update requires a chain adapter.",
        );
      }
      if (typeof this.config.chainAdapter.updateReference !== "function") {
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

      // Re-derive ownerSecret from the existing reference (proves ownership).
      const ownerSecret = await this._computeOwnerSecret(refId);

      const dek = generateDek();
      try {
        const scheme = XChaChaScheme.fromKey(dek);
        const uploadData = await scheme.encryptPayload(bytes, PAYLOAD_AAD);
        const storageResult = await this.config.storageAdapter.store(
          uploadData,
          {
            ...tags,
            "Content-Type": "application/octet-stream",
          },
        );
        const onChainStorageId = await scheme.encryptStorageId(
          storageResult.id,
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
        await this.config.chainAdapter.updateReference(
          refId,
          {
            storageId: onChainStorageId,
            encryptionScheme: "xchacha20poly1305-v1",
            storageProvider: storageResult.provider,
            ...(encryptedMetadata !== undefined ? { encryptedMetadata } : {}),
            writtenAt: Date.now(),
            keyEnvelope,
            contentHash,
          },
          ownerSecret,
          newOwnerSecret,
        );
        return { chainRefId: refId, storageId: storageResult.id };
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
      if (!this.config.chainAdapter) {
        throw new DStorageError(
          CoreErrorCode.ROTATE_KEYS_REQUIRES_CHAIN,
          "[dStorage] rotateKeys requires a chain adapter.",
        );
      }
      if (typeof this.config.chainAdapter.updateReference !== "function") {
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

      const ref = await this.config.chainAdapter.readReference(refId);
      // Proves ownership — any adapter matching an old wrapper suffices.
      const ownerSecret = await this._computeOwnerSecret(refId);
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
        await this.config.chainAdapter.updateReference(
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
   * @param storageId  The storageId returned from upload()
   */
  async retrieveByStorageId(
    storageId: string,
    dekScheme?: CryptoScheme,
    contentHash?: string,
  ): Promise<RetrieveResult> {
    try {
      this.assertConnected();

      const { bytes: rawBytes, tags } =
        await this.config.storageAdapter.retrieve(storageId);

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

      return this._decryptAndReassemble(rawBytes, storageId, tags, dekScheme);
    } catch (err) {
      wrapError(err);
    }
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
    for (const wrapper of envelope.wrappers) {
      const provider = this._encryptionProviders.find(
        (p) => p.name === wrapper.wrapKeyName,
      );
      if (!provider) continue;
      try {
        const dek = await provider.unwrapDek(wrapper);
        return XChaChaScheme.fromKey(dek);
      } catch {
        // Wrapper didn't match — try the next one.
      }
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
    for (const wrapper of envelope.wrappers) {
      const provider = this._encryptionProviders.find(
        (p) => p.name === wrapper.wrapKeyName,
      );
      if (!provider) continue;
      try {
        return await provider.unwrapDek(wrapper);
      } catch {
        // Wrapper didn't match — try the next one.
      }
    }
    throw new DStorageError(
      CoreErrorCode.UNWRAP_DEK_NO_WRAPPER_MATCHED,
      "[dStorage] Cannot unwrap DEK: this reference was not encrypted with any of your configured keys. " +
        "Check that you are using the correct encryption adapter, password, seed phrase, or keypair.",
      { cause: { code: "no_wrapper_matched" } },
    );
  }

  /**
   * Compute the ownerSecret for an existing on-chain reference.
   * Used by removeReference/updateReference to derive the ZK witness secret.
   *
   * Flow:
   *   1. Read the reference from chain to get keyEnvelope + storageId
   *   2. Unwrap the DEK from keyEnvelope using available KEKs
   *   3. Recover raw storageId (decrypt with DEK if private, plaintext if public)
   *   4. Return HKDF-SHA256(dek, rawStorageId) for private, or HKDF-SHA256(ownerSeed, rawStorageId) for public
   */
  private async _computeOwnerSecret(refId: string): Promise<Uint8Array> {
    const ref = await this.config.chainAdapter!.readReference(refId);
    const isPublic = !ref.encryptionScheme;

    if (isPublic) {
      // Public uploads store a wrapped ownerSeed envelope (any KEK can unwrap it).
      const ownerSeed = await this._unwrapDek(ref.keyEnvelope);
      return deriveOwnerSecret(
        ownerSeed,
        new TextEncoder().encode(ref.storageId),
        "dstorage:owner-secret:public:v1",
      );
    }

    // Private: unwrap DEK, decrypt storageId, derive ownerSecret from DEK.
    // Deterministic: any KEK holder can reproduce this.
    // For metadata-only references (no storageId), use a fixed domain sentinel
    // as the HKDF salt — avoids RFC 5869 empty-salt substitution (zeros(32)).
    const dek = await this._unwrapDek(ref.keyEnvelope);
    const dekScheme = XChaChaScheme.fromKey(dek);
    const rawStorageIdBytes = ref.storageId
      ? new TextEncoder().encode(
          await dekScheme.decryptStorageId(ref.storageId),
        )
      : METADATA_ONLY_OWNER_SECRET_SALT;
    return deriveOwnerSecret(dek, rawStorageIdBytes);
  }

  // Accepts an optional pre-built CryptoScheme (unwrapped from a key envelope).
  // If no dekScheme is provided, content is treated as public (no decryption).
  private async _decryptAndReassemble(
    rawBytes: Uint8Array,
    storageId: string,
    tags: Record<string, string>,
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
        const parsed: unknown = JSON.parse(
          new TextDecoder().decode(manifestBytes),
        );
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
        return this._retrieveChunked(parsed, scheme, tags);
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
        return this._retrieveChunked(parsed, null, tags);
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
   * Retrieve and decrypt data using only its on-chain reference ID.
   *
   * Flow:
   *   1. Look up the reference on-chain by refId to obtain the storage network ID.
   *   2. Fetch the blob from the storage network.
   *   3. Decrypt locally if an encryption key is available.
   *
   * Requires the chain adapter to support getReference() (MidnightChainAdapter)
   * or readReference() (MockChainAdapter).
   *
   * @param refId  The refId returned from upload()
   */
  async retrieveByRefId(refId: string): Promise<RetrieveResult> {
    try {
      this.assertConnected();

      if (!this.config.chainAdapter) {
        throw new DStorageError(
          CoreErrorCode.RETRIEVE_BY_REF_ID_REQUIRES_CHAIN,
          "[dStorage] retrieveByRefId() requires a chain adapter. " +
            "Configure one in DStorageConfig or use retrieveByStorageId() instead.",
        );
      }

      const ref = await this.config.chainAdapter.readReference(refId);
      if (!ref)
        throw new DStorageError(
          CoreErrorCode.REF_NOT_FOUND,
          `[dStorage] No on-chain reference found for refId: ${refId}`,
        );

      if (
        ref.storageProvider &&
        ref.storageProvider !== this.config.storageAdapter.name
      ) {
        throw new DStorageError(
          CoreErrorCode.STORAGE_ADAPTER_MISMATCH,
          `[dStorage] Storage adapter mismatch: reference "${refId}" was stored on ` +
            `"${ref.storageProvider}" but the configured adapter is "${this.config.storageAdapter.name}". ` +
            `Configure a "${ref.storageProvider}" storage adapter to retrieve this reference.`,
        );
      }

      const isPublic = !ref.encryptionScheme;

      // For private data: unwrap the DEK from the key envelope, then use it to
      // decrypt both the on-chain storageId and the stored content.
      // For public data: the storageId is already plaintext.
      // For metadata-only references (no storageId): get the DEK to decrypt
      // encryptedMetadata but skip storage retrieval entirely.
      let storageId: string | undefined;
      let dekScheme: CryptoScheme | undefined;

      if (!ref.storageId) {
        // Metadata-only reference — still need the DEK to decrypt encryptedMetadata.
        if (!isPublic && ref.keyEnvelope) {
          dekScheme = await this._getDekScheme(ref.keyEnvelope);
        }
      } else if (isPublic) {
        storageId = ref.storageId;
      } else {
        if (!ref.keyEnvelope) {
          throw new DStorageError(
            CoreErrorCode.RETRIEVE_BY_REF_ID_ENVELOPE_EMPTY,
            `[dStorage] Cannot decrypt refId ${refId}: key envelope is empty.`,
            { cause: { code: "envelope_empty" } },
          );
        }
        dekScheme = await this._getDekScheme(ref.keyEnvelope);
        storageId = await dekScheme.decryptStorageId(ref.storageId);
      }

      let contentBytes: Uint8Array;
      let contentTags: Record<string, string>;
      if (storageId !== undefined) {
        const r = await this.retrieveByStorageId(
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
        metadata = JSON.parse(new TextDecoder().decode(raw)) as Record<
          string,
          string
        >;
      }

      return { bytes: contentBytes, tags: contentTags, metadata };
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * List references currently available from the configured chain adapter.
   */
  async listReferences(
    options?: ListReferencesOptions,
  ): Promise<DataReferenceSummary[]> {
    try {
      if (!this.config.chainAdapter) {
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
      };

      let rawItems: RawItem[];

      if (options?.refIds && options.refIds.length > 0) {
        // Fetch each requested ref directly — avoids retrieving the full list.
        // ownerCommitment is not available from readReference; callers that need it
        // should use the no-filter path.
        rawItems = await Promise.all(
          options.refIds.map(async (refId) => {
            const ref = await this.config.chainAdapter!.readReference(refId);
            return {
              refId,
              storageId: ref.storageId ?? null,
              encryptionScheme: ref.encryptionScheme ?? null,
              keyEnvelope: ref.keyEnvelope,
              storageProvider: ref.storageProvider,
              ownerCommitment: "",
              ...(ref.encryptedMetadata !== undefined
                ? { encryptedMetadata: ref.encryptedMetadata }
                : {}),
            };
          }),
        );
      } else {
        if (typeof this.config.chainAdapter.listReferences !== "function") {
          throw new DStorageError(
            CoreErrorCode.LIST_REFS_NOT_SUPPORTED,
            "[dStorage] listReferences() is not supported by this chain adapter.",
          );
        }
        rawItems = await this.config.chainAdapter.listReferences();
      }

      return Promise.all(
        rawItems.map(async (item) => {
          let storageId: string | null = null;
          let decryptionError: string | undefined;
          const isPublic = !item.encryptionScheme;

          let dekScheme: CryptoScheme | undefined;

          if (item.storageId) {
            if (isPublic) {
              storageId = item.storageId;
            } else {
              try {
                dekScheme = await this._getDekScheme(item.keyEnvelope);
                storageId = await dekScheme.decryptStorageId(item.storageId);
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
      if (!this.config.chainAdapter) {
        throw new DStorageError(
          CoreErrorCode.REMOVE_REF_REQUIRES_CHAIN,
          "[dStorage] removeReference() requires a chain adapter.",
        );
      }
      if (typeof this.config.chainAdapter.removeReference !== "function") {
        throw new DStorageError(
          CoreErrorCode.REMOVE_REF_NOT_SUPPORTED,
          "[dStorage] removeReference() is not supported by this chain adapter.",
        );
      }
      const ownerSecret = await this._computeOwnerSecret(refId);
      await this.config.chainAdapter.removeReference(refId, ownerSecret);
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * Estimate the full cost (storage + chain) for a given payload size before committing.
   */
  async estimateCost(sizeBytes: number): Promise<CostEstimate> {
    try {
      const [storageQuote, chainQuote] = await Promise.all([
        this.config.storageAdapter.estimateCost(sizeBytes),
        this.config.chainAdapter?.estimateCost(),
      ]);

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

  /**
   * Execute a full meta-transaction for a file:
   * estimate → encrypt → pay storage → upload → pay chain → write reference
   *
   * Presents the entire flow as a single action with step-by-step progress.
   *
   * @param file        The File to encrypt and store
   * @param onProgress  Callback fired on every step state change
   * @param config      Optional token overrides and metadata
   */
  async executeMetaTransaction(
    file: File,
    onProgress: (progress: MetaTxProgress) => void,
    config: MetaTxConfig = {},
  ): Promise<MetaTxReceipt> {
    try {
      this.assertConnected();

      if (this._encryptionProviders.length === 0) {
        throw new DStorageError(
          CoreErrorCode.META_TX_REQUIRES_ENCRYPTION,
          "[dStorage] executeMetaTransaction() requires at least one encryption provider.",
        );
      }

      const metaTx = new MetaTx(this);
      metaTx.onProgress(onProgress);
      return metaTx.execute(file, config);
    } catch (err) {
      wrapError(err);
    }
  }

  /**
   * Generate a fresh random DEK, wrap it under the KEK(s), and return the crypto
   * materials needed by MetaTx to encrypt payload and storageId.
   *
   * For private stores: the DEK is wrapped under every available KEK. The ownerSecret
   * can later be re-derived as HKDF(dek, rawStorageId) by any KEK holder.
   * For public stores: a random ownerSeed is generated and wrapped under all KEKs (same pattern).
   */
  async prepareUploadCrypto(isPublic = false): Promise<UploadCrypto> {
    try {
      if (this._encryptionProviders.length === 0) {
        throw new DStorageError(
          CoreErrorCode.PREPARE_UPLOAD_NO_PROVIDERS,
          "[dStorage] Cannot prepare upload crypto: no encryption providers. Call init() first.",
        );
      }

      if (isPublic) {
        const ownerSeed = generateDek();
        const ownerSeedWrappers = await Promise.all(
          this._encryptionProviders.map(async (provider) => ({
            wrapKeyName: provider.name,
            ...(await provider.wrapDek(ownerSeed)),
          })),
        );
        const keyEnvelope = serializeKeyEnvelope(
          buildKeyEnvelope(ownerSeedWrappers),
        );
        return {
          uploadScheme: null,
          keyEnvelope,
          encryptionScheme: "",
          ownerSeed,
        };
      }

      // Private: generate a fresh DEK for this upload.
      const dek = generateDek();
      const uploadScheme = XChaChaScheme.fromKey(dek);
      const wrapperEntries = await Promise.all(
        this._encryptionProviders.map(async (provider) => ({
          wrapKeyName: provider.name,
          ...(await provider.wrapDek(dek)),
        })),
      );
      const keyEnvelope = serializeKeyEnvelope(
        buildKeyEnvelope(wrapperEntries),
      );
      return {
        uploadScheme,
        keyEnvelope,
        encryptionScheme: "xchacha20poly1305-v1",
        dek,
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
  ): Promise<StoreResult> {
    if (this._encryptionProviders.length === 0) {
      throw new DStorageError(
        CoreErrorCode.UPLOAD_NO_PROVIDERS,
        "[dStorage] No encryption providers available. Call init() before uploading.",
      );
    }

    const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE);
    const sdkVersion = corePackageJson.version ?? "unknown";
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
      });

      const chunkResult = await this.config.storageAdapter.store(chunkData, {
        ...tags,
        "dStorage-version": sdkVersion,
        "Content-Type": "application/octet-stream",
        "dstorage-chunk-index": String(i),
        "dstorage-chunk-total": String(totalChunks),
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
      });
    }

    // Build and upload the manifest.
    onProgress?.({
      phase: "finalizing",
      chunksUploaded: totalChunks,
      totalChunks,
      bytesUploaded,
      totalBytes: bytes.length,
    });

    const manifest: ChunkManifest = {
      v: 1,
      type: "dstorage-chunked-manifest",
      totalSize: bytes.length,
      chunkSize: CHUNK_SIZE,
      chunkCount: totalChunks,
      provider: this.config.storageAdapter.name,
      chunks: chunkEntries,
    };

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    let manifestData: Uint8Array;
    if (isPublic) {
      manifestData = manifestBytes;
    } else {
      manifestData = await uploadScheme!.encryptPayload(
        manifestBytes,
        MANIFEST_AAD,
      );
    }

    const manifestResult = await this.config.storageAdapter.store(
      manifestData,
      {
        "dStorage-version": sdkVersion,
        "Content-Type": "application/octet-stream",
        "dStorage-manifest-upload": "true",
      },
    );

    // For private data: encrypt the manifest storageId with the same per-upload DEK.
    // For public data: write the storageId as plaintext.
    let onChainManifestId: string;
    if (isPublic) {
      onChainManifestId = manifestResult.id;
    } else {
      onChainManifestId = await uploadScheme!.encryptStorageId(
        manifestResult.id,
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

    if (this.config.chainAdapter) {
      const contentHash = await computeBlake3Hex(manifestData);

      // Emit "stored" before the chain write so callers can persist recovery
      // info proactively (in case the chain write fails or the process crashes).
      const storeRecovery: StoreRecovery = {
        storageId: manifestResult.id,
        storageProvider: manifestResult.provider,
        keyEnvelope: isPublic ? undefined : keyEnvelope,
        contentHash,
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
        const chainResult = await this.config.chainAdapter.writeReference({
          storageId: onChainManifestId,
          encryptionScheme,
          storageProvider: manifestResult.provider,
          ...(encryptedMetadata !== undefined ? { encryptedMetadata } : {}),
          writtenAt: Date.now(),
          keyEnvelope,
          contentHash,
          ownerSecret,
        });

        const refId = chainResult.refId;
        this.logger?.log(
          "dStorage",
          `Chunked upload complete → ${totalChunks} chunks + manifest, refId: ${refId}`,
        );

        return {
          chainRefId: refId,
          storageId: manifestResult.id,
          storageProvider: manifestResult.provider,
          chainProvider: chainResult.provider,
          uploadedAt: manifestResult.uploadedAt,
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
      } catch (chainErr) {
        throw new StorePartialError(storeRecovery);
      }
    }

    this.logger?.log(
      "dStorage",
      `Chunked upload complete (storage-only) → ${totalChunks} chunks + manifest, storageId: ${manifestResult.id}`,
    );

    return {
      storageId: manifestResult.id,
      storageProvider: manifestResult.provider,
      uploadedAt: manifestResult.uploadedAt,
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
   */
  private async _retrieveChunked(
    manifest: ChunkManifest,
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
      const { bytes: rawChunkBytes } =
        await this.config.storageAdapter.retrieve(entry.storageId);

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
