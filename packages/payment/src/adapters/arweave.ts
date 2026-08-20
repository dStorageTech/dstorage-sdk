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
 *   2. pay(instruction, onStatus)  [payment_storage step]
 *        Creates the Arweave transaction, attaches tags, and prompts the
 *        wallet for approval (ArConnect popup / JWK signing). Stores the
 *        signed transaction for the upload step to pick up.
 *
 *   3. ArweaveStorageAdapter.store()  [store step]
 *        Detects the pre-signed transaction via consumeSignedTx() and simply
 *        posts it — no additional signing or wallet interaction needed.
 *
 * If provideUploadData() was not called (e.g. direct use outside MetaTransaction),
 * pay() falls back to the pass-through behaviour and store() performs the full
 * create → sign → post flow as before.
 *
 * Docs: https://docs.arweave.org/developers
 */

import type Arweave from "arweave";
import { blake3 } from "@noble/hashes/blake3.js";
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
import { DStorageError, assertValidLogger } from "@dstorage/crypto";
import { PaymentErrorCode } from "../errors.js";

import type Transaction from "arweave/node/lib/transaction";
import type { JWKInterface } from "arweave/node/lib/wallet";

// ── Arweave wallet union ───────────────────────────────────────────────────────

type ArweaveWallet = JWKInterface | "use_wallet";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default quote validity window in milliseconds. 2 minutes is appropriate for Arweave's volatile pricing. */
const DEFAULT_QUOTE_VALIDITY_MS = 120_000;

/** Arweave transaction tag storing the BLAKE3 hex digest of the uploaded bytes. */
const CONTENT_HASH_TAG = "X-Content-Hash";

export interface ArweavePaymentAdapterConfig {
  /**
   * Arweave gateway.
   * Defaults to mainnet (arweave.net).
   * Use { host: 'arweave.dev', port: 443, protocol: 'https' } for testnet.
   * Use { host: 'localhost', port: 1984, protocol: 'http' } for arlocal.
   *
   * Security: always use `protocol: 'https'` (the default) in production.
   * The SDK relies on standard OS/runtime TLS — no DNS or certificate pinning
   * is applied. Users in adversarial network environments should enforce
   * certificate pinning at the runtime level (e.g. a custom Node.js HTTPS
   * agent or a trusted corporate proxy).
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
   * Defaults to 120_000 (2 minutes) — appropriate for Arweave's volatile pricing.
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

/** Result stored after pay() signs the transaction, consumed by store(). */
export interface SignedArweaveUpload {
  tx: Transaction;
  /** AR cost string (e.g. "0.000001234") for the upload result. */
  arCost: string;
}

export class ArweavePaymentAdapter implements PaymentAdapter {
  readonly network: PaymentNetworkName = "arweave";
  readonly token: TokenSymbol = "AR";
  readonly type: NetworkType = "storage";

  protected arweaveClient: Arweave | null = null;
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
    this.quoteValidityMs = config.quoteValidityMs ?? DEFAULT_QUOTE_VALIDITY_MS;
    assertValidLogger(config.logger, "ArweavePaymentAdapter");
    this.logger = config.logger;
  }

  // ── Protected: lazy Arweave client ───────────────────────────────────────────

  protected async getClient(): Promise<Arweave> {
    if (this.arweaveClient) return this.arweaveClient;
    try {
      const _m = await import("arweave");
      // Vite 8/Rolldown wraps CJS modules differently: unwrap double-default if needed.
      const raw: unknown = _m.default;
      const ctor: { init(config: object): Arweave } =
        typeof (raw as { init?: unknown }).init === "function"
          ? (raw as { init(config: object): Arweave })
          : ((raw as { default?: { init(config: object): Arweave } }).default ??
            (raw as { init(config: object): Arweave }));
      this.arweaveClient = ctor.init(this.gateway ?? {});
      return this.arweaveClient;
    } catch {
      throw new DStorageError(
        PaymentErrorCode.ARWEAVE_NOT_INSTALLED,
        "[dStorage/arweave-payment] arweave package not installed. Run: npm install arweave",
      );
    }
  }

  // ── Protected: wallet resolution ─────────────────────────────────────────────

  protected resolveWallet(): ArweaveWallet {
    if (this.walletKey && Object.keys(this.walletKey).length > 0) {
      return this.walletKey as unknown as ArweaveWallet;
    }
    if (typeof window === "undefined") {
      throw new DStorageError(
        PaymentErrorCode.ARWEAVE_WALLET_KEY_REQUIRED,
        "[dStorage/arweave-payment] Node.js usage requires a walletKey in the config.",
      );
    }
    if (
      typeof (window as unknown as Record<string, unknown>).arweaveWallet ===
      "undefined"
    ) {
      throw new DStorageError(
        PaymentErrorCode.ARWEAVE_CONNECT_NOT_FOUND,
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
    if (CONTENT_HASH_TAG in metadata) {
      throw new DStorageError(
        PaymentErrorCode.ARWEAVE_RESERVED_TAG_KEY,
        `[dStorage/arweave-payment] metadata key "${CONTENT_HASH_TAG}" is reserved ` +
          "for the SDK's own content-hash tag and cannot be set by the caller.",
      );
    }
    const hashHex = Array.from(blake3(data))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    this.pendingUpload = {
      data,
      metadata: { [CONTENT_HASH_TAG]: hashHex, ...metadata },
    };
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
   *   transaction for ArweaveStorageAdapter.store() to post.
   *
   * Pass-through fallback (when provideUploadData was NOT called):
   *   Returns a receipt acknowledging that payment is bundled with the upload.
   *   ArweaveStorageAdapter.store() performs the full create → sign → post flow.
   */
  async pay(
    instruction: PaymentInstruction,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    if (Date.now() > instruction.expiresAt) {
      throw new DStorageError(
        PaymentErrorCode.ARWEAVE_QUOTE_EXPIRED,
        `[dStorage/payment] Quote expired at ${new Date(instruction.expiresAt).toISOString()}. ` +
          "Request a fresh quote via estimateCost() before calling pay().",
      );
    }

    if (!this.pendingUpload) {
      // Fallback: payment handled inside store()
      onStatus?.("AR fee will be deducted as part of the upload transaction.");
      return {
        txHash: "arweave-bundled-with-upload",
        token: this.token,
        amount: "0",
        type: this.type,
        paidAt: Date.now(),
        serviceFee: "0",
      };
    }

    const { data, metadata } = this.pendingUpload;
    this.pendingUpload = null;

    const arweave = await this.getClient();
    const wallet = this.resolveWallet();

    onStatus?.("Creating Arweave transaction…");
    const tx = await arweave.createTransaction({ data }, wallet);

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
      `Transaction signed → txId: ${tx.id}  cost: ~${arCost} AR`,
    );

    return {
      txHash: tx.id,
      token: this.token,
      amount: arCost,
      type: this.type,
      paidAt: Date.now(),
      serviceFee: "0",
    };
  }

  // ── Consumed by ArweaveStorageAdapter ─────────────────────────────────────────

  /**
   * Returns the pre-signed transaction produced by pay(), then clears it.
   * Called by ArweaveStorageAdapter.store() to post the already-signed tx.
   * Returns null if pay() did not sign a transaction (pass-through mode).
   */
  consumeSignedUpload(): SignedArweaveUpload | null {
    const signed = this.signedUpload;
    this.signedUpload = null;
    return signed;
  }
}
