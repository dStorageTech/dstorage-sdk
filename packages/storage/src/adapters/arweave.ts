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

import type {
  Logger,
  PaymentAdapter,
  StorageAdapter,
  StorageProviderName,
  UploadResult,
} from "../types.js";
import { ArweavePaymentAdapter } from "@dstorage/payment";
import type { SignedArweaveUpload } from "@dstorage/payment";
import storagePackageJson from "../../package.json";

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
  logger?: Logger;
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
  protected readonly logger: Logger | undefined;

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
    this.paymentAdapter = new ArweavePaymentAdapter({
      gateway: this.gateway,
      ...(config.walletKey !== undefined
        ? { walletKey: config.walletKey }
        : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
    });
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
  ): Promise<UploadResult> {
    // NOTE: Large file support is a known limitation. The full payload is loaded
    // into a single Arweave transaction in memory. Arweave supports files up to
    // ~2 GB via bundled/chunked transactions (e.g. Irys/Turbo), but the current
    // implementation does not stream data to the network. Chunked upload support
    // is planned for a future release.
    const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
    if (data.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(
        `[dStorage/arweave] Data exceeds the 10 MB upload limit (${(data.byteLength / 1024 / 1024).toFixed(1)} MB). ` +
          "Large file support is planned for a future release.",
      );
    }

    const arweave = await this.getClient();

    // ── Sign-then-post flow ────────────────────────────────────────────────────
    // Signing is always delegated to the payment adapter:
    //   • MetaTransaction path: provideUploadData → pay → [here] consumeSignedUpload → post
    //   • Direct upload path:   [here] provideUploadData → pay → consumeSignedUpload → post
    //
    // This keeps the storage adapter agnostic about how signing happens (local
    // wallet, ArConnect, or remote signing server via AccountPaymentAdapter).
    const arwPayment = this.paymentAdapter as ArweavePaymentAdapter;

    // Consume any pre-signed tx from the MetaTransaction pay() step.
    let signed: SignedArweaveUpload | null = arwPayment.consumeSignedUpload();

    if (!signed) {
      this.logger?.log(
        "dStorage/arweave",
        `Funding data storage transaction with ${arwPayment.name}...`,
      );
      // Direct upload path — stage data and trigger signing via payment adapter.
      arwPayment.provideUploadData(data, metadata);
      const winstons = (await arweave.transactions.getPrice(
        data.byteLength,
      )) as string;
      const amount = arweave.ar.winstonToAr(winstons) as string;
      await arwPayment.pay({
        token: "AR",
        amount,
        fiat_amount: "0",
        type: "storage",
        dataSizeBytes: data.byteLength,
        expiresAt: Date.now() + 600_000,
      });
      signed = arwPayment.consumeSignedUpload();
      if (!signed) {
        throw new Error(
          "[dStorage/arweave] Payment adapter did not produce a signed transaction.",
        );
      }
    }

    const { tx, arCost } = signed;

    // Broadcast with retry.
    await this.postWithRetry(arweave, tx);

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
      cost: arCost,
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

  async estimateCost(data: Uint8Array): Promise<string> {
    const arweave = await this.getClient();
    const winstons = await arweave.transactions.getPrice(data.byteLength);
    return winstons as string;
  }

  // ── Private: retry post ────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async postWithRetry(arweave: any, tx: any): Promise<void> {
    let lastError: Error | undefined;

    this.logger?.log(
      "dStorage/arweave",
      `Posting tx id=${tx.id as string} owner=${(tx.owner as string)?.slice(0, 16)}… data_size=${tx.data_size as string} reward=${tx.reward as string} data_root=${(tx.data_root as string)?.slice(0, 16) ?? "(none)"}… sig_len=${(tx.signature as string)?.length ?? 0}`,
    );

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const response = await arweave.transactions.post(tx);

      if (response.status === 200 || response.status === 202) return;

      // Try to surface the response body — arweave-js wraps it in response.data
      const detail: string =
        typeof response.data === "string"
          ? response.data
          : response.data
            ? JSON.stringify(response.data)
            : "";

      lastError = new Error(
        `[dStorage/arweave] Transaction post failed ` +
          `(attempt ${attempt}/${this.maxRetries}): ` +
          `HTTP ${response.status} ${response.statusText ?? ""}${detail ? ` — ${detail}` : ""}`.trimEnd(),
      );
      this.logger?.warn("dStorage/arweave", lastError.message);

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
