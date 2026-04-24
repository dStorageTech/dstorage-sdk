/**
 * @dstorage/payment — types.ts
 *
 * Token definitions and the PaymentAdapter interface.
 *
 * Every payment adapter (Mock, Arweave, Midnight, …) must implement PaymentAdapter.
 * Token definitions live here and are re-exported from @dstorage/core.
 */

/**
 * Minimal logger interface accepted by every SDK class.
 * Compatible with `console` — pass `logger: console` for zero-boilerplate logging.
 * Omit the field entirely to suppress all SDK output.
 */
export interface PaymentAdapterLogger {
  log(component: string, msg: string): void;
  warn(component: string, msg: string): void;
  error(component: string, msg: string): void;
  debug?(component: string, msg: string): void;
}

// ── Token definitions ─────────────────────────────────────────────────────────

/** All tokens the SDK knows about. MOCK is used for development and testing. */
export type TokenSymbol = "AR" | "ANT" | "DUST" | "MOCK";

/** Display metadata about a token — used for labels and cost conversion. */
export interface Token {
  symbol: TokenSymbol;
  name: string;
  decimals: number;
}

/** Registry of all tokens the SDK knows about. */
export const TOKENS: Record<TokenSymbol, Token> = {
  AR: { symbol: "AR", name: "Arweave", decimals: 12 },
  ANT: { symbol: "ANT", name: "Autonomi", decimals: 9 },
  DUST: { symbol: "DUST", name: "Midnight", decimals: 6 },
  MOCK: {
    symbol: "MOCK",
    name: "Mock Token",
    decimals: 6,
  },
};

// ── Provider name ─────────────────────────────────────────────────────────────

/** Identifies which network the payment provider works for. */
export type PaymentNetworkName =
  | "mock"
  | "arweave"
  | "midnight"
  | "arweave_turbo";

// ── PaymentQuote ──────────────────────────────────────────────────────────────

/**
 * A cost quote returned by PaymentAdapter.estimateCost().
 *
 * Quotes have a limited validity window — call pay() before expiresAt to
 * avoid stale pricing. Real adapters may tighten this window based on
 * network fee volatility.
 */
export interface PaymentQuote {
  /** Token this quote is denominated in */
  token: TokenSymbol;
  /** Amount in the native token (string to preserve precision) */
  amount: string;
  /** Whether this covers a storage network fee or a chain transaction fee */
  type: "storage" | "chain";
  /**
   * The network this quote is for.
   * Used by multi-network adapters (e.g. ManagedPaymentAdapter) to select the
   * correct payment path. Examples: "arweave", "arlocal", "midnight".
   */
  network: string;
  /** File size used to derive this quote */
  dataSizeBytes: number;
  /** Timestamp after which this quote should be refreshed */
  expiresAt: number;
  /**
   * Opaque serialized transaction bytes (hex) to be sent to the signing server.
   * Used by ManagedPaymentAdapter to pass a network-specific unbalanced/unsigned
   * transaction for the server to sign or balance.
   * Example: serialized UnboundTransaction hex for Midnight.
   *
   * Privacy note: this field carries only the minimum information required for the
   * server to fund, sign, or balance the transaction (e.g. fee inputs, public keys,
   * circuit call data). No personal data or plaintext user content is ever included.
   */
  txData?: string;
}

// ── PaymentReceipt ────────────────────────────────────────────────────────────

/**
 * Proof of a completed payment returned by PaymentAdapter.pay().
 */
export interface PaymentReceipt {
  /** On-chain transaction hash, or equivalent */
  txHash: string;
  /** Token used for payment */
  token: TokenSymbol;
  /** Amount paid in the native token */
  amount: string;
  /** What this payment covered */
  type: "storage" | "chain";
  /** Timestamp of payment confirmation */
  paidAt: number;
  /**
   * Opaque serialized balanced/signed transaction bytes (hex).
   * Example: serialized FinalizedTransaction hex for Midnight — the chain adapter
   * deserializes this and passes it directly to submitTx().
   */
  signedTx?: string;
}

// ── PaymentAdapter interface ──────────────────────────────────────────────────

/**
 * Contract every payment adapter must satisfy.
 *
 * Adapters are plugged into DStorageConfig:
 *   storagePaymentAdapter — covers storage network fees (AR, ANT, MOCK)
 *   chainPaymentAdapter   — covers blockchain transaction fees (DUST, ETH, MOCK)
 *
 * The adapter pattern lets you swap real payment networks without touching
 * any orchestration code.
 */
export interface PaymentAdapter {
  /** Which network the payment works for */
  readonly network: PaymentNetworkName;

  /**
   * The token this adapter transacts in.
   * Determines the token field on every PaymentQuote and PaymentReceipt it produces.
   */
  readonly token: TokenSymbol;

  /**
   * What kind of payment this adapter handles.
   * 'storage' — storage network fee (AR for Arweave, ANT for Autonomi).
   * 'chain'   — blockchain transaction fee (DUST for Midnight, ETH for Ethereum).
   */
  readonly type: "storage" | "chain";

  /**
   * Get a cost estimate for a payload of the given size.
   *
   * Call this during the estimate step before committing to payment.
   * The returned quote is valid until quote.expiresAt — pass it to pay()
   * before that window closes to avoid repricing.
   *
   * @param dataSizeBytes  Size of the encrypted payload in bytes
   */
  estimateCost(dataSizeBytes: number): Promise<PaymentQuote>;

  /**
   * Execute the payment described by the quote.
   *
   * For real adapters this triggers a wallet signature prompt and broadcasts
   * a transaction. For MockPaymentAdapter it simulates the UX with delays.
   *
   * @param quote     The quote returned from estimateCost()
   * @param onStatus  Optional callback for live status messages (used by MetaTransaction
   *                  to update the step detail shown in the UI)
   */
  pay(
    quote: PaymentQuote,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt>;

  /**
   * Optional hook called by MetaTransaction after encryption and before pay().
   *
   * Provides the actual upload payload (and optional metadata tags) to adapters
   * that need the data to construct the payment transaction before signing.
   *
   * Example: Arweave bundles data + fee in one transaction object — it must have
   * the data at sign time. MetaTransaction calls this immediately after encrypt
   * so that pay() can create → tag → sign the transaction, and the storage
   * adapter's upload() can then simply post the pre-signed transaction.
   *
   * Adapters that do not need the data (Mock, WalletManaged, Midnight) leave
   * this unimplemented and MetaTransaction skips the call.
   */
  provideUploadData?(data: Uint8Array, metadata?: Record<string, string>): void;
}
