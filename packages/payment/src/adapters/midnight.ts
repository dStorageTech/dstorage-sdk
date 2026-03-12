/**
 * @dstorage/payment — adapters/midnight.ts
 *
 * Midnight payment adapter.
 * Pays Midnight blockchain transaction fees using DUST tokens.
 *
 * Real integration flow:
 *   estimateFee(txBuilder, wallet)      → gas estimate in DUST
 *   createBalancedTx(txBuilder, wallet) → balance the tx deducting DUST from wallet
 *   balanced.submit()                   → broadcast to Midnight network
 *
 * Requirements for real payments:
 *   - Lace wallet with Midnight extension (browser), OR
 *   - Programmatic Midnight wallet instance (Node.js)
 *   - DUST tokens (available from emissions of registered NIGHT)
 *
 * Note: On Midnight, the DUST fee and the writeReference circuit call are part
 * of the same balanced transaction — the fee is automatically deducted by
 * createBalancedTx(). This adapter covers the fee estimation and authorisation
 * steps; actual deduction happens inside the Midnight.js balanced tx builder.
 */

import type {
  Logger,
  PaymentAdapter,
  PaymentNetworkName,
  PaymentQuote,
  PaymentReceipt,
  TokenSymbol,
} from "../types.js";

export interface MidnightPaymentAdapterConfig {
  /**
   * Midnight node RPC endpoint.
   */
  nodeEndpoint?: string;
  /**
   * Midnight DApp connector injected by the browser extension.
   * In Node.js, pass a programmatic wallet instance.
   */
  wallet?: unknown;
  /**
   * How long in ms before a quote expires.
   * Midnight gas prices can shift; 2 minutes is a safe default.
   * Defaults to 120_000.
   */
  quoteValidityMs?: number;
  /**
   * Optional logger for SDK operational output.
   */
  logger?: Logger;
}

export class MidnightPaymentAdapter implements PaymentAdapter {
  readonly network: PaymentNetworkName = "midnight";
  readonly token: TokenSymbol = "DUST";
  readonly type: "storage" | "chain" = "chain";

  private config: MidnightPaymentAdapterConfig;
  private readonly quoteValidityMs: number;
  private readonly logger: Logger | undefined;

  constructor(config: MidnightPaymentAdapterConfig = {}) {
    this.config = {
      nodeEndpoint:
        config.nodeEndpoint ?? "https://rpc.preprod.midnight.network",
      wallet: config.wallet,
    };
    this.quoteValidityMs = config.quoteValidityMs ?? 120_000;
    this.logger = config.logger;

    this.logger?.warn(
      "dStorage/midnight-payment",
      "Midnight payment adapter — real DUST fee deduction.",
    );
  }

  async estimateCost(dataSizeBytes: number): Promise<PaymentQuote> {
    /**
     * TODO: Replace with real Midnight fee estimation:
     *
     *   import { estimateFee } from '@midnight-ntwrk/midnight-js';
     *   import { DataRegistry }  from '../../chain/contracts/DataRegistry.compact';
     *
     *   // Build a representative transaction to get an accurate fee estimate.
     *   // On Midnight, fees are dominated by ZK proof computation cost, not data size.
     *   const contract   = new Contract(DataRegistry, contractAddress);
     *   const txBuilder  = await contract.call.storeReference(...representativeArgs);
     *   const feeInfo    = await estimateFee(txBuilder, this.config.wallet);
     *   const amount     = feeInfo.fee.toString();
     *
     *   return {
     *     token: 'DUST', amount, type: 'chain',
     *     dataSizeBytes, expiresAt: Date.now() + this.quoteValidityMs,
     *   };
     */

    // TODO: query a service to obtain estimation
    // Preview: flat ~$0.01 per chain tx.
    // On Midnight, the fee is circuit-cost-dominated, so dataSizeBytes is not proportional.
    void dataSizeBytes;
    const amount = "0.1000";

    this.logger?.log(
      "dStorage/midnight-payment",
      `(preview) Estimated: ${amount} DUST`,
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

  async pay(
    quote: PaymentQuote,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    /**
     * TODO: Replace with real Midnight fee payment:
     *
     *   import { Contract, createBalancedTx } from '@midnight-ntwrk/midnight-js';
     *   import { DataRegistry } from '../../chain/contracts/DataRegistry.compact';
     *
     *   // The DUST fee is deducted automatically when the balanced transaction is
     *   // submitted — no separate transfer tx is needed. This adapter authorises
     *   // the fee and returns a receipt once the tx is confirmed.
     *
     *   const contract  = new Contract(DataRegistry, contractAddress);
     *   const txBuilder = await contract.call.storeReference(...args);
     *
     *   onStatus?.('Requesting DUST wallet authorisation…');
     *   const balanced  = await createBalancedTx(txBuilder, this.config.wallet);
     *
     *   onStatus?.('Submitting balanced transaction to Midnight…');
     *   const receipt   = await balanced.submit();
     *   // balanced.submit() resolves once the tx is included in a block.
     *
     *   onStatus?.('Awaiting Midnight block confirmation…');
     *
     *   return {
     *     txHash: receipt.txHash, token: 'DUST', amount: quote.amount,
     *     type: 'chain', simulated: false, paidAt: Date.now(),
     *   };
     */

    // Preview: simulate with delays
    onStatus?.("Requesting DUST wallet authorisation… (preview)");
    await delay(600);

    onStatus?.("Submitting balanced transaction to Midnight… (preview)");
    await delay(900);

    onStatus?.("Awaiting Midnight block confirmation… (preview)");
    await delay(700);

    const txHash = `midnight_preview_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.logger?.log(
      "dStorage/midnight-payment",
      `(preview) Chain fee payment → txHash: ${txHash}`,
    );

    return {
      txHash,
      token: "DUST",
      amount: quote.amount,
      type: "chain",
      simulated: true, // ← becomes false once the TODO above is wired up
      paidAt: Date.now(),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
