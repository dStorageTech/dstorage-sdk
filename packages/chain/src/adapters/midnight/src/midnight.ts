/**
 * @dstorage/chain — adapters/midnight.ts
 *
 * Midnight Network chain adapter.
 *
 * Uses DataRegistryAPI (deployContract / findDeployedContract / callTx) from
 * @midnight-ntwrk/midnight-js-contracts via the api.ts wrapper, so that
 * midnight.ts only needs to manage the wallet lifecycle and provider assembly.
 *
 * Wallet lifecycle:
 *   - 'provider': accepts a pre-built wallet provider (Node.js CLI)
 *   - 'connector': connect to browser wallet extension (browser dApp)
 *
 * Transaction flow (handled by DataRegistryAPI internally):
 *   1. Build  — construct the unproven circuit call
 *   2. Prove  — generate the ZK proof (proof server, or the wallet — see PROVER_MODE)
 *   3. Balance — attach DUST fees via the connected wallet
 *   4. Submit — broadcast to the Midnight node
 *   5. Confirm — wait for block inclusion
 *
 * Docs: https://docs.midnight.network/develop/tutorial/building-a-dapp
 */

import { ManagedPaymentAdapter } from "@dstorage/payment";
import type { PaymentReceipt, ManagedPaymentOptions } from "@dstorage/payment";
import { hexToBytes, DStorageError, assertValidLogger } from "@dstorage/crypto";
import { ChainErrorCode } from "../../../errors.js";
import {
  type ProofProvider,
  type WalletProvider,
  type ZKConfigProvider,
} from "@midnight-ntwrk/midnight-js-types";
import type { FinalizedTransaction } from "@midnight-ntwrk/midnight-js-protocol/ledger";

import type {
  ChainAdapter,
  ChainProviderName,
  ChainReference,
  ChainReferenceUpdate,
  ChainWriteResult,
  EncryptionScheme,
  ChainAdapterLogger,
  WalletBalances,
  DataReferenceSummary,
  ChainQuote,
} from "../../../types.js";

import type {
  Configuration as WalletConfiguration,
  ConnectedAPI,
  InitialAPI,
  ProvingProvider,
} from "@midnight-ntwrk/dapp-connector-api";
import type { DataRegistryAPI } from "./contract-api.js";
import type {
  DataRegistryProviders,
  DataRegistryCircuitKeys,
  AdapterWalletProvider,
} from "./common-types.js";
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk/facade";
import { NetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { waitForFacadeSync } from "./sync.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Public types ──────────────────────────────────────────────────────────────

export interface WalletAddresses {
  unshielded: string;
  shielded: string;
  dust: string;
}

// ── Known networks ─────────────────────────────────────────────────────────────
// Network ids only — endpoints are never preset; configure them explicitly or
// (in connector mode) let the wallet supply them.
export const NETWORKS = {
  preprod: { networkId: "preprod" },
  preview: { networkId: "preview" },
  undeployed: { networkId: "undeployed" },
} as const;

// ── Prover modes ───────────────────────────────────────────────────────────────

/**
 * Where ZK proofs are generated in connector mode (`prover` config option).
 *
 *   - PROOF_SERVER_URL: the adapter calls the proof server set in
 *     `proofServerEndpoint` (required).
 *   - WALLET_CONFIGURED_PROOF_SERVER: the adapter calls the proof server the
 *     wallet reports as `proverServerUri` in its configuration.
 *   - WALLET_DELEGATED: proving is delegated to the wallet itself via the
 *     DApp Connector `getProvingProvider()`.
 */
export const PROVER_MODE = {
  PROOF_SERVER_URL: "proof-server-url",
  WALLET_CONFIGURED_PROOF_SERVER: "wallet-configured-proof-server",
  WALLET_DELEGATED: "wallet-delegated",
} as const;

export type ProverMode = (typeof PROVER_MODE)[keyof typeof PROVER_MODE];

/**
 * Internal resolved adapter configuration. Endpoints are only those the caller
 * explicitly configured — there are no built-in defaults.
 */
interface AdapterEnvironment {
  networkId: string;
  nodeHttp?: string;
  nodeWs?: string;
  indexerHttp?: string;
  indexerWs?: string;
  proofServer?: string;
  proofServerMaxRetries: number;
}

// ── Config ─────────────────────────────────────────────────────────────────────

interface BaseConfig {
  /**
   * Midnight node RPC (HTTP) endpoint. No default.
   */
  nodeEndpoint?: string;
  /**
   * Midnight node RPC WebSocket endpoint. No default.
   */
  nodeWsEndpoint?: string;
  /**
   * Optional logger for SDK operational output.
   * Pass `logger: console` to see all output, or inject your own logger.
   * Omit to suppress all SDK log output.
   */
  logger?: ChainAdapterLogger;
  /**
   * Midnight indexer HTTP (GraphQL) endpoint for state queries. No default.
   * Required in provider mode. In connector mode, when set, it takes priority
   * over the wallet's `indexerUri`; when omitted, the wallet's value is used.
   */
  indexerEndpoint?: string;
  /**
   * Midnight indexer WebSocket endpoint for real-time subscriptions. No default.
   * Required in provider mode. In connector mode, when set, it takes priority
   * over the wallet's `indexerWsUri`; when omitted, the wallet's value is used.
   */
  indexerWsEndpoint?: string;
  /**
   * Proof server URL. No default. Required in provider mode, and in connector
   * mode with `prover: PROVER_MODE.PROOF_SERVER_URL` (the default). Must not be
   * set with any other connector-mode `prover`.
   */
  proofServerEndpoint?: string;
  /**
   * Number of times to retry a proof-server circuit call on failure before
   * giving up. Uses exponential backoff (1 s, 2 s, 4 s, …).
   * Defaults to 3. Set to 1 to disable retries.
   */
  proofServerMaxRetries?: number;
  /**
   * On-chain address of an already-deployed DataRegistry contract.
   * If omitted, sdk.init() will deploy a new contract and return its address.
   */
  contractAddress?: string;
  /**
   * Target network. Controls wallet networkId, address format, and fee overhead.
   * Always takes priority over the connected wallet's: in connector mode it is
   * passed to `connect()`, and `init()` throws if the wallet's configuration
   * reports a different networkId.
   */
  network: NetworkId;
  /**
   * Managed signing server connection options. When provided, transaction
   * balancing is delegated to the server instead of the local wallet.
   */
  managedPayment?: ManagedPaymentOptions;
}

export type MidnightChainAdapterConfig = BaseConfig &
  (
    | {
        /**
         * Provider mode: the caller builds, starts, syncs, and passes in a wallet provider.
         * The adapter uses it directly without managing any wallet lifecycle.
         * Use this mode for Node.js CLI apps (e.g., the dStorage console demo).
         */
        walletMode: "provider";
        /**
         * A fully initialised wallet provider (started and synced before passing in).
         * Must implement AdapterWalletProvider (WalletProvider + MidnightProvider + .wallet).
         */
        walletProvider: AdapterWalletProvider;
        /**
         * LevelDB encryption password for the private state store.
         * Must satisfy the policy: at least 3 of 4 character classes
         * (uppercase, lowercase, digits, special characters).
         * Recommended derivation: "Aa1!" + seedHex (all 4 classes guaranteed).
         */
        privateStatePassword: string;
        /**
         * Path to the directory that contains the compiled DataRegistry contract's ZK artifacts.
         * Expected sub-directories:
         *   ${zkArtifactsPath}/keys/${circuitId}.prover
         *   ${zkArtifactsPath}/keys/${circuitId}.verifier
         *   ${zkArtifactsPath}/zkir/${circuitId}.bzkir
         *
         * Required for write operations (storeReference, etc.) in provider mode.
         */
        zkArtifactsPath?: string;
      }
    | {
        /**
         * Browser wallet connector mode.
         * Delegates all key management to the wallet extension (e.g., Midnight Lace).
         */
        walletMode: "connector";
        /**
         * Wallet to prefer when multiple wallets are injected under window.midnight.
         * Matched in order of reliability against each wallet's:
         *   1. `rdns` — the spec-recommended stable identifier (reverse-DNS style),
         *      e.g. 'io.lace.wallet' for Midnight Lace, 'com.midnight.1am' for the
         *      1AM wallet. Recommended, since the injected window.midnight key is
         *      not guaranteed to be stable (Lace injects under a random UUID;
         *      other wallets, e.g. 1AM, use a fixed key).
         *   2. declared `name` (e.g. 'lace' for Midnight Lace, '1AM' for the 1AM
         *      wallet — casing varies by wallet and is not normalized).
         *   3. injected window.midnight key, e.g. '1am' for the 1AM wallet.
         * Default: use the first wallet discovered.
         */
        connectorName?: string;
        /**
         * Base URL from which the ZK artifacts for the DataRegistry contract are served.
         * Must be an absolute http/https URL.
         *
         * In Vite apps: copy the compiled contract's keys/ and zkir/ directories
         * to public/ and set this to window.location.origin.
         *
         * Required for write operations (storeReference, etc.) in connector mode.
         */
        zkConfigBaseUrl?: string;
        /**
         * Where ZK proofs are generated. Default: `PROVER_MODE.PROOF_SERVER_URL`.
         *
         *   - `PROVER_MODE.PROOF_SERVER_URL`: call the proof server set in
         *     `proofServerEndpoint` (required). The wallet's `proverServerUri` is ignored.
         *   - `PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER`: call the proof server the
         *     wallet reports as `proverServerUri`. `proofServerEndpoint` must not be set.
         *   - `PROVER_MODE.WALLET_DELEGATED`: delegate proving to the wallet via the
         *     DApp Connector `getProvingProvider()`; the wallet fetches the circuit keys
         *     from `zkConfigBaseUrl`. `proofServerEndpoint` must not be set.
         *
         * Use either wallet option only when you trust the connected wallet extension.
         * Both hand the ZK witness inputs — including the ownerSecret — to something the
         * wallet controls; a compromised wallet extension could use them to take over or
         * delete references.
         */
        prover?: ProverMode;
      }
  );

// ── Browser-safe byte/encoding helpers ────────────────────────────────────────

function isHttpOrHttps(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Convert a Uint8Array to a lowercase hex string (browser-safe, no Buffer). */
function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Wallet errors arrive in incompatible shapes depending on wallet internals:
 *   - DApp Connector spec: { type: "DAppConnectorAPIError", code, reason }
 *   - Plain Error: { message }
 *   - Effect-TS FiberFailure (observed from Lace, whose wallet core is built
 *     on Effect): a bare Error with an empty .message, carrying the real
 *     failure nested at .cause.failure.message (e.g. "Insufficient Funds:
 *     could not balance dust").
 * Rather than hand-checking each shape, walk the object for the first
 * `reason`/`message` string, recursing into common wrapper fields.
 */
function findErrorDetail(
  err: unknown,
  depth = 0,
): { message: string; tag?: string } | undefined {
  if (depth > 5 || typeof err !== "object" || err === null) return undefined;
  const obj = err as Record<string, unknown>;
  const message = obj["reason"] ?? obj["message"];
  if (typeof message === "string" && message) {
    const tag = obj["_tag"];
    return typeof tag === "string" ? { message, tag } : { message };
  }
  for (const key of ["failure", "cause", "error"]) {
    const nested = findErrorDetail(obj[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * True when the error chain contains a DApp Connector rejection — the user
 * declined the wallet prompt. Such calls must not be retried, or the user is
 * prompted again for each attempt.
 */
function isWalletRejection(err: unknown, depth = 0): boolean {
  if (depth > 5 || typeof err !== "object" || err === null) return false;
  const obj = err as Record<string, unknown>;
  if (
    obj["type"] === "DAppConnectorAPIError" &&
    (obj["code"] === "Rejected" || obj["code"] === "PermissionRejected")
  ) {
    return true;
  }
  return ["failure", "cause", "error"].some((key) =>
    isWalletRejection(obj[key], depth + 1),
  );
}

function describeConnectorError(err: unknown): string {
  const detail = findErrorDetail(err);
  if (detail)
    return detail.tag ? `${detail.message} (${detail.tag})` : detail.message;
  if (typeof err === "string" && err) return err;
  try {
    return `wallet threw with no diagnosable message: ${JSON.stringify(err)}`;
  } catch {
    return `wallet threw with no diagnosable message: ${String(err)}`;
  }
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class MidnightChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = "midnight";
  readonly providerName: string = "Midnight";
  readonly managedPaymentAdapter: ManagedPaymentAdapter | null = null;

  _lastPaymentReceipt: PaymentReceipt | undefined;

  private facade: WalletFacade | null = null;
  private connectorAPI: ConnectedAPI | null = null;
  private addresses: WalletAddresses | null = null;

  // Connector mode: shielded wallet keys retrieved from Lace during init().
  private connectorCoinPublicKey: string | null = null;
  private connectorEncPublicKey: string | null = null;
  // Connector mode: endpoints from wallet configuration (may differ from config defaults).
  private connectorIndexerHttp: string | null = null;
  private connectorIndexerWs: string | null = null;
  private connectorProofServer: string | null = null;

  private readonly walletMode: "connector" | "provider";
  private readonly connectorName: string | null;
  private readonly prover: ProverMode;
  private readonly logger: ChainAdapterLogger | undefined;

  private _contractAddress: string | undefined;
  private _zkArtifactsPath: string | undefined;
  private _zkConfigBaseUrl: string | undefined;
  private _initialized = false;

  // DataRegistry API — lazily initialized by _getAPI().
  // Reset to null when contract address changes (setContractAddress) or on stop().
  private _api: DataRegistryAPI | null = null;

  private _injectedWalletProvider: AdapterWalletProvider | null = null;
  private _injectedPrivateStatePassword: string | null = null;

  private readonly config: AdapterEnvironment;

  constructor(config: MidnightChainAdapterConfig) {
    if (config.contractAddress !== undefined) {
      MidnightChainAdapter._validateContractAddress(config.contractAddress);
    }
    if (!config.network) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_NETWORK_REQUIRED,
        "[dStorage/midnight] network is required.",
      );
    }

    // Determine wallet mode and validate required fields
    const walletMode = config.walletMode;
    if (walletMode === "provider") {
      const providerConfig = config as Extract<
        MidnightChainAdapterConfig,
        { walletMode: "provider" }
      >;
      if (!providerConfig.walletProvider) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_WALLET_PROVIDER_REQUIRED,
          '[dStorage/midnight] walletProvider is required (walletMode: "provider").',
        );
      }
      if (!providerConfig.privateStatePassword) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_PRIVATE_STATE_PASSWORD_REQUIRED,
          '[dStorage/midnight] privateStatePassword is required (walletMode: "provider").',
        );
      }
      // Provider mode has no wallet configuration to take endpoints from.
      if (!config.indexerEndpoint) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_INDEXER_HTTP_NOT_SET,
          '[dStorage/midnight] indexerEndpoint is required (walletMode: "provider").',
        );
      }
      if (!config.indexerWsEndpoint) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_INDEXER_WS_NOT_SET,
          '[dStorage/midnight] indexerWsEndpoint is required (walletMode: "provider").',
        );
      }
      if (!config.proofServerEndpoint) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_PROOF_SERVER_NOT_SET,
          '[dStorage/midnight] proofServerEndpoint is required (walletMode: "provider").',
        );
      }
      if ("prover" in config) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_INVALID_PROVER_CONFIG,
          '[dStorage/midnight] prover is only supported in walletMode: "connector". ' +
            "Provider mode always uses proofServerEndpoint.",
        );
      }
      this._injectedWalletProvider = providerConfig.walletProvider;
      this._injectedPrivateStatePassword = providerConfig.privateStatePassword;
    }

    this.prover =
      walletMode === "connector"
        ? MidnightChainAdapter._resolveProver(config)
        : PROVER_MODE.PROOF_SERVER_URL;

    assertValidLogger(config.logger, "MidnightChainAdapter");
    this.logger = config.logger;
    this.walletMode = walletMode;
    this.connectorName =
      walletMode === "connector"
        ? ((
            config as Extract<
              MidnightChainAdapterConfig,
              { walletMode: "connector" }
            >
          ).connectorName ?? null)
        : null;

    this._contractAddress = config.contractAddress;
    this._zkArtifactsPath =
      walletMode === "provider" && "zkArtifactsPath" in config
        ? (
            config as Extract<
              MidnightChainAdapterConfig,
              { walletMode: "provider" }
            >
          ).zkArtifactsPath
        : undefined;
    if (this._zkArtifactsPath !== undefined && !this._zkArtifactsPath.trim()) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_ZK_ARTIFACTS_PATH_EMPTY,
        "[dStorage/midnight] zkArtifactsPath must not be empty — " +
          "set it to the directory containing keys/ and zkir/ from the compiled DataRegistry contract.",
      );
    }
    this._zkConfigBaseUrl =
      walletMode === "connector" && "zkConfigBaseUrl" in config
        ? (
            config as Extract<
              MidnightChainAdapterConfig,
              { walletMode: "connector" }
            >
          ).zkConfigBaseUrl
        : undefined;
    if (this._zkConfigBaseUrl !== undefined && !this._zkConfigBaseUrl.trim()) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_ZK_CONFIG_BASE_URL_EMPTY,
        "[dStorage/midnight] zkConfigBaseUrl must not be empty — " +
          "set it to the base URL where keys/ and zkir/ are served (e.g. window.location.origin).",
      );
    }

    // No built-in endpoint defaults: only what the caller configured is kept.
    // In connector mode, anything left unset is taken from the wallet's
    // getConfiguration() during init().
    this.config = {
      networkId: config.network,
      ...(config.indexerEndpoint
        ? { indexerHttp: config.indexerEndpoint }
        : {}),
      ...(config.indexerWsEndpoint
        ? { indexerWs: config.indexerWsEndpoint }
        : {}),
      ...(config.nodeEndpoint ? { nodeHttp: config.nodeEndpoint } : {}),
      ...(config.nodeWsEndpoint ? { nodeWs: config.nodeWsEndpoint } : {}),
      ...(config.proofServerEndpoint
        ? { proofServer: config.proofServerEndpoint }
        : {}),
      proofServerMaxRetries: config.proofServerMaxRetries ?? 3,
    };

    if (config.managedPayment) {
      if (!config.managedPayment.authToken?.trim()) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_AUTH_TOKEN_REQUIRED,
          "[dStorage/midnight] authToken is required when signingServerUrl is provided.",
        );
      }
      this.managedPaymentAdapter = new ManagedPaymentAdapter({
        network: "midnight",
        networkId: config.network,
        type: "chain",
        managedPayment: config.managedPayment,
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
      });
    }
  }

  // ── Payment provider wrapping ─────────────────────────────────────────────

  /**
   * If a payment adapter was set, it delegates wallet provider wrapping to
   * the payment adapter, otherwise returns the provider unchanged (no wrapping needed).
   * When the managed payment adaper is set, It wraps the wallet provider's balanceTx()
   * to route transaction balancing through the managed signing server instead of the
   * local wallet. The server receives the hex-serialized UnboundTransaction,
   * balances and signs it, and returns the FinalizedTransaction in the receipt.
   */
  private async _withProofRetry<T>(
    fn: () => Promise<T>,
    label: string,
  ): Promise<T> {
    const maxRetries = this.config.proofServerMaxRetries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (isWalletRejection(err)) break;
        if (attempt < maxRetries - 1) {
          const delayMs = 1_000 * 2 ** attempt; // 1 s, 2 s, 4 s, …
          this.logger?.log(
            "dStorage/midnight",
            `${label} attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delayMs} ms: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          await sleep(delayMs);
        }
      }
    }
    throw lastErr;
  }

  private _wrapPaymentProvider(walletProvider: WalletProvider): WalletProvider {
    if (!this.managedPaymentAdapter) return walletProvider;

    const logger = this.logger;
    return this.managedPaymentAdapter.createMidnightWalletProvider(
      walletProvider.getCoinPublicKey(),
      walletProvider.getEncryptionPublicKey(),
      (receipt) => {
        this._lastPaymentReceipt = receipt;
        logger?.log(
          "dStorage/midnight",
          `balanceTx: received balanced tx from managed payment service (length=${receipt.signedTx?.length ?? 0})`,
        );
      },
    ) as unknown as WalletProvider;
  }

  // ── ZK config provider ─────────────────────────────────────────────────────

  /**
   * Build a mode-specific ZK config provider.
   *
   * Facade (Node.js): reads ZK artifact files from the local filesystem via zkArtifactsPath.
   * Connector (browser): fetches ZK artifacts over HTTP via zkConfigBaseUrl.
   */
  private async _buildZkConfigProvider(): Promise<
    ZKConfigProvider<DataRegistryCircuitKeys>
  > {
    if (this.walletMode === "connector") {
      // Browser mode: fetch ZK artifacts via HTTP from the app's origin or a configured base URL.
      const baseUrl =
        this._zkConfigBaseUrl ??
        (typeof window !== "undefined" ? window.location.origin : "");
      if (!baseUrl) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_ZK_CONFIG_BASE_URL_REQUIRED,
          "[dStorage/midnight] zkConfigBaseUrl is required in connector mode.\n" +
            "  Set it to the base URL where keys/ and zkir/ are served.\n" +
            "  In a Vite app: copy compiled keys/ and zkir/ to public/, then set\n" +
            "    zkConfigBaseUrl: window.location.origin",
        );
      }
      this.logger?.log(
        "dStorage/midnight",
        `ZK artifacts base URL: ${baseUrl}`,
      );
      const { FetchZkConfigProvider } =
        await import("@midnight-ntwrk/midnight-js-fetch-zk-config-provider");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new (FetchZkConfigProvider as any)(
        baseUrl,
        fetch.bind(globalThis),
      );
    }

    // Facade mode: read ZK artifact files from the local filesystem.
    if (!this._zkArtifactsPath) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_ZK_ARTIFACTS_PATH_REQUIRED,
        "[dStorage/midnight] zkArtifactsPath is required in facade mode.\n" +
          "  Set it to the directory containing keys/ and zkir/ from the compiled DataRegistry contract.\n" +
          "  Example: zkArtifactsPath: path.resolve(__dirname, '../packages/chain/src/adapters/midnight/contracts/dataregistry/managed')",
      );
    }
    const zkConfigPath = this._zkArtifactsPath;
    this.logger?.log("dStorage/midnight", `ZK artifacts path: ${zkConfigPath}`);

    // Dynamic import keeps node:fs out of the static import graph so the
    // browser bundle (connector mode) remains free of Node.js built-ins.
    const { existsSync } = await import(/* @vite-ignore */ "node:fs");
    if (!existsSync(zkConfigPath)) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_ZK_ARTIFACTS_PATH_NOT_FOUND,
        `[dStorage/midnight] zkArtifactsPath does not exist: "${zkConfigPath}" — ` +
          "check the path points to the compiled DataRegistry contract artifacts directory.",
      );
    }

    const { NodeZkConfigProvider } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-node-zk-config-provider"
    );
    return new NodeZkConfigProvider<DataRegistryCircuitKeys>(zkConfigPath);
  }

  /**
   * midnight-js-contracts expects privateStateProvider.setContractAddress().
   * Some providers (e.g. in-memory) do not implement it, so we add a no-op shim.
   * Providers that already implement it (e.g. levelPrivateStateProvider) are left
   * untouched — their real implementation must run so the contract address is set
   * before any private state access.
   */
  private _withContractAddressShim<T extends object>(
    privateStateProvider: T,
  ): T & { setContractAddress: (address: string) => void } {
    if (!("setContractAddress" in privateStateProvider)) {
      (privateStateProvider as Record<string, unknown>).setContractAddress = (
        _address: string,
      ) => {
        /* no-op: provider doesn't use contract address for scoping */
      };
    }
    return privateStateProvider as T & {
      setContractAddress: (address: string) => void;
    };
  }

  /**
   * Assemble DataRegistryProviders from mode-specific pieces.
   */
  private async _assembleDataRegistryProviders(params: {
    privateStateProvider: object;
    zkConfigProvider: ZKConfigProvider<DataRegistryCircuitKeys>;
    indexerHttp: string;
    indexerWs: string;
    proofProvider: ProofProvider;
    walletProvider: unknown;
    midnightProvider: unknown;
  }): Promise<DataRegistryProviders> {
    const { indexerPublicDataProvider } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-indexer-public-data-provider"
    );

    return {
      privateStateProvider: this._withContractAddressShim(
        params.privateStateProvider,
      ) as unknown as DataRegistryProviders["privateStateProvider"],
      publicDataProvider: indexerPublicDataProvider(
        params.indexerHttp,
        params.indexerWs,
      ),
      zkConfigProvider: params.zkConfigProvider,
      proofProvider: params.proofProvider,
      walletProvider:
        params.walletProvider as unknown as DataRegistryProviders["walletProvider"],
      midnightProvider:
        params.midnightProvider as unknown as DataRegistryProviders["midnightProvider"],
    };
  }

  /** Build a proof provider that sends proving requests to a proof server over HTTP. */
  private async _buildHttpProofProvider(
    proofServer: string,
    zkConfigProvider: ZKConfigProvider<DataRegistryCircuitKeys>,
  ): Promise<ProofProvider> {
    const { httpClientProofProvider } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-http-client-proof-provider"
    );
    return httpClientProofProvider(proofServer, zkConfigProvider);
  }

  /**
   * Resolve connector-mode endpoints. Configured endpoints take priority; the
   * wallet's (recorded by _applyWalletConfiguration) are only used for the ones
   * left unset. There are no built-in defaults, so a missing value means it was
   * neither configured nor supplied by the wallet — fail loudly rather than use
   * "" as the URL.
   */
  private _resolveConnectorEndpoints(): {
    indexerHttp: string;
    indexerWs: string;
    /** null when the wallet proves itself (PROVER_MODE.WALLET_DELEGATED). */
    proofServer: string | null;
  } {
    const indexerHttp = this.config.indexerHttp ?? this.connectorIndexerHttp;
    const indexerWs = this.config.indexerWs ?? this.connectorIndexerWs;

    if (!indexerHttp) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_INDEXER_HTTP_NOT_SET,
        "[dStorage/midnight] Indexer HTTP endpoint is not set. " +
          "No indexerEndpoint was configured and the wallet's getConfiguration() " +
          "did not return indexerUri. " +
          "Set indexerEndpoint or check that your wallet is configured against the target network.",
      );
    }
    if (!indexerWs) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_INDEXER_WS_NOT_SET,
        "[dStorage/midnight] Indexer WebSocket endpoint is not set. " +
          "No indexerWsEndpoint was configured and the wallet's getConfiguration() " +
          "did not return indexerWsUri. " +
          "Set indexerWsEndpoint or check that your wallet is configured against the target network.",
      );
    }
    if (this.prover === PROVER_MODE.WALLET_DELEGATED) {
      return { indexerHttp, indexerWs, proofServer: null };
    }
    // PROOF_SERVER_URL: proofServerEndpoint is guaranteed by the constructor.
    // WALLET_CONFIGURED_PROOF_SERVER: taken from the wallet's configuration.
    const proofServer = this.config.proofServer ?? this.connectorProofServer;
    if (!proofServer) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_PROOF_SERVER_NOT_SET,
        "[dStorage/midnight] Proof server endpoint is not set. " +
          `The wallet's getConfiguration() did not return a usable proverServerUri (prover: "${this.prover}"). ` +
          "Check the wallet's proof server setting, or set proofServerEndpoint with PROVER_MODE.PROOF_SERVER_URL.",
      );
    }
    return { indexerHttp, indexerWs, proofServer };
  }

  /**
   * Build providers for connector (browser) mode.
   * Uses in-memory private state, FetchZkConfigProvider, and the Lace wallet connector API.
   */
  private async _buildConnectorProviders(): Promise<DataRegistryProviders> {
    if (!this.connectorAPI) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_CONNECTOR_NOT_INITIALIZED,
        "[dStorage/midnight] Connector not initialized. Call await chain.init() first.",
      );
    }

    const zkConfigProvider = await this._buildZkConfigProvider();

    const { createInMemoryPrivateStateProvider } =
      await import("./in-memory-private-state.js");
    const privateStateProvider = createInMemoryPrivateStateProvider();

    // Use browser-safe helpers defined at module level — compact-runtime's toHex/fromHex
    // use Buffer internally and are not safe in the browser.
    const { Transaction } =
      await import("@midnight-ntwrk/midnight-js-protocol/ledger");

    const connectorAPI = this.connectorAPI;
    const logger = this.logger;
    const coinPublicKey = this.connectorCoinPublicKey;
    const encPublicKey = this.connectorEncPublicKey;

    // Both keys are required. An empty or missing coin public key causes
    // computeOwnerCommitment() to receive an empty Uint8Array — ownership-gated
    // operations silently misbehave rather than failing loudly.
    if (!coinPublicKey) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_COIN_PUBLIC_KEY_MISSING,
        "[dStorage/midnight] Coin public key not available from wallet. " +
          "getShieldedAddresses() did not return shieldedCoinPublicKey. " +
          "Check that your Lace wallet is unlocked and connected to the target network.",
      );
    }
    if (!encPublicKey) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_ENC_PUBLIC_KEY_MISSING,
        "[dStorage/midnight] Encryption public key not available from wallet. " +
          "getShieldedAddresses() did not return shieldedEncryptionPublicKey. " +
          "Check that your Lace wallet is unlocked and connected to the target network.",
      );
    }
    const { indexerHttp, indexerWs, proofServer } =
      this._resolveConnectorEndpoints();

    const walletProvider = {
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => encPublicKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      balanceTx: async (tx: any, _ttl?: Date): Promise<any> => {
        const serializedTx = uint8ArrayToHex(tx.serialize());
        logger?.log(
          "dStorage/midnight",
          `balanceTx: serialized tx length=${serializedTx.length}`,
        );
        let received: { tx: string };
        try {
          received =
            await connectorAPI.balanceUnsealedTransaction(serializedTx);
        } catch (err) {
          throw new DStorageError(
            ChainErrorCode.MIDNIGHT_BALANCE_TX_FAILED,
            `[dStorage/midnight] Wallet failed to balance the transaction: ${describeConnectorError(err)}`,
            { cause: err },
          );
        }
        const balancedHex = received.tx;
        logger?.log(
          "dStorage/midnight",
          `balanceTx: received balanced tx length=${balancedHex?.length}`,
        );
        // Transaction.deserialize takes (sigType, proofType, bindingType, bytes) — see ledger-v8 API.
        return Transaction.deserialize(
          "signature",
          "proof",
          "binding",
          hexToBytes(balancedHex, "balancedHex"),
        );
      },
    };

    const midnightProvider = {
      submitTx: async (tx: FinalizedTransaction): Promise<string> => {
        const serializedTx = uint8ArrayToHex(tx.serialize());
        logger?.log(
          "dStorage/midnight",
          `submitTx: submitting tx length=${serializedTx.length}`,
        );
        try {
          await connectorAPI.submitTransaction(serializedTx);
        } catch (err) {
          throw new DStorageError(
            ChainErrorCode.MIDNIGHT_SUBMIT_TX_FAILED,
            `[dStorage/midnight] Wallet failed to submit the transaction: ${describeConnectorError(err)}`,
            { cause: err },
          );
        }
        return tx.identifiers()[0] ?? "";
      },
    };

    const proofProvider =
      proofServer === null
        ? await this._buildWalletProofProvider(connectorAPI, zkConfigProvider)
        : await this._buildHttpProofProvider(proofServer, zkConfigProvider);

    return this._assembleDataRegistryProviders({
      privateStateProvider,
      zkConfigProvider,
      indexerHttp,
      indexerWs,
      proofProvider,
      walletProvider: this._wrapPaymentProvider(walletProvider),
      midnightProvider,
    });
  }

  /**
   * Build a proof provider that delegates proving to the connected wallet
   * (PROVER_MODE.WALLET_DELEGATED). The wallet fetches circuit keys and ZKIR
   * through the ZK config provider, so zkConfigBaseUrl is still required.
   */
  private async _buildWalletProofProvider(
    connectorAPI: ConnectedAPI,
    zkConfigProvider: ZKConfigProvider<DataRegistryCircuitKeys>,
  ): Promise<ProofProvider> {
    let walletProving: ProvingProvider;
    try {
      walletProving = await connectorAPI.getProvingProvider(
        zkConfigProvider.asKeyMaterialProvider(),
      );
    } catch (err) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_WALLET_PROVING_FAILED,
        `[dStorage/midnight] Wallet did not provide a proving provider (prover: "${this.prover}"): ` +
          describeConnectorError(err),
        { cause: err },
      );
    }
    this.logger?.log(
      "dStorage/midnight",
      "Using the wallet's proving provider (proving delegated to the wallet).",
    );

    const wrap =
      <A extends unknown[], R>(op: string, fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        try {
          return await fn(...args);
        } catch (err) {
          throw new DStorageError(
            ChainErrorCode.MIDNIGHT_WALLET_PROVING_FAILED,
            `[dStorage/midnight] Wallet failed to ${op}: ${describeConnectorError(err)}`,
            { cause: err },
          );
        }
      };
    const provingProvider: ProvingProvider = {
      check: wrap("check the proof preimage", (preimage, keyLocation) =>
        walletProving.check(preimage, keyLocation),
      ),
      prove: wrap(
        "generate the proof",
        (
          preimage: Uint8Array,
          keyLocation: string,
          overwriteBindingInput?: bigint,
        ) => walletProving.prove(preimage, keyLocation, overwriteBindingInput),
      ),
    };

    const { createProofProvider } =
      await import("@midnight-ntwrk/midnight-js-types");
    return createProofProvider(provingProvider);
  }

  /**
   * Build DataRegistryProviders using a pre-built, already-started wallet provider.
   * The caller is responsible for wallet construction, sync, and fund-waiting before
   * passing the provider to the adapter via walletMode: "provider".
   */
  private async _buildWalletProviderMode(): Promise<DataRegistryProviders> {
    const walletProvider = this._injectedWalletProvider!;
    const walletFacade: WalletFacade = walletProvider.wallet;

    const zkConfigProvider = await this._buildZkConfigProvider();

    const { firstValueFrom } = await import("rxjs");
    const facadeState = await firstValueFrom(walletFacade.state());
    const { ShieldedAddress, UnshieldedAddress, DustAddress } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/wallet-sdk/address-format"
    );
    const { getNetworkId } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-network-id"
    );
    this.addresses = {
      shielded: ShieldedAddress.codec
        .encode(getNetworkId(), facadeState.shielded.address)
        .toString(),
      unshielded: UnshieldedAddress.codec
        .encode(getNetworkId(), facadeState.unshielded.address)
        .toString(),
      dust: DustAddress.codec
        .encode(getNetworkId(), facadeState.dust.address)
        .toString(),
    };

    const privateStateStoreName = "data-registry-private-state";
    const { levelPrivateStateProvider } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-level-private-state-provider"
    );
    const basePrivateStateProvider = levelPrivateStateProvider({
      privateStateStoreName,
      signingKeyStoreName: `${privateStateStoreName}-signing-keys`,
      privateStoragePasswordProvider: () => this._injectedPrivateStatePassword!,
      accountId: this.addresses!.unshielded,
    });
    const providers = await this._assembleDataRegistryProviders({
      privateStateProvider: basePrivateStateProvider,
      zkConfigProvider,
      // Guaranteed by the provider-mode constructor checks.
      indexerHttp: this.config.indexerHttp!,
      indexerWs: this.config.indexerWs!,
      proofProvider: await this._buildHttpProofProvider(
        this.config.proofServer!,
        zkConfigProvider,
      ),
      walletProvider: this._wrapPaymentProvider(walletProvider),
      midnightProvider: walletProvider,
    });

    this.facade = walletFacade;
    return providers;
  }

  /**
   * Lazily initialize and return the DataRegistryAPI.
   * Joins the existing contract at the configured address.
   * Throws if no address is configured and no deployment has occurred.
   */
  private async _getAPI(): Promise<DataRegistryAPI> {
    if (this._api) return this._api;

    // Guard: must call init() before any operation that needs the API.
    if (!this._initialized) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_NOT_INITIALIZED,
        "[dStorage/midnight] Not initialized. Call await chain.init() first.",
      );
    }

    let providers;
    if (this.walletMode === "connector") {
      providers = await this._buildConnectorProviders();
    } else {
      providers = await this._buildWalletProviderMode();
    }

    const { DataRegistryAPI } = await import("./contract-api.js");
    if (!this._contractAddress) {
      // Deploying/writing costs DUST fees. A zero or low balance is the most
      // common cause of an opaque balanceTx failure from the wallet, so log it
      // up front rather than leaving the user to guess after a cryptic error.
      if (this.walletMode === "connector" && this.connectorAPI) {
        try {
          const { balance, cap } = await this.connectorAPI.getDustBalance();
          this.logger?.log(
            "dStorage/midnight",
            `Wallet DUST balance: ${balance} (cap: ${cap})`,
          );
          if (balance <= 0n) {
            this.logger?.warn(
              "dStorage/midnight",
              "Wallet DUST balance is 0 — the deploy transaction will likely " +
                "fail to balance. Delegate NIGHT in your wallet and wait for " +
                "DUST to accumulate before retrying.",
            );
          }
        } catch (err) {
          this.logger?.debug?.(
            "dStorage/midnight",
            `Could not read DUST balance before deploy: ${describeConnectorError(err)}`,
          );
        }
      }
      this.logger?.log("dStorage/midnight", "Deploying DataRegistry contract…");
      this._api = await DataRegistryAPI.deploy(providers, this.logger);
      this._contractAddress = this._api.deployedContractAddress;
      this.logger?.log(
        "dStorage/midnight",
        `DataRegistry deployed at: ${this._contractAddress}`,
      );
    } else {
      this._api = await DataRegistryAPI.join(
        providers,
        this._contractAddress,
        this.logger,
      );
      this.logger?.log(
        "dStorage/midnight",
        `DataRegistry joined at: ${this._contractAddress}`,
      );
    }

    return this._api;
  }

  // ── Contract address management ────────────────────────────────────────────

  /** Midnight contract addresses are 32 bytes encoded as 64 lowercase hex chars. */
  private static _validateContractAddress(address: string): void {
    if (!/^[0-9a-f]{64}$/.test(address)) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_INVALID_CONTRACT_ADDRESS,
        `[dStorage/midnight] Invalid contract address "${address}". ` +
          "Expected a 64-character lowercase hex string (32 bytes).",
      );
    }
  }

  /**
   * Validate the connector-mode prover settings and return the prover mode.
   * PROOF_SERVER_URL requires proofServerEndpoint; the wallet modes forbid it,
   * so the proof source is never ambiguous.
   */
  private static _resolveProver(
    config: MidnightChainAdapterConfig,
  ): ProverMode {
    if ("allowWalletProofServer" in config) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_INVALID_PROVER_CONFIG,
        "[dStorage/midnight] allowWalletProofServer has been removed. " +
          "Use prover: PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER to use the wallet's proof server.",
      );
    }
    const prover =
      ("prover" in config ? config.prover : undefined) ??
      PROVER_MODE.PROOF_SERVER_URL;
    if (!(Object.values(PROVER_MODE) as string[]).includes(prover)) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_INVALID_PROVER_CONFIG,
        `[dStorage/midnight] Unknown prover "${String(prover)}". ` +
          `Expected one of: ${Object.values(PROVER_MODE).join(", ")}.`,
      );
    }
    if (prover === PROVER_MODE.PROOF_SERVER_URL) {
      if (!config.proofServerEndpoint) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_PROOF_SERVER_NOT_SET,
          `[dStorage/midnight] proofServerEndpoint is required (prover: "${prover}"). ` +
            "Set it, or choose PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER or " +
            "PROVER_MODE.WALLET_DELEGATED to let the wallet supply proving.",
        );
      }
    } else if (config.proofServerEndpoint) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_INVALID_PROVER_CONFIG,
        `[dStorage/midnight] proofServerEndpoint must not be set with prover: "${prover}". ` +
          "Remove it, or use PROVER_MODE.PROOF_SERVER_URL to prove with that endpoint.",
      );
    }
    return prover;
  }

  /**
   * Set the contract address to use for subsequent operations.
   * Resets the cached DataRegistryAPI so the next call re-joins at the new address.
   */
  setContractAddress(address: string): void {
    MidnightChainAdapter._validateContractAddress(address);
    this._contractAddress = address;
    this._api = null;
  }

  /**
   * Get the contract address
   */
  getContractAddress(): string {
    return this._contractAddress ?? "";
  }

  /**
   * List references currently stored in the joined/deployed DataRegistry contract.
   * For Arweave references, storageId is the original txId string.
   * For other providers, storageId is the hex of the stored Bytes<32>.
   */
  async listReferences(): Promise<DataReferenceSummary[]> {
    const api = await this._getAPI();

    const { firstValueFrom } = await import("rxjs");
    const state = await firstValueFrom(api.state$);

    return Array.from(state.references.entries())
      .map(([refId, entry]) => ({
        refId,
        storageId: entry.storageId,
        storageProvider: entry.storageProvider,
        encryptionScheme: (entry.encryptionScheme ||
          null) as EncryptionScheme | null,
        ownerCommitment: uint8ArrayToHex(entry.ownerCommitment),
        keyEnvelope: entry.keyEnvelope ?? "",
        ...(entry.metadata ? { encryptedMetadata: entry.metadata } : {}),
      }))
      .sort((a, b) => a.refId.localeCompare(b.refId));
  }

  /**
   * Look up a single reference by its refId.
   * Returns { storageId, storageProvider } with the storageId decoded to the
   * original storage network identifier (e.g. Arweave txId), or null if not found.
   */
  async readReference(refId: string): Promise<ChainReference> {
    const api = await this._getAPI();

    const { firstValueFrom } = await import("rxjs");
    const state = await firstValueFrom(api.state$);

    const refEntry = state.references.get(refId);
    if (!refEntry) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
        `[dStorage/midnight] No reference found for refId: ${refId}`,
      );
    }

    const contentHashBytes = refEntry.contentHash as Uint8Array | undefined;
    const hasContentHash =
      contentHashBytes !== undefined && contentHashBytes.some((b) => b !== 0);

    return {
      storageId: refEntry.storageId,
      encryptionScheme: refEntry.encryptionScheme as EncryptionScheme,
      storageProvider: refEntry.storageProvider,
      ...(refEntry.metadata ? { encryptedMetadata: refEntry.metadata } : {}),
      writtenAt: Number(refEntry.writtenAt),
      keyEnvelope: refEntry.keyEnvelope ?? "",
      ...(hasContentHash
        ? { contentHash: uint8ArrayToHex(contentHashBytes!) }
        : {}),
    };
  }

  // ── ChainAdapter implementation ────────────────────────────────────────────

  async estimateCost(): Promise<ChainQuote> {
    /**
     * TODO: Replace with real Midnight fee estimation.
     */
    const amount = "0.1000";

    return {
      token: "DUST",
      amount,
      network: this.name,
      expiresAt: Date.now() + 120_000,
    };
  }

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    this.logger?.log(
      "dStorage/midnight",
      `writeReference() called — storageId: ${ref.storageId}, provider: ${ref.storageProvider}`,
    );
    try {
      const api = await this._getAPI();
      this.logger?.log(
        "dStorage/midnight",
        `Storing reference for storageId: ${ref.storageId}`,
      );
      if (!ref.keyEnvelope) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_KEYENVELOPE_REQUIRED,
          "[dStorage] keyEnvelope is required for all references",
        );
      }
      if (!ref.ownerSecret) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_OWNER_SECRET_REQUIRED_WRITE,
          "[dStorage/midnight] ownerSecret is required for writeReference. " +
            "The core SDK must derive ownerSecret = HKDF(dek, rawStorageId) before calling writeReference.",
        );
      }
      const ownerSecret = ref.ownerSecret;
      const contentHashBytes = ref.contentHash
        ? hexToBytes(ref.contentHash, "contentHash")
        : new Uint8Array(32);
      const { refId, blockHeight } = await this._withProofRetry(
        () =>
          api.storeReference(
            ref.storageId ?? "",
            ref.encryptionScheme ?? "",
            ref.storageProvider,
            ref.encryptedMetadata ?? "",
            BigInt(ref.writtenAt),
            ref.keyEnvelope ?? "",
            contentHashBytes,
            ownerSecret,
          ),
        "storeReference",
      );
      const refIdHex = uint8ArrayToHex(refId);

      this.logger?.log(
        "dStorage/midnight",
        `Reference written at block ${blockHeight} → refId: ${refIdHex}`,
      );

      const paymentReceipt = this._lastPaymentReceipt;
      this._lastPaymentReceipt = undefined;
      return {
        refId: refIdHex,
        provider: this.name,
        blockHeight,
        writtenAt: ref.writtenAt,
        ...(paymentReceipt ? { paymentReceipt } : {}),
      };
    } catch (err) {
      this.logger?.error(
        "dStorage/midnight",
        `writeReference() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  async removeReference(
    refId: string,
    ownerSecret?: Uint8Array,
  ): Promise<void> {
    this.logger?.log(
      "dStorage/midnight",
      `removeReference() called — refId: ${refId}`,
    );
    if (!ownerSecret) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_OWNER_SECRET_REQUIRED_REMOVE,
        "[dStorage/midnight] ownerSecret is required for removeReference. " +
          "The core SDK must derive ownerSecret = HKDF(dek, rawStorageId) before calling removeReference.",
      );
    }
    const secret = ownerSecret;
    try {
      const api = await this._getAPI();
      const refIdBytes = hexToBytes(refId, "refId");
      await this._withProofRetry(
        () => api.removeReference(refIdBytes, secret),
        "removeReference",
      );
      this.logger?.log(
        "dStorage/midnight",
        `Reference removed → refId: ${refId}`,
      );
    } catch (err) {
      this.logger?.error(
        "dStorage/midnight",
        `removeReference() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Update the mutable fields of an existing reference.
   *
   * `update.storageId` is stored verbatim on-chain without format validation. Passing a
   * malformed storageId permanently bricks the reference (silent decryption failure on read).
   * Validate the format against the storage provider before calling this method.
   */
  async updateReference(
    refId: string,
    update: ChainReferenceUpdate,
    ownerSecret?: Uint8Array,
    newOwnerSecret?: Uint8Array,
  ): Promise<void> {
    this.logger?.log(
      "dStorage/midnight",
      `updateReference() called — refId: ${refId}`,
    );
    if (!ownerSecret) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_OWNER_SECRET_REQUIRED_UPDATE,
        "[dStorage/midnight] ownerSecret is required for updateReference. " +
          "The core SDK must derive ownerSecret = HKDF(dek, rawStorageId) before calling updateReference.",
      );
    }
    const secret = ownerSecret;
    try {
      const api = await this._getAPI();
      const refIdBytes = hexToBytes(refId, "refId");
      const contentHashBytes = update.contentHash
        ? hexToBytes(update.contentHash, "contentHash")
        : new Uint8Array(32);
      await this._withProofRetry(
        () =>
          api.updateReference(
            refIdBytes,
            update.storageId,
            update.encryptionScheme,
            update.storageProvider,
            update.encryptedMetadata ?? "",
            BigInt(update.writtenAt),
            update.keyEnvelope ?? "",
            contentHashBytes,
            secret,
            newOwnerSecret,
          ),
        "updateReference",
      );
      this.logger?.log(
        "dStorage/midnight",
        `Reference updated → refId: ${refId}`,
      );
    } catch (err) {
      this.logger?.error(
        "dStorage/midnight",
        `updateReference() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  // ── DataRegistry deployment ────────────────────────────────────────────────

  // ── Wallet lifecycle ───────────────────────────────────────────────────────

  /**
   * Initialize the wallet.
   * Branches based on wallet mode:
   *   - 'facade': derive keys, build WalletFacade, wait for sync (Node.js CLI)
   *   - 'connector': connect to browser wallet extension, extract addresses (browser dApp)
   *
   * Must be called before write operations or getBalances().
   * All Midnight wallet SDK imports are dynamic to avoid hard build-time failures.
   */
  async init(): Promise<string> {
    this._initialized = true;

    // Set global network ID (required by Midnight JS SDK).
    // No /* @vite-ignore */ — midnight-js-network-id is browser-compatible.
    const { setNetworkId } =
      await import("@midnight-ntwrk/midnight-js-network-id");
    setNetworkId(this.config.networkId);

    // Connector mode: connect to Lace wallet first so connectorAPI is available
    // before _getAPI() tries to build providers.
    if (this.walletMode === "connector") {
      await this._initConnector();
    }

    await this._getAPI();

    return this._contractAddress ?? "";
  }

  /**
   * Record the endpoints supplied by the connected wallet. They are only used
   * for endpoints not set in the adapter config (see _buildConnectorProviders).
   * Throws if the wallet is on a different network than the configured one.
   */
  private _applyWalletConfiguration(walletConfig: WalletConfiguration): void {
    if (
      walletConfig.networkId &&
      walletConfig.networkId !== this.config.networkId
    ) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_NETWORK_MISMATCH,
        `[dStorage/midnight] Wallet is connected to network "${walletConfig.networkId}" ` +
          `but the adapter is configured for "${this.config.networkId}".`,
      );
    }

    const preferConfigured = (
      label: string,
      configured: string | undefined,
      fromWallet: string | undefined,
    ) => {
      if (configured && fromWallet && configured !== fromWallet) {
        this.logger?.log(
          "dStorage/midnight",
          `Using configured ${label} "${configured}" instead of the wallet's "${fromWallet}".`,
        );
      }
    };

    preferConfigured(
      "indexerEndpoint",
      this.config.indexerHttp,
      walletConfig.indexerUri,
    );
    preferConfigured(
      "indexerWsEndpoint",
      this.config.indexerWs,
      walletConfig.indexerWsUri,
    );
    this.connectorIndexerHttp = walletConfig.indexerUri || null;
    this.connectorIndexerWs = walletConfig.indexerWsUri || null;

    const walletProofServer = walletConfig.proverServerUri;
    if (!walletProofServer) return;
    if (this.prover === PROVER_MODE.PROOF_SERVER_URL) {
      preferConfigured(
        "proofServerEndpoint",
        this.config.proofServer,
        walletProofServer,
      );
    } else if (this.prover === PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER) {
      if (!isHttpOrHttps(walletProofServer)) {
        this.logger?.warn(
          "dStorage/midnight",
          `Wallet-supplied proverServerUri has an invalid URL scheme — must be http or https. Ignoring it.`,
        );
        return;
      }
      this.logger?.warn(
        "dStorage/midnight",
        `Using wallet-supplied proof server "${walletProofServer}" (prover: "${this.prover}"). ` +
          `Ensure this endpoint is trusted — a compromised wallet can redirect ZK witness inputs to an attacker-controlled server.`,
      );
      this.connectorProofServer = walletProofServer;
    }
    // WALLET_DELEGATED: the wallet proves itself; its proverServerUri is not used here.
  }

  /**
   * Initialize in connector mode: connect to browser wallet extension.
   *
   * Discovers available wallets by enumerating window.midnight, as per the
   * dApp connector spec: https://docs.midnight.network/api-reference/dapp-connector
   */
  private async _initConnector(): Promise<WalletAddresses> {
    const windowObj =
      typeof window !== "undefined"
        ? (window as unknown as Record<string, unknown>)
        : null;
    const midnightObj = windowObj?.midnight;

    if (!midnightObj || typeof midnightObj !== "object") {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_WALLET_NOT_FOUND,
        "[dStorage/midnight] window.midnight is not available.\n" +
          "  No Midnight wallet extension detected. Install Midnight Lace or another compatible wallet.",
      );
    }

    // Discover all wallets injected at window.midnight.{walletId}
    const availableWallets = Object.entries(midnightObj)
      .filter(
        ([, v]) =>
          v &&
          typeof v === "object" &&
          typeof (v as Record<string, unknown>).connect === "function",
      )
      .map(([id, v]) => ({
        id,
        wallet: v as Partial<Omit<InitialAPI, "connect">> &
          Pick<InitialAPI, "connect">,
      }));

    if (availableWallets.length === 0) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_NO_WALLETS_FOUND,
        "[dStorage/midnight] No compatible wallets found at window.midnight.\n" +
          "  Install a Midnight-compatible wallet extension (e.g., Midnight Lace).",
      );
    }

    this.logger?.log(
      "dStorage/midnight",
      `Found ${availableWallets.length} wallet(s): ${availableWallets
        .map(
          (w) =>
            `${w.id} (name: ${w.wallet.name ?? "unknown"}, rdns: ${w.wallet.rdns ?? "unknown"})`,
        )
        .join(", ")}`,
    );

    // Select the wallet: prefer the configured connectorName, matched — in order
    // of reliability — against the wallet's `rdns` (the spec-recommended stable
    // identifier, e.g. 'io.lace.wallet'), then its declared `name`, then the
    // injected window.midnight key. Falls back to the first available wallet.
    let selected = availableWallets[0]!;
    if (this.connectorName) {
      const connectorFound =
        availableWallets.find((w) => w.wallet.rdns === this.connectorName) ??
        availableWallets.find((w) => w.wallet.name === this.connectorName) ??
        availableWallets.find((w) => w.id === this.connectorName);
      if (connectorFound) {
        selected = connectorFound;
      } else {
        this.logger?.warn(
          "dStorage/midnight",
          `Configured wallet "${this.connectorName}" not found. Using first available: "${selected.id}"`,
        );
      }
    }

    this.logger?.log(
      "dStorage/midnight",
      `Connecting to wallet "${selected.id}" (name: ${selected.wallet.name ?? "unknown"}, rdns: ${selected.wallet.rdns ?? "unknown"}, apiVersion: ${selected.wallet.apiVersion ?? "unknown"}) on network "${this.config.networkId}"...`,
    );

    // Step 1: Connect to the wallet extension
    let connectedAPI: ConnectedAPI;
    try {
      connectedAPI = await selected.wallet.connect(this.config.networkId);
      this.connectorAPI = connectedAPI;
    } catch (err) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_WALLET_CONNECT_FAILED,
        `[dStorage/midnight] Failed to connect to wallet "${selected.id}": ` +
          describeConnectorError(err),
        { cause: err },
      );
    }

    this.logger?.log(
      "dStorage/midnight",
      `✓ Connected to wallet "${selected.id}"`,
    );

    // Step 2: Retrieve wallet configuration. Endpoints explicitly set in the
    // adapter config take priority; the wallet's fill in only what is unset.
    let walletConfig: WalletConfiguration | undefined;
    try {
      walletConfig = await connectedAPI.getConfiguration();
      this.logger?.debug?.(
        "dStorage/midnight",
        `Wallet configuration: ${JSON.stringify(walletConfig)}`,
      );
    } catch (err) {
      this.logger?.warn(
        "dStorage/midnight",
        `getConfiguration() failed — only endpoints set in the adapter config will be used: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (walletConfig) {
      this._applyWalletConfiguration(walletConfig);
    }

    // Step 3: Extract addresses from connector
    try {
      let shieldedAddr = "";
      try {
        const r = await connectedAPI.getShieldedAddresses();
        shieldedAddr = r.shieldedAddress;
        this.connectorCoinPublicKey = r.shieldedCoinPublicKey;
        this.connectorEncPublicKey = r.shieldedEncryptionPublicKey;
      } catch (err) {
        this.logger?.warn(
          "dStorage/midnight",
          `getShieldedAddresses() failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let unshieldedAddr = "";
      try {
        const r = await connectedAPI.getUnshieldedAddress();
        unshieldedAddr = r.unshieldedAddress;
      } catch {
        this.logger?.warn(
          "dStorage/midnight",
          "Could not retrieve unshielded address",
        );
      }

      let dustAddr = "";
      try {
        const r = await connectedAPI.getDustAddress();
        dustAddr = r.dustAddress;
      } catch {
        this.logger?.warn(
          "dStorage/midnight",
          "Could not retrieve dust address",
        );
      }

      if (!shieldedAddr && !unshieldedAddr && !dustAddr) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_NO_ADDRESSES,
          "[dStorage/midnight] No addresses available from wallet",
        );
      }

      this.addresses = {
        shielded: shieldedAddr,
        unshielded: unshieldedAddr,
        dust: dustAddr,
      };

      this.logger?.log(
        "dStorage/midnight",
        `Wallet addresses: shielded=${shieldedAddr ? `${shieldedAddr.slice(0, 20)}…` : "(none)"} unshielded=${unshieldedAddr ? `${unshieldedAddr.slice(0, 20)}…` : "(none)"} dust=${dustAddr ? `${dustAddr.slice(0, 20)}…` : "(none)"}`,
      );
      return this.addresses;
    } catch (err) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_EXTRACT_ADDRESSES_FAILED,
        `[dStorage/midnight] Failed to extract addresses from wallet: ` +
          (err instanceof Error ? err.message : String(err)),
        { cause: err },
      );
    }
  }

  /**
   * Return wallet addresses derived during init().
   * Throws if init() not yet called.
   */
  getAddresses(): WalletAddresses {
    if (!this.addresses) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_GET_ADDRESSES_NOT_INITIALIZED,
        "[dStorage/midnight] getAddresses() called before init().",
      );
    }
    return this.addresses;
  }

  /**
   * Read NIGHT and DUST balances.
   */
  async getBalances(): Promise<WalletBalances> {
    const { unshieldedToken } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-protocol/ledger"
    );
    if (this.walletMode === "provider") {
      if (!this.facade) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_GET_BALANCES_NOT_INITIALIZED,
          "[dStorage/midnight] getBalances() called before init().",
        );
      }

      const state = await waitForFacadeSync(this.facade);
      const nightToken = unshieldedToken();

      return {
        night: state.unshielded.balances[nightToken.raw] ?? 0n,
        dust: state.dust.balance(new Date()),
      };
    } else {
      if (!this.connectorAPI) {
        throw new DStorageError(
          ChainErrorCode.MIDNIGHT_GET_BALANCES_NOT_INITIALIZED,
          "[dStorage/midnight] getBalances() called before init().",
        );
      }
      const unshieldedBalances =
        await this.connectorAPI.getUnshieldedBalances();
      const dustBalance = await this.connectorAPI.getDustBalance();
      return {
        night: unshieldedBalances[unshieldedToken().raw] ?? 0n,
        dust: dustBalance.balance,
      };
    }
  }
}
