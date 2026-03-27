/**
 * @dstorage/core — metaTx/payment.ts
 *
 * Payment utilities for the core orchestration layer.
 *
 * Token definitions (TokenSymbol, Token, TOKENS) and the PaymentReceipt type
 * are defined in @dstorage/payment and re-exported here.
 *
 * This file owns:
 *   - CostEstimate — the UI-facing aggregation of two PaymentQuotes shown in MetaTxProgress
 *   - buildCostEstimate() — assembles a CostEstimate from a storage quote + a chain quote
 */

// Re-export token primitives from @dstorage/payment
export type {
  TokenSymbol,
  Token,
  PaymentReceipt,
  PaymentQuote,
} from "@dstorage/payment";
export { TOKENS } from "@dstorage/payment";

import type { PaymentQuote, TokenSymbol } from "@dstorage/payment";

// ── CostEstimate ──────────────────────────────────────────────────────────────

/**
 * Aggregated cost estimate for a complete meta-transaction.
 * Built from two PaymentQuotes — one from the storagePaymentAdapter and one
 * from the chainPaymentAdapter — and displayed in the MetaTxProgress UI.
 */
export interface CostEstimate {
  storageCost: {
    amount: string;
    token: TokenSymbol;
  };
  chainCost: {
    amount: string;
    token: TokenSymbol;
  };
  /** File size in bytes */
  fileSizeBytes: number;
}

/**
 * Build a CostEstimate from two PaymentQuotes.
 * Called inside MetaTx.execute() during the estimate step.
 */
export function buildCostEstimate(
  storageQuote: PaymentQuote,
  chainQuote: PaymentQuote,
  fileSizeBytes: number,
): CostEstimate {
  return {
    storageCost: {
      amount: storageQuote.amount,
      token: storageQuote.token,
    },
    chainCost: {
      amount: chainQuote.amount,
      token: chainQuote.token,
    },
    fileSizeBytes,
  };
}
