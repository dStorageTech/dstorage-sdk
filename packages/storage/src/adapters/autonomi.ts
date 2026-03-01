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

import type { StorageAdapter, StorageProviderName, UploadResult } from '../types.js';

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
}

export class AutonomiStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = 'autonomi';
  readonly providerName: string = 'Autonomi';

  private config: AutonomiAdapterConfig;

  constructor(config: AutonomiAdapterConfig = {}) {
    this.config = config;
    console.warn(
      '[dStorage/autonomi] Autonomi adapter is in preview. ' +
        'Real network integration pending JS SDK stability. ' +
        'Data is stored in memory for now.'
    );
  }

  // In-memory fallback until real SDK wired up
  private store = new Map<string, string>();

  async upload(
    data: string,
    _metadata: Record<string, string> = {}
  ): Promise<UploadResult> {
    /**
     * TODO: Replace with real Autonomi upload when JS SDK is stable.
     *
     * Expected flow:
     *   const client = await autonomi.Client.connect(this.config.peers);
     *   const wallet  = autonomi.Wallet.fromPrivateKey(this.config.walletKey);
     *   const addr    = await client.dataMapChunkPut(Buffer.from(data), wallet);
     *   return { id: addr.toHex(), provider: 'autonomi', ... };
     *
     * Autonomi uses self-encryption internally — data is split, encrypted,
     * and content-addressed automatically before leaving the device.
     */

    // Preview: in-memory stub
    const id = `autonomi_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.store.set(id, data);

    console.log(`[dStorage/autonomi] (preview) Stored locally → id: ${id}`);

    return {
      id,
      provider: 'autonomi',
      cost: 'pending ANT pricing',
      uploadedAt: Date.now(),
    };
  }

  async retrieve(id: string): Promise<string> {
    /**
     * TODO: Replace with real Autonomi retrieval:
     *   const client = await autonomi.Client.connect(this.config.peers);
     *   const addr   = autonomi.XorName.fromHex(id);
     *   const data   = await client.dataMapChunkGet(addr);
     *   return data.toString('utf8');
     */

    const data = this.store.get(id);
    if (!data) {
      throw new Error(`[dStorage/autonomi] No data found for id: ${id}`);
    }
    return data;
  }

  async estimateCost(_data: string): Promise<string> {
    /**
     * TODO: Autonomi uses one-time payment model (pay once, store forever).
     * When JS SDK is available: call client.quotePut(dataSize) → returns ANT cost.
     */
    return 'One-time ANT payment (pricing pending SDK release)';
  }
}
