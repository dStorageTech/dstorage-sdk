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
 *   The dStorage API server must expose (auth-protected via Bearer token):
 *     POST /api/service/sign-tx  → { signature: string, txId: string, success: boolean, … }
 *   The server's Arweave wallet must have Turbo Credits funded at https://ardrive.io.
 *
 * ── Auth token format ─────────────────────────────────────────────────────────
 *   authToken must be in the format: <credential>.<base64url_modulus>
 *   where <base64url_modulus> is the 512-byte RSA-4096 public key modulus
 *   base64url-encoded. The adapter validates and pins the key at construction time.
 *   Re-issue the token from the signing server to obtain the current key.
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
  StorageQuote,
} from "../types.js";
import type { PaymentAdapter, PaymentNetworkName } from "@dstorage/payment";
import { ManagedPaymentAdapter } from "@dstorage/payment";
import type { Signer } from "@dha-team/arbundles";
import {
  CONTENT_HASH_TAG,
  computeBlake3Hex,
  assertContentHash,
} from "./integrity.js";

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
   * Required when `signingServerUrl` is provided.
   */
  authToken?: string; // validated at construction: required when signingServerUrl is set
  /**
   * Arweave gateway URL used for data retrieval.
   * Defaults to the public Arweave gateway.
   *
   * Security: always use an `https://` URL (the default) in production.
   * This adapter uses `globalThis.fetch` directly — no DNS or certificate
   * pinning is applied. Users in adversarial network environments can override
   * `globalThis.fetch` before constructing the adapter to inject their own
   * certificate-pinned fetch implementation.
   */
  gateway?: string;
  /**
   * Maximum number of bytes allowed in a single retrieve() call.
   * Rejects if the `Content-Length` response header exceeds this value, and
   * always rejects after loading if the actual byte count exceeds it.
   * Defaults to 268_435_456 (256 MB).
   */
  maxRetrieveSizeBytes?: number;
  /**
   * Skip BLAKE3 content-hash verification on retrieve.
   * Only set to true when connecting to a fully trusted gateway.
   * Defaults to false.
   */
  skipIntegrityCheck?: boolean;
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
  private readonly gateway: string;
  private readonly maxRetrieveSizeBytes: number;
  private readonly skipIntegrityCheck: boolean;
  protected readonly logger: StorageAdapterLogger | undefined;

  /** RSA-4096 public key modulus (512 bytes) parsed from the auth token at construction time. */
  private readonly ownerPublicKey: Uint8Array;

  constructor(config: ArweaveTurboAdapterConfig = {}) {
    this.signingServerUrl = config.signingServerUrl
      ? config.signingServerUrl.replace(/\/$/, "")
      : null;
    this.gateway = config.gateway ?? ARWEAVE_GATEWAY_URL;
    this.maxRetrieveSizeBytes =
      config.maxRetrieveSizeBytes ?? 256 * 1024 * 1024;
    this.skipIntegrityCheck = config.skipIntegrityCheck ?? false;
    this.logger = config.logger;

    // When a signing server URL is provided, use the ManagedPaymentAdapter:
    // transactions are sent unsigned to the remote server, which holds a
    // funded Arweave wallet and returns the signature.
    if (config.signingServerUrl) {
      if (!config.authToken?.trim()) {
        throw new Error(
          "[dStorage/arweave-turbo] authToken is required when signingServerUrl is provided.",
        );
      }
      this.ownerPublicKey = ArweaveTurboStorageAdapter._parseToken(
        config.authToken,
      );
      this.paymentAdapter = new ManagedPaymentAdapter({
        signingServerUrl: config.signingServerUrl,
        authToken: config.authToken,
        network: this.name as PaymentNetworkName,
        type: "storage",
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
      });
    } else {
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
    const signer = this._buildSigner(dataSizeBytes);

    const hashHex = await computeBlake3Hex(data);
    const tags = [
      { name: CONTENT_HASH_TAG, value: hashHex },
      ...Object.entries(metadata).map(([name, value]) => ({ name, value })),
    ];

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

  async retrieve(
    id: string,
  ): Promise<{ bytes: Uint8Array; tags: Record<string, string> }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) {
      throw new Error(
        `[dStorage/arweave-turbo] Invalid transaction ID — expected 43 base64url characters: "${id.slice(0, 60)}${id.length > 60 ? "…" : ""}"`,
      );
    }
    // ── Pre-fetch transaction metadata ────────────────────────────────────────
    let storedHash: string | undefined;
    const tags: Record<string, string> = {};
    if (!this.skipIntegrityCheck) {
      const metaResp = await fetch(`${this.gateway}/tx/${id}`);
      if (!metaResp.ok) {
        throw new Error(
          `[dStorage/arweave-turbo] Could not fetch transaction metadata for txId: ${id} — ` +
            "content hash cannot be verified. " +
            "Set skipIntegrityCheck: true to bypass integrity checking for fully trusted gateways.",
        );
      }
      const tx = (await metaResp.json()) as {
        tags?: Array<{ name: string; value: string }>;
      };
      for (const tag of tx.tags ?? []) {
        const name = new TextDecoder().decode(_base64urlToBytes(tag.name));
        const value = new TextDecoder().decode(_base64urlToBytes(tag.value));
        tags[name] = value;
        if (name === CONTENT_HASH_TAG) storedHash = value;
      }
      if (!storedHash) {
        throw new Error(
          `[dStorage/arweave-turbo] ${CONTENT_HASH_TAG} tag not found for txId: ${id}.\n` +
            "Set skipIntegrityCheck: true to bypass integrity checking for fully trusted gateways.",
        );
      }
    }

    // ── Download data ─────────────────────────────────────────────────────────
    const resp = await fetch(`${this.gateway}/${id}`);
    if (!resp.ok) {
      throw new Error(
        `[dStorage/arweave-turbo] Failed to retrieve txId=${id}: HTTP ${resp.status}\n` +
          `Check: https://viewblock.io/arweave/tx/${id}`,
      );
    }

    // Pre-load size guard — reject before materialising the body when the
    // server advertises a size that already exceeds the limit.
    const contentLength = resp.headers.get("Content-Length");
    if (contentLength !== null) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > this.maxRetrieveSizeBytes) {
        throw new Error(
          `[dStorage/arweave-turbo] Content-Length (${size} bytes) exceeds ` +
            `the configured limit of ${this.maxRetrieveSizeBytes} bytes for txId: ${id}.`,
        );
      }
    }

    const bytes = new Uint8Array(await resp.arrayBuffer());

    // Post-load size guard — defense-in-depth; catches missing or incorrect Content-Length.
    if (bytes.byteLength > this.maxRetrieveSizeBytes) {
      throw new Error(
        `[dStorage/arweave-turbo] Downloaded ${bytes.byteLength} bytes for txId: ${id}, ` +
          `which exceeds the configured limit of ${this.maxRetrieveSizeBytes} bytes.`,
      );
    }

    // ── Content hash verification ─────────────────────────────────────────────
    if (!this.skipIntegrityCheck && storedHash) {
      await assertContentHash(id, bytes, storedHash, "arweave-turbo");
    }

    this.logger?.log("dStorage/arweave-turbo", `Retrieved txId: ${id}`);
    return { bytes, tags };
  }

  // ── estimateCost ───────────────────────────────────────────────────────────────

  async estimateCost(dataSizeBytes: number): Promise<StorageQuote> {
    const { TurboFactory } = await import("@ardrive/turbo-sdk");
    const turbo = TurboFactory.unauthenticated();
    let costs: Awaited<ReturnType<typeof turbo.getUploadCosts>>;
    try {
      costs = await turbo.getUploadCosts({ bytes: [dataSizeBytes] });
    } catch (err) {
      throw new Error(
        `[dStorage/arweave-turbo] Failed to fetch upload cost estimate from Turbo: ${err}`,
      );
    }
    const cost = costs[0];
    if (!cost) {
      throw new Error(
        "[dStorage/arweave-turbo] Turbo returned no cost estimate for the given data size.",
      );
    }
    return {
      token: "AR",
      amount: cost.winc,
      provider: this.name,
      dataSizeBytes,
      expiresAt: Date.now() + 5 * 60_000,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────────

  /**
   * Build a minimal signer object compatible with the @dha-team/arbundles DataItem API.
   *
   * The only non-trivial method is sign(): it sends the deep_hash produced by
   * the DataItem's internal ANS-104 signing procedure to the selected payment adapter.
   * The payment adapter responds with the RSA-PSS signature over that hash (512 bytes, ANS-104 type 1).
   * Raw file bytes never leave the client.
   *
   * The owner public key is parsed from the auth token at construction time — no
   * network round-trip is needed here.
   */
  private _buildSigner(dataSizeBytes: number): Signer {
    return {
      /** RSA-4096 public key modulus (512 bytes) — used as the ANS-104 data item `owner` field. */
      publicKey: Buffer.from(this.ownerPublicKey),
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

    const quote = await this.estimateCost(dataSizeBytes);
    const paymentReceipt = await this.paymentAdapter.pay({
      network: this.name,
      txData: _bytesToBase64url(hash),
      dataSizeBytes: dataSizeBytes,
      expiresAt: quote.expiresAt,
      ownerKey: _bytesToBase64url(this.ownerPublicKey),
    });

    if (!paymentReceipt.signedTx) {
      throw new Error(
        "[dStorage/arweave-turbo] Signing server returned an invalid sign-tx response for Arweave Turbo payment.",
      );
    }

    return _base64urlToBytes(paymentReceipt.signedTx!);
  }

  /**
   * Parse the compound auth token (<credential>.<base64url_modulus>) issued by the
   * signing server. Validates that the embedded key is exactly 512 bytes (RSA-4096).
   * Throws at construction time if the format is wrong — fail-fast before any network call.
   *
   * lastIndexOf is intentional: the credential part may itself contain dots
   * (e.g. a JWT), so we always split at the *last* dot to reach the modulus.
   */
  private static _parseToken(token: string): Uint8Array {
    const dot = token.lastIndexOf(".");
    if (dot === -1) {
      throw new Error(
        "[dStorage/arweave-turbo] authToken must be in the format " +
          "<credential>.<base64url_public_key> — re-issue your token from the signing server.",
      );
    }
    const ownerBytes = _base64urlToBytes(token.slice(dot + 1));
    if (ownerBytes.length !== 512) {
      throw new Error(
        `[dStorage/arweave-turbo] authToken public key must be 512 bytes (RSA-4096 modulus), ` +
          `got ${ownerBytes.length} — re-issue your token.`,
      );
    }
    return ownerBytes;
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
