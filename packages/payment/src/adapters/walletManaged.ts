/**
 * @dstorage/payment — adapters/walletManaged.ts
 *
 * Payment adapter for chains where fees are handled internally by the wallet
 * during transaction balancing (e.g., Midnight via dApp connector).
 *
 * On Midnight, DUST fees are deducted automatically when the wallet balances
 * the transaction via `connectedAPI.balanceUnsealedTransaction()`. There is no
 * separate payment step — the Lace wallet prompts the user to approve the fee
 * as part of the transaction submission flow.
 *
 * This adapter acts as a pass-through: it returns a zero-cost quote and a
 * receipt indicating that fee handling is deferred to the wallet.
 */

import type {
  PaymentAdapter,
  PaymentProviderName,
  PaymentQuote,
  PaymentReceipt,
  TokenSymbol,
} from "../types.js";

export interface WalletManagedPaymentAdapterConfig {
  /** Token symbol for display purposes. Default: 'DUST'. */
  token?: TokenSymbol;
}

export class WalletManagedPaymentAdapter implements PaymentAdapter {
  readonly name: PaymentProviderName = "midnight";
  readonly token: TokenSymbol;
  readonly type: "storage" | "chain" = "chain";

  constructor(config: WalletManagedPaymentAdapterConfig = {}) {
    this.token = config.token ?? "DUST";
  }

  async estimateCost(dataSizeBytes: number): Promise<PaymentQuote> {
    void dataSizeBytes;
    return {
      token: this.token,
      amount: "0",
      fiat_amount: "0.00",
      type: "chain",
      dataSizeBytes,
      expiresAt: Date.now() + 300_000,
    };
  }

  async pay(
    quote: PaymentQuote,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    onStatus?.(
      "Chain fees will be handled by wallet during transaction balancing",
    );

    return {
      txHash: "wallet-managed",
      token: this.token,
      amount: quote.amount,
      fiat_amount: quote.fiat_amount,
      type: "chain",
      simulated: false,
      paidAt: Date.now(),
    };
  }
}
