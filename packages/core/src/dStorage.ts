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
 *   const { chainRefId, storageId } = await ds.upload(new TextEncoder().encode("hello"));
 *   const { bytes } = await ds.retrieveByRefId(chainRefId);
 *   await ds.listReferences();
 *   await ds.removeReference(chainRefId);
 */

import { XChaChaScheme } from "@dstorage/crypto";
import {
  generateDek,
  buildKeyEnvelope,
  serializeKeyEnvelope,
  parseKeyEnvelope,
  deriveOwnerSecret,
} from "@dstorage/crypto";

import type { CryptoScheme } from "@dstorage/crypto";
import type { UploadCrypto } from "./metaTx/index.js";
import type { StorageAdapter } from "@dstorage/storage";
import type { ChainAdapter } from "@dstorage/chain";
import corePackageJson from "../package.json";

import type {
  CostEstimate,
  DStorageConfig,
  Logger,
  RetrieveResult,
  UploadOptions,
  UploadProgress,
  UploadResult,
  WalletInfo,
} from "./types.js";
import { PAYLOAD_AAD, MANIFEST_AAD, chunkAad } from "./types.js";
import { MetaTx } from "./metaTx/index.js";
import type {
  DStorageContext,
  MetaTxConfig,
  MetaTxProgress,
  MetaTxReceipt,
} from "./metaTx/index.js";
import type { DataReferenceSummary } from "@dstorage/chain";
import { CHUNK_SIZE, ChunkManifest, isManifest } from "./chunked.js";

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
    // 1. Initialize chain adapter wallet (syncs wallet, etc.)
    if (this.config.chainAdapter?.init) {
      await this.config.chainAdapter.init();
    }

    // 2. Store encryption adapters — they wrap/unwrap DEKs on demand.
    this._encryptionProviders = this.config.encryptionAdapters ?? [];

    this._initialized = true;
    return this.config.chainAdapter?.getContractAddress();
  }

  /** Disconnect and clear the in-memory encryption providers. */
  disconnect(): void {
    this.wallet = null;
    this._encryptionProviders = [];
    this._initialized = false;
    this.logger?.log(
      "dStorage",
      "Disconnected — encryption key cleared from memory.",
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
   * Encrypt content client-side, upload to decentralised storage,
   * and write a cryptographic reference on-chain.
   *
   * Files larger than CHUNK_SIZE (5 MB) are automatically split into chunks,
   * each encrypted and uploaded independently. A manifest file ties them together.
   * Only the manifest's storageId is written on-chain.
   *
   * @param content          Uint8Array to store
   * @param metadataOrOptions  Optional metadata or UploadOptions (with onProgress callback)
   * @returns                UploadResult containing the dataId needed to retrieve later
   */
  async upload(
    bytes: Uint8Array,
    metadataOrOptions: Record<string, string> | UploadOptions = {},
  ): Promise<UploadResult> {
    this.assertConnected();

    // Distinguish old-style metadata object from new UploadOptions.
    let metadata: Record<string, string>;
    let onProgress: ((p: UploadProgress) => void) | undefined;
    let isPublic = false;
    if (
      "onProgress" in metadataOrOptions ||
      "metadata" in metadataOrOptions ||
      "isPublic" in metadataOrOptions
    ) {
      const opts = metadataOrOptions as UploadOptions;
      metadata = opts.metadata ?? {};
      onProgress = opts.onProgress;
      isPublic = opts.isPublic ?? false;
    } else {
      metadata = metadataOrOptions as Record<string, string>;
    }

    // Route large files through the chunked path.
    if (bytes.length > CHUNK_SIZE) {
      return this._uploadChunked(bytes, metadata, onProgress, isPublic);
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
        throw new Error(
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
    const storageResult = await this.config.storageAdapter.upload(uploadData, {
      ...metadata,
      "dStorage-version": sdkVersion,
      "Content-Type": "application/octet-stream",
    });

    if (isPublic) {
      // 3a. Public: no content DEK needed. Key envelope and ownerSecret are only
      // needed for on-chain reference management — skip in storage-only mode.
      if (this.config.chainAdapter) {
        if (this._encryptionProviders.length === 0) {
          throw new Error(
            "[dStorage] Cannot upload public data without at least one encryption seed provider. " +
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
        keyEnvelope = serializeKeyEnvelope(buildKeyEnvelope(ownerSeedWrappers));
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
      onChainStorageId = await uploadScheme!.encryptStorageId(storageResult.id);

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
      const dataLabel = metadata["label"];
      const chainResult = await this.config.chainAdapter.writeReference({
        storageId: onChainStorageId,
        encryptionScheme,
        storageProvider: storageResult.provider,
        ...(dataLabel !== undefined ? { dataLabel } : {}),
        writtenAt: Date.now(),
        keyEnvelope,
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
  ): Promise<RetrieveResult> {
    this.assertConnected();

    // 1. Fetch blob from storage
    const rawBytes = await this.config.storageAdapter.retrieve(storageId);

    return this._decryptAndReassemble(rawBytes, storageId, dekScheme);
  }

  /**
   * Unwrap the data DEK from a key envelope and return an XChaChaScheme built from it.
   * Throws if the KEK is not available or the envelope cannot be parsed.
   * Only valid for private uploads (envelope.wrappers must be present).
   */
  private async _getDekScheme(keyEnvelope: string): Promise<CryptoScheme> {
    if (this._encryptionProviders.length === 0) {
      throw new Error(
        "[dStorage] Cannot decrypt: no encryption providers. Call init() before retrieving private data.",
      );
    }
    const envelope = parseKeyEnvelope(keyEnvelope);
    if (!envelope) {
      throw new Error(
        "[dStorage] Cannot decrypt: key envelope is missing or malformed.",
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
        // This wrapper/provider pair didn't match — try the next wrapper.
      }
    }
    throw new Error(
      "[dStorage] Cannot decrypt: this reference was not encrypted with any of your configured keys. " +
        "Check that you are using the correct encryption adapter, password, seed phrase, or keypair.",
    );
  }

  /**
   * Unwrap the raw DEK bytes from a key envelope using the available KEKs.
   * The ownerSecret for the reference can be re-derived as HKDF(dek, rawStorageId).
   * Throws if no wrapper matches any available KEK.
   */
  private async _unwrapDek(keyEnvelope: string): Promise<Uint8Array> {
    if (this._encryptionProviders.length === 0) {
      throw new Error(
        "[dStorage] Cannot unwrap DEK: no encryption providers. Call init() first.",
      );
    }
    const envelope = parseKeyEnvelope(keyEnvelope);
    if (!envelope) {
      throw new Error(
        "[dStorage] Cannot unwrap DEK: key envelope is missing or malformed.",
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
        // This wrapper/provider pair didn't match — try the next wrapper.
      }
    }
    throw new Error(
      "[dStorage] Cannot unwrap DEK: this reference was not encrypted with any of your configured keys. " +
        "Check that you are using the correct encryption adapter, password, seed phrase, or keypair.",
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
    const dek = await this._unwrapDek(ref.keyEnvelope);
    const dekScheme = XChaChaScheme.fromKey(dek);
    const rawStorageId = await dekScheme.decryptStorageId(ref.storageId);
    return deriveOwnerSecret(dek, new TextEncoder().encode(rawStorageId));
  }

  // Accepts an optional pre-built CryptoScheme (unwrapped from a key envelope).
  // If no dekScheme is provided, content is treated as public (no decryption).
  private async _decryptAndReassemble(
    rawBytes: Uint8Array,
    storageId: string,
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
          throw new Error(
            "[dStorage] Payload authenticated as manifest but has invalid structure",
          );
        }
        this.logger?.log(
          "dStorage",
          `Manifest detected: reassembling ${parsed.chunkCount} chunks`,
        );
        return this._retrieveChunked(parsed, scheme);
      }

      // Not a manifest — decrypt as regular payload.
      let decryptedBytes: Uint8Array;
      try {
        decryptedBytes = await scheme.decryptPayload(rawBytes, PAYLOAD_AAD);
      } catch (err) {
        throw new Error(`[dStorage] Failed to decrypt payload: ${err}`);
      }

      this.logger?.log(
        "dStorage",
        `Retrieved by refId → storageId: ${storageId}`,
      );
      return { bytes: decryptedBytes, metadata: {} };
    }

    // Public upload (no encryption): fall back to JSON shape detection for manifests.
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBytes));
      if (isManifest(parsed)) {
        this.logger?.log(
          "dStorage",
          `Manifest detected: reassembling ${parsed.chunkCount} chunks`,
        );
        return this._retrieveChunked(parsed, null);
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
    this.assertConnected();

    if (!this.config.chainAdapter) {
      throw new Error(
        "[dStorage] retrieveByRefId() requires a chain adapter. " +
          "Configure one in DStorageConfig or use retrieveByStorageId() instead.",
      );
    }

    const ref = await this.config.chainAdapter.readReference(refId);
    if (!ref)
      throw new Error(
        `[dStorage] No on-chain reference found for refId: ${refId}`,
      );

    if (ref.storageProvider !== this.config.storageAdapter.name) {
      throw new Error(
        `[dStorage] Storage adapter mismatch: reference "${refId}" was stored on ` +
          `"${ref.storageProvider}" but the configured adapter is "${this.config.storageAdapter.name}". ` +
          `Configure a "${ref.storageProvider}" storage adapter to retrieve this reference.`,
      );
    }

    const isPublic = !ref.encryptionScheme;

    // For private data: unwrap the DEK from the key envelope, then use it to
    // decrypt both the on-chain storageId and the stored content.
    // For public data: the storageId is already plaintext.
    let storageId: string;
    let dekScheme: CryptoScheme | undefined;
    if (isPublic) {
      storageId = ref.storageId;
    } else {
      if (!ref.keyEnvelope) {
        throw new Error(
          `[dStorage] Cannot decrypt refId ${refId}: key envelope is missing.`,
        );
      }
      dekScheme = await this._getDekScheme(ref.keyEnvelope);
      storageId = await dekScheme.decryptStorageId(ref.storageId);
    }

    return await this.retrieveByStorageId(storageId, dekScheme);
  }

  /**
   * List references currently available from the configured chain adapter.
   */
  async listReferences(): Promise<DataReferenceSummary[]> {
    if (!this.config.chainAdapter) {
      throw new Error("[dStorage] listReferences() requires a chain adapter.");
    }
    if (typeof this.config.chainAdapter.listReferences !== "function") {
      throw new Error(
        "[dStorage] listReferences() is not supported by this chain adapter.",
      );
    }

    const refs = await this.config.chainAdapter.listReferences();
    return Promise.all(
      refs.map(async (item) => {
        let storageId: string | null = null;
        let decryptionError: string | undefined;
        const isPublic = !item.encryptionScheme;

        if (item.storageId) {
          if (isPublic) {
            storageId = item.storageId;
          } else {
            try {
              const dekScheme = await this._getDekScheme(item.keyEnvelope);
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

        return {
          refId: item.refId,
          storageId,
          storageProvider: item.storageProvider,
          encryptionScheme: item.encryptionScheme,
          keyEnvelope: item.keyEnvelope,
          ownerCommitment: item.ownerCommitment,
          ...(decryptionError !== undefined ? { decryptionError } : {}),
        };
      }),
    );
  }

  /**
   * Remove a reference from the on-chain registry.
   * Only the owner of the reference can successfully call this — the chain
   * enforces ownership via ZK proof using the witness-derived ownerSecret.
   */
  async removeReference(refId: string): Promise<void> {
    if (!this.config.chainAdapter) {
      throw new Error("[dStorage] removeReference() requires a chain adapter.");
    }
    if (typeof this.config.chainAdapter.removeReference !== "function") {
      throw new Error(
        "[dStorage] removeReference() is not supported by this chain adapter.",
      );
    }
    const ownerSecret = await this._computeOwnerSecret(refId);
    await this.config.chainAdapter.removeReference(refId, ownerSecret);
  }

  /**
   * Estimate the full cost (storage + chain) for a given payload size before committing.
   */
  async estimateCost(sizeBytes: number): Promise<CostEstimate> {
    const [storageQuote, chainQuote] = await Promise.all([
      this.config.storageAdapter.estimateCost(sizeBytes),
      this.config.chainAdapter?.estimateCost(),
    ]);

    return {
      storageCost: { amount: storageQuote.amount, token: storageQuote.token },
      ...(chainQuote
        ? { chainCost: { amount: chainQuote.amount, token: chainQuote.token } }
        : {}),
      fileSizeBytes: sizeBytes,
    };
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
    this.assertConnected();

    if (this._encryptionProviders.length === 0) {
      throw new Error(
        "[dStorage] executeMetaTransaction() requires at least one encryption provider.",
      );
    }

    const metaTx = new MetaTx(this);
    metaTx.onProgress(onProgress);
    return metaTx.execute(file, config);
  }

  /**
   * Generate a fresh random DEK, wrap it under the KEK(s), and return the upload
   * crypto materials needed by MetaTx to encrypt payload and storageId.
   *
   * For private uploads: the DEK is wrapped under every available KEK. The ownerSecret
   * can later be re-derived as HKDF(dek, rawStorageId) by any KEK holder.
   * For public uploads: a random ownerSeed is generated and wrapped under all KEKs (same pattern).
   */
  async prepareUploadCrypto(isPublic = false): Promise<UploadCrypto> {
    if (this._encryptionProviders.length === 0) {
      throw new Error(
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
    const keyEnvelope = serializeKeyEnvelope(buildKeyEnvelope(wrapperEntries));
    return {
      uploadScheme,
      keyEnvelope,
      encryptionScheme: "xchacha20poly1305-v1",
      dek,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Upload large content by splitting into CHUNK_SIZE pieces, encrypting each
   * independently, and storing a manifest that ties them together.
   * Only the manifest's storageId is written on-chain.
   */
  private async _uploadChunked(
    bytes: Uint8Array,
    metadata: Record<string, string>,
    onProgress?: (p: UploadProgress) => void,
    isPublic = false,
  ): Promise<UploadResult> {
    if (this._encryptionProviders.length === 0) {
      throw new Error(
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

      const chunkResult = await this.config.storageAdapter.upload(chunkData, {
        ...metadata,
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

    const manifestResult = await this.config.storageAdapter.upload(
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
      const dataLabel = metadata["label"];
      const chainResult = await this.config.chainAdapter.writeReference({
        storageId: onChainManifestId,
        encryptionScheme,
        storageProvider: manifestResult.provider,
        ...(dataLabel !== undefined ? { dataLabel } : {}),
        writtenAt: Date.now(),
        keyEnvelope,
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
  ): Promise<RetrieveResult> {
    // Validate manifest integrity before touching storage.
    if (manifest.chunks.length !== manifest.chunkCount) {
      throw new Error(
        `[dStorage] Manifest declares ${manifest.chunkCount} chunks but contains ${manifest.chunks.length} entries`,
      );
    }
    const sorted = [...manifest.chunks].sort((a, b) => a.index - b.index);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i]!.index !== i) {
        throw new Error(
          `[dStorage] Manifest chunk list is not contiguous: expected index ${i}, got ${sorted[i]!.index}`,
        );
      }
    }

    const result = new Uint8Array(manifest.totalSize);
    let offset = 0;

    for (const entry of sorted) {
      const rawChunkBytes = await this.config.storageAdapter.retrieve(
        entry.storageId,
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
          throw new Error(
            `[dStorage] Failed to decrypt chunk ${entry.index}: ${err}`,
          );
        }
      }

      if (offset + chunkBytes.length > manifest.totalSize) {
        throw new Error(
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
      throw new Error(
        `[dStorage] Reassembled ${offset} bytes but manifest declares totalSize ${manifest.totalSize}`,
      );
    }

    return {
      bytes: result,
      metadata: {},
    };
  }

  private assertConnected(): void {
    if (!this._initialized && this.wallet === null) {
      throw new Error("[dStorage] Not connected. Call dStorage.init() first.");
    }
  }
}
