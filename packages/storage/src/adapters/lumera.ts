/**
 * @dstorage/storage — adapters/lumera.ts
 *
 * Lumera / Cascade storage adapter.
 * Permanent, immutable, censorship-resistant distributed file storage
 * on the Lumera blockchain's Cascade layer.
 *
 * ── Upload flow ───────────────────────────────────────────────────────────────
 *
 * Cascade separates payment (Cosmos tx) from data transfer (HTTP to supernodes):
 *
 *   MetaTransaction orchestrated flow (via LumeraPaymentAdapter):
 *     provideUploadData → pay() [Keplr tx, registers action, deducts LUME]
 *     → store() [sendFileToSupernodes() via HTTP to Cascade]
 *
 *   Direct flow (no prior MetaTransaction):
 *     store() performs both steps inline.
 *
 * ── Retrieve flow ─────────────────────────────────────────────────────────────
 *
 *   retrieve(actionId) → downloadFile() via Cascade HTTP
 *
 * Docs: https://github.com/kaleababayneh/Lumera-Research-Archive
 */

import type {
  StorageAdapterLogger,
  StorageAdapter,
  StorageProviderName,
  StorageUploadResult,
  StorageQuote,
  RetrieveOptions,
} from "../types.js";
import {
  LumeraPaymentAdapter,
  ManagedPaymentAdapter,
  PaymentAdapter,
} from "@dstorage/payment";
import type {
  LumeraPendingUpload,
  ManagedPaymentOptions,
} from "@dstorage/payment";
import { assertContentHash } from "./integrity.js";

export interface LumeraCascadeAdapterConfig {
  /** "testnet" connects to lumera-testnet-2; "mainnet" connects to lumera-1. */
  network: "testnet" | "mainnet";
  /**
   * When provided, uses ManagedPaymentAdapter (remote signing server) instead of
   * LumeraPaymentAdapter (local Keplr). Note: managed Lumera payment is not
   * yet fully implemented on the server side.
   */
  managedPayment?: ManagedPaymentOptions;
  logger?: StorageAdapterLogger;
}

export class LumeraCascadeStorageAdapter implements StorageAdapter {
  readonly name: StorageProviderName = "lumera";
  readonly providerName: string;
  readonly paymentAdapter: PaymentAdapter;

  private readonly lumeraNetwork: "testnet" | "mainnet";
  private readonly logger: StorageAdapterLogger | undefined;

  constructor(config: LumeraCascadeAdapterConfig) {
    this.lumeraNetwork = config.network;
    this.providerName =
      config.network === "testnet"
        ? "Lumera Cascade (Testnet)"
        : "Lumera Cascade";
    this.logger = config.logger;

    if (config.managedPayment) {
      this.paymentAdapter = new ManagedPaymentAdapter({
        network: "lumera",
        type: "storage",
        managedPayment: config.managedPayment,
        ...(config.logger ? { logger: config.logger } : {}),
      });
    } else {
      this.paymentAdapter = new LumeraPaymentAdapter({
        network: config.network,
        ...(config.logger ? { logger: config.logger } : {}),
      });
    }
  }

  // ── StorageAdapter: store ─────────────────────────────────────────────────────

  async store(
    data: Uint8Array,
    metadata: Record<string, string> = {},
  ): Promise<StorageUploadResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payment = this.paymentAdapter as any;

    // Consume action registration result from the payment step (MetaTransaction flow)
    let pending: LumeraPendingUpload | null =
      typeof payment.consumePendingUpload === "function"
        ? (payment.consumePendingUpload() as LumeraPendingUpload | null)
        : null;

    if (!pending) {
      // Direct path: no prior MetaTransaction — run payment inline
      if (typeof payment.provideUploadData === "function") {
        payment.provideUploadData(data, metadata);
      }
      const quote = await this.paymentAdapter.estimateCost(data.byteLength);
      await this.paymentAdapter.pay(quote);
      pending =
        typeof payment.consumePendingUpload === "function"
          ? (payment.consumePendingUpload() as LumeraPendingUpload | null)
          : null;
    }

    if (!pending) {
      throw new Error(
        "[dStorage/lumera] No actionId available after payment. " +
          "Ensure the payment adapter completed registerAction() successfully.",
      );
    }

    const client = await this._getClient();

    this.logger?.log(
      "dStorage/lumera",
      `Uploading ${data.byteLength} bytes to Cascade — actionId: ${pending.actionId}`,
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    await client.Cascade.uploader.sendFileToSupernodes(
      pending.actionId,
      pending.authSignature,
      data,
    );

    this.logger?.log(
      "dStorage/lumera",
      `Upload complete → actionId: ${pending.actionId}`,
    );

    return {
      id: pending.actionId,
      provider: this.name,
      uploadedAt: Date.now(),
    };
  }

  // ── StorageAdapter: retrieve ──────────────────────────────────────────────────

  async retrieve(
    id: string,
    options?: RetrieveOptions,
  ): Promise<{ bytes: Uint8Array; tags: Record<string, string> }> {
    const client = await this._getClient();

    this.logger?.log("dStorage/lumera", `Retrieving actionId: ${id}`);

    // downloadFile expects { actionId } and returns a ReadableStream.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const stream = (await client.Cascade.downloader.downloadFile({
      actionId: id,
    })) as ReadableStream<Uint8Array>;

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      if (value)
        chunks.push(
          value instanceof Uint8Array ? value : new Uint8Array(value),
        );
    }

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    // Cascade has no gateway-native integrity tag to fall back on — only verify
    // when the caller supplies a chain-anchored hash to check against.
    if (options?.expectedContentHash) {
      await assertContentHash(id, bytes, options.expectedContentHash, "lumera");
    }

    return { bytes, tags: {} };
  }

  // ── StorageAdapter: estimateCost ──────────────────────────────────────────────

  async estimateCost(dataSizeBytes: number): Promise<StorageQuote> {
    const quote = await this.paymentAdapter.estimateCost(dataSizeBytes);
    return {
      token: quote.token,
      amount: quote.amount,
      provider: this.name,
      dataSizeBytes,
      expiresAt: quote.expiresAt,
    };
  }

  // ── Private: Lumera client ────────────────────────────────────────────────────

  /**
   * Returns the LumeraClient, sourced from the payment adapter (which holds a
   * Keplr-initialized client) or initialised directly.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _getClient(): Promise<any> {
    // LumeraPaymentAdapter exposes getOrCreateClient() — reuse to avoid double Keplr init
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payment = this.paymentAdapter as any;
    if (typeof payment.getOrCreateClient === "function") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      return payment.getOrCreateClient();
    }

    // ManagedPaymentAdapter path: init own client for supernodes/download operations.
    // The user still needs Keplr connected to call the Cascade HTTP API.
    return this._initOwnClient();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _ownClient: any = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _initOwnClient(): Promise<any> {
    if (this._ownClient) return this._ownClient;

    if (typeof window === "undefined") {
      throw new Error(
        "[dStorage/lumera] Keplr requires a browser environment.",
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keplr = (window as any).keplr;
    if (!keplr) {
      throw new Error(
        "[dStorage/lumera] Keplr not found. Install from https://www.keplr.app/get",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sdk: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdk = (await import("@lumera-protocol/sdk-js")) as any;
    } catch {
      throw new Error(
        "[dStorage/lumera] @lumera-protocol/sdk-js not installed. Run: npm install @lumera-protocol/sdk-js",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const preset = sdk.CHAIN_PRESETS[this.lumeraNetwork];
    const chainId = preset.chainId;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    await keplr.enable(chainId);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const signer = keplr.getOfflineSigner(chainId);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const accounts = (await signer.getAccounts()) as Array<{ address: string }>;
    const first = accounts[0];
    if (!first)
      throw new Error("[dStorage/lumera] Keplr returned no accounts.");
    const address = first.address;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    this._ownClient = await sdk.createLumeraClient({
      preset: this.lumeraNetwork,
      signer,
      address,
    });
    return this._ownClient;
  }
}
