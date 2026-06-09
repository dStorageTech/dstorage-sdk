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
 *   2. Prove  — send to proof server for ZK proof generation
 *   3. Balance — attach DUST fees via the connected wallet
 *   4. Submit — broadcast to the Midnight node
 *   5. Confirm — wait for block inclusion
 *
 * Docs: https://docs.midnight.network/develop/tutorial/building-a-dapp
 */

import { ManagedPaymentAdapter } from "@dstorage/payment";
import type { PaymentReceipt } from "@dstorage/payment";
import { hexToBytes } from "@dstorage/crypto";
import { type WalletProvider } from "@midnight-ntwrk/midnight-js-types";

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

import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import type { DataRegistryAPI } from "./contract-api.js";
import type { DataRegistryProviders } from "./common-types.js";
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import type { AdapterWalletProvider } from "./common-types.js";
import { NetworkId } from "@midnight-ntwrk/midnight-js-network-id";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Public types ──────────────────────────────────────────────────────────────

export interface WalletAddresses {
  unshielded: string;
  shielded: string;
  dust: string;
}

// ── Network default endpoints ──────────────────────────────────────────────────
type SUPPORTED_NETWORKS = {
  [K in "preprod" | "undeployed"]: EnvironmentConfiguration;
};
export const NETWORKS: SUPPORTED_NETWORKS = {
  preprod: {
    networkId: "preprod",
    nodeHttp: "https://rpc.preprod.midnight.network",
    nodeWs: "wss://rpc.preprod.midnight.network",
    indexerHttp: "https://indexer.preprod.midnight.network/api/v3/graphql",
    indexerWs: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
    proofServer: "http://127.0.0.1:6300",
  },
  undeployed: {
    networkId: "undeployed",
    nodeHttp: "http://127.0.0.1:9944",
    nodeWs: "ws://127.0.0.1:9944",
    indexerHttp: "http://127.0.0.1:8088/api/v3/graphql",
    indexerWs: "ws://127.0.0.1:8088/api/v3/graphql/ws",
    proofServer: "http://127.0.0.1:6300",
  },
} as const;

/** Internal environment configuration passed to wallet SDK providers. */
interface EnvironmentConfiguration {
  networkId: string;
  nodeHttp: string;
  nodeWs: string;
  indexerHttp: string;
  indexerWs: string;
  proofServer: string;
  proofServerMaxRetries?: number;
}

// ── Config ─────────────────────────────────────────────────────────────────────

interface BaseConfig {
  /**
   * Midnight node RPC endpoint.
   */
  nodeEndpoint?: string;
  nodeWsEndpoint?: string;
  /**
   * Optional logger for SDK operational output.
   * Pass `logger: console` to see all output, or inject your own logger.
   * Omit to suppress all SDK log output.
   */
  logger?: ChainAdapterLogger;
  /**
   * Midnight indexer HTTP (GraphQL) endpoint for state queries.
   */
  indexerEndpoint?: string;
  /**
   * Midnight indexer WebSocket endpoint for real-time subscriptions.
   */
  indexerWsEndpoint?: string;
  /**
   * Proof server URL.
   */
  proofServerEndpoint: string;
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
   */
  network: NetworkId;
  /**
   * Base URL of the dStorage managed payment signing server (no trailing slash).
   * When provided, transaction balancing is delegated to the server instead of
   * the local wallet.
   */
  signingServerUrl?: string;
  /**
   * Bearer token sent as the `Authorization` header to authenticate with the signing server.
   * Required when `signingServerUrl` is provided.
   */
  authToken?: string; // validated at construction: required when signingServerUrl is set
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
         * Wallet connector name. Default: 'mnLace' (Midnight Lace).
         * Example: window.midnight.mnLace
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
      }
  );

// ── Browser-safe byte/encoding helpers ────────────────────────────────────────

/** Convert a Uint8Array to a lowercase hex string (browser-safe, no Buffer). */
function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class MidnightChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = "midnight";
  readonly providerName: string = "Midnight";
  readonly managedPaymentAdapter: ManagedPaymentAdapter | null = null;

  _lastPaymentReceipt: PaymentReceipt | undefined;

  private facade: unknown | null = null;
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

  private readonly config: EnvironmentConfiguration;

  constructor(config: MidnightChainAdapterConfig) {
    if (config.contractAddress !== undefined) {
      MidnightChainAdapter._validateContractAddress(config.contractAddress);
    }
    if (!config.network) {
      throw new Error("[dStorage/midnight] network is required.");
    }

    // Determine wallet mode and validate required fields
    const walletMode = config.walletMode;
    if (walletMode === "provider") {
      const providerConfig = config as Extract<
        MidnightChainAdapterConfig,
        { walletMode: "provider" }
      >;
      if (!providerConfig.walletProvider) {
        throw new Error(
          '[dStorage/midnight] walletProvider is required (walletMode: "provider").',
        );
      }
      if (!providerConfig.privateStatePassword) {
        throw new Error(
          '[dStorage/midnight] privateStatePassword is required (walletMode: "provider").',
        );
      }
      this._injectedWalletProvider = providerConfig.walletProvider;
      this._injectedPrivateStatePassword = providerConfig.privateStatePassword;
    }

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
      throw new Error(
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
      throw new Error(
        "[dStorage/midnight] zkConfigBaseUrl must not be empty — " +
          "set it to the base URL where keys/ and zkir/ are served (e.g. window.location.origin).",
      );
    }

    const networkDefaults = NETWORKS[config.network as keyof typeof NETWORKS];
    if (
      !networkDefaults &&
      (config.indexerEndpoint === undefined ||
        config.indexerWsEndpoint === undefined ||
        config.nodeEndpoint === undefined ||
        config.nodeWsEndpoint === undefined ||
        config.proofServerEndpoint === undefined)
    ) {
      throw new Error(
        `Unsupported network: "${config.network}". Supported networks: ${Object.keys(NETWORKS).join(", ")}. ` +
          `For custom networks, provide all endpoint options explicitly.`,
      );
    }
    this.config = {
      networkId: config.network,
      indexerHttp: config.indexerEndpoint ?? networkDefaults.indexerHttp,
      indexerWs: config.indexerWsEndpoint ?? networkDefaults.indexerWs,
      nodeHttp: config.nodeEndpoint ?? networkDefaults.nodeHttp,
      nodeWs: config.nodeWsEndpoint ?? networkDefaults.nodeWs,
      proofServer: config.proofServerEndpoint ?? networkDefaults.proofServer,
      proofServerMaxRetries: config.proofServerMaxRetries ?? 3,
    };

    if (config.signingServerUrl) {
      if (!config.authToken?.trim()) {
        throw new Error(
          "[dStorage/midnight] authToken is required when signingServerUrl is provided.",
        );
      }
      this.managedPaymentAdapter = new ManagedPaymentAdapter({
        network: "midnight",
        type: "chain",
        signingServerUrl: config.signingServerUrl,
        authToken: config.authToken,
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
  private async _buildZkConfigProvider(): Promise<any> {
    if (this.walletMode === "connector") {
      // Browser mode: fetch ZK artifacts via HTTP from the app's origin or a configured base URL.
      const baseUrl =
        this._zkConfigBaseUrl ??
        (typeof window !== "undefined" ? window.location.origin : "");
      if (!baseUrl) {
        throw new Error(
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
      throw new Error(
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
      throw new Error(
        `[dStorage/midnight] zkArtifactsPath does not exist: "${zkConfigPath}" — ` +
          "check the path points to the compiled DataRegistry contract artifacts directory.",
      );
    }

    const { NodeZkConfigProvider } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-node-zk-config-provider"
    );
    return new NodeZkConfigProvider(zkConfigPath);
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
      (privateStateProvider as any).setContractAddress = (_address: string) => {
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
    zkConfigProvider: unknown;
    indexerHttp: string;
    indexerWs: string;
    proofServer: string;
    walletProvider: unknown;
    midnightProvider: unknown;
  }): Promise<DataRegistryProviders> {
    const { indexerPublicDataProvider } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-indexer-public-data-provider"
    );
    const { httpClientProofProvider } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-http-client-proof-provider"
    );

    return {
      privateStateProvider: this._withContractAddressShim(
        params.privateStateProvider,
      ) as unknown as DataRegistryProviders["privateStateProvider"],
      publicDataProvider: indexerPublicDataProvider(
        params.indexerHttp,
        params.indexerWs,
      ),
      zkConfigProvider:
        params.zkConfigProvider as DataRegistryProviders["zkConfigProvider"],
      proofProvider: httpClientProofProvider(
        params.proofServer,
        params.zkConfigProvider as any,
      ),
      walletProvider:
        params.walletProvider as unknown as DataRegistryProviders["walletProvider"],
      midnightProvider:
        params.midnightProvider as unknown as DataRegistryProviders["midnightProvider"],
    };
  }

  /**
   * Build providers for connector (browser) mode.
   * Uses in-memory private state, FetchZkConfigProvider, and the Lace wallet connector API.
   */
  private async _buildConnectorProviders(): Promise<DataRegistryProviders> {
    if (!this.connectorAPI) {
      throw new Error(
        "[dStorage/midnight] Connector not initialized. Call await chain.init() first.",
      );
    }

    const zkConfigProvider = await this._buildZkConfigProvider();

    const { createInMemoryPrivateStateProvider } =
      await import("./in-memory-private-state.js");
    const privateStateProvider = createInMemoryPrivateStateProvider();

    // Use browser-safe helpers defined at module level — compact-runtime's toHex/fromHex
    // use Buffer internally and are not safe in the browser.
    const { Transaction } = await import("@midnight-ntwrk/ledger-v8");

    const connectorAPI = this.connectorAPI;
    const logger = this.logger;
    const coinPublicKey = this.connectorCoinPublicKey;
    const encPublicKey = this.connectorEncPublicKey;

    // Both keys are required. An empty or missing coin public key causes
    // computeOwnerCommitment() to receive an empty Uint8Array — ownership-gated
    // operations silently misbehave rather than failing loudly.
    if (!coinPublicKey) {
      throw new Error(
        "[dStorage/midnight] Coin public key not available from wallet. " +
          "getShieldedAddresses() did not return shieldedCoinPublicKey. " +
          "Check that your Lace wallet is unlocked and connected to the target network.",
      );
    }
    if (!encPublicKey) {
      throw new Error(
        "[dStorage/midnight] Encryption public key not available from wallet. " +
          "getShieldedAddresses() did not return shieldedEncryptionPublicKey. " +
          "Check that your Lace wallet is unlocked and connected to the target network.",
      );
    }
    const indexerHttp = this.connectorIndexerHttp ?? this.config.indexerHttp;
    const indexerWs = this.connectorIndexerWs ?? this.config.indexerWs ?? "";
    const proofServer = this.connectorProofServer ?? this.config.proofServer;

    // All three endpoints are required. An empty string here means either
    // getConfiguration() failed/returned partial data AND no fallback was
    // supplied in the adapter config — every provider call would silently use
    // "" as the URL, producing fetch errors with no useful diagnosis.
    if (!indexerHttp) {
      throw new Error(
        "[dStorage/midnight] Indexer HTTP endpoint is not set. " +
          "getConfiguration() did not return indexerUri and no indexerEndpoint " +
          "was supplied in the adapter config. " +
          "Check that your Lace wallet is configured against the target network.",
      );
    }
    if (!indexerWs) {
      throw new Error(
        "[dStorage/midnight] Indexer WebSocket endpoint is not set. " +
          "getConfiguration() did not return indexerWsUri and no indexerWsEndpoint " +
          "was supplied in the adapter config. " +
          "Check that your Lace wallet is configured against the target network.",
      );
    }
    if (!proofServer) {
      throw new Error(
        "[dStorage/midnight] Proof server endpoint is not set. " +
          "getConfiguration() did not return proverServerUri and no proofServerEndpoint " +
          "was supplied in the adapter config.",
      );
    }

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
        const received =
          await connectorAPI.balanceUnsealedTransaction(serializedTx);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      submitTx: async (tx: any): Promise<any> => {
        const serializedTx = uint8ArrayToHex((tx as any).serialize());
        logger?.log(
          "dStorage/midnight",
          `submitTx: submitting tx length=${serializedTx.length}`,
        );
        await connectorAPI.submitTransaction(serializedTx);
        return (tx as any).identifiers?.()[0] ?? "";
      },
    };

    return this._assembleDataRegistryProviders({
      privateStateProvider,
      zkConfigProvider,
      indexerHttp,
      indexerWs,
      proofServer,
      walletProvider: this._wrapPaymentProvider(walletProvider),
      midnightProvider,
    });
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
    const facadeState = await firstValueFrom(
      (walletFacade as any).state() as any,
    );
    const { ShieldedAddress, UnshieldedAddress } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/wallet-sdk-address-format"
    );
    const { getNetworkId } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-network-id"
    );
    this.addresses = {
      shielded: ShieldedAddress.codec
        .encode(getNetworkId(), (facadeState as any).shielded.address)
        .toString(),
      unshielded: UnshieldedAddress.codec
        .encode(getNetworkId(), (facadeState as any).unshielded.address)
        .toString(),
      dust: (facadeState as any).dust.dustAddress,
    };

    const privateStateStoreName = "data-registry-private-state";
    const { levelPrivateStateProvider } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-level-private-state-provider"
    );
    const basePrivateStateProvider = (levelPrivateStateProvider as any)({
      privateStateStoreName,
      signingKeyStoreName: `${privateStateStoreName}-signing-keys`,
      privateStoragePasswordProvider: () => this._injectedPrivateStatePassword!,
      accountId: this.addresses!.unshielded,
    });
    const providers = await this._assembleDataRegistryProviders({
      privateStateProvider: basePrivateStateProvider,
      zkConfigProvider,
      indexerHttp: this.config.indexerHttp,
      indexerWs: this.config.indexerWs,
      proofServer: this.config.proofServer,
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
      throw new Error(
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
      throw new Error(
        `[dStorage/midnight] Invalid contract address "${address}". ` +
          "Expected a 64-character lowercase hex string (32 bytes).",
      );
    }
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
      throw new Error(
        `[dStorage/midnight] No reference found for refId: ${refId}`,
      );
    }

    return {
      storageId: refEntry.storageId,
      encryptionScheme: refEntry.encryptionScheme as EncryptionScheme,
      storageProvider: refEntry.storageProvider,
      ...(refEntry.metadata ? { encryptedMetadata: refEntry.metadata } : {}),
      writtenAt: Number(refEntry.writtenAt),
      keyEnvelope: refEntry.keyEnvelope ?? "",
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
        throw new Error(
          "[dStorage] keyEnvelope is required for all references",
        );
      }
      if (!ref.ownerSecret) {
        throw new Error(
          "[dStorage/midnight] ownerSecret is required for writeReference. " +
            "The core SDK must derive ownerSecret = HKDF(dek, rawStorageId) before calling writeReference.",
        );
      }
      const ownerSecret = ref.ownerSecret;
      const { refId, blockHeight } = await this._withProofRetry(
        () =>
          api.storeReference(
            ref.storageId ?? "",
            ref.encryptionScheme ?? "",
            ref.storageProvider,
            ref.encryptedMetadata ?? "",
            BigInt(ref.writtenAt),
            ref.keyEnvelope ?? "",
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
      throw new Error(
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

  async updateReference(
    refId: string,
    update: ChainReferenceUpdate,
    ownerSecret?: Uint8Array,
  ): Promise<void> {
    this.logger?.log(
      "dStorage/midnight",
      `updateReference() called — refId: ${refId}`,
    );
    if (!ownerSecret) {
      throw new Error(
        "[dStorage/midnight] ownerSecret is required for updateReference. " +
          "The core SDK must derive ownerSecret = HKDF(dek, rawStorageId) before calling updateReference.",
      );
    }
    const secret = ownerSecret;
    try {
      const api = await this._getAPI();
      const refIdBytes = hexToBytes(refId, "refId");
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
            secret,
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
   * Initialize in connector mode: connect to browser wallet extension.
   *
   * Discovers available wallets by enumerating window.midnight, as per the
   * dApp connector spec: https://docs.midnight.network/api-reference/dapp-connector
   */
  private async _initConnector(): Promise<WalletAddresses> {
    const windowAny = typeof window !== "undefined" ? (window as any) : null;
    const midnightObj = windowAny?.midnight;

    if (!midnightObj || typeof midnightObj !== "object") {
      throw new Error(
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
          typeof (v as any).connect === "function",
      )
      .map(([id, v]) => ({
        id,
        wallet: v as {
          name?: string;
          apiVersion?: string;
          connect: (networkId: string) => Promise<ConnectedAPI>;
        },
      }));

    if (availableWallets.length === 0) {
      throw new Error(
        "[dStorage/midnight] No compatible wallets found at window.midnight.\n" +
          "  Install a Midnight-compatible wallet extension (e.g., Midnight Lace).",
      );
    }

    this.logger?.log(
      "dStorage/midnight",
      `Found ${availableWallets.length} wallet(s): ${availableWallets.map((w) => `${w.id} (${w.wallet.name ?? "unknown"})`).join(", ")}`,
    );

    // Select the wallet: prefer the configured connectorName, otherwise use the first available
    let selected = availableWallets[0]!;
    if (this.connectorName) {
      const connectorFound = availableWallets.find(
        (w) => w.id === this.connectorName,
      );
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
      `Connecting to wallet "${selected.id}" (name: ${selected.wallet.name ?? "unknown"}, apiVersion: ${selected.wallet.apiVersion ?? "unknown"}) on network "${this.config.networkId}"...`,
    );

    // Step 1: Connect to the wallet extension
    let connectedAPI: ConnectedAPI;
    try {
      connectedAPI = await selected.wallet.connect(this.config.networkId);
      this.connectorAPI = connectedAPI;
    } catch (err) {
      throw new Error(
        `[dStorage/midnight] Failed to connect to wallet "${selected.id}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    this.logger?.log(
      "dStorage/midnight",
      `✓ Connected to wallet "${selected.id}"`,
    );

    // Step 2: Retrieve wallet configuration (respects user preferences for proof server, indexer, etc.)
    try {
      const walletConfig = await connectedAPI.getConfiguration();
      this.logger?.debug?.(
        "dStorage/midnight",
        `Wallet configuration: ${JSON.stringify(walletConfig)}`,
      );
      this.connectorIndexerHttp =
        walletConfig.indexerUri ?? this.config.indexerHttp;
      this.connectorIndexerWs =
        walletConfig.indexerWsUri ?? this.config.indexerWs ?? null;
      this.connectorProofServer =
        walletConfig.proverServerUri ?? this.config.proofServer;
    } catch (err) {
      this.logger?.warn(
        "dStorage/midnight",
        `getConfiguration() failed — falling back to adapter config endpoints ` +
          `(indexer: "${this.config.indexerHttp}", proofServer: "${this.config.proofServer}"): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Step 3: Extract addresses from connector
    try {
      let shieldedAddr = "";
      try {
        const r = await connectedAPI.getShieldedAddresses();
        const obj = Array.isArray(r) ? r[0] : r;
        shieldedAddr =
          (obj as any)?.shieldedAddress ??
          (obj as any)?.address ??
          (typeof obj === "string" ? obj : "");
        this.connectorCoinPublicKey =
          (obj as any)?.shieldedCoinPublicKey ?? null;
        this.connectorEncPublicKey =
          (obj as any)?.shieldedEncryptionPublicKey ?? null;
      } catch (err) {
        this.logger?.warn(
          "dStorage/midnight",
          `getShieldedAddresses() failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let unshieldedAddr = "";
      try {
        const r = await (connectedAPI as any).getUnshieldedAddress?.();
        unshieldedAddr =
          (r as any)?.unshieldedAddress ?? (typeof r === "string" ? r : "");
      } catch {
        this.logger?.warn(
          "dStorage/midnight",
          "Could not retrieve unshielded address",
        );
      }

      let dustAddr = "";
      try {
        const r = await (connectedAPI as any).getDustAddress?.();
        dustAddr = (r as any)?.dustAddress ?? (typeof r === "string" ? r : "");
      } catch {
        this.logger?.warn(
          "dStorage/midnight",
          "Could not retrieve dust address",
        );
      }

      if (!shieldedAddr && !unshieldedAddr && !dustAddr) {
        throw new Error("No addresses available from wallet");
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
      throw new Error(
        `[dStorage/midnight] Failed to extract addresses from wallet: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Return wallet addresses derived during init().
   * Throws if init() not yet called.
   */
  getAddresses(): WalletAddresses {
    if (!this.addresses) {
      throw new Error(
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
      /* @vite-ignore */ "@midnight-ntwrk/ledger-v8"
    );
    if (this.walletMode === "provider") {
      if (!this.facade) {
        throw new Error(
          "[dStorage/midnight] getBalances() called before init().",
        );
      }

      const state = await (this.facade as any).waitForSyncedState();
      const nightToken = unshieldedToken();

      return {
        night: (state as any).unshielded?.balances?.[nightToken.raw] ?? 0n,
        dust: (state as any).dust?.balance?.(new Date()) ?? 0n,
      };
    } else {
      if (!this.connectorAPI) {
        throw new Error(
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
