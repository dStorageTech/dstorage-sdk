/**
 * @dstorage/payment — adapters/lumera.ts
 *
 * Lumera / Cascade payment adapter.
 *
 * ── Register-then-upload flow ─────────────────────────────────────────────────
 *
 * Lumera/Cascade separates the payment (Cosmos transaction) from the data
 * upload (HTTP to Cascade supernodes). This adapter implements the same
 * two-phase flow as ArweavePaymentAdapter:
 *
 *   1. provideUploadData(data, metadata)
 *        Called after encryption. Stores data + metadata for use in pay().
 *
 *   2. pay(instruction, onStatus)  [payment_storage step]
 *        - Initialises Keplr wallet and creates a LumeraClient.
 *        - Calls SDK's prepareFile() to hash the data (BLAKE3, local only).
 *        - Calls SDK's registerAction() which creates and broadcasts the Cosmos
 *          transaction, prompting Keplr for approval and deducting LUME fees.
 *        - Stores { actionId, authSignature } for the upload step.
 *
 *   3. LumeraCascadeStorageAdapter.store()  [upload step]
 *        Calls consumePendingUpload() to retrieve { actionId, authSignature },
 *        then calls SDK's sendFileToSupernodes() to transfer data to Cascade.
 *
 * Docs: https://github.com/kaleababayneh/Lumera-Research-Archive
 */

import type {
  PaymentAdapterLogger,
  PaymentAdapter,
  PaymentNetworkName,
  PaymentQuote,
  PaymentInstruction,
  PaymentReceipt,
  TokenSymbol,
} from "../types.js";

// ── Lumera chain constants ─────────────────────────────────────────────────────

const TESTNET_CHAIN_ID = "lumera-testnet-2";
//const TESTNET_RPC_URL = "https://rpc.testnet.lumera.io";

//const TESTNET_RPC_URL = "https://lumera-testnet-rpc.linknode.org/";
//const TESTNET_RPC_URL = "https://lumera-testnet-rpc.stakerhouse.com/";
const TESTNET_RPC_URL = "https://lumera-rpc.polkachu.com/";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Result of a successful registerAction() call — consumed by the storage adapter. */
export interface LumeraPendingUpload {
  actionId: string;
  authSignature: string;
}

export interface LumeraPaymentAdapterConfig {
  /** "testnet" uses lumera-testnet-2; "mainnet" uses lumera-1. */
  network: "testnet" | "mainnet";
  /** Quote validity window in ms. Defaults to 10 minutes. */
  quoteValidityMs?: number;
  logger?: PaymentAdapterLogger;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class LumeraPaymentAdapter implements PaymentAdapter {
  readonly network: PaymentNetworkName = "lumera";
  readonly token: TokenSymbol = "LUME";
  readonly type: "storage" | "chain" = "storage";

  protected readonly lumeraNetwork: "testnet" | "mainnet";
  protected readonly quoteValidityMs: number;
  protected readonly logger: PaymentAdapterLogger | undefined;

  private uploadData: {
    data: Uint8Array;
    metadata: Record<string, string>;
  } | null = null;
  private pendingUpload: LumeraPendingUpload | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cachedClient: any = null;

  constructor(config: LumeraPaymentAdapterConfig) {
    this.lumeraNetwork = config.network;
    this.quoteValidityMs = config.quoteValidityMs ?? 600_000;
    this.logger = config.logger;
  }

  // ── PaymentAdapter: provideUploadData ─────────────────────────────────────────

  provideUploadData(
    data: Uint8Array,
    metadata: Record<string, string> = {},
  ): void {
    this.uploadData = { data, metadata };
    this.logger?.log(
      "dStorage/lumera-payment",
      `Upload data staged: ${data.byteLength} bytes`,
    );
  }

  // ── PaymentAdapter: estimateCost ─────────────────────────────────────────────

  /**
   * Returns a fee estimate for uploading data to Lumera/Cascade.
   * TODO: query the Lumera LCD /lumera/supernode/v1/fee endpoint for a real estimate.
   */
  async estimateCost(dataSizeBytes: number): Promise<PaymentQuote> {
    const amount = this._estimateAmount(dataSizeBytes);

    this.logger?.log(
      "dStorage/lumera-payment",
      `Estimated: ~${amount} LUME for ${dataSizeBytes} bytes`,
    );

    return {
      token: this.token,
      amount,
      network: this.network,
      type: this.type,
      dataSizeBytes,
      expiresAt: Date.now() + this.quoteValidityMs,
    };
  }

  /** Placeholder: Cascade charges ~0.001 LUME per KB (rough estimate). */
  private _estimateAmount(dataSizeBytes: number): string {
    const lume = (dataSizeBytes / 1024) * 0.001;
    return Math.max(lume, 0.001).toFixed(6);
  }

  // ── PaymentAdapter: pay ───────────────────────────────────────────────────────

  /**
   * Register-then-store flow:
   *   1. Initialises Keplr and creates a LumeraClient (cached for reuse).
   *   2. Calls SDK's prepareFile() to hash the data locally (no network call).
   *   3. Calls SDK's registerAction() which creates and broadcasts the Cosmos tx,
   *      triggering the Keplr wallet popup to deduct LUME fees.
   *   4. Stores { actionId, authSignature } for LumeraCascadeStorageAdapter to use.
   *
   * Fallback: if registerAction() throws "action_registered event not found" the tx
   * still went through — we recover by querying listActionsByCreator for the latest
   * Cascade action and regenerating the auth signature via makeAuthSignature().
   */
  async pay(
    _instruction: PaymentInstruction,
    onStatus?: (message: string) => void,
  ): Promise<PaymentReceipt> {
    if (!this.uploadData) {
      throw new Error(
        "[dStorage/lumera-payment] provideUploadData() must be called before pay().",
      );
    }

    const { data, metadata } = this.uploadData;
    this.uploadData = null;

    const client = await this.getOrCreateClient();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const uploader = client.Cascade.uploader;

    onStatus?.("Hashing file for Lumera registration…");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const prepared = await uploader.prepareFile(data);

    const fileName = metadata["fileName"] ?? `dstorage_${Date.now()}.bin`;
    // 24-hour expiration window (Unix timestamp in seconds)
    // Add 120 s buffer: chain validates against block time, which leads wall clock by ~15 s on testnet.
    const expirationTime = String(Math.floor(Date.now() / 1000) + 86_400 + 120);

    onStatus?.("Requesting Keplr approval for Lumera action registration…");
    this.logger?.log(
      "dStorage/lumera-payment",
      `Registering action: fileName=${fileName} expirationTime=${expirationTime}`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let registered: { actionId: string; authSignature: string };
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      registered = await uploader.registerAction(prepared, {
        fileName,
        isPublic: true,
        expirationTime,
      });
    } catch (err) {
      // Lumera testnet may not emit the `action_registered` ABCI event in the
      // format the SDK expects, yet the MsgRequestAction tx still succeeds and
      // the action IS registered on-chain. Detect this specific case and recover.
      if (
        !(err instanceof Error) ||
        !err.message.includes("action_registered event not found")
      ) {
        throw err;
      }
      this.logger?.log(
        "dStorage/lumera-payment",
        "action_registered event absent from tx response — querying chain for latest action",
      );
      onStatus?.("Fetching action ID from chain (fallback)…");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      registered = await this._recoverRegisteredAction(
        client,
        prepared.dataHash as string,
      );
    }

    this.pendingUpload = {
      actionId: registered.actionId,
      authSignature: registered.authSignature,
    };

    this.logger?.log(
      "dStorage/lumera-payment",
      `Action registered → actionId: ${registered.actionId}`,
    );

    return {
      txHash: registered.actionId,
      token: "LUME",
      amount: this._estimateAmount(data.byteLength),
      type: "storage",
      paidAt: Date.now(),
      serviceFee: "0",
    };
  }

  /**
   * Fallback action-ID recovery used when registerAction() broadcasts a
   * MsgRequestAction successfully but can't parse the action_registered event
   * (a known SDK v0.2.7 / testnet-2 compatibility gap).
   *
   * Queries listActionsByCreator on the chain and picks the Cascade action with
   * the highest blockHeight (i.e. the one we just registered), then re-generates
   * the auth signature with makeAuthSignature().
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _recoverRegisteredAction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    dataHash: string,
  ): Promise<{ actionId: string; authSignature: string }> {
    // RpcActionQuery exposes its inner QueryClientImpl as `.client`
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const rawQuery = client.Blockchain.Action.client;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const creator: string = client.Blockchain.bech32Address as string;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const response = await rawQuery.listActionsByCreator({ creator });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const actions: Array<any> = (response.actions ?? []) as Array<any>;

    const cascadeActions = actions.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a: any) => (a.actionType as string) === "cascade",
    );

    if (cascadeActions.length === 0) {
      throw new Error(
        "[dStorage/lumera-payment] The MsgRequestAction tx succeeded but no Cascade " +
          "actions were found for this address on the chain. The Lumera testnet may " +
          "not yet support the Cascade action type.",
      );
    }

    // Take the most recently registered action (highest blockHeight)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const latest = cascadeActions.sort((a: any, b: any) => {
      const aH = BigInt(a.blockHeight ?? 0);
      const bH = BigInt(b.blockHeight ?? 0);
      return bH > aH ? 1 : bH < aH ? -1 : 0;
    })[0] as { actionID: string };

    const actionId = latest.actionID;
    this.logger?.log(
      "dStorage/lumera-payment",
      `Recovered actionId from chain query: ${actionId}`,
    );

    // Re-generate auth signature now that we have the actionId
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const authSignature = (await client.Cascade.uploader.makeAuthSignature(
      actionId,
      dataHash,
    )) as string;

    return { actionId, authSignature };
  }

  // ── Consumed by LumeraCascadeStorageAdapter ───────────────────────────────────

  /**
   * Returns the { actionId, authSignature } produced by pay(), then clears it.
   * Called by LumeraCascadeStorageAdapter.store() to send the file to supernodes.
   */
  consumePendingUpload(): LumeraPendingUpload | null {
    const pending = this.pendingUpload;
    this.pendingUpload = null;
    return pending;
  }

  /**
   * Returns the cached LumeraClient, initialising Keplr on first call.
   * Used by LumeraCascadeStorageAdapter for sendFileToSupernodes() and downloadFile().
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getOrCreateClient(): Promise<any> {
    if (this.cachedClient) return this.cachedClient;
    this.cachedClient = await this._initKeplrClient();
    return this.cachedClient;
  }

  // ── Private: Keplr initialisation ────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _initKeplrClient(): Promise<any> {
    if (typeof window === "undefined") {
      throw new Error(
        "[dStorage/lumera-payment] Keplr requires a browser environment.",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keplr = (window as any).keplr;
    if (!keplr) {
      throw new Error(
        "[dStorage/lumera-payment] Keplr not found. Install from https://www.keplr.app/get",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sdk: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdk = (await import("@lumera-protocol/sdk-js")) as any;
    } catch {
      throw new Error(
        "[dStorage/lumera-payment] @lumera-protocol/sdk-js not installed. Run: npm install @lumera-protocol/sdk-js",
      );
    }

    // Use CHAIN_PRESETS from the SDK to get chainId and snapiUrl, but always
    // override with our canonical testnet values when network is "testnet".
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const preset = sdk.CHAIN_PRESETS[this.lumeraNetwork];
    const chainId =
      this.lumeraNetwork === "testnet" ? TESTNET_CHAIN_ID : preset.chainId;
    const rpcUrl =
      this.lumeraNetwork === "testnet" ? TESTNET_RPC_URL : preset.rpcUrl;

    // Mirror the working keplr-test flow: first enable the chain in Keplr
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    await keplr.enable(chainId);

    // Use the SDK's getKeplrSigner helper (matches the official browser example).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const signer = await (
      sdk.getKeplrSigner as (
        chainId: string,
      ) => Promise<{ getAccounts: () => Promise<Array<{ address: string }>> }>
    )(chainId);
    const accounts = await signer.getAccounts();
    const first = accounts[0];
    if (!first)
      throw new Error("[dStorage/lumera-payment] Keplr returned no accounts.");
    const address = first.address;

    this.logger?.log(
      "dStorage/lumera-payment",
      `Connected to Keplr — address: ${address} network: ${this.lumeraNetwork}`,
    );

    this.logger?.log(
      "dStorage/lumera-payment",
      `Initialising Lumera client for network: ${this.lumeraNetwork}`,
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return sdk.createLumeraClient({
      preset: this.lumeraNetwork,
      chainId,
      rpcUrl,
      signer,
      address,
      gasPrice: "0.025ulume",
      http: {
        timeout: 45000,
        maxRetries: 3,
      },
    });
  }
}
