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
 * this adapter constructs the Arweave transaction, computes the Merkle tree
 * (data_root) locally, then sends a stripped transaction JSON — containing
 * only metadata, data_root, and data_size but NOT the raw file bytes — to a
 * remote REST API. The server holds a funded Arweave account, signs the
 * stripped transaction, and returns the signature and id. The file content
 * never leaves the client.
 *
 *   POST {baseUrl}{POST_SIGN_TX_API_PATH}
 *        → { txData: object, network: string, userId: string }
 *             txData   — Arweave transaction JSON with data stripped (tx.toJSON()
 *                        after clearing tx.data; data_root + data_size preserved).
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
  MidnightWalletProvider,
  PaymentNetworkName,
  PaymentQuote,
  PaymentReceipt,
  NetworkType,
} from "../types.js";
import { ArweavePaymentAdapter } from "./arweave.js";
import type { ArweavePaymentAdapterConfig } from "./arweave.js";

// Shared API endpoint for all network payment flows on the dStorage signing server.
const POST_SIGN_TX_API_PATH = "/api/service/sign-tx";

// ── Byte / encoding helpers ───────────────────────────────────────────────────

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Extract raw transaction bytes from either a Midnight tagged string
 * ("midnight:transaction[v9](...):hexdata") or a plain hex string.
 */
function parseSignedTxBytes(signedTx: string): Uint8Array {
  if (signedTx.startsWith("midnight:")) {
    const colonIdx = signedTx.lastIndexOf(":");
    return hexToUint8Array(signedTx.slice(colonIdx + 1));
  }
  return hexToUint8Array(signedTx);
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface ManagedPaymentAdapterConfig extends Omit<
  ArweavePaymentAdapterConfig,
  "walletKey"
> {
  /** Which network this adapter is used for */
  network: PaymentNetworkName;
  /** Whether this covers a storage network fee or a chain transaction fee */
  type: NetworkType;
  /**
   * Base URL of the remote signing server (no trailing slash).
   * Example: "https://api.my-server.com"
   */
  signingServerUrl: string;
  /**
   * Bearer token sent as the `Authorization` header to authenticate with the signing server.
   * When omitted, requests are sent without an Authorization header.
   */
  authToken?: string;
}

// ── Server response shapes ────────────────────────────────────────────────────

interface SignTxResponse {
  /** Indicates whether the signing service successfully produced a signature. */
  success: boolean;
  /** Arweave transaction id (base64url-encoded). */
  txId: string;
  /** RSA-PSS signature over the Arweave signature data (base64url-encoded). */
  signature: string;
  /** Total transaction amount/cost as a string (server-defined units). */
  txAmount: string;
  /** Wallet public key used as the transaction owner (base64url-encoded RSA `n`). */
  publicKey: string;
  /** Service fee amount (server-defined units). */
  serviceFee: string;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class ManagedPaymentAdapter extends ArweavePaymentAdapter {
  override readonly network: PaymentNetworkName;
  override readonly type: NetworkType;

  private readonly signingServerUrl: string;
  private readonly authToken?: string;

  constructor(config: ManagedPaymentAdapterConfig) {
    super({
      ...(config.gateway !== undefined ? { gateway: config.gateway } : {}),
      ...(config.quoteValidityMs !== undefined
        ? { quoteValidityMs: config.quoteValidityMs }
        : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
    });
    this.signingServerUrl = config.signingServerUrl.replace(/\/$/, "");
    if (config.authToken !== undefined) this.authToken = config.authToken;
    this.network = config.network;
    this.type = config.type;
  }

  // ── PaymentAdapter: estimateCost ─────────────────────────────────────────────

  /**
   * Query the Arweave fee oracle for the real upload cost.
   */
  async estimateCost(dataSizeBytes: number): Promise<PaymentQuote> {
    if (this.network === "arweave") {
      return await super.estimateCost(dataSizeBytes);
    }

    // FIXME: query a service to obtain estimation
    const amount = "0.0012345";
    this.logger?.log(
      "dStorage/managed-payment",
      `Estimated: ${amount} ${this.token}`,
    );

    return {
      token: this.token, // FIXME: should be probably obtained from the signing service
      amount,
      network: this.network,
      type: this.type,
      dataSizeBytes,
      txData: "---",
      expiresAt: Date.now() + this.quoteValidityMs,
    };
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
    } else if (quote.network === "arweave") {
      return this._payArweave(quote, onStatus);
    } else if (quote.network === "arweave_turbo") {
      return this._payArweaveTurbo(quote, onStatus);
    }

    throw Error(`Unsupported network: ${quote.network}`);
  }

  // ── Network-specific wallet provider factories ────────────────────────────────

  /**
   * Returns a WalletProvider-compatible object for the Midnight chain whose
   * `balanceTx()` is fulfilled by the managed signing server instead of a
   * local wallet. The caller supplies the public keys (from whichever source
   * they have — HD derivation, a server endpoint, etc.); the SDK only handles
   * the signing-server round-trip.
   *
   * The returned object satisfies the @midnight-ntwrk/midnight-js-types
   * WalletProvider interface via structural typing — no Midnight package
   * import is required from the caller's side.
   *
   * @param coinPublicKey        Midnight coin public key (hex) for the ZK fee circuit.
   * @param encryptionPublicKey  Midnight encryption public key (hex).
   * @param onReceipt            Optional callback invoked with the PaymentReceipt
   *                             after each successful balanceTx call. Used internally
   *                             by MidnightChainAdapter to capture receipt metadata;
   *                             external callers can omit it.
   */
  createMidnightWalletProvider(
    coinPublicKey: string,
    encryptionPublicKey: string,
    onReceipt?: (receipt: PaymentReceipt) => void,
  ): MidnightWalletProvider {
    return {
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => encryptionPublicKey,
      balanceTx: async (tx, _ttl?) => {
        const txData = uint8ArrayToHex(tx.serialize());
        const receipt = await this.pay({
          token: "DUST",
          amount: "0",
          type: "chain",
          network: "midnight",
          txData,
          dataSizeBytes: txData.length,
          expiresAt: Date.now() + 60_000,
        });
        onReceipt?.(receipt);
        if (!receipt.signedTx) {
          throw new Error(
            "[dStorage/payment] Midnight managed payment server did not return a balanced transaction.",
          );
        }
        const { Transaction } = await import("@midnight-ntwrk/ledger-v8");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (Transaction as any).deserialize(
          "signature",
          "proof",
          "binding",
          parseSignedTxBytes(receipt.signedTx),
        );
      },
    };
  }

  // ── Network-specific payment handlers ────────────────────────────────────────

  /**
   * Arweave remote-signing flow:
   *   1. Creates the Arweave transaction locally (data + tags, no local signing).
   *   2. Calls prepareChunks() to compute data_root (Merkle root) locally.
   *   3. Strips the raw data from the transaction before serialising — only the
   *      data_root and data_size (not the actual bytes) are sent to the server.
   *   4. POSTs the stripped transaction JSON to the signing server.
   *   5. Applies the returned id, signature, and owner to the transaction.
   *   6. Restores the raw data so the chunked uploader can post it directly to
   *      the Arweave gateway — the server never sees the file content.
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

    // Compute the Merkle tree (data_root) locally so the server can sign based
    // on the data_root without ever receiving the raw file content.
    await tx.prepareChunks(tx.data);

    // Strip the raw bytes before sending — only metadata + data_root travel
    // to the signing server. Data is restored afterwards for the chunked uploader.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawData: any = tx.data;
    tx.data = new Uint8Array(0);

    const body = JSON.stringify({
      txData: tx.toJSON(),
      network: quote.network,
    });

    const {
      txId,
      signature,
      publicKey,
      txAmount: arCost,
      serviceFee,
    } = await this._sendSignTxRequest(body, quote.network, onStatus);

    onStatus?.("Applying remote signature…");
    tx.setSignature({ id: txId, signature, owner: publicKey });

    // Restore raw data so the chunked uploader can post it to the gateway.
    tx.data = rawData;

    this.signedUpload = { tx, arCost };

    this.logger?.log(
      "dStorage/managed-payment",
      `Transaction signed remotely (${this.signingServerUrl} API service) → txId: ${txId}  cost: ~${arCost} ${quote.token} (service fee: ${serviceFee})`,
    );

    return {
      txHash: txId,
      token: quote.token,
      amount: arCost,
      type: quote.type,
      paidAt: Date.now(),
      serviceFee,
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
    const body = JSON.stringify({
      txData: quote.txData ?? null,
      network: quote.network,
    });

    const {
      txId,
      signature,
      txAmount: dustCost,
      serviceFee,
    } = await this._sendSignTxRequest(body, quote.network, onStatus);

    this.logger?.log(
      "dStorage/managed-payment",
      `Midnight Tx signed remotely (${this.signingServerUrl} API service) → txId: ${txId}  cost: ~${dustCost} ${quote.token} (service fee: ${serviceFee})`,
    );

    return {
      txHash: txId,
      token: "DUST",
      amount: dustCost,
      type: quote.type,
      signedTx: signature,
      paidAt: Date.now(),
      serviceFee,
    };
  }

  /**
   * Arweave Turbo
   */
  private async _payArweaveTurbo(
    quote: PaymentQuote,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    const body = JSON.stringify({
      txData: quote.txData ?? null,
      network: quote.network,
    });

    const {
      txId,
      signature,
      txAmount: arCost,
      serviceFee,
    } = await this._sendSignTxRequest(body, quote.network, onStatus);

    this.logger?.log(
      "dStorage/managed-payment",
      `Arweave Turbo Tx signed remotely (${this.signingServerUrl} API service) → txId: ${txId}  cost: ~${arCost} ${quote.token} (service fee: ${serviceFee})`,
    );

    return {
      txHash: txId,
      token: "AR",
      amount: arCost,
      type: quote.type,
      signedTx: signature,
      paidAt: Date.now(),
      serviceFee,
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
    body: string,
    network: string,
    onStatus?: (message: string) => void,
  ): Promise<SignTxResponse> {
    onStatus?.(`Sending ${network} transaction to signing server…`);
    let signResp: Response;
    try {
      this.logger?.log(
        "dStorage/managed-payment",
        `${network}: delegating to managed payment service (serialized req length=${body.length})`,
      );

      signResp = await fetch(
        `${this.signingServerUrl}${POST_SIGN_TX_API_PATH}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.authToken
              ? { Authorization: `Bearer ${this.authToken}` }
              : {}),
          },
          body,
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

    try {
      return (await signResp.json()) as SignTxResponse;
    } catch {
      throw new Error(
        `[dStorage/managed-payment] Managed payment service returned a non-JSON response — ` +
          `check that the service URL is correct and reachable: ${this.signingServerUrl}${POST_SIGN_TX_API_PATH}`,
      );
    }
  }
}
