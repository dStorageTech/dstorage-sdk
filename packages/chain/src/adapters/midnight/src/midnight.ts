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
 *   - 'facade': derive keys, build WalletFacade, wait for sync (Node.js CLI)
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

import type {
  ChainAdapter,
  ChainProviderName,
  ChainReference,
  ChainWriteResult,
  WalletBalances,
  DataReferencesSummary,
} from "../../../types.js";

import type { DataRegistryAPI, PrivateStateId } from "./api.js";
import type { DataRegistryProviders } from "./common-types.js";
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import type { EnvironmentConfiguration } from "@midnight-ntwrk/testkit-js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface WalletAddresses {
  unshielded: string;
  shielded: string;
  dust: string;
}

// Token names used to populate WalletBalances map
const TOKEN_NAME_NIGTH = "night"; // unshielded NIGHT token
const TOKEN_NAME_DUST = "dust"; // DUST fee token

// ── Connector API types (minimal surface from dApp connector spec) ────────────
// See: https://docs.midnight.network/api-reference/dapp-connector

/** ConnectedAPI: returned by wallet.connect(networkId). */
interface ConnectedAPI {
  // Configuration
  getConfiguration(): Promise<{
    networkId?: string;
    indexerUri?: string;
    indexerWsUri?: string;
    proverServerUri?: string;
    substrateNodeUri?: string;
  }>;
  // Wallet state
  getShieldedBalances?(): Promise<unknown>;
  getUnshieldedBalances?(): Promise<unknown>;
  getDustBalance?(): Promise<unknown>;
  getShieldedAddresses(): Promise<
    | {
        shieldedAddress: string;
        shieldedCoinPublicKey: string;
        shieldedEncryptionPublicKey: string;
      }
    | unknown
  >;
  getUnshieldedAddress?(): Promise<{ unshieldedAddress: string } | string>;
  getDustAddress?(): Promise<{ dustAddress: string } | string>;
  // Transaction methods
  balanceUnsealedTransaction(tx: string): Promise<string | { tx: string }>;
  submitTransaction(tx: string): Promise<string>;
  // Proving
  getProvingProvider?(): Promise<unknown>;
}

// ── Config ─────────────────────────────────────────────────────────────────────

const FACADE_WALLET_SYNC_TIMEOUT = 600_000;

interface BaseConfig {
  /**
   * Midnight node RPC endpoint.
   */
  nodeEndpoint: string;
  nodeWsEndpoint: string;
  /**
   * Midnight indexer HTTP (GraphQL) endpoint for state queries.
   */
  indexerEndpoint: string;
  /**
   * Midnight indexer WebSocket endpoint for real-time subscriptions.
   */
  indexerWsEndpoint: string;
  /**
   * Proof server URL.
   */
  proofServerEndpoint: string;
  /**
   * On-chain address of the deployed DataRegistry contract.
   * Optional — if omitted, call deployDataRegistry() (or sdk.init()) to deploy a new contract.
   */
  contractAddress?: string;
  /**
   * Target network. Controls wallet networkId, address format, and fee overhead.
   */
  network: "preprod" | "undeployed";
}

export type MidnightChainAdapterConfig = BaseConfig &
  (
    | {
        /**
         * Wallet mode. Default: 'facade' (uses wallet-sdk-facade for Node.js CLI).
         * Set to 'connector' to use browser wallet extension (e.g., Midnight Lace).
         */
        walletMode: "facade";
        /**
         * Wallet credentials. Provide exactly one of mnemonic or seedHex.
         * Used by init() to derive Midnight signing keys in facade mode.
         * Required only when walletMode is 'facade'.
         */
        credentials: {
          mnemonic?: string; // BIP-39 mnemonic
          seedHex?: string; // 64 or 128 hex chars
        };
        /**
         * Path to the directory that contains the compiled DataRegistry contract's ZK artifacts.
         * Expected sub-directories:
         *   ${zkArtifactsPath}/keys/${circuitId}.prover
         *   ${zkArtifactsPath}/keys/${circuitId}.verifier
         *   ${zkArtifactsPath}/zkir/${circuitId}.bzkir
         *
         * Required for write operations (storeReference, etc.) in facade mode.
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

/** Decode a base64url string to a Uint8Array (browser-safe, no Buffer). */
function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Encode a Uint8Array to a base64url string (browser-safe, no Buffer). */
function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Convert a lowercase hex string to a Uint8Array (browser-safe, no Buffer). */
function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class MidnightChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = "midnight";
  readonly providerName: string = "Midnight";

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

  private readonly walletMode: "facade" | "connector";
  private readonly connectorName: string | null;

  private _contractAddress: string | undefined;
  private _zkArtifactsPath: string | undefined;
  private _zkConfigBaseUrl: string | undefined;
  private _initialized = false;

  // DataRegistry API — lazily initialized by _getAPI().
  // Reset to null when contract address changes (setContractAddress) or on stop().
  private _api: DataRegistryAPI | null = null;

  private readonly _credentials: { mnemonic?: string; seedHex?: string };

  private readonly config: EnvironmentConfiguration;

  constructor(config: MidnightChainAdapterConfig) {
    if (config.contractAddress !== undefined && !config.contractAddress) {
      throw new Error(
        "[dStorage/midnight] contractAddress is required. " +
          "Deploy your DataRegistry contract to Midnight and pass the address, " +
          "or omit it to auto-deploy via deployDataRegistry().",
      );
    }
    if (!config.network) {
      throw new Error("[dStorage/midnight] network is required.");
    }

    // Determine wallet mode and validate credentials
    const walletMode =
      "walletMode" in config ? (config.walletMode ?? "facade") : "facade";
    if (walletMode === "facade") {
      const facadeConfig = config as Extract<
        MidnightChainAdapterConfig,
        { walletMode?: "facade" }
      >;
      if (
        !facadeConfig.credentials?.mnemonic &&
        !facadeConfig.credentials?.seedHex
      ) {
        throw new Error(
          '[dStorage/midnight] credentials.mnemonic or credentials.seedHex is required (walletMode: "facade").',
        );
      }
    }

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
    this._credentials =
      walletMode === "facade" && "credentials" in config
        ? config.credentials
        : {};
    this._zkArtifactsPath =
      walletMode === "facade" && "zkArtifactsPath" in config
        ? (
            config as Extract<
              MidnightChainAdapterConfig,
              { walletMode: "facade" }
            >
          ).zkArtifactsPath
        : undefined;
    this._zkConfigBaseUrl =
      walletMode === "connector" && "zkConfigBaseUrl" in config
        ? (
            config as Extract<
              MidnightChainAdapterConfig,
              { walletMode: "connector" }
            >
          ).zkConfigBaseUrl
        : undefined;

    this.config = {
      walletNetworkId: config.network,
      networkId: config.network,
      indexer: config.indexerEndpoint,
      indexerWS: config.indexerWsEndpoint,
      node: config.nodeEndpoint,
      nodeWS: config.nodeWsEndpoint,
      faucet: "https://faucet.preprod.midnight.network/api/request-tokens",
      proofServer: config.proofServerEndpoint,
    };
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
      console.log(`[dStorage/midnight] ZK artifacts base URL: ${baseUrl}`);
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
    console.log(`[dStorage/midnight] ZK artifacts path: ${zkConfigPath}`);

    const { NodeZkConfigProvider } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/midnight-js-node-zk-config-provider"
    );
    return new NodeZkConfigProvider(zkConfigPath);
  }

  /**
   * midnight-js-contracts expects privateStateProvider.setContractAddress().
   * Some providers do not implement it, so we add a no-op shim.
   */
  private _withContractAddressShim<T extends object>(
    privateStateProvider: T,
  ): T & { setContractAddress: (address: string) => void } {
    return Object.assign(privateStateProvider, {
      setContractAddress: (_address: string) => {
        /* no-op: provider scopes by privateStateId */
      },
    });
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
    const { Transaction } = await import("@midnight-ntwrk/ledger-v7");

    const connectorAPI = this.connectorAPI;
    const coinPublicKey = this.connectorCoinPublicKey ?? "";
    const encPublicKey = this.connectorEncPublicKey ?? "";
    const indexerHttp = this.connectorIndexerHttp ?? this.config.indexer;
    const indexerWs = this.connectorIndexerWs ?? this.config.indexerWS ?? "";
    const proofServer = this.connectorProofServer ?? this.config.proofServer;

    const walletProvider = {
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => encPublicKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      balanceTx: async (tx: any, _ttl?: Date): Promise<any> => {
        const serializedTx = uint8ArrayToHex((tx as any).serialize());
        console.log(
          `[dStorage/midnight] balanceTx: serialized tx length=${serializedTx.length}`,
        );
        const received =
          await connectorAPI.balanceUnsealedTransaction(serializedTx);
        const balancedHex =
          typeof received === "string" ? received : (received as any).tx;
        console.log(
          `[dStorage/midnight] balanceTx: received balanced tx length=${balancedHex?.length}`,
        );
        // Transaction.deserialize takes (sigType, proofType, bindingType, bytes) — see ledger-v7 API.
        return (Transaction as any).deserialize(
          "signature",
          "proof",
          "binding",
          hexToUint8Array(balancedHex),
        );
      },
    };

    const midnightProvider = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      submitTx: async (tx: any): Promise<any> => {
        const serializedTx = uint8ArrayToHex((tx as any).serialize());
        console.log(
          `[dStorage/midnight] submitTx: submitting tx length=${serializedTx.length}`,
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
      walletProvider,
      midnightProvider,
    });
  }

  /**
   * Build a DataRegistryProviders object by combining the Midnight providers
   * (wallet, proof server, indexer, node) with an in-memory private state store.
   */
  private async _buildDataRegistryProviders(): Promise<DataRegistryProviders> {
    // Facade mode (Node.js CLI only — uses WalletFacade and levelDb private state).
    const zkConfigProvider = await this._buildZkConfigProvider();

    const { MidnightWalletProvider } = await import(
      /* @vite-ignore */ "./wallet-provider.js"
    );
    const walletProvider = await MidnightWalletProvider.build(
      this.config,
      this._credentials.seedHex,
    );
    const walletFacade: WalletFacade = walletProvider.wallet;
    await walletProvider.start();

    const { waitForUnshieldedFunds } = await import(
      /* @vite-ignore */ "./wallet-utils.js"
    );
    const { unshieldedToken } = await import(
      /* @vite-ignore */ "@midnight-ntwrk/ledger-v7"
    );
    const unshieldedState = await waitForUnshieldedFunds(
      walletFacade,
      this.config,
      unshieldedToken(),
      false,
    );
    const nightBalance = unshieldedState.balances[unshieldedToken().raw];
    if (nightBalance === undefined) {
      console.log("No funds received, exiting...");
      throw new Error("[dStorage/midnight] No NIGHT funds received/detected.");
    }
    console.log(`Your NIGHT wallet balance is: ${nightBalance}`);

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
      privateStoragePasswordProvider: () => {
        return "key-just-for-testing-here!";
      },
    });
    const providers = await this._assembleDataRegistryProviders({
      privateStateProvider: basePrivateStateProvider,
      zkConfigProvider,
      indexerHttp: this.config.indexer,
      indexerWs: this.config.indexerWS,
      proofServer: this.config.proofServer,
      walletProvider,
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
      providers = await this._buildDataRegistryProviders();
    }

    const { DataRegistryAPI } = await import("./api.js");
    if (!this._contractAddress) {
      console.log("[dStorage/midnight] Deploying DataRegistry contract…");
      this._api = await DataRegistryAPI.deploy(providers);
      this._contractAddress = this._api.deployedContractAddress;
      console.log(
        `[dStorage/midnight] DataRegistry deployed at: ${this._contractAddress}`,
      );
    } else {
      this._api = await DataRegistryAPI.join(providers, this._contractAddress);
      console.log(
        `[dStorage/midnight] DataRegistry joined at: ${this._contractAddress}`,
      );
    }

    return this._api;
  }

  // ── Contract address management ────────────────────────────────────────────

  /**
   * Set the contract address to use for subsequent operations.
   * Resets the cached DataRegistryAPI so the next call re-joins at the new address.
   */
  setContractAddress(address: string): void {
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
  async listReferences(): Promise<DataReferencesSummary[]> {
    const api = await this._getAPI();

    const { firstValueFrom } = await import("rxjs");
    const state = await firstValueFrom(api.state$);

    return Array.from(state.references.entries())
      .map(([refId, entry]) => ({
        refId,
        storageId: this._decodeStorageId(
          entry.storageId,
          entry.storageProvider,
        ),
        storageProvider: entry.storageProvider,
      }))
      .sort((a, b) => a.refId.localeCompare(b.refId));
  }

  /**
   * Look up a single reference by its refId.
   * Returns { storageId, storageProvider } with the storageId decoded to the
   * original storage network identifier (e.g. Arweave txId), or null if not found.
   */
  async getReference(refId: string): Promise<DataReferencesSummary | null> {
    const api = await this._getAPI();

    const { firstValueFrom } = await import("rxjs");
    const state = await firstValueFrom(api.state$);

    const entry = state.references.get(refId);
    if (!entry) return null;

    return {
      refId,
      storageId: this._decodeStorageId(entry.storageId, entry.storageProvider),
      storageProvider: entry.storageProvider,
    };
  }

  // ── ChainAdapter implementation ────────────────────────────────────────────

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    console.log(
      `[dStorage/midnight] writeReference() called — storageId: ${ref.storageId}, provider: ${ref.storageProvider}`,
    );
    try {
      const api = await this._getAPI();
      console.log("[dStorage/midnight] Encoding storageId…");
      const encodedStorageId = await this._encodeStorageId(ref.storageId);

      console.log(
        `[dStorage/midnight] Storing reference for storageId: ${uint8ArrayToHex(encodedStorageId)}`,
      );
      const {
        refId,
        txHash: _,
        blockHeight,
      } = await api.storeReference(encodedStorageId, ref.storageProvider);
      const refIdHex = uint8ArrayToHex(refId);

      console.log(
        `[dStorage/midnight] Reference written at block ${blockHeight} → refId: ${refIdHex}`,
      );

      return {
        refId: refIdHex,
        provider: this.name,
        blockHeight,
        writtenAt: Date.now(),
      };
    } catch (err) {
      console.error("[dStorage/midnight] writeReference() failed:", err);
      throw err;
    }
  }

  /**
   * Encode a storage ID string into a 32-byte Uint8Array for the contract's Bytes<32> field.
   *
   * Arweave txIds are 43-character base64url strings that decode to exactly 32 bytes,
   * so we store the raw bytes directly — this allows lossless recovery of the original txId.
   *
   * For all other IDs (e.g. mock UUIDs, Autonomi addresses), we fall back to SHA-256 hashing.
   */
  private async _encodeStorageId(id: string): Promise<Uint8Array> {
    // FIXME!!!
    // We have to encrypt the storage id not only for privacy reasons but also
    // to be able to then retrieve the stored content using its id,
    // using a hash as we do in the fallback case is not reversible

    // Arweave txIds: exactly 43 base64url characters → 32 bytes when decoded
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) {
      return base64urlToBytes(id);
    }
    // Generic fallback: SHA-256 hash to fit any string into 32 bytes
    const bytes = new TextEncoder().encode(id);
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return new Uint8Array(hashBuffer);
  }

  /**
   * Decode a 32-byte storageId (as stored on-chain) back to the original storage ID string.
   *
   * For Arweave: the raw 32 bytes were the base64url-decoded txId, so we base64url-encode
   * them back to recover the original 43-character Arweave txId.
   * For other providers: return the hex representation (the original ID is not recoverable
   * if it was SHA-256 hashed).
   */
  private _decodeStorageId(bytes: Uint8Array, storageProvider: string): string {
    if (storageProvider === "arweave") {
      return bytesToBase64url(bytes);
    }
    return uint8ArrayToHex(bytes);
  }

  // ── DataRegistry deployment ────────────────────────────────────────────────

  /**
   * Derive a deterministic AES-GCM encryption key from the adapter's credentials.
   * Only available in facade mode (where credentials are held by the adapter).
   * Throws in connector mode (credentials are held by the wallet extension).
   */
  async getEncryptionKey(): Promise<CryptoKey> {
    if (this.walletMode === "facade" && this._credentials) {
      const { KeyDeriver } = await import("@dstorage/crypto");
      return new KeyDeriver(this._credentials).deriveEncryptionKey();
    }
    throw new Error(
      "[dStorage/midnight] getEncryptionKey() is not available in connector mode.\n" +
        "  Encryption key derivation requires wallet credentials (facade mode only).",
    );
  }

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

    console.log(
      `[dStorage/midnight] Found ${availableWallets.length} wallet(s): ` +
        availableWallets
          .map((w) => `${w.id} (${w.wallet.name ?? "unknown"})`)
          .join(", "),
    );

    // Select the wallet: prefer the configured connectorName, otherwise use the first available
    let selected = availableWallets[0]!;
    if (this.connectorName) {
      let connectorFound = availableWallets.find(
        (w) => w.id === this.connectorName,
      );
      if (connectorFound) {
        selected = connectorFound;
      } else {
        console.warn(
          `[dStorage/midnight] Configured wallet "${this.connectorName}" not found. ` +
            `Using first available: "${selected.id}"`,
        );
      }
    }

    console.log(
      `[dStorage/midnight] Connecting to wallet "${selected.id}" ` +
        `(name: ${selected.wallet.name ?? "unknown"}, apiVersion: ${selected.wallet.apiVersion ?? "unknown"}) ` +
        `on network "${this.config.networkId}"...`,
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

    console.log(`[dStorage/midnight] ✓ Connected to wallet "${selected.id}"`);

    // Step 2: Retrieve wallet configuration (respects user preferences for proof server, indexer, etc.)
    try {
      const walletConfig = await connectedAPI.getConfiguration();
      console.log("[dStorage/midnight] Wallet configuration:", walletConfig);
      this.connectorIndexerHttp =
        walletConfig.indexerUri ?? this.config.indexer;
      this.connectorIndexerWs =
        walletConfig.indexerWsUri ?? this.config.indexerWS ?? null;
      this.connectorProofServer =
        walletConfig.proverServerUri ?? this.config.proofServer;
    } catch (err) {
      console.warn(
        "[dStorage/midnight] Failed to retrieve wallet configuration:",
        err instanceof Error ? err.message : String(err),
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
        console.warn("[dStorage/midnight] getShieldedAddresses() failed:", err);
      }

      let unshieldedAddr = "";
      try {
        const r = await (connectedAPI as any).getUnshieldedAddress?.();
        unshieldedAddr =
          (r as any)?.unshieldedAddress ?? (typeof r === "string" ? r : "");
      } catch {
        console.warn(
          "[dStorage/midnight] Could not retrieve unshielded address",
        );
      }

      let dustAddr = "";
      try {
        const r = await (connectedAPI as any).getDustAddress?.();
        dustAddr = (r as any)?.dustAddress ?? (typeof r === "string" ? r : "");
      } catch {
        console.warn("[dStorage/midnight] Could not retrieve dust address");
      }

      if (!shieldedAddr && !unshieldedAddr && !dustAddr) {
        throw new Error("No addresses available from wallet");
      }

      this.addresses = {
        shielded: shieldedAddr,
        unshielded: unshieldedAddr,
        dust: dustAddr,
      };

      console.log("[dStorage/midnight] Wallet addresses:", {
        shielded: shieldedAddr ? `${shieldedAddr.slice(0, 20)}…` : "(none)",
        unshielded: unshieldedAddr
          ? `${unshieldedAddr.slice(0, 20)}…`
          : "(none)",
        dust: dustAddr ? `${dustAddr.slice(0, 20)}…` : "(none)",
      });
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
   * - Facade mode: reads from synced wallet state
   * TODO:
   * - Connector mode: returns 0n (known limitation)
   */
  async getBalances(): Promise<WalletBalances> {
    if (this.walletMode === "facade") {
      if (!this.facade) {
        throw new Error(
          "[dStorage/midnight] getBalances() called before init().",
        );
      }

      const { firstValueFrom } = await import("rxjs");
      const { unshieldedToken } = await import(
        /* @vite-ignore */ "@midnight-ntwrk/ledger-v7"
      );
      const state = await firstValueFrom((this.facade as any).state() as any);
      const nightToken = unshieldedToken();

      return {
        TOKEN_NAME_NIGTH:
          (state as any).unshielded?.balances?.[nightToken.raw] ?? 0n,
        TOKEN_NAME_DUST: (state as any).dust?.walletBalance?.(new Date()) ?? 0n,
      };
    } else {
      if (!this.connectorAPI) {
        throw new Error(
          "[dStorage/midnight] getBalances() called before init().",
        );
      }
      return {
        TOKEN_NAME_NIGTH: 0n,
        TOKEN_NAME_DUST: 0n,
      };
    }
  }
}
