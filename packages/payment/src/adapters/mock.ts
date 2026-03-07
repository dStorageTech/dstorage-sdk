/**
 * @dstorage/payment — adapters/mock.ts
 *
 * Mock payment adapter for development, testing, and demos.
 *
 * Simulates the full wallet-prompt → broadcast → confirmation UX with
 * realistic delays. No real token transfers occur — every receipt has
 * simulated: true.
 *
 * The token and type (storage or chain) are set at construction time,
 * so a single adapter class covers both storage and chain payment slots.
 *
 * Usage:
 *   new MockPaymentAdapter()                            // MOCK token, storage type
 *   new MockPaymentAdapter({ type: 'chain' })           // MOCK token, chain type
 *   new MockPaymentAdapter({ token: 'AR', type: 'storage' })
 *   new MockPaymentAdapter({ token: 'DUST', type: 'chain' })
 */

import type {
  Logger,
  PaymentAdapter,
  PaymentProviderName,
  PaymentQuote,
  PaymentReceipt,
  TokenSymbol,
} from "../types.js";
import { TOKENS } from "../types.js";

export interface MockPaymentAdapterConfig {
  /**
   * Token to simulate payments with.
   * Defaults to 'MOCK'.
   */
  token?: TokenSymbol;
  /**
   * Payment type this instance simulates.
   * Defaults to 'storage'.
   */
  type?: "storage" | "chain";
  /**
   * How long in ms before a quote expires.
   * Defaults to 600_000 (10 minutes).
   */
  quoteValidityMs?: number;
  /**
   * Optional logger for SDK operational output.
   */
  logger?: Logger;
}

export class MockPaymentAdapter implements PaymentAdapter {
  readonly name: PaymentProviderName = "mock";
  readonly token: TokenSymbol;
  readonly type: "storage" | "chain";

  private readonly quoteValidityMs: number;
  private readonly logger: Logger | undefined;

  constructor(config: MockPaymentAdapterConfig = {}) {
    this.token = config.token ?? "MOCK";
    this.type = config.type ?? "storage";
    this.quoteValidityMs = config.quoteValidityMs ?? 600_000;
    this.logger = config.logger;
  }

  async estimateCost(dataSizeBytes: number): Promise<PaymentQuote> {
    // MOCK pricing: 0.001 MOCK per KB, minimum 0.0001 MOCK
    const kb = dataSizeBytes / 1024;
    const amount = Math.max(0.0001, kb * 0.001).toFixed(6);
    const usd = (
      parseFloat(amount) * (TOKENS[this.token]?.approxUsdPrice ?? 1)
    ).toFixed(6);

    this.logger?.log(
      `[dStorage/mock-payment] Estimated cost: ${amount} ${this.token} ≈ $${usd}`,
    );

    return {
      token: this.token,
      amount,
      usd,
      type: this.type,
      dataSizeBytes,
      expiresAt: Date.now() + this.quoteValidityMs,
    };
  }

  async pay(
    quote: PaymentQuote,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    const tokenName = TOKENS[quote.token]?.name ?? quote.token;

    // Phase 1 — wallet prompt
    onStatus?.(`Requesting ${tokenName} wallet signature…`);
    await delay(600);

    // Phase 2 — broadcasting
    onStatus?.(`Broadcasting ${quote.type} payment transaction…`);
    await delay(800);

    // Phase 3 — confirmation
    onStatus?.("Awaiting confirmation…");
    await delay(500);

    const txHash = generateSimulatedTxHash();

    this.logger?.log(
      `[dStorage/mock-payment] Simulated ${quote.type} payment → txHash: ${txHash}`,
    );

    return {
      txHash,
      token: quote.token,
      amount: quote.amount,
      usd: quote.usd,
      type: quote.type,
      simulated: true,
      paidAt: Date.now(),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateSimulatedTxHash(): string {
  const hex = Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `0x${hex}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
