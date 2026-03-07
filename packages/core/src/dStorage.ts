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
} from "@dstorage/crypto";

import type {
  DStorageConfig,
  RetrieveResult,
  UploadResult,
  WalletInfo,
} from "./types.js";
import { MetaTransaction } from "./metaTransaction.js";
import type {
  MetaTxConfig,
  MetaTxProgress,
  MetaTxReceipt,
} from "./metaTransaction.js";

export class DStorage {
  private config: DStorageConfig;
  private wallet: WalletInfo | null = null;
  private encryptionKey: CryptoKey | null = null;
  private _initialized = false;

  constructor(config: DStorageConfig) {
    this.config = config;
  }

  // ── Initialization (new API) ────────────────────────────────────────────────

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

    // 2. Derive encryption key from chain adapter credentials (facade mode)
    /*if (this.config.chainAdapter.getEncryptionKey) {
      this.encryptionKey = await this.config.chainAdapter.getEncryptionKey();
    }*/

    this._initialized = true;
    return this.config.chainAdapter.getContractAddress();
  }

  // ── Connection ──────────────────────────────────────────────────────────────

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
    this.encryptionKey = await deriveKeyFromSignature(
      walletInfo._signatureHex,
      walletInfo.address,
    );

    console.log(`[dStorage] Connected: ${walletInfo.address}`);
  }

  /** Disconnect and clear the in-memory encryption key. */
  disconnect(): void {
    this.wallet = null;
    this.encryptionKey = null;
    this._initialized = false;
    console.log(
      "[dStorage] Disconnected — encryption key cleared from memory.",
    );
  }

  get isConnected(): boolean {
    return (
      (this.wallet !== null && this.encryptionKey !== null) || this._initialized
    );
  }

  get connectedAddress(): string | null {
    return this.wallet?.address ?? null;
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

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

    // 1. Encrypt client-side if key is available; otherwise store raw bytes
    let uploadData: Uint8Array;
    if (this.encryptionKey) {
      const payload = await encrypt(this.encryptionKey, bytes);
      uploadData = new TextEncoder().encode(serializePayload(payload));
    } else {
      uploadData = bytes;
    }

    // 2. Upload to chosen storage network
    const ownerAddress = this.wallet?.address ?? "";
    const storageResult = await this.config.storageAdapter.upload(uploadData, {
      ...metadata,
      "dstorage-version": "0.1.0",
      ...(ownerAddress ? { "dstorage-owner": ownerAddress } : {}),
    });

    // 3. Write on-chain reference — only the pointer, never the data
    const dataLabel = this.config.defaultDataLabel ?? metadata["label"];
    const chainResult = await this.config.chainAdapter.writeReference({
      storageId: storageResult.id,
      storageProvider: storageResult.provider,
      owner: ownerAddress,
      ...(dataLabel !== undefined ? { dataLabel } : {}),
      writtenAt: Date.now(),
    });

    const refId = chainResult.refId;
    const dataId = `${storageResult.id}::${refId}`;

    console.log(`[dStorage] Upload complete → refId: ${refId}`);

    return {
      refId,
      dataId,
      storageId: storageResult.id,
      chainRefId: refId,
      storageProvider: storageResult.provider,
      chainProvider: chainResult.provider,
      uploadedAt: storageResult.uploadedAt,
    };
  }

  // ── Retrieve ───────────────────────────────────────────────────────────────

  /**
   * Retrieve and decrypt data by its dataId.
   * Decryption happens locally — the SDK never sends plaintext anywhere.
   *
   * @param dataId  The dataId returned from upload()
   */
  async retrieve(dataId: string): Promise<RetrieveResult> {
    this.assertConnected();

    const storageId = parseStorageId(dataId);

    // 1. Fetch blob from storage
    const rawBytes = await this.config.storageAdapter.retrieve(storageId);

    // 2. Deserialize and decrypt if an encryption key is available
    let decryptedBytes: Uint8Array;
    if (this.encryptionKey) {
      const payload = deserializePayload(new TextDecoder().decode(rawBytes));
      decryptedBytes = await decrypt(this.encryptionKey, payload);
    } else {
      // No encryption key — assume content was stored as raw bytes
      decryptedBytes = rawBytes;
    }

    const content = new TextDecoder().decode(decryptedBytes);

    console.log(`[dStorage] Retrieved → dataId: ${dataId}`);

    return {
      content,
      bytes: decryptedBytes,
      metadata: {},
    };
  }

  // ── Retrieve by refId ─────────────────────────────────────────────────────

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

    // 1. Resolve the original storage network ID from the on-chain reference
    const adapter = this.config.chainAdapter as unknown as {
      getReference?: (
        refId: string,
      ) => Promise<{ storageId: string; storageProvider: string } | null>;
      readReference?: (refId: string) => Promise<{ storageId: string }>;
    };

    let storageId: string;
    if (typeof adapter.getReference === "function") {
      const ref = await adapter.getReference(refId);
      if (!ref)
        throw new Error(
          `[dStorage] No on-chain reference found for refId: ${refId}`,
        );
      storageId = ref.storageId;
    } else if (typeof adapter.readReference === "function") {
      const ref = await adapter.readReference(refId);
      storageId = ref.storageId;
    } else {
      throw new Error(
        "[dStorage] retrieveByRefId() requires the chain adapter to implement " +
          "getReference() or readReference().",
      );
    }

    // 2. Fetch blob from storage
    const rawBytes = await this.config.storageAdapter.retrieve(storageId);

    // 3. Deserialize and decrypt if an encryption key is available
    let decryptedBytes: Uint8Array;
    if (this.encryptionKey) {
      const payload = deserializePayload(new TextDecoder().decode(rawBytes));
      decryptedBytes = await decrypt(this.encryptionKey, payload);
    } else {
      // No encryption key — assume content was stored as raw bytes
      decryptedBytes = rawBytes;
    }

    const content = new TextDecoder().decode(decryptedBytes);

    console.log(`[dStorage] Retrieved by refId → storageId: ${storageId}`);

    return {
      content,
      bytes: decryptedBytes,
      metadata: {},
    };
  }

  // ── Cost estimation ────────────────────────────────────────────────────────

  /**
   * List references currently available from the configured chain adapter.
   *
   * Supports both shapes used by current adapters:
   *   - { refId, storageId, storageProvider }
   *   - { refId, ref: { storageId, storageProvider } }
   */
  async listReferences(): Promise<
    Array<{ refId: string; storageId: string; storageProvider: string }>
  > {
    const adapter = this.config.chainAdapter as unknown as {
      listReferences?: () => Promise<
        Array<
          | { refId: string; storageId: string; storageProvider: string }
          | {
              refId: string;
              ref: { storageId: string; storageProvider: string };
            }
        >
      >;
    };

    if (typeof adapter.listReferences !== "function") {
      throw new Error(
        "[dStorage] listReferences() is not supported by this chain adapter.",
      );
    }

    const refs = await adapter.listReferences();
    return refs.map((item) => {
      if ("ref" in item) {
        return {
          refId: item.refId,
          storageId: item.ref.storageId,
          storageProvider: item.ref.storageProvider,
        };
      }
      return {
        refId: item.refId,
        storageId: item.storageId,
        storageProvider: item.storageProvider,
      };
    });
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

  // ── Meta-transaction ──────────────────────────────────────────────────────

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

    if (!this.encryptionKey) {
      throw new Error(
        "[dStorage] executeMetaTransaction() requires an encryption key. " +
          "Call connect() with wallet credentials, or use init() with a facade-mode chain adapter.",
      );
    }

    const metaTx = new MetaTransaction(
      this.config.storageAdapter,
      this.config.chainAdapter,
      this.encryptionKey,
      this.wallet?.address ?? "",
      this.config.storagePaymentAdapter,
      this.config.chainPaymentAdapter,
    );

    metaTx.onProgress(onProgress);
    return metaTx.execute(file, config);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this._initialized && this.wallet === null) {
      throw new Error(
        "[dStorage] Not connected. Call dStorage.connect(walletInfo) first.",
      );
    }
  }
}

// ── dataId parsing ────────────────────────────────────────────────────────────

function parseStorageId(dataId: string): string {
  const parts = dataId.split("::");
  if (!parts[0]) throw new Error(`[dStorage] Invalid dataId: ${dataId}`);
  return parts[0];
}

function parseChainRefId(dataId: string): string {
  const parts = dataId.split("::");
  if (!parts[1])
    throw new Error(`[dStorage] Invalid dataId (missing chain ref): ${dataId}`);
  return parts[1];
}
