/**
 * @dstorage/core — dStorage.ts
 *
 * The main SDK class. Orchestrates:
 *   1. Wallet-derived key generation  (@dstorage/crypto)
 *   2. Client-side encryption         (@dstorage/crypto)
 *   3. Decentralised storage          (@dstorage/storage)
 *   4. On-chain reference writing     (@dstorage/chain)
 *
 * Developer API:
 *   const ds = new DStorage(config);
 *   await ds.connect(walletInfo);
 *   const { dataId } = await ds.upload("hello, private world");
 *   const { content } = await ds.retrieve(dataId);
 *   await ds.grant(dataId, "0xRecipientAddress");
 *   await ds.revoke(dataId, "0xRecipientAddress");
 */

import {
  encrypt,
  decrypt,
  serializePayload,
  deserializePayload,
  deriveKeyFromSignature,
  deriveStorageIdKey,
  encryptStorageId,
  decryptStorageId,
  base64urlToBytes,
  bytesToBase64url,
} from "@dstorage/crypto";
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
import { MetaTransaction } from "./metaTransaction.js";
import type {
  DStorageContext,
  MetaTxConfig,
  MetaTxProgress,
  MetaTxReceipt,
} from "./metaTransaction.js";
import { DataReferenceSummary } from "@dstorage/chain";
import { CHUNK_SIZE, ChunkManifest, isManifest } from "./chunked.js";

export class DStorage implements DStorageContext {
  private config: DStorageConfig;
  private wallet: WalletInfo | null = null;
  private _encryptionKey: CryptoKey | null = null;
  /** AES-GCM key for encrypting storage IDs — derived from the same root as _encryptionKey. */
  private _storageIdKey: CryptoKey | null = null;
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
    // 1. Initialize chain adapter wallet (derives keys, syncs wallet, etc.)
    if (this.config.chainAdapter.init) {
      await this.config.chainAdapter.init();
    }

    // 2. Derive encryption keys from chain adapter credentials (facade mode)
    if (this.config.chainAdapter.getEncryptionKey) {
      this._encryptionKey = await this.config.chainAdapter.getEncryptionKey();
    }
    if (this.config.chainAdapter.getStorageIdKey) {
      this._storageIdKey = await this.config.chainAdapter.getStorageIdKey();
    }

    this._initialized = true;
    return this.config.chainAdapter.getContractAddress();
  }

  /**
   * Bind the SDK to a connected wallet.
   * Must be called before upload() or retrieve().
   *
   * The walletInfo is obtained from connectMetaMask() or connectMidnightWallet()
   * helpers, which prompt the user to sign the key-derivation message.
   */
  async connect(walletInfo: WalletInfo): Promise<void> {
    this.wallet = walletInfo;

    // Derive a deterministic AES-GCM key from the wallet signature.
    // The key never leaves the device and is not persisted.
    this._encryptionKey = await deriveKeyFromSignature(
      walletInfo._signatureHex,
      walletInfo.address,
    );

    // Derive a separate AES-GCM key for storage ID encryption (same root, different salt).
    this._storageIdKey = await deriveStorageIdKey(
      walletInfo._signatureHex,
      `dstorage-storageId-v1:${walletInfo.address}`,
    );

    this.logger?.log("dStorage", `Connected: ${walletInfo.address}`);
  }

  /** Disconnect and clear the in-memory encryption keys. */
  disconnect(): void {
    this.wallet = null;
    this._encryptionKey = null;
    this._storageIdKey = null;
    this._initialized = false;
    this.logger?.log(
      "dStorage",
      "Disconnected — encryption key cleared from memory.",
    );
  }

  get isConnected(): boolean {
    return (
      (this.wallet !== null && this._encryptionKey !== null) ||
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
   * @param content          Plain-text string or Uint8Array to store
   * @param metadataOrOptions  Optional metadata or UploadOptions (with onProgress callback)
   * @returns                UploadResult containing the dataId needed to retrieve later
   */
  async upload(
    content: string | Uint8Array,
    metadataOrOptions: Record<string, string> | UploadOptions = {},
  ): Promise<UploadResult> {
    this.assertConnected();

    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;

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
    const encryptionScheme = isPublic ? ("" as const) : ("aes-gcm-v1" as const);

    if (isPublic) {
      // 1a. Public: store raw bytes, write storageId as plaintext on-chain.
      uploadData = bytes;
      onChainStorageId = ""; // set after storage upload below
    } else {
      // 1b. Private: encrypt content — fail if no encryption key is available.
      if (!this._encryptionKey || !this._storageIdKey) {
        throw new Error(
          "[dStorage] Encryption keys not available. Call connect() or init() before uploading private data.",
        );
      }
      this.logger?.log("dStorage", "Encrypting content...");
      const payload = await encrypt(this._encryptionKey, bytes);
      uploadData = new TextEncoder().encode(serializePayload(payload));
      onChainStorageId = ""; // set after storage upload below
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
      // 3b. Private: encrypt the storageId before writing on-chain.
      // The encrypted form is an 80-char base64url string stored as Opaque<"string"> in the contract.
      const encrypted = await encryptStorageId(
        this._storageIdKey!,
        base64urlToBytes(storageResult.id),
      );
      onChainStorageId = bytesToBase64url(encrypted);
    }

    // 4. Write on-chain reference — only the storage pointer, never the data
    const dataLabel = this.config.defaultDataLabel ?? metadata["label"];
    const chainResult = await this.config.chainAdapter.writeReference({
      storageId: onChainStorageId,
      encryptionScheme,
      storageProvider: storageResult.provider,
      ...(dataLabel !== undefined ? { dataLabel } : {}),
      writtenAt: Date.now(),
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
    isPublic = false,
  ): Promise<RetrieveResult> {
    this.assertConnected();

    // 1. Fetch blob from storage
    const rawBytes = await this.config.storageAdapter.retrieve(storageId);

    // 2. Decrypt if content is private; return raw bytes if public.
    let decryptedBytes = rawBytes;
    if (!isPublic) {
      if (!this._encryptionKey) {
        throw new Error(
          "[dStorage] Encryption key not available. Call connect() or init() before retrieving private data.",
        );
      }
      const encryptedPayload = deserializePayload(
        new TextDecoder().decode(rawBytes),
      );
      if (encryptedPayload) {
        try {
          decryptedBytes = await decrypt(this._encryptionKey, encryptedPayload);
          this.logger?.log(
            "dStorage",
            `Data decrypted successfully: ${decryptedBytes.byteLength} bytes`,
          );
        } catch (err) {
          throw new Error(`[dStorage] Failed to decrypt payload: ${err}`);
        }
      } else {
        // It's not the expected payload for encrypted content,
        // thus assume it's not encrypted
        this.logger?.log(
          "dStorage",
          `Retrieved non encrypted content of ${decryptedBytes.byteLength} bytes`,
        );
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
        return this._retrieveChunked(parsed, isPublic);
      }
    } catch {
      // Not JSON — treat as raw content, fall through.
    }

    this.logger?.log(
      "dStorage",
      `Retrieved by refId → storageId: ${storageId}`,
    );

    return {
      content: new TextDecoder().decode(decryptedBytes),
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

    // encryptionScheme === "aes-gcm-v1" means encrypted; "" or undefined means public.
    const isPublic = !ref.encryptionScheme;

    // For private data: decrypt the on-chain storageId to recover the original storage network ID.
    // For public data: the storageId is already plaintext.
    let storageId: string;
    if (isPublic) {
      storageId = ref.storageId;
    } else {
      const decrypted = await this._decryptStorageId(ref.storageId);
      if (!decrypted) {
        throw new Error(
          `[dStorage] Failed to decrypt storageId for refId: ${refId}`,
        );
      }
      storageId = decrypted;
    }
    return await this.retrieveByStorageId(storageId, isPublic);
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
          } else {
            try {
              storageId = await this._decryptStorageId(item.storageId);
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
        };
      }),
    );
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

    if (!this._encryptionKey) {
      throw new Error(
        "[dStorage] executeMetaTransaction() requires an encryption key. " +
          "Call connect() with wallet credentials, or use init() with a facade-mode chain adapter.",
      );
    }

    const metaTx = new MetaTransaction(this);
    metaTx.onProgress(onProgress);
    return metaTx.execute(file, config);
  }

  /**
   * Encrypt raw payload bytes with the active client-side key and serialize them
   * into the SDK wire format expected by storage adapters.
   * Returns null when no encryption key is available.
   */
  async encryptPayload(bytes: Uint8Array): Promise<Uint8Array | null> {
    if (this._encryptionKey) {
      this.logger?.log("dStorage", "Encrypting content...");
      const payload = await encrypt(this._encryptionKey, bytes);
      return new TextEncoder().encode(serializePayload(payload));
    } else {
      return null;
    }
  }

  /**
   * Encrypt a storageId string before writing it to the chain.
   *
   * The storageId must be a 43-char base64url string (32 bytes decoded) —
   * this is the format used by Arweave txIds and MockStorageAdapter IDs.
   * AES-GCM encryption produces a 60-byte output (ciphertext + IV + tag),
   * which is base64url-encoded to an 80-char string stored as Opaque<"string"> in the contract.
   *
   * If no storageIdKey is available (e.g. unauthenticated state), it returns null
   *
   * @internal — part of DStorageContext; used by MetaTransaction.
   */
  async encryptStorageIdForChain(storageId: string): Promise<string | null> {
    if (!this._storageIdKey) return null;
    const bytes = base64urlToBytes(storageId); // 32 bytes (43-char base64url input)
    const encrypted = await encryptStorageId(this._storageIdKey, bytes); // 60 bytes
    return bytesToBase64url(encrypted); // 80-char base64url string
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
    if (!isPublic && (!this._encryptionKey || !this._storageIdKey)) {
      throw new Error(
        "[dStorage] Encryption keys not available. Call connect() or init() before uploading private data.",
      );
    }

    const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE);
    const sdkVersion = corePackageJson.version ?? "unknown";
    const encryptionScheme = isPublic ? ("" as const) : ("aes-gcm-v1" as const);

    this.logger?.log(
      "dStorage",
      `Chunked upload: ${bytes.length} bytes → ${totalChunks} chunks`,
    );

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
        const payload = await encrypt(this._encryptionKey!, chunk);
        chunkData = new TextEncoder().encode(serializePayload(payload));
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
      const payload = await encrypt(this._encryptionKey!, manifestBytes);
      manifestData = new TextEncoder().encode(serializePayload(payload));
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

    // For private data: encrypt the manifest storageId before writing on-chain.
    // For public data: write the storageId as plaintext.
    let onChainManifestId: string;
    if (isPublic) {
      onChainManifestId = manifestResult.id;
    } else {
      const encrypted = await encryptStorageId(
        this._storageIdKey!,
        base64urlToBytes(manifestResult.id),
      );
      onChainManifestId = bytesToBase64url(encrypted);
    }

    const dataLabel = this.config.defaultDataLabel ?? metadata["label"];
    const chainResult = await this.config.chainAdapter.writeReference({
      storageId: onChainManifestId,
      encryptionScheme,
      storageProvider: manifestResult.provider,
      ...(dataLabel !== undefined ? { dataLabel } : {}),
      writtenAt: Date.now(),
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
    isPublic = false,
  ): Promise<RetrieveResult> {
    if (!isPublic && !this._encryptionKey) {
      throw new Error(
        "[dStorage] Encryption key not available. Call connect() or init() before retrieving private data.",
      );
    }

    const result = new Uint8Array(manifest.totalSize);
    let offset = 0;

    for (const entry of manifest.chunks) {
      const rawChunkBytes = await this.config.storageAdapter.retrieve(
        entry.storageId,
      );

      let chunkBytes = rawChunkBytes;
      if (!isPublic) {
        const encryptedPayload = deserializePayload(
          new TextDecoder().decode(rawChunkBytes),
        );
        if (encryptedPayload) {
          try {
            chunkBytes = await decrypt(this._encryptionKey!, encryptedPayload);
          } catch (err) {
            throw new Error(
              `[dStorage] Failed to decrypt chunk ${entry.index}: ${err}`,
            );
          }
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
      content: new TextDecoder().decode(result),
      bytes: result,
      metadata: {},
    };
  }

  /**
   * Decrypt a storageId retrieved from the chain back to the original storage network ID.
   *
   * If no storageIdKey is available, returns null
   */
  private async _decryptStorageId(encryptedId: string): Promise<string | null> {
    if (!this._storageIdKey) return null;
    try {
      const bytes = base64urlToBytes(encryptedId); // 60 bytes: [ciphertext(32) | IV(12) | tag(16)]
      const decrypted = await decryptStorageId(this._storageIdKey, bytes); // 32 bytes
      return bytesToBase64url(decrypted); // 43-char base64url (original storage ID)
    } catch {
      throw new Error(
        "[dStorage] Failed to decrypt storageId — the record may have been encrypted with a different key.",
      );
    }
  }

  private assertConnected(): void {
    if (!this._initialized && this.wallet === null) {
      throw new Error(
        "[dStorage] Not connected. Call dStorage.connect(walletInfo) first.",
      );
    }
  }
}
