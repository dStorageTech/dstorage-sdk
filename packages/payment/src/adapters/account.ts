/**
 * @dstorage/payment — adapters/account.ts
 *
 * Account payment adapter for Arweave — remote signing via REST API.
 *
 * Instead of signing the Arweave transaction locally (ArConnect or JWK),
 * this adapter sends the transaction's signature-data bytes to a remote
 * REST API. The server holds a funded Arweave account and produces the
 * signature on behalf of the caller.
 *
 * Only the transaction header hash is sent to the server — the full data
 * payload stays local and is never transmitted to the signing service.
 *
 * ── REST API contract ─────────────────────────────────────────────────────────
 *
 *   GET  {baseUrl}/api/wallet/public-key?userId={userId}
 *        ← { publicKey: string }
 *             Server wallet's public key. Used to set the transaction owner
 *             field so the signature data includes the correct public key.
 *             Response is cached after the first successful call.
 *
 *   POST {baseUrl}/api/service/sign-tx
 *        → { txData: string, network: string, userId: string }
 *             txData   — base64url-encoded bytes from tx.getSignatureData(),
 *                        the deep-hash of the Arweave transaction header.
 *             network  — Arweave network identifier (e.g. "arweave", "arlocal").
 *             userId   — caller identity forwarded to the server.
 *        ← { txId: string, signature: string, publicKey: string }
 *             All values base64url-encoded. The adapter calls
 *             tx.setSignature({ id: txId, signature, owner: publicKey }).
 *
 * ── Integration ───────────────────────────────────────────────────────────────
 *
 * AccountPaymentAdapter extends ArweavePaymentAdapter and slots into the
 * same sign-then-post flow used by ArweaveStorageAdapter:
 *
 *   MetaTransaction:
 *     provideUploadData(data, metadata)  ← stores data + tags
 *     pay(quote, onStatus)               ← creates tx, sends header hash to
 *                                           server, sets remote signature
 *
 *   ArweaveStorageAdapter.upload():
 *     consumeSignedUpload()              ← picks up the pre-signed tx
 *     postWithRetry(arweave, tx)         ← broadcasts to Arweave network
 */

import type { PaymentProviderName, PaymentQuote, PaymentReceipt } from "../types.js";
import { ArweavePaymentAdapter } from "./arweave.js";
import type { ArweavePaymentAdapterConfig } from "./arweave.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uint8ArrayToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface AccountPaymentAdapterConfig
  extends Omit<ArweavePaymentAdapterConfig, "walletKey"> {
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

interface PublicKeyResponse {
  /** Server wallet's public key (base64url-encoded RSA `n` component) */
  publicKey: string;
}

interface SignTxResponse {
  /** base64url-encoded transaction id */
  txId: string;
  /** base64url-encoded RSA-PSS signature */
  signature: string;
  /** base64url-encoded RSA public key echoed back for verification */
  publicKey: string;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class AccountPaymentAdapter extends ArweavePaymentAdapter {
  override readonly name: PaymentProviderName = "dstorage";

  private readonly signingServerUrl: string;
  private readonly userId: string;
  private readonly network: string;
  private cachedPublicKey: string | null = null;

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

  // ── Private: server public key ────────────────────────────────────────────────

  /**
   * Fetch and cache the server wallet's public key.
   * Required to set the transaction owner before computing the signature data.
   *
   * GET {signingServerUrl}/api/wallet/public-key?userId={userId}
   */
  private async fetchServerPublicKey(): Promise<string> {
    if (this.cachedPublicKey) return this.cachedPublicKey;

    const url = `${this.signingServerUrl}/api/wallet/public-key?userId=${encodeURIComponent(this.userId)}`;
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (err) {
      throw new Error(
        `[dStorage/account-payment] Could not reach signing server at ${url}: ${err}`,
      );
    }
    if (!resp.ok) {
      throw new Error(
        `[dStorage/account-payment] GET /api/wallet/public-key failed: HTTP ${resp.status}`,
      );
    }

    const body = (await resp.json()) as PublicKeyResponse;
    if (!body.publicKey) {
      throw new Error(
        `[dStorage/account-payment] GET /api/wallet/public-key response missing "publicKey" field`,
      );
    }

    this.cachedPublicKey = body.publicKey;
    this.logger?.log(
      "dStorage/account-payment",
      `Server public key fetched (publicKey: ${body.publicKey.slice(0, 12)}…)`,
    );
    return body.publicKey;
  }

  // ── PaymentAdapter: pay ───────────────────────────────────────────────────────

  /**
   * Remote-signing flow:
   *   1. Fetches server wallet's public key to set the transaction owner.
   *   2. Creates the Arweave transaction locally (data + tags, no local signing).
   *   3. Computes the signature data bytes (deep-hash of the tx header).
   *   4. POSTs only those bytes to the signing server — data never leaves locally.
   *   5. Applies the returned signature to the transaction.
   *   6. Stores the signed transaction for ArweaveStorageAdapter.upload() to post.
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

    onStatus?.("Fetching server account public key…");
    const publicKey = await this.fetchServerPublicKey();

    onStatus?.("Creating Arweave transaction…");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await arweave.createTransaction({ data }, { n: publicKey });
    for (const [key, value] of Object.entries(metadata)) {
      tx.addTag(key, value);
    }

    onStatus?.("Sending transaction header to signing server…");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signableBytes = (await (tx as any).getSignatureData()) as Uint8Array;

    let signResp: Response;
    try {
      signResp = await fetch(`${this.signingServerUrl}/api/service/sign-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txData: uint8ArrayToBase64url(signableBytes),
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

    const { txId, signature, publicKey: signedPublicKey } =
      (await signResp.json()) as SignTxResponse;

    onStatus?.("Applying remote signature…");
    tx.setSignature({ id: txId, signature, owner: signedPublicKey });

    const winstons = (await arweave.transactions.getPrice(
      data.byteLength,
    )) as string;
    const arCost = arweave.ar.winstonToAr(winstons) as string;

    this.signedUpload = { tx, arCost };

    this.logger?.log(
      "dStorage/account-payment",
      `Transaction signed remotely → txId: ${txId}  cost: ~${arCost} AR`,
    );

    return {
      txHash: txId,
      token: "AR",
      amount: quote.amount,
      fiat_amount: quote.fiat_amount,
      type: "storage",
      simulated: false,
      paidAt: Date.now(),
    };
  }
}
