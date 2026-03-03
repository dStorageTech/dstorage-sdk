/**
 * @dstorage/payment — adapters/arweave.ts
 *
 * Arweave payment adapter.
 * Pays for permanent storage on the Arweave permaweb using AR tokens.
 *
 * Real integration flow (Sprint 2):
 *   arweave.transactions.getPrice(bytes)  → fetch Winston cost from fee oracle
 *   arweave.transactions.sign(tx, wallet) → sign with JWK (Node.js) or ArConnect (browser)
 *   arweave.transactions.post(tx)         → broadcast to Arweave network
 *
 * Requirements for real payments:
 *   - ArConnect browser extension (browser), OR a JWK wallet key (Node.js)
 *   - AR tokens in the connected wallet
 *
 * Note: In the full integration, the storage payment and the data upload share
 * the same Arweave transaction object — ArweavePaymentAdapter and
 * ArweaveStorageAdapter will need to co-ordinate. For now both operate
 * independently using the preview stub below.
 *
 * Status: Structure defined. Real AR transfer pending Arweave integration.
 * Docs: https://docs.arweave.org/developers
 */

import type {
  PaymentAdapter,
  PaymentProviderName,
  PaymentQuote,
  PaymentReceipt,
  TokenSymbol,
} from "../types.js";
import { TOKENS } from "../types.js";

export interface ArweavePaymentAdapterConfig {
  /**
   * Arweave gateway.
   * Defaults to mainnet (arweave.net).
   * Use { host: 'arweave.dev', port: 443, protocol: 'https' } for testnet.
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
}

export class ArweavePaymentAdapter implements PaymentAdapter {
  readonly name: PaymentProviderName = "arweave";
  readonly token: TokenSymbol = "AR";
  readonly type: "storage" | "chain" = "storage";

  private config: ArweavePaymentAdapterConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private arweaveClient: any; // typed as any to avoid a hard import at module level
  private readonly quoteValidityMs: number;

  constructor(config: ArweavePaymentAdapterConfig = {}) {
    this.config = {
      gateway: config.gateway ?? {
        host: "arweave.net",
        port: 443,
        protocol: "https",
      },
      ...(config.walletKey !== undefined
        ? { walletKey: config.walletKey }
        : {}),
    };
    this.quoteValidityMs = config.quoteValidityMs ?? 600_000;

    console.warn(
      "[dStorage/arweave-payment] Arweave payment adapter preview mode — " +
        "real AR token transfer pending full Arweave integration.",
    );
  }

  /** Lazily initialise the Arweave client to avoid bundling it when not used. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (this.arweaveClient) return this.arweaveClient;
    try {
      const { default: Arweave } = await import("arweave");
      this.arweaveClient = Arweave.init(this.config.gateway!);
      return this.arweaveClient;
    } catch {
      throw new Error(
        "[dStorage/arweave-payment] arweave package not installed. Run: npm install arweave",
      );
    }
  }

  async estimateCost(dataSizeBytes: number): Promise<PaymentQuote> {
    /**
     * TODO: Replace preview formula with the real Arweave fee oracle:
     *
     *   const arweave = await this.getClient();
     *   // getPrice() returns the cost in Winston for storing `dataSizeBytes` bytes.
     *   // 1 AR = 1e12 Winston.
     *   const winstons = await arweave.transactions.getPrice(dataSizeBytes);
     *   const amount   = arweave.ar.winstonToAr(winstons);
     *   const usd      = (parseFloat(amount) * TOKENS['AR'].approxUsdPrice).toFixed(6);
     *
     *   return {
     *     token: 'AR', amount, usd, type: 'storage',
     *     dataSizeBytes, expiresAt: Date.now() + this.quoteValidityMs,
     *   };
     */

    // Preview: static formula (~$0.004/MB) matching existing estimateCost() in core/payment.ts
    const fileSizeMB = dataSizeBytes / (1024 * 1024);
    const storageUsd = Math.max(0.0001, fileSizeMB * 0.004);
    const amount = (storageUsd / TOKENS["AR"].approxUsdPrice).toFixed(8);
    const usd = storageUsd.toFixed(6);

    console.log(
      `[dStorage/arweave-payment] (preview) Estimated: ${amount} AR ≈ $${usd}`,
    );

    return {
      token: "AR",
      amount,
      usd,
      type: "storage",
      dataSizeBytes,
      expiresAt: Date.now() + this.quoteValidityMs,
    };
  }

  async pay(
    quote: PaymentQuote,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    /**
     * TODO: Replace with real Arweave payment flow:
     *
     *   const arweave = await this.getClient();
     *   const wallet  = this.config.walletKey ?? 'use_wallet'; // 'use_wallet' → ArConnect
     *
     *   // Convert quoted AR amount back to Winston for the transaction value.
     *   const winstons = arweave.ar.arToWinston(quote.amount);
     *
     *   // Bundled flow: in the full integration, data upload and fee payment share one tx.
     *   // Standalone payment tx (pre-integration placeholder):
     *   const tx = await arweave.createTransaction({ data: new Uint8Array(0) }, wallet);
     *   tx.addTag('App-Name',      'dStorage');
     *   tx.addTag('App-Version',   '0.1.0');
     *   tx.addTag('Payment-Type',  'storage');
     *   tx.addTag('Payment-Bytes', String(quote.dataSizeBytes));
     *
     *   onStatus?.('Requesting AR wallet signature…');
     *   await arweave.transactions.sign(tx, wallet);
     *
     *   onStatus?.('Broadcasting AR payment transaction…');
     *   const response = await arweave.transactions.post(tx);
     *   if (response.status !== 200 && response.status !== 202) {
     *     throw new Error(`[dStorage/arweave-payment] Broadcast failed: ${response.statusText}`);
     *   }
     *
     *   onStatus?.('Awaiting Arweave confirmation…');
     *   // Arweave is optimistic — treat 200/202 as accepted for UX purposes.
     *
     *   return {
     *     txHash: tx.id, token: 'AR', amount: quote.amount, usd: quote.usd,
     *     type: 'storage', simulated: false, paidAt: Date.now(),
     *   };
     */

    // Preview: simulate with delays
    onStatus?.("Requesting AR wallet signature… (preview)");
    await delay(600);

    onStatus?.("Broadcasting AR payment transaction… (preview)");
    await delay(800);

    onStatus?.("Awaiting Arweave confirmation… (preview)");
    await delay(500);

    const txHash = `arweave_preview_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    console.log(
      `[dStorage/arweave-payment] (preview) Storage payment → txHash: ${txHash}`,
    );

    return {
      txHash,
      token: "AR",
      amount: quote.amount,
      usd: quote.usd,
      type: "storage",
      simulated: true, // ← becomes false once the TODO above is wired up
      paidAt: Date.now(),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
