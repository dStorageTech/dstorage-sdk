/**
 * @dstorage/storage — adapters/arweave.ts
 *
 * Arweave storage adapter.
 * Uploads encrypted blobs to the Arweave permaweb — pay once, store forever.
 *
 * Requirements:
 *   - ArConnect browser extension (https://arconnect.io) for browser usage, OR
 *   - A JWK wallet key file for Node.js usage.
 *   - AR tokens to pay for uploads (use the Arweave faucet for testnet).
 *
 * Gateway: https://arweave.net (mainnet) | https://arweave.dev (testnet)
 */

import type { StorageAdapter, StorageProviderName, UploadResult } from '../types.js';

export interface ArweaveAdapterConfig {
  /**
   * Arweave gateway config.
   * Defaults to mainnet — use { host: 'arweave.dev', port: 443, protocol: 'https' } for testnet.
   */
  gateway?: {
    host: string;
    port: number;
    protocol: 'http' | 'https';
  };
  /**
   * JWK wallet key for Node.js server-side usage.
   * In the browser, leave undefined — ArConnect is used automatically.
   */
  walletKey?: Record<string, string>;
}

export class ArweaveStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = 'arweave';

  private config: ArweaveAdapterConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private arweave: any; // typed as any to avoid hard dependency at module level

  constructor(config: ArweaveAdapterConfig = {}) {
    this.config = {
      gateway: config.gateway ?? {
        host: 'arweave.net',
        port: 443,
        protocol: 'https',
      },
      ...(config.walletKey !== undefined ? { walletKey: config.walletKey } : {}),
    };
  }

  // Lazily initialise Arweave to avoid bundling it when not used
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getArweave(): Promise<any> {
    if (this.arweave) return this.arweave;

    try {
      // Dynamic import — only loads arweave-js if this adapter is actually used
      const { default: Arweave } = await import('arweave');
      this.arweave = Arweave.init(this.config.gateway!);
      return this.arweave;
    } catch {
      throw new Error(
        '[dStorage/arweave] arweave package not installed. Run: npm install arweave'
      );
    }
  }

  async upload(
    data: string,
    metadata: Record<string, string> = {}
  ): Promise<UploadResult> {
    const arweave = await this.getArweave();

    // Determine wallet: ArConnect in browser, JWK in Node
    const wallet = this.config.walletKey ?? 'use_wallet'; // 'use_wallet' = ArConnect

    // Create transaction with the encrypted data
    const tx = await arweave.createTransaction({ data }, wallet);

    // Tag the transaction so it can be queried later
    tx.addTag('App-Name', 'dStorage');
    tx.addTag('App-Version', '0.1.0');
    tx.addTag('Content-Type', 'application/json');

    // Add any caller-provided metadata as tags
    for (const [key, value] of Object.entries(metadata)) {
      tx.addTag(key, value);
    }

    await arweave.transactions.sign(tx, wallet);
    const response = await arweave.transactions.post(tx);

    if (response.status !== 200 && response.status !== 202) {
      throw new Error(
        `[dStorage/arweave] Upload failed with status ${response.status}: ${response.statusText}`
      );
    }

    const url = `${this.config.gateway!.protocol}://${this.config.gateway!.host}/${tx.id}`;

    console.log(`[dStorage/arweave] Uploaded → txId: ${tx.id}`);

    return {
      id: tx.id as string,
      provider: 'arweave',
      url,
      uploadedAt: Date.now(),
    };
  }

  async retrieve(id: string): Promise<string> {
    const arweave = await this.getArweave();

    const response = await arweave.transactions.getData(id, {
      decode: true,
      string: true,
    });

    if (!response) {
      throw new Error(`[dStorage/arweave] No data found for txId: ${id}`);
    }

    console.log(`[dStorage/arweave] Retrieved txId: ${id}`);
    return response as string;
  }

  async estimateCost(data: string): Promise<string> {
    const arweave = await this.getArweave();

    const bytes = new TextEncoder().encode(data).byteLength;
    const winstonCost = await arweave.transactions.getPrice(bytes);
    const arCost = arweave.ar.winstonToAr(winstonCost);
    return `~${arCost} AR`;
  }
}
