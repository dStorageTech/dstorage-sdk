/**
 * @dstorage/core — payment.ts
 *
 * Payment utilities for the core orchestration layer.
 *
 * Token definitions (TokenSymbol, Token, TOKENS) and the PaymentReceipt type
 * are defined in @dstorage/payment and re-exported here for backward compatibility.
 *
 * This file owns:
 *   - CostEstimate — the UI-facing aggregation of two PaymentQuotes shown in MetaTxProgress
 *   - buildCostEstimate() — assembles a CostEstimate from a storage quote + a chain quote
 *   - defaultStorageToken() / defaultChainToken() — token selectors used when no payment
 *     adapter is configured, to instantiate the correct MockPaymentAdapter defaults
 */

// Re-export token primitives from @dstorage/payment for backward compatibility
export type { TokenSymbol, Token, PaymentReceipt } from "@dstorage/payment";
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
    usd: string;
  };
  chainCost: {
    amount: string;
    token: TokenSymbol;
    usd: string;
  };
  /** Combined total in USD (approximate) */
  totalUsd: string;
  /** File size in bytes */
  fileSizeBytes: number;
  /** Human-readable file size, e.g. "1.2 MB" or "340.0 KB" */
  fileSizeDisplay: string;
}

/**
 * Build a CostEstimate from two PaymentQuotes.
 * Called inside MetaTransaction.execute() during the estimate step.
 */
export function buildCostEstimate(
  storageQuote: PaymentQuote,
  chainQuote: PaymentQuote,
  fileSizeBytes: number,
): CostEstimate {
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  const fileSizeDisplay =
    fileSizeMB < 1
      ? `${(fileSizeBytes / 1024).toFixed(1)} KB`
      : `${fileSizeMB.toFixed(2)} MB`;

  const totalUsd = (
    parseFloat(storageQuote.usd) + parseFloat(chainQuote.usd)
  ).toFixed(6);

  return {
    storageCost: {
      amount: storageQuote.amount,
      token: storageQuote.token,
      usd: storageQuote.usd,
    },
    chainCost: {
      amount: chainQuote.amount,
      token: chainQuote.token,
      usd: chainQuote.usd,
    },
    totalUsd,
    fileSizeBytes,
    fileSizeDisplay,
  };
}

// ── Token selector helpers ────────────────────────────────────────────────────

/**
 * Return the default storage payment token for a given storage provider name.
 * Used by MetaTransaction to instantiate MockPaymentAdapter with the right token
 * when no storagePaymentAdapter is configured.
 */
export function defaultStorageToken(storageProvider: string): TokenSymbol {
  switch (storageProvider) {
    case "arweave":
      return "AR";
    case "autonomi":
      return "ANT";
    default:
      return "MOCK";
  }
}

/**
 * Return the default chain payment token for a given chain provider name.
 * Used by MetaTransaction to instantiate MockPaymentAdapter with the right token
 * when no chainPaymentAdapter is configured.
 */
export function defaultChainToken(chainProvider: string): TokenSymbol {
  switch (chainProvider) {
    case "midnight":
      return "DUST";
    case "ethereum":
      return "ETH";
    case "polygon":
      return "MATIC";
    default:
      return "MOCK";
  }
}
