/**
 * @dstorage/storage — adapters/arweave.ts
 *
 * Real Arweave storage adapter.
 * Uploads encrypted blobs to the Arweave permaweb — pay once, store forever.
 *
 * ── Runtime environments ──────────────────────────────────────────────────────
 *
 *   Browser (ArConnect):
 *     const adapter = new ArweaveStorageAdapter();
 *     // Requires the ArConnect extension: https://arconnect.io
 *
 *   Node.js (JWK wallet file):
 *     const adapter = new ArweaveStorageAdapter({
 *       walletKey: JSON.parse(fs.readFileSync('wallet.json', 'utf8')),
 *     });
 *
 * ── Testnet ───────────────────────────────────────────────────────────────────
 *
 *   const adapter = new ArweaveStorageAdapter({
 *     gateway: { host: 'arweave.dev', port: 443, protocol: 'https' },
 *   });
 *
 * ── Peer dependency ───────────────────────────────────────────────────────────
 *   npm install arweave
 *
 * ── Notes ─────────────────────────────────────────────────────────────────────
 *
 *   • Arweave transactions are optimistic: a 202 response means accepted, not
 *     confirmed. Confirmation (inclusion in a block) typically takes 2–20 minutes.
 *     Set waitForConfirmation: true to block until the tx is on-chain.
 *
 *   • For large files or high-volume uploads, consider Irys (https://irys.xyz)
 *     which bundles many transactions together for cheaper and near-instant
 *     finality. An IrysStorageAdapter can be added alongside this one.
 *
 *   • storageId (txId) is PUBLIC on Arweave. Data security relies entirely on
 *     the AES-GCM encryption applied by @dstorage/crypto before reaching here.
 */

import type { StorageAdapter, StorageProviderName, UploadResult } from '../types.js';

// ── Config ─────────────────────────────────────────────────────────────────────

export interface ArweaveGatewayConfig {
  host:     string;
  port:     number;
  protocol: 'http' | 'https';
}

export interface ArweaveAdapterConfig {
  /**
   * Arweave gateway to broadcast transactions to.
   * Defaults to mainnet (arweave.net:443).
   *
   * Testnet: { host: 'arweave.dev', port: 443, protocol: 'https' }
   */
  gateway?: ArweaveGatewayConfig;

  /**
   * JWK wallet key for Node.js server-side usage.
   * Leave undefined in the browser — ArConnect is used automatically.
   *
   * Obtain a free wallet at https://arweave.app or generate via arweave-js:
   *   const jwk = await Arweave.init({}).wallets.generate();
   */
  walletKey?: Record<string, string>;

  /**
   * How many times to retry a failed transaction post before throwing.
   * Uses a simple linear back-off: 1 s, 2 s, 3 s…
   * Defaults to 3.
   */
  maxRetries?: number;

  /**
   * If true, poll Arweave until the transaction is confirmed (block included)
   * before returning from upload(). Confirmation typically takes 2–20 minutes.
   *
   * Defaults to false (optimistic — returns as soon as the gateway accepts
   * the transaction with HTTP 200 or 202).
   */
  waitForConfirmation?: boolean;

  /**
   * Polling interval in ms while waiting for confirmation.
   * Defaults to 30_000 (30 seconds).
   */
  confirmationPollMs?: number;

  /**
   * Maximum time in ms to wait for confirmation before throwing a timeout error.
   * Defaults to 1_200_000 (20 minutes).
   */
  confirmationTimeoutMs?: number;
}

// ── Defaults ───────────────────────────────────────────────────────────────────

const MAINNET: ArweaveGatewayConfig = {
  host:     'arweave.net',
  port:     443,
  protocol: 'https',
};

// ── Adapter ────────────────────────────────────────────────────────────────────

export class ArweaveStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = 'arweave';
  readonly providerName: string = 'Arweave';

  private readonly gateway:               ArweaveGatewayConfig;
  private readonly walletKey:             Record<string, string> | undefined;
  private readonly maxRetries:            number;
  private readonly shouldWaitForConfirm:  boolean;
  private readonly confirmationPollMs:    number;
  private readonly confirmationTimeoutMs: number;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private arweaveClient: any; // typed as `any` to avoid a hard import at module level

  constructor(config: ArweaveAdapterConfig = {}) {
    this.gateway               = config.gateway               ?? MAINNET;
    this.walletKey             = config.walletKey;
    this.maxRetries            = config.maxRetries            ?? 3;
    this.shouldWaitForConfirm  = config.waitForConfirmation   ?? false;
    this.confirmationPollMs    = config.confirmationPollMs    ?? 30_000;
    this.confirmationTimeoutMs = config.confirmationTimeoutMs ?? 20 * 60 * 1_000;
  }

  // ── Private: lazy Arweave client ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (this.arweaveClient) return this.arweaveClient;

    try {
      // Dynamic import — arweave-js is only bundled when this adapter is used.
      const { default: Arweave } = await import('arweave');
      this.arweaveClient = Arweave.init(this.gateway);
      return this.arweaveClient;
    } catch {
      throw new Error(
        '[dStorage/arweave] arweave package not found.\n' +
        'Install it with: npm install arweave'
      );
    }
  }

  // ── Private: wallet resolution ────────────────────────────────────────────────

  /**
   * Returns the wallet to pass to arweave-js:
   *   - Node.js  → the JWK key object from config
   *   - Browser  → the 'use_wallet' sentinel (arweave-js delegates to ArConnect)
   *
   * Throws a clear, actionable error if the required wallet isn't available.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveWallet(): any {
    const isNode = typeof window === 'undefined';

    if (isNode) {
      if (!this.walletKey || Object.keys(this.walletKey).length === 0) {
        throw new Error(
          '[dStorage/arweave] Node.js usage requires a JWK walletKey.\n' +
          'Pass it in the constructor:\n' +
          '  new ArweaveStorageAdapter({\n' +
          '    walletKey: JSON.parse(fs.readFileSync("wallet.json", "utf8")),\n' +
          '  })'
        );
      }
      // Cast is safe: we've verified the key is non-empty above.
      return this.walletKey as Record<string, string>;
    }

    // Browser — verify ArConnect is installed before proceeding.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (window as any).arweaveWallet === 'undefined') {
      throw new Error(
        '[dStorage/arweave] ArConnect extension not found in the browser.\n' +
        'Install it from https://arconnect.io and reload the page.'
      );
    }

    // 'use_wallet' is the arweave-js sentinel for "delegate signing to ArConnect".
    return 'use_wallet';
  }

  // ── upload ─────────────────────────────────────────────────────────────────────

  async upload(
    data: string,
    metadata: Record<string, string> = {}
  ): Promise<UploadResult> {
    const arweave = await this.getClient();
    const wallet  = this.resolveWallet();

    // Pre-flight: estimate cost so callers can surface it in the UI.
    const bytes    = new TextEncoder().encode(data).byteLength;
    const winstons = await arweave.transactions.getPrice(bytes);
    const arCost   = arweave.ar.winstonToAr(winstons) as string;

    // Build the transaction — data is already encrypted by @dstorage/crypto.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await arweave.createTransaction({ data }, wallet);

    // Standard dStorage tags — queryable via the Arweave GraphQL gateway.
    tx.addTag('App-Name',    'dStorage');
    tx.addTag('App-Version', '0.1.0');
    tx.addTag('Content-Type','application/octet-stream');

    // Caller-supplied metadata (e.g. dstorage-owner, dstorage-version).
    for (const [key, value] of Object.entries(metadata)) {
      tx.addTag(key, value);
    }

    // Sign — prompts ArConnect in the browser; uses JWK silently in Node.js.
    await arweave.transactions.sign(tx, wallet);

    // Broadcast with retry.
    await this.postWithRetry(arweave, tx);

    const txId = tx.id as string;
    const url  = `${this.gateway.protocol}://${this.gateway.host}/${txId}`;

    console.log(`[dStorage/arweave] Uploaded → txId: ${txId}  cost: ~${arCost} AR`);

    // Optional: block until the transaction is included in a block.
    if (this.shouldWaitForConfirm) {
      console.log('[dStorage/arweave] Waiting for on-chain confirmation…');
      await this.pollUntilConfirmed(arweave, txId);
    }

    return {
      id:         txId,
      provider:   'arweave',
      cost:       `~${arCost} AR`,
      url,
      uploadedAt: Date.now(),
    };
  }

  // ── retrieve ───────────────────────────────────────────────────────────────────

  async retrieve(id: string): Promise<string> {
    const arweave = await this.getClient();

    const raw = await arweave.transactions.getData(id, {
      decode: true,
      string: true,
    });

    if (!raw) {
      throw new Error(
        `[dStorage/arweave] No data returned for txId: ${id}\n` +
        'The transaction may still be pending — Arweave can take a few minutes to confirm.\n' +
        `Check status at: https://viewblock.io/arweave/tx/${id}`
      );
    }

    console.log(`[dStorage/arweave] Retrieved txId: ${id}`);
    return raw as string;
  }

  // ── estimateCost ───────────────────────────────────────────────────────────────

  async estimateCost(data: string): Promise<string> {
    const arweave  = await this.getClient();
    const bytes    = new TextEncoder().encode(data).byteLength;
    const winstons = await arweave.transactions.getPrice(bytes);
    const arCost   = arweave.ar.winstonToAr(winstons) as string;
    return `~${arCost} AR`;
  }

  // ── Private: retry post ────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async postWithRetry(arweave: any, tx: any): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const response = await arweave.transactions.post(tx);

      if (response.status === 200 || response.status === 202) return;

      lastError = new Error(
        `[dStorage/arweave] Transaction post failed ` +
        `(attempt ${attempt}/${this.maxRetries}): ` +
        `HTTP ${response.status} ${response.statusText ?? ''}`.trimEnd()
      );
      console.warn(lastError.message);

      if (attempt < this.maxRetries) {
        // Linear back-off: 1 s, 2 s, 3 s…
        await sleep(1_000 * attempt);
      }
    }

    throw lastError;
  }

  // ── Private: confirmation polling ─────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async pollUntilConfirmed(arweave: any, txId: string): Promise<void> {
    const deadline = Date.now() + this.confirmationTimeoutMs;

    while (Date.now() < deadline) {
      await sleep(this.confirmationPollMs);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status: any = await arweave.transactions.getStatus(txId);

      if (status.status === 200) {
        const block = status.confirmed?.block_height as number | undefined;
        console.log(
          `[dStorage/arweave] Confirmed: ${txId}` +
          (block !== undefined ? ` (block ${block})` : '')
        );
        return;
      }

      const remaining = Math.round((deadline - Date.now()) / 1_000);
      console.log(
        `[dStorage/arweave] Still pending (HTTP ${status.status}) — ` +
        `retrying in ${this.confirmationPollMs / 1_000}s… ` +
        `(timeout in ${remaining}s)`
      );
    }

    throw new Error(
      `[dStorage/arweave] Confirmation timeout for txId: ${txId}.\n` +
      'The transaction may still be processed eventually — track it at:\n' +
      `  https://viewblock.io/arweave/tx/${txId}`
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
