/**
 * @dstorage/payment — adapters/account.ts
 *
 * Account payment adapter for Arweave — remote signing via REST API.
 *
 * Instead of signing the Arweave transaction locally (ArConnect or JWK),
 * this adapter constructs the Arweave transaction and sends its JSON
 * representation to a remote REST API. The server holds a funded Arweave
 * account, signs the transaction, and returns the signature and id.
 *
 * ── REST API contract ─────────────────────────────────────────────────────────
 *
 *   POST {baseUrl}/api/service/sign-tx
 *        → { txData: object, network: string, userId: string }
 *             txData   — full Arweave transaction JSON (tx.toJSON()).
 *             network  — Arweave network identifier (e.g. "arweave", "arlocal").
 *             userId   — caller identity forwarded to the server.
 *        ← { txId: string, signature: string, publicKey: string, txAmount: string, ... }
 *             txId      — valid 43-char base64url Arweave transaction id.
 *             signature — base64url RSA-PSS signature.
 *             publicKey — server wallet's RSA modulus n (base64url).
 *             The adapter calls tx.setSignature({ id, signature, owner }).
 *
 * ── Integration ───────────────────────────────────────────────────────────────
 *
 * AccountPaymentAdapter extends ArweavePaymentAdapter and slots into the
 * same sign-then-post flow used by ArweaveStorageAdapter:
 *
 *   MetaTransaction:
 *     provideUploadData(data, metadata)  ← stores data + tags
 *     pay(quote, onStatus)               ← creates tx, sends JSON to server,
 *                                           applies returned signature
 *
 *   ArweaveStorageAdapter.upload():
 *     consumeSignedUpload()              ← picks up the pre-signed tx
 *     postWithRetry(arweave, tx)         ← broadcasts to Arweave network
 */

import type {
  PaymentProviderName,
  PaymentQuote,
  PaymentReceipt,
} from "../types.js";
import { ArweavePaymentAdapter } from "./arweave.js";
import type { ArweavePaymentAdapterConfig } from "./arweave.js";

// ── Config ────────────────────────────────────────────────────────────────────

export interface AccountPaymentAdapterConfig extends Omit<
  ArweavePaymentAdapterConfig,
  "walletKey"
> {
  /**
   * Base URL of the remote signing server (no trailing slash).
   * Example: "https://api.my-server.com"
   */
  signingServerUrl: string;
  /**
   * Caller identity forwarded to every server request.
   * Used by the server to look up the account and record transactions.
   */
  userId: string;
  /**
   * Arweave network identifier sent with every sign request.
   * The server uses this to select the correct network context.
   * Example: "arweave" (mainnet), "arlocal" (local test node).
   */
  network: string;
}

// ── Server response shapes ────────────────────────────────────────────────────

interface SignTxResponse {
  /** Arweave transaction id (base64url-encoded). */
  txId: string;
  /** RSA-PSS signature over the Arweave signature data (base64url-encoded). */
  signature: string;
  /** Wallet public key used as the transaction owner (base64url-encoded RSA `n`). */
  publicKey: string;
  /**
   * Total transaction amount/cost as a string (server-defined units, typically AR).
   * Used by this adapter as the returned `arCost` display value.
   */
  txAmount: string;
  /** Indicates whether the signing service successfully produced a signature. */
  success: boolean;
  /** Address of the server-side wallet that signed/broadcasts the transaction. */
  walletAddress: string;
  /**
   * Optional Arweave fee estimate returned by the server (string, units server-defined).
   * Informational only; the adapter does not currently use this value.
   */
  arFeeEstimate: string;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class AccountPaymentAdapter extends ArweavePaymentAdapter {
  override readonly name: PaymentProviderName = "dstorage";

  private readonly signingServerUrl: string;
  private readonly userId: string;
  private readonly network: string;

  constructor(config: AccountPaymentAdapterConfig) {
    // walletKey intentionally omitted — signing is remote
    super({
      ...(config.gateway !== undefined ? { gateway: config.gateway } : {}),
      ...(config.quoteValidityMs !== undefined
        ? { quoteValidityMs: config.quoteValidityMs }
        : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
    });
    this.signingServerUrl = config.signingServerUrl.replace(/\/$/, "");
    this.userId = config.userId;
    this.network = config.network;
  }

  // ── PaymentAdapter: pay ───────────────────────────────────────────────────────

  /**
   * Remote-signing flow:
   *   1. Creates the Arweave transaction locally (data + tags, no local signing).
   *   2. POSTs the full transaction JSON to the signing server.
   *   3. Applies the returned id, signature, and owner to the transaction.
   *   4. Stores the signed transaction for ArweaveStorageAdapter.upload() to post.
   *
   * Falls back to the base-class pass-through if provideUploadData() was not called.
   */
  override async pay(
    quote: PaymentQuote,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    if (!this.pendingUpload) {
      return super.pay(quote, onStatus);
    }

    const { data, metadata } = this.pendingUpload;
    this.pendingUpload = null;

    const arweave = await this.getClient();

    onStatus?.("Creating Arweave transaction…");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await arweave.createTransaction({ data });
    for (const [key, value] of Object.entries(metadata)) {
      tx.addTag(key, value);
    }

    onStatus?.("Sending transaction to signing server…");
    let signResp: Response;
    try {
      signResp = await fetch(`${this.signingServerUrl}/api/service/sign-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          txData: tx.toJSON(),
          network: this.network,
          userId: this.userId,
        }),
      });
    } catch (err) {
      throw new Error(
        `[dStorage/account-payment] Could not reach signing server: ${err}`,
      );
    }
    if (!signResp.ok) {
      const body = await signResp.text().catch(() => "");
      throw new Error(
        `[dStorage/account-payment] POST /api/service/sign-tx failed: HTTP ${signResp.status}${body ? ` — ${body}` : ""}`,
      );
    }

    const {
      txId,
      signature,
      publicKey: signedPublicKey,
      txAmount: arCost,
    } = (await signResp.json()) as SignTxResponse;

    onStatus?.("Applying remote signature…");
    tx.setSignature({ id: txId, signature, owner: signedPublicKey });

    this.signedUpload = { tx, arCost };

    this.logger?.log(
      "dStorage/account-payment",
      `Transaction signed remotely (${this.signingServerUrl} API service) → txId: ${txId}  cost: ~${arCost} AR`,
    );

    return {
      txHash: txId,
      token: "AR",
      amount: quote.amount,
      type: "storage",
      simulated: false,
      paidAt: Date.now(),
    };
  }
}
