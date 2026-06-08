/**
 * @dstorage/storage — adapters/autonomi.ts
 *
 * Autonomi (formerly SAFE Network) storage adapter.
 * Self-encrypting, content-addressed, pay-once-store-forever decentralised storage.
 *
 * Status: Adapter structure defined. Wire-up pending Autonomi's JS/TS SDK stability.
 * Autonomi docs: https://docs.autonomi.com
 *
 * When Autonomi's JS SDK is stable, replace the TODOs below with real calls.
 */

import type {
  StorageAdapterLogger,
  StorageAdapter,
  StorageProviderName,
  StorageUploadResult,
  StorageQuote,
} from "../types.js";
import { MockPaymentAdapter, PaymentAdapter } from "@dstorage/payment";

export interface AutonomiAdapterConfig {
  /**
   * Autonomi network node peers to connect to.
   * Defaults to public mainnet peers.
   */
  peers?: string[];
  /**
   * Wallet private key or mnemonic for paying storage costs in ANT token.
   */
  walletKey?: string;
  /**
   * Optional logger for SDK operational output.
   */
  logger?: StorageAdapterLogger;
}

export class AutonomiStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = "autonomi";
  readonly providerName: string = "Autonomi";
  readonly paymentAdapter: PaymentAdapter;

  private config: AutonomiAdapterConfig;
  private readonly logger: StorageAdapterLogger | undefined;

  constructor(config: AutonomiAdapterConfig = {}) {
    this.config = config;
    this.logger = config.logger;
    // TODO: replace with real AutonomiPaymentAdapter once ANT JS SDK is stable
    this.paymentAdapter = new MockPaymentAdapter({
      type: "storage",
    });
    this.logger?.warn(
      "dStorage/autonomi",
      "Autonomi adapter is in preview. Real network integration pending JS SDK stability. Data is stored in memory for now.",
    );
  }

  // In-memory fallback until real SDK wired up
  private store = new Map<string, Uint8Array>();

  async upload(
    data: Uint8Array,
    _metadata: Record<string, string> = {},
  ): Promise<StorageUploadResult> {
    /**
     * TODO: Replace with real Autonomi upload when JS SDK is stable.
     */
    // Preview: in-memory stub
    const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const id = `autonomi_${Date.now()}_${randomPart}`;
    this.store.set(id, data);
    const cost = await this.estimateCost(data.byteLength);

    this.logger?.log(
      "dStorage/autonomi",
      `(preview) Stored locally → id: ${id}`,
    );

    return {
      id,
      provider: this.name,
      cost,
      uploadedAt: Date.now(),
    };
  }

  async retrieve(
    id: string,
  ): Promise<{ bytes: Uint8Array; tags: Record<string, string> }> {
    /**
     * TODO: Replace with real Autonomi retrieval:
     */
    const data = this.store.get(id);
    if (!data) {
      throw new Error(`[dStorage/autonomi] No data found for id: ${id}`);
    }
    return { bytes: data, tags: {} };
  }

  async estimateCost(dataSizeBytes: number): Promise<StorageQuote> {
    // TODO: When Autonomi JS SDK is stable, call client.quotePut(dataSize) → real ANT cost.
    return {
      token: "ANT",
      amount: `${dataSizeBytes}`,
      provider: this.name,
      dataSizeBytes,
      expiresAt: Date.now() + 5 * 60_000,
    };
  }
}
