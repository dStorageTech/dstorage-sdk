/**
 * @dstorage/payment — adapters/managed.ts
 *
 * Managed payment adapter — remote payment via dStorage API services.
 *
 * Routes payment to the correct network-specific flow based on
 * PaymentQuote.network. All networks share the same endpoint:
 *   POST {baseUrl}{POST_SIGN_TX_API_PATH}
 * Currently implemented:
 *   - "arweave" / "arlocal": remote Arweave signing via REST API
 *   - "midnight": placeholder — not yet implemented
 *
 * ── Arweave flow ──────────────────────────────────────────────────────────────
 *
 * Instead of signing the Arweave transaction locally (ArConnect or JWK),
 * this adapter constructs the Arweave transaction and sends its JSON
 * representation to a remote REST API. The server holds a funded Arweave
 * account, signs the transaction, and returns the signature and id.
 *
 *   POST {baseUrl}{POST_SIGN_TX_API_PATH}
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
 * ── Integration (Arweave) ─────────────────────────────────────────────────────
 *
 * ManagedPaymentAdapter extends ArweavePaymentAdapter and slots into the
 * same sign-then-post flow used by ArweaveStorageAdapter:
 *
 *   MetaTransaction:
 *     provideUploadData(data, metadata)  ← stores data + tags
 *     pay(quote, onStatus)               ← routes by quote.network, creates tx,
 *                                           sends JSON to server, applies signature
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

// Shared API endpoint for all network payment flows on the dStorage signing server.
const POST_SIGN_TX_API_PATH = "/api/service/sign-tx";

// ── Config ────────────────────────────────────────────────────────────────────

export interface ManagedPaymentAdapterConfig extends Omit<
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

export class ManagedPaymentAdapter extends ArweavePaymentAdapter {
  override readonly name: PaymentProviderName = "dstorage";

  private readonly signingServerUrl: string;
  private readonly userId: string;

  constructor(config: ManagedPaymentAdapterConfig) {
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
  }

  // ── PaymentAdapter: pay ───────────────────────────────────────────────────────

  /**
   * Routes payment to the correct network-specific handler based on quote.network.
   *
   * Falls back to the base-class pass-through if provideUploadData() was not called
   * (Arweave path only) or if the network is unrecognised.
   */
  override async pay(
    quote: PaymentQuote,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    if (quote.network === "midnight") {
      return this._payMidnight(quote, onStatus);
    }

    // Default: Arweave (covers "arweave", "arlocal", and unset network).
    return this._payArweave(quote, onStatus);
  }

  // ── Network-specific payment handlers ────────────────────────────────────────

  /**
   * Arweave remote-signing flow:
   *   1. Creates the Arweave transaction locally (data + tags, no local signing).
   *   2. POSTs the full transaction JSON to the signing server.
   *   3. Applies the returned id, signature, and owner to the transaction.
   *   4. Stores the signed transaction for ArweaveStorageAdapter.upload() to post.
   *
   * Falls back to the base-class pass-through if provideUploadData() was not called.
   */
  private async _payArweave(
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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const txJson = tx.toJSON();

    const {
      txId,
      signature,
      publicKey: signedPublicKey,
      txAmount: arCost,
    } = await this._sendSignTxRequest(txJson, quote.network, onStatus);

    onStatus?.("Applying remote signature…");
    tx.setSignature({ id: txId, signature, owner: signedPublicKey });

    this.signedUpload = { tx, arCost };

    this.logger?.log(
      "dStorage/managed-payment",
      `Transaction signed remotely (${this.signingServerUrl} API service) → txId: ${txId}  cost: ~${arCost} ${quote.token}`,
    );

    return {
      txHash: txId,
      token: quote.token,
      amount: quote.amount,
      type: quote.type,
      simulated: false,
      paidAt: Date.now(),
    };
  }

  /**
   * Midnight payment flow:
   *   POSTs the fee amount to the dStorage API service, which holds a funded
   *   Midnight account and submits the chain transaction on behalf of the user.
   *
   *   POST {baseUrl}{POST_SIGN_TX_API_PATH}
   *        → { txData: string (hex-serialized UnboundTransaction), network: string, userId: string }
   *        ← { txId: string, signature: string (hex-serialized FinalizedTransaction), ... }
   *
   * The hex-serialized FinalizedTransaction is returned in PaymentReceipt.signedTx
   * for the chain adapter to deserialize and pass to submitTx().
   */
  private async _payMidnight(
    quote: PaymentQuote,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    const {
      txId,
      signature,
      txAmount: dustCost,
    } = await this._sendSignTxRequest(
      quote.txData ?? null,
      quote.network,
      onStatus,
    );

    this.logger?.log(
      "dStorage/managed-payment",
      `Midnight Tx signed remotely (${this.signingServerUrl} API service) → txId: ${txId}  cost: ~${dustCost} ${quote.token}`,
    );

    return {
      txHash: txId,
      token: quote.token,
      amount: quote.amount,
      type: quote.type,
      signedTx: signature,
      simulated: false,
      paidAt: Date.now(),
    };
  }

  /**
   * Shared HTTP helper: POSTs a transaction payload to the signing server and
   * returns the parsed SignTxResponse.
   *
   * - Arweave: txJson is the Arweave tx JSON object (from tx.toJSON()); the server
   *   signs it and returns the signature + owner in the response fields.
   * - Midnight: txJson is the hex-serialized UnboundTransaction; the server balances
   *   and signs it, returning the hex-serialized FinalizedTransaction in the
   *   `signature` response field.
   *
   * Throws on network errors or non-2xx HTTP responses.
   */
  private async _sendSignTxRequest(
    txJson: any,
    network: string,
    onStatus?: (message: string) => void,
  ): Promise<SignTxResponse> {
    onStatus?.(`Sending ${network} transaction to signing server…`);
    let signResp: Response;
    try {
      signResp = await fetch(
        `${this.signingServerUrl}${POST_SIGN_TX_API_PATH}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            txData: txJson,
            network,
            userId: this.userId,
          }),
        },
      );
    } catch (err) {
      throw new Error(
        `[dStorage/managed-payment] Could not reach signing server: ${err}`,
      );
    }
    if (!signResp.ok) {
      const body = await signResp.text().catch(() => "");
      throw new Error(
        `[dStorage/managed-payment] POST ${POST_SIGN_TX_API_PATH} failed: HTTP ${signResp.status}${body ? ` — ${body}` : ""}`,
      );
    }

    return (await signResp.json()) as SignTxResponse;
  }
}
