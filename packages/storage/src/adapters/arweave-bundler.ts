/**
 * @dstorage/storage — adapters/arweave-bundler.ts
 *
 * Arweave Bundler storage adapter — ANS-104 bundled uploads with server-side signing.
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
 *   6. Client POSTs the signed data item directly to the ArDrive bundler.
 *   7. Returns with near-instant finality — txId is available immediately.
 *
 * ── Retrieve flow ─────────────────────────────────────────────────────────────
 *   Standard Arweave gateway fetch (identical to ArweaveStorageAdapter.retrieve).
 *   Its content-hash check only defends against a malicious gateway when called
 *   with an `expectedContentHash` anchor sourced independently of this gateway
 *   (see skipIntegrityCheck below) — @dstorage/core supplies this automatically
 *   from the on-chain reference. Without an anchor, the check falls back to a
 *   gateway-supplied tag and only catches non-adversarial corruption.
 *
 * ── Peer dependency ───────────────────────────────────────────────────────────
 *   @dha-team/arbundles (ANS-104 data item construction — the only network calls
 *   this adapter makes are plain `fetch` requests to the ArDrive Turbo payment/
 *   upload services below; no @ardrive/turbo-sdk dependency).
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
 *   • The ArDrive bundler provides near-instant finality — unlike the 2–20 min Arweave L1 wait.
 *   • The server holds the funded Turbo Credits account; users need no AR tokens.
 *   • Only 48 bytes (the deep_hash) go to the server; ciphertext stays on client.
 */

import type {
  StorageAdapter,
  StorageProviderName,
  StorageUploadResult,
  StorageAdapterLogger,
  StorageQuote,
  RetrieveOptions,
} from "../types.js";
import type {
  PaymentAdapter,
  PaymentNetworkName,
  ManagedPaymentOptions,
} from "@dstorage/payment";
import { ManagedPaymentAdapter } from "@dstorage/payment";
import type { Signer } from "@dha-team/arbundles";
import {
  CONTENT_HASH_TAG,
  computeBlake3Hex,
  assertContentHash,
} from "./integrity.js";
import {
  DStorageError,
  assertValidLogger,
  isDStorageError,
  readResponseTextWithLimit,
} from "@dstorage/crypto";
import { StorageErrorCode } from "../errors.js";

const ARWEAVE_GATEWAY_URL = "https://turbo-gateway.com";
/**
 * ArDrive's bundler payment and upload services. Talked to directly via `fetch`
 * (GET /v1/price/bytes/:n for cost estimates, POST /v1/tx/arweave for signed
 * data item uploads) rather than through the @ardrive/turbo-sdk package —
 * that SDK statically pulls in a large, unused multi-chain (Cosmos/Solana/EVM)
 * dependency tree even for these two unauthenticated Arweave-only calls.
 */
const BUNDLER_PAYMENT_SERVICE_URL = "https://payment.ardrive.io";
const BUNDLER_UPLOAD_SERVICE_URL = "https://upload.ardrive.io";

/** Default request timeout — matches the convention used by managed.ts. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Default max size for the metadata/tags JSON response (always tiny in practice). */
const DEFAULT_MAX_METADATA_RESPONSE_BYTES = 1024 * 1024; // 1 MiB
/** Default max size for the retrieved blob body. */
const DEFAULT_MAX_RETRIEVE_SIZE_BYTES = 256 * 1024 * 1024; // 256 MiB

// ── Config ─────────────────────────────────────────────────────────────────────

export interface ArweaveBundlerAdapterConfig {
  /**
   * Managed signing server connection options. The server must hold a
   * funded Turbo Credits account. Required — local signing is not supported.
   */
  managedPayment?: ManagedPaymentOptions;
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
   * Base URL of the bundler payment (cost estimate) service.
   * Defaults to ArDrive's production payment service. Override to point at a
   * self-hosted or local test double (e.g. for integration testing).
   */
  paymentServiceUrl?: string;
  /**
   * Base URL of the bundler upload service.
   * Defaults to ArDrive's production upload service. Override to point at a
   * self-hosted or local test double (e.g. for integration testing).
   */
  uploadServiceUrl?: string;
  /**
   * Maximum number of bytes allowed in a single retrieve() call.
   * Rejects if the `Content-Length` response header exceeds this value, and
   * always rejects after loading if the actual byte count exceeds it.
   * Defaults to 268_435_456 (256 MB).
   */
  maxRetrieveSizeBytes?: number;
  /**
   * Skip BLAKE3 content-hash verification on retrieve.
   * By default (false) the adapter verifies retrieved bytes against a content hash.
   * The strength of that guarantee depends on the hash's source:
   *   - When retrieve() is called with `options.expectedContentHash` (as
   *     `@dstorage/core` does automatically, from the on-chain ChainReference),
   *     verification is anchored to that chain-committed value and holds even
   *     against a fully malicious/colluding gateway.
   *   - Without an anchor, the adapter falls back to the `X-Content-Hash` tag
   *     fetched from this same gateway — that only catches non-adversarial
   *     corruption in transit, since a malicious gateway controls both the tag
   *     and the bytes and can make them consistent with each other.
   * Only set to true when connecting to a fully trusted gateway.
   */
  skipIntegrityCheck?: boolean;
  /**
   * Maximum time in milliseconds to wait for any single retrieve() request
   * (metadata or data fetch) before aborting. Defaults to 30_000 ms (30 s).
   * Pass `0` to disable the timeout entirely (not recommended for production).
   */
  requestTimeoutMs?: number;
  /**
   * Maximum number of bytes allowed in the transaction metadata/tags JSON
   * response fetched during retrieve(). Guards against a hostile or
   * misbehaving gateway returning an oversized body to exhaust memory.
   * Defaults to 1_048_576 (1 MiB) — metadata/tags are always tiny in practice.
   */
  maxMetadataResponseBytes?: number;
  /**
   * Maximum number of attempts for the upload POST to the bundler service
   * before giving up. On failure (network/timeout error or a non-ok HTTP
   * response), attempts are retried with linear back-off (1s, 2s, 3s, …) —
   * mirrors `ArweaveAdapterConfig.maxRetries`'s chunk-upload retry behavior.
   * Defaults to 3.
   */
  maxRetries?: number;
  /**
   * Optional logger for SDK operational output.
   */
  logger?: StorageAdapterLogger;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

/**
 * Stores encrypted data on Arweave via the ArDrive bundler (near-instant finality).
 *
 * Signing is delegated to the dStorage API server, which holds a funded Turbo Credits
 * account. The client sends only a 48-byte ANS-104 deep_hash to the server — the
 * encrypted file bytes never leave the client, preserving the same privacy invariant
 * as the existing managed Arweave flow.
 *
 * @example
 * const adapter = new ArweaveBundlerStorageAdapter({
 *   managedPayment: {
 *     signingServerUrl: "https://api.my-server.com",
 *     authToken: "ds_...",
 *   },
 * });
 * const { id } = await adapter.store(encryptedBytes, { "Content-Type": "application/octet-stream" });
 */
export class ArweaveBundlerStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = "arweave_bundler";
  readonly providerName = "Arweave (Bundler)";
  readonly paymentAdapter: PaymentAdapter;

  private readonly signingServerUrl: string | null;
  private readonly gateway: string;
  private readonly paymentServiceUrl: string;
  private readonly uploadServiceUrl: string;
  private readonly maxRetrieveSizeBytes: number;
  private readonly skipIntegrityCheck: boolean;
  private readonly requestTimeoutMs: number;
  private readonly maxMetadataResponseBytes: number;
  private readonly maxRetries: number;
  protected readonly logger: StorageAdapterLogger | undefined;

  /** RSA-4096 public key modulus (512 bytes) parsed from the auth token at construction time. */
  private readonly ownerPublicKey: Uint8Array;

  constructor(config: ArweaveBundlerAdapterConfig = {}) {
    this.signingServerUrl = config.managedPayment
      ? config.managedPayment.signingServerUrl.replace(/\/$/, "")
      : null;
    this.gateway = config.gateway ?? ARWEAVE_GATEWAY_URL;
    this.paymentServiceUrl =
      config.paymentServiceUrl ?? BUNDLER_PAYMENT_SERVICE_URL;
    this.uploadServiceUrl =
      config.uploadServiceUrl ?? BUNDLER_UPLOAD_SERVICE_URL;
    this.maxRetrieveSizeBytes =
      config.maxRetrieveSizeBytes ?? DEFAULT_MAX_RETRIEVE_SIZE_BYTES;
    this.skipIntegrityCheck = config.skipIntegrityCheck ?? false;
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxMetadataResponseBytes =
      config.maxMetadataResponseBytes ?? DEFAULT_MAX_METADATA_RESPONSE_BYTES;
    this.maxRetries = config.maxRetries ?? 3;
    assertValidLogger(config.logger, "ArweaveBundlerStorageAdapter");
    this.logger = config.logger;

    // When a signing server URL is provided, use the ManagedPaymentAdapter:
    // transactions are sent unsigned to the remote server, which holds a
    // funded Arweave wallet and returns the signature.
    if (config.managedPayment) {
      if (!config.managedPayment.authToken?.trim()) {
        throw new DStorageError(
          StorageErrorCode.ARWEAVE_BUNDLER_AUTH_TOKEN_REQUIRED,
          "[dStorage/arweave-bundler] authToken is required when signingServerUrl is provided.",
        );
      }
      this.ownerPublicKey = ArweaveBundlerStorageAdapter._parseToken(
        config.managedPayment.authToken,
      );
      this.paymentAdapter = new ManagedPaymentAdapter({
        managedPayment: config.managedPayment,
        network: this.name as PaymentNetworkName,
        type: "storage",
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
      });
    } else {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_LOCAL_NOT_SUPPORTED,
        "[dStorage/arweave-bundler] Local signing not supported yet.",
      );
    }
  }

  // ── upload ─────────────────────────────────────────────────────────────────────

  async store(
    data: Uint8Array,
    metadata: Record<string, string> = {},
  ): Promise<StorageUploadResult> {
    if (CONTENT_HASH_TAG in metadata) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_RESERVED_TAG_KEY,
        `[dStorage/arweave-bundler] metadata key "${CONTENT_HASH_TAG}" is reserved ` +
          "for the SDK's own content-hash tag and cannot be set by the caller.",
      );
    }
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
      "dStorage/arweave-bundler",
      `Creating ANS-104 data item (${dataSizeBytes} bytes, ${tags.length} tags)…`,
    );

    // createData allocates the data item structure.
    // dataItem.sign() computes the deep_hash and calls signer.sign(hash) — which
    // sends only those 48 hash bytes to the signing server.
    const dataItem = createData(data, signer, { tags });
    await dataItem.sign(signer);

    const raw: Uint8Array = dataItem.getRaw();
    const { txId, dataCaches } = await this._uploadToBundler(raw);

    const url = dataCaches[0]
      ? `https://${dataCaches[0]}/${txId}`
      : `${this.gateway}/${txId}`;
    this.logger?.log(
      "dStorage/arweave-bundler",
      `Uploaded via bundler → txId: ${txId}`,
    );

    return { id: txId, provider: this.name, url, uploadedAt: Date.now() };
  }

  /** Adds an AbortSignal.timeout() to a fetch init object (when requestTimeoutMs > 0). */
  private _withTimeout(init: RequestInit = {}): RequestInit {
    const signal =
      this.requestTimeoutMs > 0
        ? AbortSignal.timeout(this.requestTimeoutMs)
        : undefined;
    return { ...init, ...(signal !== undefined ? { signal } : {}) };
  }

  // ── retrieve ───────────────────────────────────────────────────────────────────

  async retrieve(
    id: string,
    options?: RetrieveOptions,
  ): Promise<{ bytes: Uint8Array; tags: Record<string, string> }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_INVALID_TX_ID,
        `[dStorage/arweave-bundler] Invalid transaction ID — expected 43 base64url characters: "${id.slice(0, 60)}${id.length > 60 ? "…" : ""}"`,
      );
    }
    // ── Pre-fetch transaction metadata via GraphQL ────────────────────────────
    let storedHash: string | undefined;
    const tags: Record<string, string> = {};
    if (!this.skipIntegrityCheck) {
      const gqlQuery = `{ transactions(ids: ["${id}"]) { edges { node { tags { name value } } } } }`;
      const metaResp = await fetch(
        `${this.gateway}/graphql`,
        this._withTimeout({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: gqlQuery }),
        }),
      );
      if (!metaResp.ok) {
        throw new DStorageError(
          StorageErrorCode.ARWEAVE_BUNDLER_TX_METADATA_FAILED,
          `[dStorage/arweave-bundler] Could not fetch transaction metadata for txId: ${id} — ` +
            "content hash cannot be verified. " +
            "Set skipIntegrityCheck: true to bypass integrity checking for fully trusted gateways.",
        );
      }
      const metaText = await readResponseTextWithLimit(metaResp, {
        maxBytes: this.maxMetadataResponseBytes,
        code: StorageErrorCode.ARWEAVE_BUNDLER_METADATA_TOO_LARGE,
        component: `[dStorage/arweave-bundler] retrieve(${id}) metadata`,
      });
      const gql = JSON.parse(metaText) as {
        data?: {
          transactions?: {
            edges?: Array<{
              node?: { tags?: Array<{ name: string; value: string }> };
            }>;
          };
        };
      };
      const edges = gql.data?.transactions?.edges ?? [];
      if (edges.length === 0) {
        throw new DStorageError(
          StorageErrorCode.ARWEAVE_BUNDLER_TX_METADATA_FAILED,
          `[dStorage/arweave-bundler] Could not fetch transaction metadata for txId: ${id} — ` +
            "content hash cannot be verified. " +
            "Set skipIntegrityCheck: true to bypass integrity checking for fully trusted gateways.",
        );
      }
      for (const tag of edges[0]?.node?.tags ?? []) {
        tags[tag.name] = tag.value;
        if (tag.name === CONTENT_HASH_TAG) storedHash = tag.value;
      }
      if (!options?.expectedContentHash && !storedHash) {
        throw new DStorageError(
          StorageErrorCode.ARWEAVE_BUNDLER_HASH_TAG_MISSING,
          `[dStorage/arweave-bundler] Cannot verify content integrity for txId: ${id} — ` +
            `no expectedContentHash anchor was provided and the ${CONTENT_HASH_TAG} tag was not found.\n` +
            "Set skipIntegrityCheck: true to bypass integrity checking for fully trusted gateways.",
        );
      }
    }

    // ── Download data ─────────────────────────────────────────────────────────
    const resp = await fetch(`${this.gateway}/${id}`, this._withTimeout());
    if (!resp.ok) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_RETRIEVE_HTTP_ERROR,
        `[dStorage/arweave-bundler] Failed to retrieve txId=${id}: HTTP ${resp.status}\n` +
          `Check: https://viewblock.io/arweave/tx/${id}`,
      );
    }

    // Pre-load size guard — reject before materialising the body when the
    // server advertises a size that already exceeds the limit.
    const contentLength = resp.headers.get("Content-Length");
    if (contentLength !== null) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > this.maxRetrieveSizeBytes) {
        throw new DStorageError(
          StorageErrorCode.ARWEAVE_BUNDLER_SIZE_LIMIT_EXCEEDED,
          `[dStorage/arweave-bundler] Content-Length (${size} bytes) exceeds ` +
            `the configured limit of ${this.maxRetrieveSizeBytes} bytes for txId: ${id}.`,
        );
      }
    }

    const bytes = new Uint8Array(await resp.arrayBuffer());

    // Post-load size guard — defense-in-depth; catches missing or incorrect Content-Length.
    if (bytes.byteLength > this.maxRetrieveSizeBytes) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_SIZE_MISMATCH,
        `[dStorage/arweave-bundler] Downloaded ${bytes.byteLength} bytes for txId: ${id}, ` +
          `which exceeds the configured limit of ${this.maxRetrieveSizeBytes} bytes.`,
      );
    }

    // ── Content hash verification ─────────────────────────────────────────────
    // Prefer a chain-anchored expectedContentHash (independent of this gateway) over
    // the gateway-supplied X-Content-Hash tag — a gateway that controls both the bytes
    // and the tag could otherwise fabricate an internally-consistent pair.
    const anchorHash = options?.expectedContentHash;
    if (!this.skipIntegrityCheck && (anchorHash || storedHash)) {
      await assertContentHash(
        id,
        bytes,
        anchorHash ?? storedHash!,
        "arweave-bundler",
      );
    }

    this.logger?.log("dStorage/arweave-bundler", `Retrieved txId: ${id}`);
    return { bytes, tags };
  }

  // ── estimateCost ───────────────────────────────────────────────────────────────

  async estimateCost(dataSizeBytes: number): Promise<StorageQuote> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.paymentServiceUrl}/v1/price/bytes/${dataSizeBytes}`,
        this._withTimeout(),
      );
    } catch (err) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_COST_ESTIMATE_FAILED,
        `[dStorage/arweave-bundler] Failed to fetch upload cost estimate from Arweave bundler: ${err}`,
        { cause: err },
      );
    }
    if (!resp.ok) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_COST_ESTIMATE_FAILED,
        `[dStorage/arweave-bundler] Failed to fetch upload cost estimate from Arweave bundler: HTTP ${resp.status}`,
      );
    }
    const text = await readResponseTextWithLimit(resp, {
      maxBytes: this.maxMetadataResponseBytes,
      code: StorageErrorCode.ARWEAVE_BUNDLER_METADATA_TOO_LARGE,
      component: `[dStorage/arweave-bundler] estimateCost(${dataSizeBytes})`,
    });
    let cost: { winc?: string };
    try {
      cost = JSON.parse(text) as { winc?: string };
    } catch {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_NO_COST_ESTIMATE,
        "[dStorage/arweave-bundler] Arweave bundler returned a malformed cost estimate response.",
      );
    }
    if (!cost.winc) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_NO_COST_ESTIMATE,
        "[dStorage/arweave-bundler] Arweave bundler returned no cost estimate for the given data size.",
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
   * Uses network: "arweave_bundler" so the server routes to the bundler-specific signing path.
   * The `dataSizeBytes` field lets the server estimate and quote the upload cost.
   */
  private async _signHash(
    hash: Uint8Array,
    dataSizeBytes: number,
  ): Promise<Uint8Array> {
    this.logger?.log(
      "dStorage/arweave-bundler",
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
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_INVALID_SIGN_TX_RESPONSE,
        "[dStorage/arweave-bundler] Signing server returned an invalid sign-tx response for Arweave bundler payment.",
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
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_INVALID_AUTH_TOKEN_FORMAT,
        "[dStorage/arweave-bundler] authToken must be in the format " +
          "<credential>.<base64url_public_key> — re-issue your token from the signing server.",
      );
    }
    const ownerBytes = _base64urlToBytes(token.slice(dot + 1));
    if (ownerBytes.length !== 512) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_INVALID_AUTH_TOKEN_KEY,
        `[dStorage/arweave-bundler] authToken public key must be 512 bytes (RSA-4096 modulus), ` +
          `got ${ownerBytes.length} — re-issue your token.`,
      );
    }
    return ownerBytes;
  }

  /**
   * POST the complete signed ANS-104 data item bytes directly to the ArDrive bundler.
   * Server Turbo Credits are consumed based on the signing key — no client wallet needed.
   *
   * Retries the whole attempt up to `maxRetries` times with linear back-off
   * (1s, 2s, 3s, …) on any failure — network/timeout error or a non-ok HTTP
   * response — mirroring `ArweaveStorageAdapter`'s chunk-upload retry behavior.
   */
  private async _uploadToBundler(
    dataItemBuffer: Uint8Array,
  ): Promise<{ txId: string; dataCaches: string[] }> {
    this.logger?.log(
      "dStorage/arweave-bundler",
      `Uploading ${dataItemBuffer.byteLength}-byte signed data item to bundler…`,
    );

    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this._attemptUpload(dataItemBuffer);
      } catch (err) {
        lastErr = err;
        if (attempt >= this.maxRetries) break;
        this.logger?.warn(
          "dStorage/arweave-bundler",
          `Upload attempt ${attempt}/${this.maxRetries} failed — ${err} — retrying in ${attempt}s…`,
        );
        await sleep(1_000 * attempt);
      }
    }
    // Preserve the last attempt's specific error code (e.g. NO_TX_ID_RETURNED,
    // METADATA_TOO_LARGE) rather than collapsing every failure mode into one
    // generic code — only fall back to UPLOAD_FAILED for a non-DStorageError.
    const code = isDStorageError(lastErr)
      ? lastErr.code
      : StorageErrorCode.ARWEAVE_BUNDLER_UPLOAD_FAILED;
    throw new DStorageError(
      code,
      `[dStorage/arweave-bundler] Upload to Arweave bundler failed after ${this.maxRetries} attempts: ${lastErr}`,
      { cause: lastErr },
    );
  }

  /** Single upload attempt — see _uploadToBundler for the retry wrapper. */
  private async _attemptUpload(
    dataItemBuffer: Uint8Array,
  ): Promise<{ txId: string; dataCaches: string[] }> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.uploadServiceUrl}/v1/tx/arweave`,
        this._withTimeout({
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": `${dataItemBuffer.byteLength}`,
          },
          body: Buffer.from(dataItemBuffer),
        }),
      );
    } catch (err) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_UPLOAD_FAILED,
        `[dStorage/arweave-bundler] Upload to Arweave bundler failed: ${err}`,
        { cause: err },
      );
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_UPLOAD_FAILED,
        `[dStorage/arweave-bundler] Upload to Arweave bundler failed: HTTP ${resp.status}${errText ? ` — ${errText}` : ""}`,
      );
    }
    const text = await readResponseTextWithLimit(resp, {
      maxBytes: this.maxMetadataResponseBytes,
      code: StorageErrorCode.ARWEAVE_BUNDLER_METADATA_TOO_LARGE,
      component: "[dStorage/arweave-bundler] upload response",
    });
    let result: { id?: string; dataCaches?: string[] };
    try {
      result = JSON.parse(text) as { id?: string; dataCaches?: string[] };
    } catch {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_NO_TX_ID_RETURNED,
        "[dStorage/arweave-bundler] Arweave bundler returned a malformed upload response.",
      );
    }
    if (!result.id) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_BUNDLER_NO_TX_ID_RETURNED,
        "[dStorage/arweave-bundler] Arweave bundler did not return a transaction id.",
      );
    }

    return { txId: result.id, dataCaches: result.dataCaches ?? [] };
  }
}

/** Linear back-off delay between upload retry attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
