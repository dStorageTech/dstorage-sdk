/**
 * @dstorage/payment — adapters/mock.ts
 *
 * Mock payment adapter for development, testing, and demos.
 *
 * Simulates the full wallet-prompt → broadcast → confirmation UX with
 * realistic delays. No real token transfers occur.
 *
 * The token and type (storage or chain) are set at construction time,
 * so a single adapter class covers both storage and chain payment slots.
 *
 * Usage:
 *   new MockPaymentAdapter({ token: 'MOCK', type: 'chain' })
 *   new MockPaymentAdapter({ token: 'AR', type: 'storage' })
 *   new MockPaymentAdapter({ token: 'DUST', type: 'chain' })
 */

import type {
  PaymentAdapterLogger,
  PaymentAdapter,
  PaymentInstruction,
  PaymentNetworkName,
  PaymentQuote,
  PaymentReceipt,
  TokenSymbol,
  NetworkType,
} from "../types.js";
import { TOKENS } from "../types.js";
import { assertValidLogger } from "@dstorage/crypto";

export interface MockPaymentAdapterConfig {
  /**
   * Token this adapter simulates payments in.
   * Defaults to 'MOCK'.
   */
  token?: TokenSymbol;
  /**
   * Payment type this instance simulates.
   */
  type: NetworkType;
  /**
   * How long in ms before a quote expires.
   * Defaults to 600_000 (10 minutes).
   */
  quoteValidityMs?: number;
  /**
   * Optional logger for SDK operational output.
   */
  logger?: PaymentAdapterLogger;
}

export class MockPaymentAdapter implements PaymentAdapter {
  readonly network: PaymentNetworkName = "mock";
  readonly token: TokenSymbol;
  readonly type: NetworkType;

  private readonly quoteValidityMs: number;
  private readonly logger: PaymentAdapterLogger | undefined;

  constructor(config: MockPaymentAdapterConfig) {
    this.token = config.token ?? "MOCK";
    this.type = config.type;
    this.quoteValidityMs = config.quoteValidityMs ?? 600_000;
    assertValidLogger(config.logger, "MockPaymentAdapter");
    this.logger = config.logger;
  }

  async estimateCost(dataSizeBytes: number): Promise<PaymentQuote> {
    // MOCK pricing: 0.001 MOCK per KB, minimum 0.0001 MOCK
    const kb = dataSizeBytes / 1024;
    const amount = Math.max(0.0001, kb * 0.001).toFixed(6);

    this.logger?.log(
      "dStorage/mock-payment",
      `Estimated cost: ${amount} ${this.token}`,
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
    instruction: PaymentInstruction,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    const tokenName = TOKENS[this.token]?.name ?? this.token;

    onStatus?.(`Requesting ${tokenName} wallet signature…`);
    onStatus?.(`Broadcasting ${this.type} payment transaction…`);
    onStatus?.("Awaiting confirmation…");

    const txHash = generateSimulatedTxHash();
    const { amount } = await this.estimateCost(instruction.dataSizeBytes);

    this.logger?.log(
      "dStorage/mock-payment",
      `Simulated ${this.type} payment → txHash: ${txHash}`,
    );

    return {
      txHash,
      token: this.token,
      amount,
      type: this.type,
      paidAt: Date.now(),
      serviceFee: "0",
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
