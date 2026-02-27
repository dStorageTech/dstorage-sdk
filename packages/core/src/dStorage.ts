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
} from '@dstorage/crypto';

import type { ChainReference, CircuitCallResult } from '@dstorage/chain';
import type { DStorageConfig, RetrieveResult, UploadResult, WalletInfo } from './types.js';
import { MetaTransaction } from './metaTransaction.js';
import type { MetaTxConfig, MetaTxProgress, MetaTxReceipt } from './metaTransaction.js';

export class DStorage {
  private config: DStorageConfig;
  private wallet: WalletInfo | null = null;
  private encryptionKey: CryptoKey | null = null;

  constructor(config: DStorageConfig) {
    this.config = config;
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
      walletInfo.address
    );

    console.log(`[dStorage] Connected: ${walletInfo.address}`);
  }

  /** Disconnect and clear the in-memory encryption key. */
  disconnect(): void {
    this.wallet = null;
    this.encryptionKey = null;
    console.log('[dStorage] Disconnected — encryption key cleared from memory.');
  }

  get isConnected(): boolean {
    return this.wallet !== null && this.encryptionKey !== null;
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
    metadata: Record<string, string> = {}
  ): Promise<UploadResult> {
    this.assertConnected();

    const bytes =
      typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content;

    // 1. Encrypt client-side — plaintext never leaves this function unencrypted
    const payload = await encrypt(this.encryptionKey!, bytes);
    const serialized = serializePayload(payload);

    // 2. Upload encrypted payload to chosen storage network
    const storageResult = await this.config.storageAdapter.upload(
      serialized,
      {
        ...metadata,
        'dstorage-version': '0.1.0',
        'dstorage-owner': this.wallet!.address,
      }
    );

    // 3. Write on-chain reference — only the pointer, never the data
    const dataLabel = this.config.defaultDataLabel ?? metadata['label'];
    const chainResult = await this.config.chainAdapter.writeReference({
      storageId: storageResult.id,
      storageProvider: storageResult.provider,
      owner: this.wallet!.address,
      ...(dataLabel !== undefined ? { dataLabel } : {}),
      createdAt: Date.now(),
    });

    const dataId = `${storageResult.id}::${chainResult.refId}`;

    console.log(`[dStorage] Upload complete → dataId: ${dataId}`);

    return {
      dataId,
      storageId: storageResult.id,
      chainRefId: chainResult.refId,
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

    // 1. Fetch encrypted blob from storage
    const serialized = await this.config.storageAdapter.retrieve(storageId);

    // 2. Deserialize and decrypt locally
    const payload = deserializePayload(serialized);
    const decryptedBytes = await decrypt(this.encryptionKey!, payload);
    const content = new TextDecoder().decode(decryptedBytes);

    console.log(`[dStorage] Retrieved and decrypted → dataId: ${dataId}`);

    return {
      content,
      bytes: decryptedBytes,
      metadata: {},
    };
  }

  // ── Permissions ────────────────────────────────────────────────────────────

  /**
   * Grant another wallet address read access to a specific dataId.
   * Writes a permission record on-chain.
   */
  async grant(dataId: string, recipientAddress: string): Promise<string> {
    this.assertConnected();

    const chainRefId = parseChainRefId(dataId);

    const permId = await this.config.chainAdapter.grantAccess({
      refId: chainRefId,
      grantee: recipientAddress,
    });

    console.log(`[dStorage] Access granted: ${recipientAddress} → ${dataId}`);
    return permId;
  }

  /**
   * Revoke a previously granted permission.
   */
  async revoke(dataId: string, recipientAddress: string): Promise<void> {
    this.assertConnected();

    const chainRefId = parseChainRefId(dataId);
    await this.config.chainAdapter.revokeAccess(chainRefId, recipientAddress);

    console.log(`[dStorage] Access revoked: ${recipientAddress} → ${dataId}`);
  }

  /**
   * Check if a wallet address has access to a dataId.
   */
  async hasAccess(dataId: string, walletAddress: string): Promise<boolean> {
    const chainRefId = parseChainRefId(dataId);
    return this.config.chainAdapter.hasAccess(chainRefId, walletAddress);
  }

  // ── Cost estimation ────────────────────────────────────────────────────────

  /**
   * Estimate the storage cost for a given content string before committing.
   * Returns a human-readable cost string.
   */
  async estimateCost(content: string): Promise<string> {
    if (this.config.storageAdapter.estimateCost) {
      return this.config.storageAdapter.estimateCost(content);
    }
    return 'Cost estimation not available for this storage provider.';
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
    config: MetaTxConfig = {}
  ): Promise<MetaTxReceipt> {
    this.assertConnected();

    const metaTx = new MetaTransaction(
      this.config.storageAdapter,
      this.config.chainAdapter,
      this.encryptionKey!,
      this.wallet!.address,
      this.config.storagePaymentAdapter,
      this.config.chainPaymentAdapter
    );

    metaTx.onProgress(onProgress);
    return metaTx.execute(file, config);
  }

  // ── List references ────────────────────────────────────────────────────────

  /**
   * List all references stored in the contract ledger.
   *
   * Requires the chain adapter to support `listReferences()` (e.g.
   * `MidnightChainAdapter` with the full compiled module, or `MockMidnightChainAdapter`).
   * Does not require a connected wallet — reading the ledger is unauthenticated.
   */
  async listReferences(): Promise<Array<{ refId: string; ref: ChainReference }>> {
    if (!this.config.chainAdapter.listReferences) {
      throw new Error(
        '[dStorage] The current chain adapter does not support listReferences(). ' +
          'Use MidnightChainAdapter or MockMidnightChainAdapter.'
      );
    }
    return this.config.chainAdapter.listReferences();
  }

  // ── Custom circuit calls ───────────────────────────────────────────────────

  /**
   * Call a custom ZK circuit on the connected chain adapter.
   *
   * Runs the full prove → balance → submit pipeline for the named circuit.
   * Only available when using an adapter that supports ZK proving
   * (e.g. MidnightChainAdapter or MockMidnightChainAdapter).
   *
   * @param circuitName  The exact circuit name as compiled by compactc
   * @param inputs       Positional arguments forwarded to the circuit call
   */
  async executeCircuit(circuitName: string, inputs: unknown[]): Promise<CircuitCallResult> {
    this.assertConnected();

    if (!this.config.chainAdapter.callCircuit) {
      throw new Error(
        '[dStorage] The current chain adapter does not support callCircuit(). ' +
          'Use MidnightChainAdapter or MockMidnightChainAdapter.'
      );
    }

    return this.config.chainAdapter.callCircuit(circuitName, inputs);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this.isConnected) {
      throw new Error(
        '[dStorage] Not connected. Call dStorage.connect(walletInfo) first.'
      );
    }
  }
}

// ── dataId parsing ────────────────────────────────────────────────────────────

function parseStorageId(dataId: string): string {
  const parts = dataId.split('::');
  if (!parts[0]) throw new Error(`[dStorage] Invalid dataId: ${dataId}`);
  return parts[0];
}

function parseChainRefId(dataId: string): string {
  const parts = dataId.split('::');
  if (!parts[1]) throw new Error(`[dStorage] Invalid dataId (missing chain ref): ${dataId}`);
  return parts[1];
}
