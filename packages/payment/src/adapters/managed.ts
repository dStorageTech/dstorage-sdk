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
 *     pay(instruction, onStatus)          ← routes by instruction.network, creates tx,
 *                                           sends JSON to server, applies signature
 *
 *   ArweaveStorageAdapter.store():
 *     consumeSignedUpload()              ← picks up the pre-signed tx
 *     postWithRetry(arweave, tx)         ← broadcasts to Arweave network
 */

import type {
  MidnightWalletProvider,
  PaymentInstruction,
  PaymentNetworkName,
  PaymentQuote,
  PaymentReceipt,
  NetworkType,
} from "../types.js";
import { ArweavePaymentAdapter } from "./arweave.js";
import type { ArweavePaymentAdapterConfig } from "./arweave.js";
import { hexToBytes, DStorageError } from "@dstorage/crypto";
import { sanitiseErrorBody } from "../utils.js";
import { PaymentErrorCode } from "../errors.js";

// Shared API endpoint for all network payment flows on the dStorage signing server.
const POST_SIGN_TX_API_PATH = "/api/service/sign-tx";

// ── Byte / encoding helpers ───────────────────────────────────────────────────

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Extract raw transaction bytes from either a Midnight tagged string
 * ("midnight:transaction[v9](...):hexdata") or a plain hex string.
 */
function parseSignedTxBytes(signedTx: string): Uint8Array {
  if (signedTx.startsWith("midnight:")) {
    const colonIdx = signedTx.lastIndexOf(":");
    return hexToBytes(signedTx.slice(colonIdx + 1), "signedTx");
  }
  return hexToBytes(signedTx, "signedTx");
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
   * Must be a non-empty, non-whitespace string — the constructor throws immediately on
   * an empty value so a misconfigured caller (e.g. unresolved env var) fails fast
   * rather than silently sending unauthenticated requests to the signing service.
   */
  authToken: string;
  /**
   * Maximum time in milliseconds to wait for the signing server to respond before
   * aborting the request and throwing. Defaults to 30 000 ms (30 s).
   * Pass `0` to disable the timeout entirely (not recommended for production).
   */
  requestTimeoutMs?: number;
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

/**
 * Validate and parse a raw signing server response.
 * Throws a descriptive error if any required field is absent, the wrong type,
 * or if the server reported success:false.
 *
 * Exported for unit testing — not part of the public SDK surface.
 */
export function parseSignTxResponse(raw: unknown): SignTxResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new DStorageError(
      PaymentErrorCode.MANAGED_NON_OBJECT_RESPONSE,
      "[dStorage/managed-payment] Signing server returned a non-object response.",
    );
  }
  const r = raw as Record<string, unknown>;

  if (r["success"] !== true) {
    throw new DStorageError(
      PaymentErrorCode.MANAGED_SERVER_FAILURE,
      `[dStorage/managed-payment] Signing server reported success:false — ${sanitiseErrorBody(JSON.stringify(r))}`,
    );
  }

  for (const field of [
    "txId",
    "signature",
    "publicKey",
    "txAmount",
    "serviceFee",
  ] as const) {
    if (typeof r[field] !== "string") {
      throw new DStorageError(
        PaymentErrorCode.MANAGED_MISSING_FIELD,
        `[dStorage/managed-payment] Signing server response missing or invalid field: ${field}`,
      );
    }
  }

  return r as unknown as SignTxResponse;
}

/**
 * Assert that the owner key returned by the signing server matches the key pinned
 * out-of-band (the RSA modulus suffix of a compound auth token). When a pinned key
 * is present, a mismatch indicates a compromised or MITM'd signing server attempting
 * to substitute an attacker-controlled (publicKey, signature) pair — which would make
 * the attacker the on-chain owner of the upload. A no-op when no key was pinned.
 *
 * Exported for unit testing — not part of the public SDK surface.
 */
export function assertOwnerKeyMatch(
  responseKey: string,
  pinnedKey: string | undefined,
): void {
  if (pinnedKey && responseKey !== pinnedKey) {
    throw new DStorageError(
      PaymentErrorCode.MANAGED_PUBLIC_KEY_MISMATCH,
      "[dStorage/managed-payment] Signing server returned a public key that does not " +
        "match the pinned key from the auth token — possible server compromise or MITM.",
    );
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class ManagedPaymentAdapter extends ArweavePaymentAdapter {
  override readonly network: PaymentNetworkName;
  override readonly type: NetworkType;

  private readonly signingServerUrl: string;
  private readonly authToken: string;
  private readonly requestTimeoutMs: number;
  private readonly ownerPublicKey: string | undefined;

  /**
   * Strip a RSA-4096 modulus suffix from a compound auth token
   * (<credential>.<base64url_683_chars>), returning only the credential.
   * A plain token (no '.' or wrong suffix length) is returned unchanged.
   * This lets ArweaveBundlerStorageAdapter compound tokens be passed directly
   * to any adapter that uses ManagedPaymentAdapter without breaking authentication.
   *
   * lastIndexOf is intentional: the credential part may itself contain dots
   * (e.g. a JWT), so we always split at the *last* dot to reach the modulus.
   */
  private static _parseAuthToken(token: string): {
    credential: string;
    ownerPublicKey: string | undefined;
  } {
    const dot = token.lastIndexOf(".");
    if (dot !== -1) {
      const suffix = token.slice(dot + 1);
      // base64url-encoded 512-byte RSA modulus is always exactly 683 chars (512 = 170×3+2)
      if (suffix.length === 683 && /^[A-Za-z0-9_-]+$/.test(suffix)) {
        return { credential: token.slice(0, dot), ownerPublicKey: suffix };
      }
    }
    return { credential: token, ownerPublicKey: undefined };
  }

  constructor(config: ManagedPaymentAdapterConfig) {
    super({
      ...(config.gateway !== undefined ? { gateway: config.gateway } : {}),
      ...(config.quoteValidityMs !== undefined
        ? { quoteValidityMs: config.quoteValidityMs }
        : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
    });
    this.signingServerUrl = config.signingServerUrl.replace(/\/$/, "");
    if (!config.authToken || config.authToken.trim() === "") {
      throw new DStorageError(
        PaymentErrorCode.MANAGED_TOKEN_REQUIRED,
        "[dStorage/managed-payment] authToken is required and must not be empty or whitespace.",
      );
    }
    const { credential, ownerPublicKey } =
      ManagedPaymentAdapter._parseAuthToken(config.authToken);
    this.authToken = credential;
    this.ownerPublicKey = ownerPublicKey;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
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
    instruction: PaymentInstruction,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    if (Date.now() > instruction.expiresAt) {
      throw new DStorageError(
        PaymentErrorCode.MANAGED_QUOTE_EXPIRED,
        `[dStorage/payment] Quote expired at ${new Date(instruction.expiresAt).toISOString()}. ` +
          "Request a fresh quote via estimateCost() before calling pay().",
      );
    }

    // When the adapter itself is configured for managed mock, always use that
    // flow regardless of what network the caller claims (e.g. MidnightSimulatorChainAdapter
    // passes network:"midnight" but the payment should still go through TEST).
    if (this.network === "managedmock") {
      return this._payManagedMock(instruction, onStatus);
    }

    if (instruction.network === "midnight") {
      return this._payMidnight(instruction, onStatus);
    } else if (instruction.network === "arweave") {
      return this._payArweave(instruction, onStatus);
    } else if (instruction.network === "arweave_bundler") {
      return this._payArweaveBundler(instruction, onStatus);
    }

    throw Error(`Unsupported network: ${instruction.network}`);
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
          network: "midnight",
          txData,
          dataSizeBytes: txData.length,
          expiresAt: Date.now() + 60_000,
        });
        onReceipt?.(receipt);
        if (!receipt.signedTx) {
          throw new DStorageError(
            PaymentErrorCode.MANAGED_UNBALANCED_TX,
            "[dStorage/payment] Midnight managed payment server did not return a balanced transaction.",
          );
        }
        const { Transaction } =
          await import("@midnight-ntwrk/midnight-js-protocol/ledger");
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
    instruction: PaymentInstruction,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    if (!this.pendingUpload) {
      return super.pay(instruction, onStatus);
    }

    const { data, metadata } = this.pendingUpload;
    this.pendingUpload = null;

    const arweave = await this.getClient();

    onStatus?.("Creating Arweave transaction…");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await arweave.createTransaction({ data });
    if (this.ownerPublicKey) {
      tx.owner = this.ownerPublicKey;
    }
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
      network: instruction.network,
    });

    const {
      txId,
      signature,
      publicKey,
      txAmount: arCost,
      serviceFee,
    } = await this._sendSignTxRequest(body, instruction.network, onStatus);

    // Pin check: when an expected server modulus was supplied out-of-band (in the
    // auth token), the response's owner key must match it before we apply the
    // signature locally.
    assertOwnerKeyMatch(publicKey, this.ownerPublicKey);

    onStatus?.("Applying remote signature…");
    tx.setSignature({ id: txId, signature, owner: publicKey });

    // Restore raw data so the chunked uploader can post it to the gateway.
    tx.data = rawData;

    this.signedUpload = { tx, arCost };

    this.logger?.log(
      "dStorage/managed-payment",
      `Transaction signed remotely (${this.signingServerUrl} API service) → txId: ${txId}  cost: ~${arCost} ${this.token} (service fee: ${serviceFee})`,
    );

    return {
      txHash: txId,
      token: this.token,
      amount: arCost,
      type: this.type,
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
    instruction: PaymentInstruction,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    const body = JSON.stringify({
      txData: instruction.txData ?? null,
      network: instruction.network,
    });

    const {
      txId,
      signature,
      txAmount: dustCost,
      serviceFee,
    } = await this._sendSignTxRequest(body, instruction.network, onStatus);

    this.logger?.log(
      "dStorage/managed-payment",
      `Midnight Tx signed remotely (${this.signingServerUrl} API service) → txId: ${txId}  cost: ~${dustCost} ${this.token} (service fee: ${serviceFee})`,
    );

    return {
      txHash: txId,
      token: "DUST",
      amount: dustCost,
      type: this.type,
      signedTx: signature,
      paidAt: Date.now(),
      serviceFee,
    };
  }

  /**
   * Arweave Bundler
   */
  private async _payArweaveBundler(
    instruction: PaymentInstruction,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    const body = JSON.stringify({
      txData: instruction.txData ?? null,
      network: instruction.network,
      ...(instruction.ownerKey !== undefined
        ? { ownerKey: instruction.ownerKey }
        : {}),
    });

    const {
      txId,
      signature,
      txAmount: arCost,
      serviceFee,
    } = await this._sendSignTxRequest(body, instruction.network, onStatus);

    this.logger?.log(
      "dStorage/managed-payment",
      `Arweave bundler Tx signed remotely (${this.signingServerUrl} API service) → txId: ${txId}  cost: ~${arCost} ${this.token} (service fee: ${serviceFee})`,
    );

    return {
      txHash: txId,
      token: "AR",
      amount: arCost,
      type: this.type,
      signedTx: signature,
      paidAt: Date.now(),
      serviceFee,
    };
  }

  /**
   * Managed mock flow:
   *   Sends a minimal request to the signing server with the literal network
   *   identifier "TEST" — the server treats this as a sandbox/test flow with no
   *   real funds involved. The SDK-side network name is "managedmock" to follow
   *   the lowercase naming convention; the server-side string is always "TEST".
   */
  private async _payManagedMock(
    instruction: PaymentInstruction,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    const body = JSON.stringify({
      txData: instruction.txData || "mock",
      network: "TEST",
    });

    const { txId, txAmount, serviceFee } = await this._sendSignTxRequest(
      body,
      "TEST",
      onStatus,
    );

    this.logger?.log(
      "dStorage/managed-payment",
      `ManagedMock Tx signed remotely (${this.signingServerUrl}) → txId: ${txId}  cost: ~${txAmount} MOCK (service fee: ${serviceFee})`,
    );

    return {
      txHash: txId,
      token: "MOCK",
      amount: txAmount,
      type: this.type,
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

      const signal =
        this.requestTimeoutMs > 0
          ? AbortSignal.timeout(this.requestTimeoutMs)
          : undefined;
      signResp = await fetch(
        `${this.signingServerUrl}${POST_SIGN_TX_API_PATH}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.authToken}`,
          },
          body,
          ...(signal !== undefined ? { signal } : {}),
        },
      );
    } catch (err) {
      throw new DStorageError(
        PaymentErrorCode.MANAGED_SERVER_UNREACHABLE,
        `[dStorage/managed-payment] Could not reach signing server: ${err}`,
        { cause: err },
      );
    }
    if (signResp.status === 409) {
      throw new DStorageError(
        PaymentErrorCode.MANAGED_KEY_CHANGED,
        "[dStorage/managed-payment] Signing server key has changed — " +
          "re-issue your API token to obtain the updated public key.",
      );
    }
    if (!signResp.ok) {
      const rawBody = await signResp.text().catch(() => "");
      const body = sanitiseErrorBody(rawBody);
      throw new DStorageError(
        PaymentErrorCode.MANAGED_SIGN_HTTP_ERROR,
        `[dStorage/managed-payment] POST ${POST_SIGN_TX_API_PATH} failed: HTTP ${signResp.status}${body ? ` — ${body}` : ""}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await signResp.json();
    } catch {
      throw new DStorageError(
        PaymentErrorCode.MANAGED_NON_JSON_RESPONSE,
        `[dStorage/managed-payment] Managed payment service returned a non-JSON response — ` +
          `check that the service URL is correct and reachable: ${this.signingServerUrl}${POST_SIGN_TX_API_PATH}`,
      );
    }
    return parseSignTxResponse(parsed);
  }
}
