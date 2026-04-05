/**
 * @dstorage/core — dStorage.ts
 *
 * The main SDK class. Orchestrates:
 *   1. Seed-provider key generation   (@dstorage/seed-providers + @dstorage/crypto)
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

import { CryptoSchemeRegistry, XChaChaScheme } from "@dstorage/crypto";
import {
  generateDek,
  deriveKek,
  wrapKey,
  unwrapKey,
  buildKeyEnvelope,
  serializeKeyEnvelope,
  parseKeyEnvelope,
  findWrapper,
} from "@dstorage/crypto";
import type { CryptoScheme, EncryptionScheme } from "@dstorage/crypto";
import type { StorageAdapter } from "@dstorage/storage";
import type { ChainAdapter } from "@dstorage/chain";
import corePackageJson from "../package.json";

import type {
  DStorageConfig,
  Logger,
  RetrieveResult,
  UploadOptions,
  UploadProgress,
  UploadResult,
  WalletInfo,
} from "./types.js";
import { MetaTx } from "./metaTx/index.js";
import type {
  DStorageContext,
  MetaTxConfig,
  MetaTxProgress,
  MetaTxReceipt,
} from "./metaTx/index.js";
import { DataReferenceSummary } from "@dstorage/chain";
import { CHUNK_SIZE, ChunkManifest, isManifest } from "./chunked.js";

export class DStorage implements DStorageContext {
  private config: DStorageConfig;
  private wallet: WalletInfo | null = null;
  private _cryptoSchemes: CryptoSchemeRegistry | null = null; // null until connect() or init()
  /** Key Encryption Key derived from the seed provider — used to wrap/unwrap per-upload DEKs. */
  private _kek: Uint8Array | null = null;
  /** Scheme used for all new writes. Part of DStorageContext — consumed by MetaTransaction. */
  readonly defaultEncryptionScheme: EncryptionScheme = "xchacha20poly1305-v1";
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

  get chainAdapter(): ChainAdapter {
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
    if (this.config.chainAdapter.init) {
      await this.config.chainAdapter.init();
    }

    // 2. Resolve encryption seed, derive KEK, and set up crypto scheme registry.
    if (this.config.encryptionSeedProvider) {
      const seed = await this.config.encryptionSeedProvider.getSeed();
      this._cryptoSchemes = await CryptoSchemeRegistry.create(seed);
      this._kek = await deriveKek(seed);
      this.config.chainAdapter.setScheme?.(this._cryptoSchemes.getDefault());
    }

    this._initialized = true;
    return this.config.chainAdapter.getContractAddress();
  }

  /** Disconnect and clear the in-memory encryption keys. */
  disconnect(): void {
    this.wallet = null;
    this._cryptoSchemes = null;
    this._kek = null;
    this._initialized = false;
    this.logger?.log(
      "dStorage",
      "Disconnected — encryption key cleared from memory.",
    );
  }

  get isConnected(): boolean {
    return (
      (this.wallet !== null && this._cryptoSchemes !== null) ||
      this._initialized
    );
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

    let keyEnvelope: string | undefined;
    // Per-upload scheme: for private uploads this holds an XChaChaScheme
    // built from a fresh random DEK (not the seed-derived key).
    let uploadScheme: CryptoScheme | null = null;

    if (isPublic) {
      // 1a. Public: store raw bytes, write storageId as plaintext on-chain.
      uploadData = bytes;
    } else {
      // 1b. Private: generate a random DEK, encrypt content with it.
      if (!this._kek) {
        throw new Error(
          "[dStorage] Encryption key not available. Call init() before uploading private data.",
        );
      }
      const dek = generateDek();
      uploadScheme = XChaChaScheme.fromKey(dek);
      this.logger?.log(
        "dStorage",
        `Encrypting content using scheme: ${encryptionScheme}`,
      );
      uploadData = await uploadScheme.encryptPayload(bytes);

      // Wrap the DEK under the KEK and build the key envelope.
      const wrappedDek = await wrapKey(dek, this._kek);
      keyEnvelope = serializeKeyEnvelope(buildKeyEnvelope(wrappedDek));
    }

    // 2. Upload to chosen storage network
    const sdkVersion = corePackageJson.version ?? "unknown";
    const storageResult = await this.config.storageAdapter.upload(uploadData, {
      ...metadata,
      "dStorage-version": sdkVersion,
      "Content-Type": "application/octet-stream",
    });

    if (isPublic) {
      // 3a. Public: write storageId as-is on-chain.
      onChainStorageId = storageResult.id;
    } else {
      // 3b. Private: encrypt the storageId with the same per-upload DEK scheme.
      onChainStorageId = await uploadScheme!.encryptStorageId(storageResult.id);
    }

    // 4. Write on-chain reference — only the storage pointer, never the data
    const dataLabel = metadata["label"];
    const chainResult = await this.config.chainAdapter.writeReference({
      storageId: onChainStorageId,
      encryptionScheme,
      storageProvider: storageResult.provider,
      ...(dataLabel !== undefined ? { dataLabel } : {}),
      writtenAt: Date.now(),
      isOurs: true,
      ...(keyEnvelope !== undefined ? { keyEnvelope } : {}),
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
        storageCost: {
          amount: storageResult.cost ?? "unknown",
          token: "AR", // FIXME: this.config.storageAdapter.tokenSymbol
        },
        chainCost: {
          amount: chainResult.paymentReceipt?.amount ?? "unknown",
          token: "DUST", // FIXME: this.config.chainAdapter.tokenSymbol
        },
        fileSizeBytes: uploadData.length,
      },
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
    encryptionScheme?: EncryptionScheme,
  ): Promise<RetrieveResult> {
    this.assertConnected();

    // 1. Fetch blob from storage
    const rawBytes = await this.config.storageAdapter.retrieve(storageId);

    return this._decryptAndReassemble(rawBytes, storageId, encryptionScheme);
  }

  /**
   * Unwrap the DEK from a key envelope and return an XChaChaScheme built from it.
   * Throws if the KEK is not available or the envelope cannot be parsed.
   */
  private async _getDekScheme(keyEnvelope: string): Promise<CryptoScheme> {
    if (!this._kek) {
      throw new Error(
        "[dStorage] Cannot decrypt: KEK not available. Call init() before retrieving private data.",
      );
    }
    const envelope = parseKeyEnvelope(keyEnvelope);
    if (!envelope) {
      throw new Error(
        "[dStorage] Cannot decrypt: key envelope is missing or malformed.",
      );
    }
    // Use the first wrapper — in v1 there is always exactly one.
    const wrapper = findWrapper(envelope, envelope.wrappers[0].wrapKeyName);
    if (!wrapper) {
      throw new Error(
        `[dStorage] Cannot decrypt: wrapper '${envelope.wrappers[0].wrapKeyName}' not found in envelope.`,
      );
    }
    const dek = await unwrapKey(wrapper.wrappedDek, this._kek);
    return XChaChaScheme.fromKey(dek);
  }

  // Accepts a pre-built CryptoScheme (from a key envelope) or an encryptionScheme
  // name to look up from the registry. Throws if private and no scheme is available.
  private async _decryptAndReassemble(
    rawBytes: Uint8Array,
    storageId: string,
    encryptionScheme?: EncryptionScheme,
    dekScheme?: CryptoScheme,
  ): Promise<RetrieveResult> {
    let scheme: CryptoScheme | null = dekScheme ?? null;
    if (!scheme && encryptionScheme) {
      scheme = this._cryptoSchemes?.get(encryptionScheme) ?? null;
      if (scheme === null) {
        throw new Error(
          `[dStorage] Cannot decrypt: scheme '${encryptionScheme}' is not available in the registry.`,
        );
      }
    }

    // 2. Decrypt if content is private; return raw bytes if public.
    let decryptedBytes = rawBytes;
    if (scheme) {
      try {
        decryptedBytes = await scheme.decryptPayload(rawBytes);
        this.logger?.log(
          "dStorage",
          `Data decrypted successfully: ${decryptedBytes.byteLength} bytes`,
        );
      } catch (err) {
        throw new Error(`[dStorage] Failed to decrypt payload: ${err}`);
      }
    }

    // 3. Detect chunked manifest and reassemble transparently.
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder().decode(decryptedBytes),
      );
      if (isManifest(parsed)) {
        this.logger?.log(
          "dStorage",
          `Manifest detected: reassembling ${parsed.chunkCount} chunks`,
        );
        return this._retrieveChunked(parsed, scheme);
      }
    } catch {
      // Not JSON — treat as raw content, fall through.
    }

    this.logger?.log(
      "dStorage",
      `Retrieved by refId → storageId: ${storageId}`,
    );

    return {
      bytes: decryptedBytes,
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

    const ref = await this.config.chainAdapter.readReference(refId);
    if (!ref)
      throw new Error(
        `[dStorage] No on-chain reference found for refId: ${refId}`,
      );

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

    const rawBytes = await this.config.storageAdapter.retrieve(storageId);
    return this._decryptAndReassemble(
      rawBytes,
      storageId,
      ref.encryptionScheme,
      dekScheme,
    );
  }

  /**
   * List references currently available from the configured chain adapter.
   */
  async listReferences(): Promise<DataReferenceSummary[]> {
    if (typeof this.config.chainAdapter.listReferences !== "function") {
      throw new Error(
        "[dStorage] listReferences() is not supported by this chain adapter.",
      );
    }

    const refs = await this.config.chainAdapter.listReferences();
    return Promise.all(
      refs.map(async (item) => {
        let storageId: string | null = null;
        if (item.storageId) {
          const isPublic = !item.encryptionScheme;
          if (isPublic) {
            storageId = item.storageId;
          } else if (item.keyEnvelope) {
            try {
              const dekScheme = await this._getDekScheme(item.keyEnvelope);
              storageId = await dekScheme.decryptStorageId(item.storageId);
            } catch {
              /* we cannot decrypt */
            }
          }
        }
        return {
          refId: item.refId,
          storageId,
          storageProvider: item.storageProvider,
          encryptionScheme: item.encryptionScheme,
          ownerCommitment: item.ownerCommitment,
          isOurs: item.isOurs,
        };
      }),
    );
  }

  /**
   * Remove a reference from the on-chain registry.
   * Only the owner of the reference can successfully call this — the chain
   * enforces ownership via ZK proof.
   */
  async removeReference(refId: string): Promise<void> {
    if (typeof this.config.chainAdapter.removeReference !== "function") {
      throw new Error(
        "[dStorage] removeReference() is not supported by this chain adapter.",
      );
    }
    await this.config.chainAdapter.removeReference(refId);
  }

  /**
   * Estimate the storage cost for a given content string before committing.
   * Returns a human-readable cost string.
   */
  async estimateCost(content: Uint8Array): Promise<string> {
    if (this.config.storageAdapter.estimateCost) {
      return this.config.storageAdapter.estimateCost(content);
    }
    return "Cost estimation not available for this storage provider.";
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

    if (!this._cryptoSchemes) {
      throw new Error(
        "[dStorage] executeMetaTransaction() requires an encryption key.",
      );
    }

    const metaTx = new MetaTx(this);
    metaTx.onProgress(onProgress);
    return metaTx.execute(file, config);
  }

  /**
   * Encrypt raw payload bytes with the active client-side key and serialize them
   * into the SDK wire format expected by storage adapters.
   * Returns null when no encryption key is available.
   */
  async encryptPayload(bytes: Uint8Array): Promise<Uint8Array | null> {
    if (!this._cryptoSchemes) return null;
    this.logger?.log("dStorage", "Encrypting content...");
    return this._cryptoSchemes.getDefault().encryptPayload(bytes);
  }

  /**
   * Encrypt a storageId string before writing it to the chain using XChaCha20-Poly1305.
   *
   * The storageId must be a 43-char base64url string (32 bytes decoded) —
   * this is the format used by Arweave txIds and MockStorageAdapter IDs.
   * Encryption produces a 72-byte output:
   *   [ nonce(24) | ciphertext(32) | auth-tag(16) ],
   * which is base64url-encoded to a 96-char string stored as Opaque<"string"> in the contract.
   *
   * If no key is available (e.g. unauthenticated state), it returns null.
   *
   * @internal — part of DStorageContext; used by MetaTransaction.
   */
  async encryptStorageIdForChain(storageId: string): Promise<string | null> {
    if (!this._cryptoSchemes) return null;
    return this._cryptoSchemes.getDefault().encryptStorageId(storageId);
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
    if (!isPublic && !this._kek) {
      throw new Error(
        "[dStorage] Encryption key not available. Call init() before uploading private data.",
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

    // Generate one DEK for all chunks + manifest of this upload.
    let uploadScheme: CryptoScheme | null = null;
    let keyEnvelope: string | undefined;
    if (!isPublic) {
      const dek = generateDek();
      uploadScheme = XChaChaScheme.fromKey(dek);
      const wrappedDek = await wrapKey(dek, this._kek!);
      keyEnvelope = serializeKeyEnvelope(buildKeyEnvelope(wrappedDek));
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
        chunkData = await uploadScheme!.encryptPayload(chunk);
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
      provider: "mock", // will be overwritten by manifestResult.provider below
      chunks: chunkEntries,
    };

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    let manifestData: Uint8Array;
    if (isPublic) {
      manifestData = manifestBytes;
    } else {
      manifestData = await uploadScheme!.encryptPayload(manifestBytes);
    }

    const manifestResult = await this.config.storageAdapter.upload(
      manifestData,
      {
        "dStorage-version": sdkVersion,
        "Content-Type": "application/octet-stream",
        "dStorage-manifest-upload": "true",
      },
    );

    // Update manifest provider now that we have it, and re-upload isn't needed —
    // the provider field is informational only (retrieval uses stored chunk storageIds).
    // We store the provider in the manifest for debugging; patch the in-memory object only.
    manifest.provider = manifestResult.provider;

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

    const dataLabel = metadata["label"];
    const chainResult = await this.config.chainAdapter.writeReference({
      storageId: onChainManifestId,
      encryptionScheme,
      storageProvider: manifestResult.provider,
      ...(dataLabel !== undefined ? { dataLabel } : {}),
      writtenAt: Date.now(),
      isOurs: true,
      ...(keyEnvelope !== undefined ? { keyEnvelope } : {}),
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
          amount: manifestResult.cost ?? "unknown",
          token: "AR",
        },
        chainCost: {
          amount: chainResult.paymentReceipt?.amount ?? "unknown",
          token: "DUST",
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
    const result = new Uint8Array(manifest.totalSize);
    let offset = 0;

    for (const entry of manifest.chunks) {
      const rawChunkBytes = await this.config.storageAdapter.retrieve(
        entry.storageId,
      );

      let chunkBytes = rawChunkBytes;
      if (scheme) {
        try {
          chunkBytes = await scheme!.decryptPayload(rawChunkBytes);
        } catch (err) {
          throw new Error(
            `[dStorage] Failed to decrypt chunk ${entry.index}: ${err}`,
          );
        }
      }

      result.set(chunkBytes, offset);
      offset += chunkBytes.length;

      this.logger?.log(
        "dStorage",
        `Retrieved chunk ${entry.index + 1}/${manifest.chunkCount}: ${chunkBytes.length} bytes`,
      );
    }

    return {
      bytes: result,
      metadata: {},
    };
  }

  /**
   * Decrypt a storageId retrieved from the chain back to the original storage network ID.
   *
   * Returns null if no schemeName is provided or the scheme is not found in the registry.
   */
  private async _decryptStorageId(
    encryptedId: string,
    schemeName?: EncryptionScheme,
  ): Promise<string | null> {
    if (!schemeName) return null;
    const scheme = this._cryptoSchemes?.get(schemeName) ?? null;
    if (!scheme) return null;
    try {
      return await scheme.decryptStorageId(encryptedId);
    } catch {
      throw new Error(
        "[dStorage] Failed to decrypt storageId — the record may have been encrypted with a different key.",
      );
    }
  }

  /**
   * Convert a hex string (with or without 0x prefix) to a Uint8Array.
   * Used to derive the seed bytes from the wallet signature hex.
   */
  private _hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  private assertConnected(): void {
    if (!this._initialized && this.wallet === null) {
      throw new Error(
        "[dStorage] Not connected. Call dStorage.connect(walletInfo) first.",
      );
    }
  }
}
