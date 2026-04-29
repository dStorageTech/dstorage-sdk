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
 *     the XChaCha20-Poly1305 encryption applied by @dstorage/crypto before reaching here.
 */

import type {
  StorageAdapterLogger,
  StorageAdapter,
  StorageProviderName,
  StorageUploadResult,
  StorageQuote,
} from "../types.js";
import {
  PaymentAdapter,
  ArweavePaymentAdapter,
  ManagedPaymentAdapter,
} from "@dstorage/payment";
import type {
  PaymentNetworkName,
  SignedArweaveUpload,
} from "@dstorage/payment";

// ── Config ─────────────────────────────────────────────────────────────────────

export interface ArweaveGatewayConfig {
  host: string;
  port: number;
  protocol: "http" | "https";
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
   * Base URL of a local ManagedPaymentAdapter signing server.
   * When provided, the adapter uses ManagedPaymentAdapter (remote signing)
   * instead of the default ArweavePaymentAdapter (local signing).
   * Example: "http://localhost:3000"
   */
  signingServerUrl?: string;

  /**
   * Bearer token sent as the `Authorization` header to authenticate with the signing server.
   * When omitted, requests are sent without an Authorization header.
   */
  authToken?: string;

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
  /**
   * Optional logger for SDK operational output.
   * Pass `logger: console` to see all output, or inject your own logger.
   * Omit to suppress all SDK log output.
   */
  logger?: StorageAdapterLogger;
}

// ── Defaults ───────────────────────────────────────────────────────────────────

/**
 * Arweave mainnet gateway preset.
 *
 * @example
 * new ArweaveStorageAdapter({ gateway: ARWEAVE_MAINNET })
 */
export const ARWEAVE_MAINNET: ArweaveGatewayConfig = {
  host: "arweave.net",
  port: 443,
  protocol: "https",
};

// ── Adapter ────────────────────────────────────────────────────────────────────

export class ArweaveStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = "arweave";
  readonly providerName: string = "Arweave";
  paymentAdapter: PaymentAdapter;

  private readonly gateway: ArweaveGatewayConfig;
  private readonly maxRetries: number;
  private readonly shouldWaitForConfirm: boolean;
  private readonly confirmationPollMs: number;
  private readonly confirmationTimeoutMs: number;
  protected readonly logger: StorageAdapterLogger | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private arweaveClient: any; // typed as `any` to avoid a hard import at module level

  constructor(config: ArweaveAdapterConfig = {}) {
    this.gateway = config.gateway ?? ARWEAVE_MAINNET;
    this.maxRetries = config.maxRetries ?? 3;
    this.shouldWaitForConfirm = config.waitForConfirmation ?? false;
    this.confirmationPollMs = config.confirmationPollMs ?? 30_000;
    this.confirmationTimeoutMs =
      config.confirmationTimeoutMs ?? 20 * 60 * 1_000;
    this.logger = config.logger;

    // When a signing server URL is provided, use the ManagedPaymentAdapter:
    // transactions are sent unsigned to the remote server, which holds a
    // funded Arweave wallet and returns the signature.
    if (config.signingServerUrl) {
      this.paymentAdapter = new ManagedPaymentAdapter({
        signingServerUrl: config.signingServerUrl,
        ...(config.authToken !== undefined
          ? { authToken: config.authToken }
          : {}),
        network: this.name as PaymentNetworkName,
        type: "storage",
        gateway: this.gateway,
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
      });
    } else {
      // ...otherwise use the local-signing adapter
      this.paymentAdapter = new ArweavePaymentAdapter({
        gateway: this.gateway,
        ...(config.walletKey !== undefined
          ? { walletKey: config.walletKey }
          : {}),
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
      });
    }
  }

  // ── Private: lazy Arweave client ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (this.arweaveClient) return this.arweaveClient;

    try {
      // Dynamic import — arweave-js is only bundled when this adapter is used.
      const { default: Arweave } = await import("arweave");
      this.arweaveClient = Arweave.init(this.gateway);
      return this.arweaveClient;
    } catch {
      throw new Error(
        "[dStorage/arweave] arweave package not found.\n" +
          "Install it with: npm install arweave",
      );
    }
  }

  // ── upload ─────────────────────────────────────────────────────────────────────

  async upload(
    data: Uint8Array,
    metadata: Record<string, string> = {},
  ): Promise<StorageUploadResult> {
    const arweave = await this.getClient();

    // ── Sign-then-post flow ────────────────────────────────────────────────────
    // Signing is always delegated to the payment adapter:
    //   • MetaTransaction path: provideUploadData → pay → [here] consumeSignedUpload → post
    //   • Direct upload path:   [here] provideUploadData → pay → consumeSignedUpload → post
    //
    // This keeps the storage adapter agnostic about how signing happens (local
    // wallet, ArConnect, or remote signing server via ManagedPaymentAdapter).
    const arwPayment = this.paymentAdapter as ArweavePaymentAdapter;

    const quote = await this.estimateCost(data.byteLength);

    // Consume any pre-signed tx from the MetaTransaction pay() step.
    let signed: SignedArweaveUpload | null = arwPayment.consumeSignedUpload();

    if (!signed) {
      this.logger?.log(
        "dStorage/arweave",
        `Funding data storage transaction...`,
      );
      // Direct upload path — stage data and trigger signing via payment adapter.
      arwPayment.provideUploadData(data, metadata);
      await arwPayment.pay({
        token: quote.token,
        amount: quote.amount,
        network: this.name,
        type: "storage",
        dataSizeBytes: quote.dataSizeBytes,
        expiresAt: quote.expiresAt,
      });
      signed = arwPayment.consumeSignedUpload();
      if (!signed) {
        throw new Error(
          "[dStorage/arweave] Payment adapter did not produce a signed transaction.",
        );
      }
    }

    const { tx, arCost } = signed;

    // Broadcast via chunked uploader — sends 256 KB slices to /chunk endpoint.
    // Supports transactions up to ~2 GB and retries failed slices independently.
    await this.uploadWithChunker(arweave, tx);

    const txId = tx.id as string;
    const url = `${this.gateway.protocol}://${this.gateway.host}/${txId}`;

    this.logger?.log(
      "dStorage/arweave",
      `Uploaded → txId: ${txId}  cost: ~${arCost} AR`,
    );

    // Optional: block until the transaction is included in a block.
    if (this.shouldWaitForConfirm) {
      this.logger?.log(
        "dStorage/arweave",
        "Waiting for on-chain confirmation…",
      );
      await this.pollUntilConfirmed(arweave, txId);
    }

    return {
      id: txId,
      provider: this.name,
      cost: { ...quote, amount: arCost },
      url,
      uploadedAt: Date.now(),
    };
  }

  // ── retrieve ───────────────────────────────────────────────────────────────────

  async retrieve(id: string): Promise<Uint8Array> {
    const arweave = await this.getClient();

    const raw = await arweave.transactions.getData(id, {
      decode: true,
      string: false,
    });

    if (!raw) {
      throw new Error(
        `[dStorage/arweave] No data returned for txId: ${id}\n` +
          "The transaction may still be pending — Arweave can take a few minutes to confirm.\n" +
          `Check status at: https://viewblock.io/arweave/tx/${id}`,
      );
    }

    this.logger?.log("dStorage/arweave", `Retrieved txId: ${id}`);
    return raw as Uint8Array;
  }

  // ── estimateCost ───────────────────────────────────────────────────────────────

  async estimateCost(dataSizeBytes: number): Promise<StorageQuote> {
    const arweave = await this.getClient();
    const winstons = await arweave.transactions.getPrice(dataSizeBytes);
    return {
      token: "AR",
      amount: arweave.ar.winstonToAr(winstons as string) as string,
      provider: this.name,
      dataSizeBytes,
      expiresAt: Date.now() + 5 * 60_000,
    };
  }

  // ── Private: chunked uploader ─────────────────────────────────────────────────

  /**
   * Upload a signed transaction using arweave-js getUploader().
   *
   * getUploader() sends just the tx header to /tx, then streams each 256 KB
   * data slice to the /chunk endpoint. This avoids the ~12 MB HTTP body limit
   * of transactions.post() and supports arbitrarily large transactions.
   *
   * Failed slices are retried individually up to maxRetries times with linear
   * back-off, so a transient network error won't restart the entire upload.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async uploadWithChunker(arweave: any, tx: any): Promise<void> {
    this.logger?.log(
      "dStorage/arweave",
      `Posting tx id=${tx.id as string} owner=${(tx.owner as string)?.slice(0, 16)}… data_size=${tx.data_size as string} reward=${tx.reward as string}`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uploader: any = await arweave.transactions.getUploader(tx);
    let chunkAttempt = 0;

    while (!uploader.isComplete) {
      try {
        await uploader.uploadChunk();
        chunkAttempt = 0; // reset per-chunk retry count on success
        if (uploader.totalChunks > 1) {
          this.logger?.log(
            "dStorage/arweave",
            `Uploading: ${uploader.pctComplete as number}% (${uploader.uploadedChunks as number}/${uploader.totalChunks as number} network chunks)`,
          );
        }
      } catch (err) {
        chunkAttempt++;
        if (chunkAttempt >= this.maxRetries) {
          throw new Error(
            `[dStorage/arweave] Chunk upload failed after ${this.maxRetries} attempts: ${err}`,
          );
        }
        this.logger?.warn(
          "dStorage/arweave",
          `Chunk upload failed (attempt ${chunkAttempt}/${this.maxRetries}), retrying in ${chunkAttempt}s… ${err}`,
        );
        await sleep(1_000 * chunkAttempt);
      }
    }
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
        this.logger?.log(
          "dStorage/arweave",
          `Confirmed: ${txId}${block !== undefined ? ` (block ${block})` : ""}`,
        );
        return;
      }

      const remaining = Math.round((deadline - Date.now()) / 1_000);
      this.logger?.log(
        "dStorage/arweave",
        `Still pending (HTTP ${status.status}) — retrying in ${this.confirmationPollMs / 1_000}s… (timeout in ${remaining}s)`,
      );
    }

    throw new Error(
      `[dStorage/arweave] Confirmation timeout for txId: ${txId}.\n` +
        "The transaction may still be processed eventually — track it at:\n" +
        `  https://viewblock.io/arweave/tx/${txId}`,
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
