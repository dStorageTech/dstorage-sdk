/**
 * @dstorage/storage — adapters/arweave-turbo.ts
 *
 * Arweave Turbo storage adapter with server-side ANS-104 signing.
 *
 * ── Upload flow (no client-side Arweave wallet needed) ────────────────────────
 *
 *   1. Client creates an ANS-104 data item locally with the already-encrypted data.
 *   2. Computes the 48-byte deep_hash locally — the ANS-104 signing digest.
 *   3. Sends ONLY the hash to the dStorage API signing server.
 *      Raw file bytes never leave the client — same privacy invariant as the
 *      current managed Arweave flow where only the stripped tx JSON (data_root)
 *      goes to the server.
 *   4. Server signs the hash with its Arweave JWK (funded Turbo Credits account).
 *   5. Client assembles the complete signed data item locally.
 *   6. Client POSTs the signed data item directly to the Turbo bundler.
 *   7. Returns with near-instant finality — txId is available immediately.
 *
 * ── Retrieve flow ─────────────────────────────────────────────────────────────
 *   Standard Arweave gateway fetch (identical to ArweaveStorageAdapter.retrieve).
 *
 * ── Peer dependency ───────────────────────────────────────────────────────────
 *   No extra install needed — @dha-team/arbundles ships as a dependency of @ardrive/turbo-sdk.
 *
 * ── Server requirements ───────────────────────────────────────────────────────
 *   The dStorage API server must expose (both auth-protected via Bearer token):
 *     GET  /api/service/public-key  → { publicKey: string }
 *     POST /api/service/sign-hash   → { signature: string, publicKey: string, success: boolean }
 *   The server's Arweave wallet must have Turbo Credits funded at https://ardrive.io.
 *
 * ── Notes ─────────────────────────────────────────────────────────────────────
 *   • Turbo provides near-instant finality — unlike the 2–20 min Arweave L1 wait.
 *   • The server holds the funded Turbo Credits account; users need no AR tokens.
 *   • Only 48 bytes (the deep_hash) go to the server; ciphertext stays on client.
 */

import type {
  StorageAdapter,
  StorageProviderName,
  StorageUploadResult,
  StorageAdapterLogger,
} from "../types.js";
import type { PaymentAdapter, PaymentNetworkName } from "@dstorage/payment";
import { ManagedPaymentAdapter } from "@dstorage/payment";
import type { Signer } from "@dha-team/arbundles";

const ARWEAVE_GATEWAY_URL = "https://turbo-gateway.com";

// ── Config ─────────────────────────────────────────────────────────────────────

export interface ArweaveTurboAdapterConfig {
  /**
   * Base URL of the dStorage API server that holds the funded Turbo Credits account.
   * Example: "https://api.my-dstorage-server.com"
   */
  signingServerUrl?: string;
  /**
   * Bearer token sent as the `Authorization` header to authenticate with the signing server.
   * When omitted, requests are sent without an Authorization header.
   */
  authToken?: string;
  /**
   * Arweave gateway URL used for data retrieval.
   * Defaults to ARWEAVE_GATEWAY_URL
   */
  gateway?: string;
  /**
   * Optional logger for SDK operational output.
   */
  logger?: StorageAdapterLogger;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

/**
 * Stores encrypted data on Arweave via the Turbo bundler (near-instant finality).
 *
 * Signing is delegated to the dStorage API server, which holds a funded Turbo Credits
 * account. The client sends only a 48-byte ANS-104 deep_hash to the server — the
 * encrypted file bytes never leave the client, preserving the same privacy invariant
 * as the existing managed Arweave flow.
 *
 * @example
 * const adapter = new ArweaveTurboStorageAdapter({
 *   signingServerUrl: "https://api.my-server.com",
 *   authToken: "ds_...",
 * });
 * const { id } = await adapter.upload(encryptedBytes, { "Content-Type": "application/octet-stream" });
 */
export class ArweaveTurboStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = "arweave_turbo";
  readonly providerName = "Arweave (Turbo)";
  readonly paymentAdapter: PaymentAdapter;

  private readonly signingServerUrl: string | null;
  private readonly authToken: string | undefined;
  private readonly gateway: string;
  protected readonly logger: StorageAdapterLogger | undefined;

  /** Cached server RSA modulus (base64url). Fetched once, reused across uploads. */
  private _serverPublicKey: string | undefined;

  constructor(config: ArweaveTurboAdapterConfig = {}) {
    this.signingServerUrl = config.signingServerUrl
      ? config.signingServerUrl.replace(/\/$/, "")
      : null;
    this.authToken = config.authToken;
    this.gateway = config.gateway ?? ARWEAVE_GATEWAY_URL;
    this.logger = config.logger;

    // When a signing server URL is provided, use the ManagedPaymentAdapter:
    // transactions are sent unsigned to the remote server, which holds a
    // funded Arweave wallet and returns the signature.
    if (config.signingServerUrl) {
      this.paymentAdapter = new ManagedPaymentAdapter({
        signingServerUrl: config.signingServerUrl,
        ...(config.authToken !== undefined
          ? { authToken: config.authToken }
          : {}),
        network: this.name as PaymentNetworkName,
        token: "AR",
        type: "storage",
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
      });
    } else {
      // ...otherwise use the local-signing adapter
      // FIXME!!!
      throw new Error("Local Arweave Turbo Adapter not supported yet");
    }
  }

  // ── upload ─────────────────────────────────────────────────────────────────────

  async upload(
    data: Uint8Array,
    metadata: Record<string, string> = {},
  ): Promise<StorageUploadResult> {
    const { createData } = await import("@dha-team/arbundles");

    // The signer only sends the 48-byte deep_hash to the server; data stays local.
    const dataSizeBytes = data.byteLength;
    const signer = await this._buildSigner(dataSizeBytes);

    const tags = Object.entries(metadata).map(([name, value]) => ({
      name,
      value,
    }));

    this.logger?.log(
      "dStorage/arweave-turbo",
      `Creating ANS-104 data item (${dataSizeBytes} bytes, ${tags.length} tags)…`,
    );

    // createData allocates the data item structure.
    // dataItem.sign() computes the deep_hash and calls signer.sign(hash) — which
    // sends only those 48 hash bytes to the signing server.
    const dataItem = createData(data, signer, { tags });
    await dataItem.sign(signer);

    const raw: Uint8Array = dataItem.getRaw();
    const { txId, dataCaches } = await this._uploadToTurbo(raw);

    const url = dataCaches[0]
      ? `https://${dataCaches[0]}/${txId}`
      : `${this.gateway}/${txId}`;
    this.logger?.log(
      "dStorage/arweave-turbo",
      `Uploaded via Turbo → txId: ${txId}`,
    );

    return { id: txId, provider: this.name, url, uploadedAt: Date.now() };
  }

  // ── retrieve ───────────────────────────────────────────────────────────────────

  async retrieve(id: string): Promise<Uint8Array> {
    const resp = await fetch(`${this.gateway}/${id}`);
    if (!resp.ok) {
      throw new Error(
        `[dStorage/arweave-turbo] Failed to retrieve txId=${id}: HTTP ${resp.status}\n` +
          `Check: https://viewblock.io/arweave/tx/${id}`,
      );
    }
    this.logger?.log("dStorage/arweave-turbo", `Retrieved txId: ${id}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  // ── Private helpers ────────────────────────────────────────────────────────────

  /**
   * Build a minimal signer object compatible with the @dha-team/arbundles DataItem API.
   *
   * The only non-trivial method is sign(): it sends the deep_hash produced by
   * the DataItem's internal ANS-104 signing procedure to the selected payment adapter.
   * The payment adapter responds with the RSA-PSS signature over that hash (512 bytes, ANS-104 type 1).
   * Raw file bytes never leave the client.
   */
  private async _buildSigner(dataSizeBytes: number): Promise<Signer> {
    // Fetch the server's RSA modulus (needed as ANS-104 data item `owner` field).
    const ownerBase64PublicKey = await this._getArweaveTurboPublicKey();
    const ownerBytes = _base64urlToBytes(ownerBase64PublicKey);

    return {
      /** RSA-4096 public key modulus (512 bytes) — used as the ANS-104 data item `owner` field. */
      publicKey: Buffer.from(ownerBytes),
      /** Arweave RSA-4096 signature type (ANS-104 type 1). */
      signatureType: 1,
      ownerLength: 512,
      signatureLength: 512,
      sign: (message: Uint8Array): Promise<Uint8Array> =>
        this._signHash(message, dataSizeBytes),
    };
  }

  /**
   * POST the 48-byte ANS-104 deep_hash to the signing server via the shared sign-tx endpoint.
   *
   * Uses network: "ARWEAVE_ARIO_TURBO" so the server routes to the Turbo-specific signing path.
   * The `bytes` field lets the server estimate upload cost for user account deduction.
   * Caches the server public key from the response to avoid a round-trip on the next upload.
   */
  private async _signHash(
    hash: Uint8Array,
    dataSizeBytes: number,
  ): Promise<Uint8Array> {
    this.logger?.log(
      "dStorage/arweave-turbo",
      "Delegating ANS-104 signature to server via sign-tx (only deep_hash sent, data stays on client)…",
    );

    const paymentReceipt = await this.paymentAdapter.pay({
      token: "AR",
      amount: "0", // FIXME: add price estimation
      network: this.name,
      type: "storage",
      txData: _bytesToBase64url(hash),
      dataSizeBytes: dataSizeBytes,
      expiresAt: Date.now() + 600_000,
    });

    if (!paymentReceipt.signedTx) {
      throw new Error(
        "[dStorage/arweave-turbo] Signing server returned an invalid sign-tx response for Arweave Turbo payment.",
      );
    }

    return _base64urlToBytes(paymentReceipt.signedTx!);
  }

  /**
   * FIXME: remove this function as we should set client's instead of server's PK
   * Fetch the server's RSA modulus (base64url, 512 bytes) via the sign-tx endpoint.
   * Sends network: "ARWEAVE_ARIO_TURBO" without txData — server returns publicKey without signing.
   * Cached after the first fetch; also populated by subsequent sign-tx (signing) responses.
   */
  private async _getArweaveTurboPublicKey(): Promise<string> {
    const body = { network: "arweave_turbo" };
    let resp: Response;
    try {
      resp = await fetch(`${this.signingServerUrl}/api/service/pk`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.authToken
            ? { Authorization: `Bearer ${this.authToken}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `[dStorage/arweave-turbo] Could not reach signing server at ${this.signingServerUrl}: ${err}`,
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `[dStorage/arweave-turbo] sign-tx request failed: HTTP ${resp.status}${text ? ` — ${text}` : ""}`,
      );
    }
    const json = await resp.json();
    if (!json.publicKey) {
      throw new Error(
        "[dStorage/arweave-turbo] sign-tx (TURBO_ARWEAVE) returned no publicKey.",
      );
    }

    return json.publicKey;
  }

  /**
   * POST the complete signed ANS-104 data item bytes directly to the Turbo bundler.
   * Server Turbo Credits are consumed based on the signing key — no client wallet needed.
   */
  private async _uploadToTurbo(
    dataItemBuffer: Uint8Array,
  ): Promise<{ txId: string; dataCaches: string[] }> {
    this.logger?.log(
      "dStorage/arweave-turbo",
      `Uploading ${dataItemBuffer.byteLength}-byte signed data item to Turbo…`,
    );

    const { TurboFactory } = await import("@ardrive/turbo-sdk");
    const turbo = TurboFactory.unauthenticated();
    try {
      const result = await turbo.uploadSignedDataItem({
        dataItemStreamFactory: () => Buffer.from(dataItemBuffer),
        dataItemSizeFactory: () => dataItemBuffer.byteLength,
        signal: AbortSignal.timeout(10_000),
      });
      if (!result.id) {
        throw new Error(
          "[dStorage/arweave-turbo] Arweave Turbo did not return a transaction id.",
        );
      }

      return { txId: result.id, dataCaches: result.dataCaches };
    } catch (err) {
      throw new Error(
        `[dStorage/arweave-turbo] Upload to Arweave Turbo failed: ${err}`,
      );
    }
  }
}

// ── Encoding helpers (browser-safe, no Buffer dependency) ─────────────────────

function _base64urlToBytes(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function _bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
