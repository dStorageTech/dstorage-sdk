/**
 * @dstorage/storage — adapters/arweave.ts
 *
 * Real Arweave storage adapter.
 * Uploads encrypted blobs to the Arweave permaweb — pay once, store forever.
 *
 * ── Runtime environments ──────────────────────────────────────────────────────
 *
 *   Browser (ArConnect):
 *     const adapter = new ArweaveStorageAdapter();
 *     // Requires the ArConnect extension: https://arconnect.io
 *
 *   Node.js (JWK wallet file):
 *     const adapter = new ArweaveStorageAdapter({
 *       walletKey: JSON.parse(fs.readFileSync('wallet.json', 'utf8')),
 *     });
 *
 * ── Testnet ───────────────────────────────────────────────────────────────────
 *
 *   const adapter = new ArweaveStorageAdapter({
 *     gateway: { host: 'arweave.dev', port: 443, protocol: 'https' },
 *   });
 *
 * ── Peer dependency ───────────────────────────────────────────────────────────
 *   npm install arweave
 *
 * ── Notes ─────────────────────────────────────────────────────────────────────
 *
 *   • Arweave transactions are optimistic: a 202 response means accepted, not
 *     confirmed. Confirmation (inclusion in a block) typically takes 2–20 minutes.
 *     Set waitForConfirmation: true to block until the tx is on-chain.
 *
 *   • For large files or high-volume uploads, consider Irys (https://irys.xyz)
 *     which bundles many transactions together for cheaper and near-instant
 *     finality. An IrysStorageAdapter can be added alongside this one.
 *
 *   • storageId (txId) is PUBLIC on Arweave. Data security relies entirely on
 *     the XChaCha20-Poly1305 encryption applied by @dstorage/crypto before reaching here.
 */

import type Arweave from "arweave";
import type {
  StorageAdapterLogger,
  StorageAdapter,
  StorageProviderName,
  StorageUploadResult,
  StorageQuote,
} from "../types.js";
import {
  PaymentAdapter,
  ArweavePaymentAdapter,
  ManagedPaymentAdapter,
} from "@dstorage/payment";
import type {
  PaymentNetworkName,
  SignedArweaveUpload,
} from "@dstorage/payment";
import { CONTENT_HASH_TAG, assertContentHash } from "./integrity.js";
import { DStorageError } from "@dstorage/crypto";
import { StorageErrorCode } from "../errors.js";

import type Transaction from "arweave/node/lib/transaction";
import type { TransactionUploader } from "arweave/node/lib/transaction-uploader";
import type { TransactionStatusResponse } from "arweave/node/transactions";

// ── Config ─────────────────────────────────────────────────────────────────────

export interface ArweaveGatewayConfig {
  host: string;
  port: number;
  protocol: "http" | "https";
}

export interface ArweaveAdapterConfig {
  /**
   * Arweave gateway to broadcast transactions to.
   * Defaults to mainnet (arweave.net:443).
   *
   * Testnet: { host: 'arweave.dev', port: 443, protocol: 'https' }
   *
   * Security: always use `protocol: 'https'` (the default) in production.
   * The SDK relies on standard OS/runtime TLS — no DNS or certificate pinning
   * is applied. Users in adversarial network environments should enforce
   * certificate pinning at the runtime level (e.g. a custom Node.js HTTPS
   * agent or a trusted corporate proxy).
   */
  gateway?: ArweaveGatewayConfig;

  /**
   * JWK wallet key for Node.js server-side usage.
   * Leave undefined in the browser — ArConnect is used automatically.
   *
   * Obtain a free wallet at https://arweave.app or generate via arweave-js:
   *   const jwk = await Arweave.init({}).wallets.generate();
   */
  walletKey?: Record<string, string>;

  /**
   * Base URL of a local ManagedPaymentAdapter signing server.
   * When provided, the adapter uses ManagedPaymentAdapter (remote signing)
   * instead of the default ArweavePaymentAdapter (local signing).
   * Example: "http://localhost:3000"
   */
  signingServerUrl?: string;

  /**
   * Bearer token sent as the `Authorization` header to authenticate with the signing server.
   * Required when `signingServerUrl` is provided.
   */
  authToken?: string; // validated at construction: required when signingServerUrl is set

  /**
   * How many times to retry a failed transaction post before throwing.
   * Uses a simple linear back-off: 1 s, 2 s, 3 s…
   * Defaults to 3.
   */
  maxRetries?: number;

  /**
   * If true, poll Arweave until the transaction is confirmed (block included)
   * before returning from store(). Confirmation typically takes 2–20 minutes.
   *
   * Defaults to false (optimistic — returns as soon as the gateway accepts
   * the transaction with HTTP 200 or 202).
   */
  waitForConfirmation?: boolean;

  /**
   * Polling interval in ms while waiting for confirmation.
   * Defaults to 30_000 (30 seconds).
   */
  confirmationPollMs?: number;

  /**
   * Maximum time in ms to wait for confirmation before throwing a timeout error.
   * Defaults to 1_200_000 (20 minutes).
   */
  confirmationTimeoutMs?: number;
  /**
   * When true, skip the BLAKE3 content-hash check on retrieve.
   * By default (false) the adapter fetches the transaction metadata and verifies
   * that the `X-Content-Hash` tag recorded at upload time matches the retrieved
   * bytes. Set to true only if you trust the gateway entirely or are using an
   * Arweave node that does not expose the transaction metadata endpoint.
   */
  skipIntegrityCheck?: boolean;

  /**
   * Maximum number of bytes allowed in a single retrieve() call.
   * The adapter rejects the download before materialising the blob if the
   * Arweave transaction metadata reports a larger `data_size`, and always
   * rejects after loading if the actual byte count exceeds this value.
   * Defaults to 268_435_456 (256 MB).
   */
  maxRetrieveSizeBytes?: number;

  /**
   * Optional logger for SDK operational output.
   * Pass `logger: console` to see all output, or inject your own logger.
   * Omit to suppress all SDK log output.
   */
  logger?: StorageAdapterLogger;
}

// ── Tag names ─────────────────────────────────────────────────────────────────

// ── Defaults ───────────────────────────────────────────────────────────────────

/**
 * Arweave mainnet gateway preset.
 *
 * @example
 * new ArweaveStorageAdapter({ gateway: ARWEAVE_MAINNET })
 */
export const ARWEAVE_MAINNET: ArweaveGatewayConfig = {
  host: "arweave.net",
  port: 443,
  protocol: "https",
};

// ── Adapter ────────────────────────────────────────────────────────────────────

export class ArweaveStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = "arweave";
  readonly providerName: string = "Arweave";
  paymentAdapter: PaymentAdapter;

  private readonly gateway: ArweaveGatewayConfig;
  private readonly maxRetries: number;
  private readonly shouldWaitForConfirm: boolean;
  private readonly confirmationPollMs: number;
  private readonly confirmationTimeoutMs: number;
  private readonly skipIntegrityCheck: boolean;
  private readonly maxRetrieveSizeBytes: number;
  protected readonly logger: StorageAdapterLogger | undefined;

  private arweaveClient: Arweave | null = null;

  constructor(config: ArweaveAdapterConfig = {}) {
    this.gateway = config.gateway ?? ARWEAVE_MAINNET;
    this.maxRetries = config.maxRetries ?? 3;
    this.shouldWaitForConfirm = config.waitForConfirmation ?? false;
    this.confirmationPollMs = config.confirmationPollMs ?? 30_000;
    this.confirmationTimeoutMs =
      config.confirmationTimeoutMs ?? 20 * 60 * 1_000;
    this.skipIntegrityCheck = config.skipIntegrityCheck ?? false;
    this.maxRetrieveSizeBytes =
      config.maxRetrieveSizeBytes ?? 256 * 1024 * 1024;
    this.logger = config.logger;

    // When a signing server URL is provided, use the ManagedPaymentAdapter:
    // transactions are sent unsigned to the remote server, which holds a
    // funded Arweave wallet and returns the signature.
    if (config.signingServerUrl) {
      if (!config.authToken?.trim()) {
        throw new DStorageError(
          StorageErrorCode.ARWEAVE_AUTH_TOKEN_REQUIRED,
          "[dStorage/arweave] authToken is required when signingServerUrl is provided.",
        );
      }
      this.paymentAdapter = new ManagedPaymentAdapter({
        signingServerUrl: config.signingServerUrl,
        authToken: config.authToken,
        network: this.name as PaymentNetworkName,
        type: "storage",
        gateway: this.gateway,
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
      });
    } else {
      // ...otherwise use the local-signing adapter
      this.paymentAdapter = new ArweavePaymentAdapter({
        gateway: this.gateway,
        ...(config.walletKey !== undefined
          ? { walletKey: config.walletKey }
          : {}),
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
      });
    }
  }

  // ── Private: lazy Arweave client ──────────────────────────────────────────────

  private async getClient(): Promise<Arweave> {
    if (this.arweaveClient) return this.arweaveClient;

    try {
      // Dynamic import — arweave-js is only bundled when this adapter is used.
      const _m = await import("arweave");
      // Vite 8/Rolldown wraps CJS modules differently: unwrap double-default if needed.
      const raw: unknown = _m.default;
      const ctor: { init(config: object): Arweave } =
        typeof (raw as { init?: unknown }).init === "function"
          ? (raw as { init(config: object): Arweave })
          : ((raw as { default?: { init(config: object): Arweave } }).default ??
            (raw as { init(config: object): Arweave }));
      this.arweaveClient = ctor.init(this.gateway);
      return this.arweaveClient;
    } catch {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_NOT_INSTALLED,
        "[dStorage/arweave] arweave package not found.\n" +
          "Install it with: npm install arweave",
      );
    }
  }

  // ── upload ─────────────────────────────────────────────────────────────────────

  async store(
    data: Uint8Array,
    metadata: Record<string, string> = {},
  ): Promise<StorageUploadResult> {
    const arweave = await this.getClient();

    // ── Sign-then-post flow ────────────────────────────────────────────────────
    // Signing is always delegated to the payment adapter:
    //   • MetaTransaction path: provideUploadData → pay → [here] consumeSignedUpload → post
    //   • Direct upload path:   [here] provideUploadData → pay → consumeSignedUpload → post
    //
    // This keeps the storage adapter agnostic about how signing happens (local
    // wallet, ArConnect, or remote signing server via ManagedPaymentAdapter).
    const arwPayment = this.paymentAdapter as ArweavePaymentAdapter;

    const quote = await this.estimateCost(data.byteLength);

    // Consume any pre-signed tx from the MetaTransaction pay() step.
    let signed: SignedArweaveUpload | null = arwPayment.consumeSignedUpload();

    if (!signed) {
      this.logger?.log(
        "dStorage/arweave",
        `Funding data storage transaction...`,
      );
      // Direct upload path — stage data and trigger signing via payment adapter.
      arwPayment.provideUploadData(data, metadata);
      await arwPayment.pay({
        network: this.name,
        dataSizeBytes: quote.dataSizeBytes,
        expiresAt: quote.expiresAt,
      });
      signed = arwPayment.consumeSignedUpload();
      if (!signed) {
        throw new DStorageError(
          StorageErrorCode.ARWEAVE_NO_SIGNED_TX,
          "[dStorage/arweave] Payment adapter did not produce a signed transaction.",
        );
      }
    }

    const { tx, arCost } = signed;

    // Broadcast via chunked uploader — sends 256 KB slices to /chunk endpoint.
    // Supports transactions up to ~2 GB and retries failed slices independently.
    await this.uploadWithChunker(arweave, tx);

    const txId = tx.id as string;
    const url = `${this.gateway.protocol}://${this.gateway.host}/${txId}`;

    this.logger?.log(
      "dStorage/arweave",
      `Uploaded → txId: ${txId}  cost: ~${arCost} AR`,
    );

    // Optional: block until the transaction is included in a block.
    if (this.shouldWaitForConfirm) {
      this.logger?.log(
        "dStorage/arweave",
        "Waiting for on-chain confirmation…",
      );
      await this.pollUntilConfirmed(arweave, txId);
    }

    return {
      id: txId,
      provider: this.name,
      cost: { ...quote, amount: arCost },
      url,
      uploadedAt: Date.now(),
    };
  }

  // ── retrieve ───────────────────────────────────────────────────────────────────

  async retrieve(
    id: string,
  ): Promise<{ bytes: Uint8Array; tags: Record<string, string> }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_INVALID_TX_ID,
        `[dStorage/arweave] Invalid transaction ID — expected 43 base64url characters: "${id.slice(0, 60)}${id.length > 60 ? "…" : ""}"`,
      );
    }
    const arweave = await this.getClient();

    // ── Pre-fetch transaction metadata ────────────────────────────────────────
    // Done before downloading data so we can (a) reject oversized blobs before
    // they materialise in memory, and (b) grab the X-Content-Hash tag for
    // integrity verification — both in a single round trip.
    let storedHash: string | undefined;
    const tags: Record<string, string> = {};
    if (!this.skipIntegrityCheck) {
      try {
        const tx = await arweave.transactions.get(id);

        // Size guard — reject before materialising a potentially huge blob.
        const dataSize = parseInt(tx.data_size ?? "0", 10);
        if (!isNaN(dataSize) && dataSize > this.maxRetrieveSizeBytes) {
          throw new DStorageError(
            StorageErrorCode.ARWEAVE_TX_TOO_LARGE,
            `[dStorage/arweave] Transaction data_size (${dataSize} bytes) exceeds ` +
              `the configured limit of ${this.maxRetrieveSizeBytes} bytes for txId: ${id}.`,
          );
        }

        for (const tag of tx.tags) {
          const name = tag.get("name", { decode: true, string: true });
          const value = tag.get("value", { decode: true, string: true });
          tags[name] = value;
          if (name === CONTENT_HASH_TAG) storedHash = value;
        }
      } catch (err) {
        if ((err as Error).message.startsWith("[dStorage/arweave]")) throw err;
        throw new DStorageError(
          StorageErrorCode.ARWEAVE_TX_METADATA_FAILED,
          `[dStorage/arweave] Could not fetch transaction metadata for txId: ${id} — ` +
            "content hash cannot be verified. " +
            "Set skipIntegrityCheck: true to bypass integrity checking for fully trusted gateways.",
          { cause: err },
        );
      }
    }

    // ── Download data ─────────────────────────────────────────────────────────
    let raw: unknown;
    try {
      raw = await arweave.transactions.getData(id, {
        decode: true,
        string: false,
      });
    } catch (err) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_GET_DATA_FAILED,
        `[dStorage/arweave] Failed to download data for txId: ${id} — ${String(err)}`,
        { cause: err },
      );
    }

    if (!raw) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_NO_DATA_RETURNED,
        `[dStorage/arweave] No data returned for txId: ${id}\n` +
          "The transaction may still be pending — Arweave can take a few minutes to confirm.\n" +
          `Check status at: https://viewblock.io/arweave/tx/${id}`,
      );
    }

    const bytes = raw as Uint8Array;

    // Post-load size guard — defense-in-depth and covers the skipIntegrityCheck path.
    if (bytes.byteLength > this.maxRetrieveSizeBytes) {
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_SIZE_MISMATCH,
        `[dStorage/arweave] Downloaded ${bytes.byteLength} bytes for txId: ${id}, ` +
          `which exceeds the configured limit of ${this.maxRetrieveSizeBytes} bytes.`,
      );
    }

    // ── Content hash verification ─────────────────────────────────────────────
    if (!this.skipIntegrityCheck) {
      if (!storedHash) {
        throw new DStorageError(
          StorageErrorCode.ARWEAVE_HASH_TAG_MISSING,
          `[dStorage/arweave] ${CONTENT_HASH_TAG} tag not found for txId: ${id}.\n` +
            "Set skipIntegrityCheck: true to bypass integrity checking for fully trusted gateways.",
        );
      }
      await assertContentHash(id, bytes, storedHash, "arweave");
    }

    this.logger?.log("dStorage/arweave", `Retrieved txId: ${id}`);
    return { bytes, tags };
  }

  // ── estimateCost ───────────────────────────────────────────────────────────────

  async estimateCost(dataSizeBytes: number): Promise<StorageQuote> {
    const arweave = await this.getClient();
    const winstons = await arweave.transactions.getPrice(dataSizeBytes);
    return {
      token: "AR",
      amount: arweave.ar.winstonToAr(winstons as string) as string,
      provider: this.name,
      dataSizeBytes,
      expiresAt: Date.now() + 5 * 60_000,
    };
  }

  // ── Private: chunked uploader ─────────────────────────────────────────────────

  /**
   * Upload a signed transaction using arweave-js getUploader().
   *
   * getUploader() sends just the tx header to /tx, then streams each 256 KB
   * data slice to the /chunk endpoint. This avoids the ~12 MB HTTP body limit
   * of transactions.post() and supports arbitrarily large transactions.
   *
   * Failed slices are retried individually up to maxRetries times with linear
   * back-off, so a transient network error won't restart the entire upload.
   */
  private async uploadWithChunker(
    arweave: Arweave,
    tx: Transaction,
  ): Promise<void> {
    this.logger?.log(
      "dStorage/arweave",
      `Posting tx id=${tx.id} owner=${tx.owner.slice(0, 16)}… data_size=${tx.data_size} reward=${tx.reward}`,
    );

    let uploader: TransactionUploader | undefined;
    try {
      uploader = await arweave.transactions.getUploader(tx);
    } catch (err) {
      const { protocol, host, port } = this.gateway;
      const gwUrl = `${protocol}://${host}:${port}`;
      try {
        const diagResp = await fetch(`${gwUrl}/tx/${tx.id}`);
        const diagBody = await diagResp.text();
        this.logger?.warn(
          "dStorage/arweave",
          `gateway GET /tx/${tx.id} → HTTP ${diagResp.status} — ${diagBody}`,
        );
      } catch {
        /* ignore diagnostic failures */
      }
      throw new DStorageError(
        StorageErrorCode.ARWEAVE_UPLOADER_INIT_FAILED,
        `[dStorage/arweave] Failed to initialise transaction uploader: ${err}`,
        { cause: err },
      );
    }

    let chunkAttempt = 0;

    while (!uploader.isComplete) {
      try {
        await uploader.uploadChunk();
        chunkAttempt = 0; // reset per-chunk retry count on success
        if (uploader.totalChunks > 1) {
          this.logger?.log(
            "dStorage/arweave",
            `Uploading: ${uploader.pctComplete}% (${uploader.uploadedChunks}/${uploader.totalChunks} network chunks)`,
          );
        }
      } catch (err) {
        chunkAttempt++;
        const status = uploader.lastResponseStatus ?? "n/a";
        const body = uploader.lastResponseError || String(err);
        this.logger?.warn(
          "dStorage/arweave",
          `chunk upload failed — HTTP ${status} — ${body}`,
        );
        if (chunkAttempt >= this.maxRetries) {
          throw new DStorageError(
            StorageErrorCode.ARWEAVE_CHUNK_UPLOAD_FAILED,
            `[dStorage/arweave] Chunk upload failed after ${this.maxRetries} attempts — HTTP ${status}: ${body}`,
            { cause: err },
          );
        }
        this.logger?.warn(
          "dStorage/arweave",
          `Chunk upload failed (attempt ${chunkAttempt}/${this.maxRetries}), retrying in ${chunkAttempt}s…`,
        );
        await sleep(1_000 * chunkAttempt);
      }
    }
  }

  // ── Private: confirmation polling ─────────────────────────────────────────────

  private async pollUntilConfirmed(
    arweave: Arweave,
    txId: string,
  ): Promise<void> {
    const deadline = Date.now() + this.confirmationTimeoutMs;

    while (Date.now() < deadline) {
      await sleep(this.confirmationPollMs);

      const status: TransactionStatusResponse =
        await arweave.transactions.getStatus(txId);

      if (status.status === 200) {
        const block = status.confirmed?.block_height;
        this.logger?.log(
          "dStorage/arweave",
          `Confirmed: ${txId}${block !== undefined ? ` (block ${block})` : ""}`,
        );
        return;
      }

      const remaining = Math.round((deadline - Date.now()) / 1_000);
      this.logger?.log(
        "dStorage/arweave",
        `Still pending (HTTP ${status.status}) — retrying in ${this.confirmationPollMs / 1_000}s… (timeout in ${remaining}s)`,
      );
    }

    throw new DStorageError(
      StorageErrorCode.ARWEAVE_CONFIRM_TIMEOUT,
      `[dStorage/arweave] Confirmation timeout for txId: ${txId}.\n` +
        "The transaction may still be processed eventually — track it at:\n" +
        `  https://viewblock.io/arweave/tx/${txId}`,
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
