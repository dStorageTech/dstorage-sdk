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
import type { PaymentAdapter } from "@dstorage/payment";
import corePackageJson from "../package.json";

import type {
  DStorageConfig,
  Logger,
  RetrieveResult,
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

  get chainPaymentAdapter(): PaymentAdapter | undefined {
    return this.config.chainPaymentAdapter;
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
   * @param content   Plain-text string or Uint8Array to store
   * @param metadata  Optional key-value metadata attached to the storage transaction
   * @returns         UploadResult containing the dataId needed to retrieve later
   */
  async upload(
    content: string | Uint8Array,
    metadata: Record<string, string> = {},
  ): Promise<UploadResult> {
    this.assertConnected();

    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;

    // NOTE: Large file support is a known limitation. The entire payload is held
    // in memory (plaintext + ciphertext + base64-encoded form) which can peak at
    // ~4× the file size. Streaming encryption and chunked uploads will be
    // supported in a future release.
    const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(
        `[dStorage] Content exceeds the 10 MB upload limit (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB). ` +
          "Large file support is planned for a future release.",
      );
    }

    // 1. Encrypt client-side if key is available; otherwise store raw bytes
    let uploadData = (await this.encryptPayload(bytes)) ?? bytes;

    // 2. Upload to chosen storage network
    const sdkVersion = corePackageJson.version ?? "unknown";
    const storageResult = await this.config.storageAdapter.upload(uploadData, {
      ...metadata,
      "dStorage-version": sdkVersion,
      "Content-Type": "application/octet-stream",
    });

    // 3. Encrypt the storageId before writing on-chain — keeps the storage pointer private.
    // The encrypted form is an 80-char base64url string (60 bytes), compatible with Bytes<60>.
    // If no key is available we store it unencrytpted assuming is public data.
    const encryptedStorageId =
      (await this.encryptStorageIdForChain(storageResult.id)) ??
      storageResult.id;

    // 4. Write on-chain reference — only the encrypted pointer, never the data
    const dataLabel = this.config.defaultDataLabel ?? metadata["label"];
    const chainResult = await this.config.chainAdapter.writeReference({
      storageId: encryptedStorageId,
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
    };
  }

  /**
   * Retrieve and decrypt data by its storageId.
   * Decryption happens locally — the SDK never sends plaintext anywhere.
   *
   * @param storageId  The storageId returned from upload()
   */
  async retrieveByStorageId(storageId: string): Promise<RetrieveResult> {
    this.assertConnected();

    // 1. Fetch blob from storage
    const rawBytes = await this.config.storageAdapter.retrieve(storageId);

    // 2. Deserialize and decrypt if an encryption key is available
    // If no encryption key — assume content was stored as raw bytes
    let decryptedBytes = rawBytes;
    if (this._encryptionKey) {
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

    // Decrypt the on-chain storageId to recover the original storage network ID.
    const storageId =
      (await this._decryptStorageId(ref.storageId)) ?? ref.storageId;
    return await this.retrieveByStorageId(storageId);
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
          try {
            storageId = await this._decryptStorageId(item.storageId);
          } catch {}
        }
        return {
          refId: item.refId,
          storageId,
          storageProvider: item.storageProvider,
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
   * which is base64url-encoded to an 80-char string for the Bytes<60> contract field.
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
   * Decrypt a storageId retrieved from the chain back to the original storage network ID.
   *
   * If no storageIdKey is available, returns null
   */
  private async _decryptStorageId(encryptedId: string): Promise<string | null> {
    if (!this._storageIdKey) return null;
    try {
      const bytes = base64urlToBytes(encryptedId); // 60 bytes (80-char base64url input)
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
