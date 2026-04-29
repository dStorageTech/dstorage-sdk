/**
 * @dstorage/payment — adapters/arweave.ts
 *
 * Arweave payment adapter.
 *
 * ── Sign-then-post flow ───────────────────────────────────────────────────────
 *
 * On Arweave, data and fee share a single transaction object. The fee is
 * deducted automatically when the transaction is posted — there is no
 * separate payment channel.
 *
 * This adapter implements the two-phase flow supported by MetaTransaction:
 *
 *   1. provideUploadData(data, metadata)
 *        Called after encryption. Stores the data + metadata tags so that
 *        pay() can build the complete transaction without a separate round-trip.
 *
 *   2. pay(quote, onStatus)  [payment_storage step]
 *        Creates the Arweave transaction, attaches tags, and prompts the
 *        wallet for approval (ArConnect popup / JWK signing). Stores the
 *        signed transaction for the upload step to pick up.
 *
 *   3. ArweaveStorageAdapter.upload()  [upload step]
 *        Detects the pre-signed transaction via consumeSignedTx() and simply
 *        posts it — no additional signing or wallet interaction needed.
 *
 * If provideUploadData() was not called (e.g. direct use outside MetaTransaction),
 * pay() falls back to the pass-through behaviour and upload() performs the full
 * create → sign → post flow as before.
 *
 * ── Fiat conversion ───────────────────────────────────────────────────────────
 *
 * AR/USD price is approximated. Replace APPROX_AR_USD_PRICE with a live feed
 * (CoinGecko, etc.) for production dashboards.
 *
 * Docs: https://docs.arweave.org/developers
 */

import type {
  PaymentAdapterLogger,
  PaymentAdapter,
  PaymentNetworkName,
  PaymentQuote,
  PaymentReceipt,
  TokenSymbol,
  NetworkType,
} from "../types.js";

export interface ArweavePaymentAdapterConfig {
  /**
   * Arweave gateway.
   * Defaults to mainnet (arweave.net).
   * Use { host: 'arweave.dev', port: 443, protocol: 'https' } for testnet.
   * Use { host: 'localhost', port: 1984, protocol: 'http' } for arlocal.
   */
  gateway?: {
    host: string;
    port: number;
    protocol: "http" | "https";
  };
  /**
   * JWK wallet key for Node.js server-side usage.
   * In the browser leave undefined — ArConnect is used automatically.
   */
  walletKey?: Record<string, string>;
  /**
   * How long in ms before a quote expires.
   * Arweave fees are relatively stable; 10 minutes is a safe default.
   * Defaults to 600_000.
   */
  quoteValidityMs?: number;
  /**
   * Optional logger for SDK operational output.
   */
  logger?: PaymentAdapterLogger;
}

/** Internal state stored between provideUploadData() and pay(). */
interface PendingUpload {
  data: Uint8Array;
  metadata: Record<string, string>;
}

/** Result stored after pay() signs the transaction, consumed by upload(). */
export interface SignedArweaveUpload {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any;
  /** AR cost string (e.g. "0.000001234") for the upload result. */
  arCost: string;
}

export class ArweavePaymentAdapter implements PaymentAdapter {
  readonly network: PaymentNetworkName = "arweave";
  readonly token: TokenSymbol = "AR";
  readonly type: NetworkType = "storage";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected arweaveClient: any;
  protected readonly gateway: ArweavePaymentAdapterConfig["gateway"];
  private readonly walletKey: Record<string, string> | undefined;
  protected readonly quoteValidityMs: number;
  protected readonly logger: PaymentAdapterLogger | undefined;

  protected pendingUpload: PendingUpload | null = null;
  protected signedUpload: SignedArweaveUpload | null = null;

  constructor(config: ArweavePaymentAdapterConfig = {}) {
    this.gateway = config.gateway ?? {
      host: "arweave.net",
      port: 443,
      protocol: "https",
    };
    this.walletKey = config.walletKey;
    this.quoteValidityMs = config.quoteValidityMs ?? 600_000;
    this.logger = config.logger;
  }

  // ── Protected: lazy Arweave client ───────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getClient(): Promise<any> {
    if (this.arweaveClient) return this.arweaveClient;
    try {
      const { default: Arweave } = await import("arweave");
      this.arweaveClient = Arweave.init(this.gateway ?? {});
      return this.arweaveClient;
    } catch {
      throw new Error(
        "[dStorage/arweave-payment] arweave package not installed. Run: npm install arweave",
      );
    }
  }

  // ── Protected: wallet resolution ─────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected resolveWallet(): any {
    if (this.walletKey && Object.keys(this.walletKey).length > 0) {
      return this.walletKey;
    }
    if (typeof window === "undefined") {
      throw new Error(
        "[dStorage/arweave-payment] Node.js usage requires a walletKey in the config.",
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (window as any).arweaveWallet === "undefined") {
      throw new Error(
        "[dStorage/arweave-payment] ArConnect extension not found. Install it from https://arconnect.io",
      );
    }
    return "use_wallet";
  }

  // ── PaymentAdapter: provideUploadData ─────────────────────────────────────────

  /**
   * Store the encrypted upload payload and metadata tags so that pay() can
   * build and sign the complete Arweave transaction in one step.
   * Called by MetaTransaction after the encrypt step, before pay().
   */
  provideUploadData(
    data: Uint8Array,
    metadata: Record<string, string> = {},
  ): void {
    this.pendingUpload = { data, metadata };
    this.logger?.log(
      "dStorage/arweave-payment",
      `Upload data staged: ${data.byteLength} bytes`,
    );
  }

  // ── PaymentAdapter: estimateCost ─────────────────────────────────────────────

  /**
   * Query the Arweave fee oracle for the real upload cost.
   */
  async estimateCost(dataSizeBytes: number): Promise<PaymentQuote> {
    const arweave = await this.getClient();
    const winstons = (await arweave.transactions.getPrice(
      dataSizeBytes,
    )) as string;
    const amount = arweave.ar.winstonToAr(winstons) as string;

    this.logger?.log(
      "dStorage/arweave-payment",
      `Estimated: ${amount} AR (${winstons} Winstons)`,
    );

    return {
      token: this.token,
      amount,
      network: this.network,
      type: this.type,
      dataSizeBytes,
      expiresAt: Date.now() + this.quoteValidityMs,
    };
  }

  // ── PaymentAdapter: pay ───────────────────────────────────────────────────────

  /**
   * Sign-then-store flow (when provideUploadData was called):
   *   Creates the Arweave transaction with data + tags, prompts the wallet
   *   for approval (ArConnect popup or JWK signing), and stores the signed
   *   transaction for ArweaveStorageAdapter.upload() to post.
   *
   * Pass-through fallback (when provideUploadData was NOT called):
   *   Returns a receipt acknowledging that payment is bundled with the upload.
   *   ArweaveStorageAdapter.upload() performs the full create → sign → post flow.
   */
  async pay(
    quote: PaymentQuote,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    if (!this.pendingUpload) {
      // Fallback: payment handled inside upload()
      onStatus?.("AR fee will be deducted as part of the upload transaction.");
      return {
        txHash: "arweave-bundled-with-upload",
        token: this.token,
        amount: quote.amount,
        type: this.type,
        paidAt: Date.now(),
      };
    }

    const { data, metadata } = this.pendingUpload;
    this.pendingUpload = null;

    const arweave = await this.getClient();
    const wallet = this.resolveWallet();

    onStatus?.("Creating Arweave transaction…");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await arweave.createTransaction({ data }, wallet);

    for (const [key, value] of Object.entries(metadata)) {
      tx.addTag(key, value);
    }

    onStatus?.("Requesting AR wallet approval…");
    await arweave.transactions.sign(tx, wallet);

    // Fetch the real cost for the upload result receipt
    const winstons = (await arweave.transactions.getPrice(
      data.byteLength,
    )) as string;
    const arCost = arweave.ar.winstonToAr(winstons) as string;

    this.signedUpload = { tx, arCost };

    this.logger?.log(
      "dStorage/arweave-payment",
      `Transaction signed → txId: ${tx.id as string}  cost: ~${arCost} AR`,
    );

    return {
      txHash: tx.id as string,
      token: this.token,
      amount: quote.amount,
      type: this.type,
      paidAt: Date.now(),
    };
  }

  // ── Consumed by ArweaveStorageAdapter ─────────────────────────────────────────

  /**
   * Returns the pre-signed transaction produced by pay(), then clears it.
   * Called by ArweaveStorageAdapter.upload() to post the already-signed tx.
   * Returns null if pay() did not sign a transaction (pass-through mode).
   */
  consumeSignedUpload(): SignedArweaveUpload | null {
    const signed = this.signedUpload;
    this.signedUpload = null;
    return signed;
  }
}
