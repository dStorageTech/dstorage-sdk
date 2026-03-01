/**
 * @dstorage/chain — adapters/midnight.ts
 *
 * Real Midnight Network chain adapter.
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
  CircuitCallResult,
} from '../../types.js';

import type { DataRegistryAPI } from './api.js';
import type { DataRegistryProviders } from './common-types.js';
import { dataRegistryPrivateStateKey } from './common-types.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface WalletAddresses {
  unshielded: string;
  shielded: string;
  dust: string;
}

export interface WalletBalances {
  night: bigint;   // unshielded NIGHT token balance
  dust: bigint;    // DUST fee token balance
}

// ── Connector API types (minimal surface from dApp connector spec) ────────────
// See: https://docs.midnight.network/api-reference/dapp-connector

/** InitialAPI: exposed at window.midnight.{walletId} before connection. */
interface WalletInitialAPI {
  name: string;
  icon: string;
  apiVersion: string;
  connect(networkId: string): Promise<ConnectedAPI>;
}

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
  getShieldedAddresses(): Promise<{ shieldedAddress: string; shieldedCoinPublicKey: string; shieldedEncryptionPublicKey: string } | unknown>;
  getUnshieldedAddress?(): Promise<{ unshieldedAddress: string } | string>;
  getDustAddress?(): Promise<{ dustAddress: string } | string>;
  // Transaction methods
  balanceUnsealedTransaction(tx: string): Promise<string | { tx: string }>;
  submitTransaction(tx: string): Promise<string>;
  // Proving
  getProvingProvider?(): Promise<unknown>;
}

// ── Config ─────────────────────────────────────────────────────────────────────

interface BaseConfig {
  /**
   * Midnight node RPC endpoint.
   * Default: Midnight testnet-02 public node.
   */
  nodeEndpoint?: string;
  /**
   * Midnight indexer HTTP (GraphQL) endpoint for state queries.
   * Default: Midnight testnet-02 public indexer.
   */
  indexerEndpoint?: string;
  /**
   * Midnight indexer WebSocket endpoint for real-time subscriptions.
   */
  indexerWsEndpoint?: string;
  /**
   * Proof server URL.
   * Default: http://localhost:6300 (local proof server).
   */
  proofServerEndpoint?: string;
  /**
   * On-chain address of the deployed DataRegistry contract.
   * Optional — if omitted, call deployDataRegistry() (or sdk.init()) to deploy a new contract.
   */
  contractAddress?: string;
  /**
   * Target network. Controls wallet networkId, address format, and fee overhead.
   */
  network: 'testnet' | 'preprod' | 'undeployed';
}

export type MidnightChainAdapterConfig = BaseConfig & (
  | {
      /**
       * Wallet mode. Default: 'facade' (uses wallet-sdk-facade for Node.js CLI).
       * Set to 'connector' to use browser wallet extension (e.g., Midnight Lace).
       */
      walletMode?: 'facade';
      /**
       * Wallet credentials. Provide exactly one of mnemonic or seedHex.
       * Used by init() to derive Midnight signing keys in facade mode.
       * Required only when walletMode is 'facade' or not specified.
       */
      credentials: {
        mnemonic?: string;  // BIP-39 mnemonic
        seedHex?: string;   // 64 or 128 hex chars
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
      walletMode: 'connector';
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

// ── Adapter ────────────────────────────────────────────────────────────────────

export class MidnightChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = 'midnight';

  private facade: unknown | null = null;
  private connectorAPI: ConnectedAPI | null = null;
  private addresses: WalletAddresses | null = null;

  // Facade mode: shielded public keys and dust seed derived during _initFacade().
  private facadeCoinPublicKey: string | null = null;
  private facadeEncPublicKey: string | null = null;
  private facadeDustSeed: Uint8Array | null = null;
  // Full secret key objects needed for balanceTx (WalletFacade.balanceUnboundTransaction).
  private facadeShieldedSecretKeys: unknown | null = null;
  private facadeDustSecretKey: unknown | null = null;

  // Connector mode: shielded wallet keys retrieved from Lace during init().
  private connectorCoinPublicKey: string | null = null;
  private connectorEncPublicKey: string | null = null;
  // Connector mode: endpoints from wallet configuration (may differ from config defaults).
  private connectorIndexerHttp: string | null = null;
  private connectorIndexerWs: string | null = null;
  private connectorProofServer: string | null = null;

  private readonly walletMode: 'facade' | 'connector';
  private readonly connectorName: string;

  private _contractAddress: string | undefined;

  // DataRegistry API — lazily initialized by _getAPI().
  // Reset to null when contract address changes (setContractAddress) or on stop().
  private _api: DataRegistryAPI | null = null;

  // In-memory private state store for DataRegistry circuit witness (localSecretKey).
  // Key: 'DataRegistryPrivateState', Value: { secretKey: Uint8Array }
  private _privateStateMap: Map<string, unknown> = new Map();

  private readonly config: {
    nodeEndpoint: string;
    indexerEndpoint: string;
    indexerWsEndpoint?: string;
    proofServerEndpoint: string;
    contractAddress?: string;
    network: 'testnet' | 'preprod' | 'undeployed';
    credentials?: { mnemonic?: string; seedHex?: string };
    zkConfigBaseUrl?: string;   // connector mode
    zkArtifactsPath?: string;   // facade mode
  };

  constructor(config: MidnightChainAdapterConfig) {
    if (config.contractAddress !== undefined && !config.contractAddress) {
      throw new Error(
        '[dStorage/midnight] contractAddress is required. ' +
          'Deploy your DataRegistry contract to Midnight and pass the address, ' +
          'or omit it to auto-deploy via deployDataRegistry().'
      );
    }
    if (!config.network) {
      throw new Error(
        '[dStorage/midnight] network is required.'
      );
    }

    // Determine wallet mode and validate credentials
    const walletMode = 'walletMode' in config ? config.walletMode ?? 'facade' : 'facade';
    if (walletMode === 'facade') {
      const facadeConfig = config as Extract<MidnightChainAdapterConfig, { walletMode?: 'facade' }>;
      if (!facadeConfig.credentials?.mnemonic && !facadeConfig.credentials?.seedHex) {
        throw new Error(
          '[dStorage/midnight] credentials.mnemonic or credentials.seedHex is required (walletMode: "facade").'
        );
      }
    }

    this.walletMode = walletMode;
    this.connectorName = walletMode === 'connector'
      ? (config as Extract<MidnightChainAdapterConfig, { walletMode: 'connector' }>).connectorName ?? 'mnLace'
      : '';

    this._contractAddress = config.contractAddress;

    this.config = {
      nodeEndpoint: config.nodeEndpoint ?? 'https://rpc.testnet-02.midnight.network',
      indexerEndpoint:
        config.indexerEndpoint ?? 'https://indexer.testnet-02.midnight.network/api/v1/graphql',
      ...(config.indexerWsEndpoint !== undefined
        ? { indexerWsEndpoint: config.indexerWsEndpoint }
        : {}),
      proofServerEndpoint: config.proofServerEndpoint ?? 'http://localhost:6300',
      ...(config.contractAddress !== undefined ? { contractAddress: config.contractAddress } : {}),
      network: config.network,
      ...(walletMode === 'facade' && 'credentials' in config ? { credentials: config.credentials } : {}),
      ...(walletMode === 'connector' && 'zkConfigBaseUrl' in config && config.zkConfigBaseUrl !== undefined
        ? { zkConfigBaseUrl: config.zkConfigBaseUrl }
        : {}),
      ...(walletMode === 'facade' && 'zkArtifactsPath' in config && (config as any).zkArtifactsPath !== undefined
        ? { zkArtifactsPath: (config as any).zkArtifactsPath }
        : {}),
    };
  }

  // ── ZK config provider ─────────────────────────────────────────────────────

  /**
   * Build a mode-specific ZK config provider.
   *
   * Facade (Node.js): reads ZK artifact files from the local filesystem via zkArtifactsPath.
   * Connector (browser): fetches ZK artifacts over HTTP via zkConfigBaseUrl.
   */
  private async _buildZkConfigProvider(): Promise<unknown> {
    if (this.walletMode === 'facade') {
      const zkArtifactsPath = this.config.zkArtifactsPath;
      if (!zkArtifactsPath) {
        throw new Error(
          '[dStorage/midnight] zkArtifactsPath is required in facade mode to load ZK artifacts.\n' +
            '  Set it to the directory containing the compiled DataRegistry contract\'s keys/ and zkir/ subdirectories.\n' +
            '  Example: zkArtifactsPath: path.resolve(__dirname, \'../packages/chain/src/adapters/midnight/contracts/managed/contract\')'
        );
      }
      const { readFile } = await import('node:fs/promises');
      const { createProverKey, createVerifierKey, createZKIR } =
        await import('@midnight-ntwrk/midnight-js-types');
      return {
        getProverKey:   async (id: string) =>
          (createProverKey as any)(new Uint8Array(await readFile(`${zkArtifactsPath}/keys/${id}.prover`))),
        getVerifierKey: async (id: string) =>
          (createVerifierKey as any)(new Uint8Array(await readFile(`${zkArtifactsPath}/keys/${id}.verifier`))),
        getZKIR:        async (id: string) =>
          (createZKIR as any)(new Uint8Array(await readFile(`${zkArtifactsPath}/zkir/${id}.bzkir`))),
      };
    } else {
      const zkConfigBaseUrl = this.config.zkConfigBaseUrl;
      if (!zkConfigBaseUrl) {
        throw new Error(
          '[dStorage/midnight] zkConfigBaseUrl is required in connector mode to fetch ZK artifacts.\n' +
            '  Set it to the base URL where keys/ and zkir/ are served.\n' +
            '  In a Vite app: copy compiled keys/ and zkir/ to public/, then set\n' +
            '    zkConfigBaseUrl: window.location.origin'
        );
      }
      let FetchZkConfigProvider: new (baseUrl: string, fetchFn?: typeof fetch) => unknown;
      try {
        const mod = await import('@midnight-ntwrk/midnight-js-fetch-zk-config-provider');
        FetchZkConfigProvider = (mod as any).FetchZkConfigProvider;
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(
          '[dStorage/midnight] @midnight-ntwrk/midnight-js-fetch-zk-config-provider is not installed.\n' +
            '  Run: npm install @midnight-ntwrk/midnight-js-fetch-zk-config-provider\n' +
            `  Cause: ${cause}`
        );
      }
      return new FetchZkConfigProvider(zkConfigBaseUrl, fetch.bind(globalThis));
    }
  }

  /**
   * Build the full set of Midnight providers needed by DataRegistryAPI.
   */
  private async _buildProviders(zkConfigProvider: unknown): Promise<{
    publicDataProvider: unknown;
    zkConfigProvider: unknown;
    proofProvider: unknown;
    walletProvider: unknown;
    midnightProvider: unknown;
  }> {
    // ── Proof provider (proof server HTTP client) ────────────────────────────
    let httpClientProofProvider: (url: string, zkConfig: unknown) => unknown;
    try {
      const mod = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
      httpClientProofProvider = (mod as any).httpClientProofProvider;
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        '[dStorage/midnight] @midnight-ntwrk/midnight-js-http-client-proof-provider is not installed.\n' +
          '  Run: npm install @midnight-ntwrk/midnight-js-http-client-proof-provider\n' +
          `  Cause: ${cause}`
      );
    }

    // ── Public data provider (indexer) ───────────────────────────────────────
    let indexerPublicDataProvider: (httpUrl: string, wsUrl: string) => unknown;
    try {
      const mod = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
      indexerPublicDataProvider = (mod as any).indexerPublicDataProvider;
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        '[dStorage/midnight] @midnight-ntwrk/midnight-js-indexer-public-data-provider is not installed.\n' +
          '  Run: npm install @midnight-ntwrk/midnight-js-indexer-public-data-provider\n' +
          `  Cause: ${cause}`
      );
    }

    const indexerHttp =
      (this.walletMode === 'connector' ? this.connectorIndexerHttp : null) ??
      this.config.indexerEndpoint;
    const indexerWs =
      (this.walletMode === 'connector' ? this.connectorIndexerWs : null) ??
      this.config.indexerWsEndpoint ?? '';
    const publicDataProvider = indexerPublicDataProvider(indexerHttp, indexerWs);

    if (this.walletMode === 'facade') {
      // ── Facade mode ────────────────────────────────────────────────────────
      if (!this.facade) {
        throw new Error('[dStorage/midnight] Wallet not initialized. Call await chain.init() first.');
      }
      const proofProvider = httpClientProofProvider(this.config.proofServerEndpoint, zkConfigProvider);
      const facade = this.facade as any;
      const shieldedSecretKeys = this.facadeShieldedSecretKeys;
      const dustSecretKey = this.facadeDustSecretKey;
      const facadeCoinPublicKey = this.facadeCoinPublicKey;
      const facadeEncPublicKey = this.facadeEncPublicKey;
      const { ttlOneHour } = await import('@midnight-ntwrk/midnight-js-utils');

      const walletProvider = {
        getCoinPublicKey: () => facadeCoinPublicKey,
        getEncryptionPublicKey: () => facadeEncPublicKey,
        balanceTx: async (tx: unknown, ttl?: Date) => {
          const recipe = await facade.balanceUnboundTransaction(
            tx,
            { shieldedSecretKeys, dustSecretKey },
            { ttl: ttl ?? ttlOneHour() }
          );
          return facade.finalizeRecipe(recipe);
        },
      };
      const midnightProvider = {
        submitTx: (tx: unknown) => facade.submitTransaction(tx),
      };

      return { publicDataProvider, zkConfigProvider, proofProvider, walletProvider, midnightProvider };

    } else {
      // ── Connector mode ─────────────────────────────────────────────────────
      if (!this.connectorAPI) {
        throw new Error('[dStorage/midnight] Connector not initialized. Call await chain.init() first.');
      }
      const proofServerUrl = this.connectorProofServer ?? this.config.proofServerEndpoint;
      const proofProvider = httpClientProofProvider(proofServerUrl, zkConfigProvider);
      const connectorAPI = this.connectorAPI;
      const connectorCoinPublicKey = this.connectorCoinPublicKey;
      const connectorEncPublicKey = this.connectorEncPublicKey;

      const { toHex, fromHex } = await import('@midnight-ntwrk/midnight-js-utils');
      const ledger = await import(/* @vite-ignore */ '@midnight-ntwrk/ledger-v7');

      const walletProvider = {
        getCoinPublicKey: () => connectorCoinPublicKey,
        getEncryptionPublicKey: () => connectorEncPublicKey,
        balanceTx: async (tx: unknown) => {
          const serializedTx = toHex((tx as any).serialize());
          const received = await connectorAPI.balanceUnsealedTransaction(serializedTx);
          const balancedHex = typeof received === 'string' ? received : received.tx;
          return (ledger as any).Transaction.deserialize(
            'signature', 'proof', 'binding',
            fromHex(balancedHex)
          );
        },
      };
      const midnightProvider = {
        submitTx: async (tx: unknown) => {
          await connectorAPI.submitTransaction(toHex((tx as any).serialize()));
          return (tx as any).identifiers()[0];
        },
      };

      return { publicDataProvider, zkConfigProvider, proofProvider, walletProvider, midnightProvider };
    }
  }

  /**
   * Build a DataRegistryProviders object by combining the Midnight providers
   * (wallet, proof server, indexer, node) with an in-memory private state store.
   */
  private async _buildDataRegistryProviders(): Promise<DataRegistryProviders> {
    const zkConfigProvider = await this._buildZkConfigProvider();
    const providers = await this._buildProviders(zkConfigProvider);
    const map = this._privateStateMap;
    const privateStateProvider = {
      get: (key: string) => Promise.resolve(map.get(key) ?? null),
      set: (key: string, state: unknown) => { map.set(key, state); return Promise.resolve(); },
    };
    return { ...providers, privateStateProvider } as unknown as DataRegistryProviders;
  }

  /**
   * Lazily initialize and return the DataRegistryAPI.
   * Joins the existing contract at the configured address.
   * Throws if no address is configured and no deployment has occurred.
   */
  private async _getAPI(): Promise<DataRegistryAPI> {
    if (this._api) return this._api;

    // Check wallet initialization early, before any provider building that could throw
    // unrelated errors (e.g., "Invalid URL" from empty WebSocket URL).
    if (this.walletMode === 'facade' && !this.facade) {
      throw new Error('[dStorage/midnight] Wallet not initialized. Call await chain.init() first.');
    }
    if (this.walletMode === 'connector' && !this.connectorAPI) {
      throw new Error('[dStorage/midnight] Connector not initialized. Call await chain.init() first.');
    }

    const addr = this._contractAddress ?? this.config.contractAddress;
    if (!addr) {
      throw new Error(
        '[dStorage/midnight] No contract address configured. ' +
          'Call sdk.init() to auto-deploy, or pass contractAddress in the adapter config.'
      );
    }

    // Seed the private state with the dust seed in facade mode for deterministic witness.
    if (this.walletMode === 'facade' && this.facadeDustSeed && !this._privateStateMap.has(dataRegistryPrivateStateKey)) {
      const { createDataRegistryPrivateState } = await import('./contracts/src/index.js');
      this._privateStateMap.set(dataRegistryPrivateStateKey, createDataRegistryPrivateState(this.facadeDustSeed.slice(0, 32)));
    }

    const providers = await this._buildDataRegistryProviders();
    const { DataRegistryAPI: API } = await import('./api.js');
    this._api = await API.join(providers, addr);
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

  // ── ChainAdapter implementation ────────────────────────────────────────────

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    const api = await this._getAPI();
    const encodedStorageId = await this._encodeStorageId(ref.storageId);
    const { refId, txHash, blockHeight } = await api.storeReference(encodedStorageId, ref.storageProvider);

    // Use circuit-computed refId if non-zero, otherwise fall back to txHash.
    const refIdHex = refId.some(b => b !== 0)
      ? Buffer.from(refId).toString('hex')
      : txHash;

    console.log(
      `[dStorage/midnight] Reference written at block ${blockHeight} → refId: ${refIdHex}`
    );

    return {
      refId: refIdHex,
      provider: 'midnight',
      blockHeight,
      writtenAt: Date.now(),
    };
  }

  /**
   * Encode a storage ID string as a 32-byte SHA-256 hash.
   * Used to fit arbitrary storage IDs (Arweave txId, etc.) into the contract's Bytes<32> field.
   */
  private async _encodeStorageId(id: string): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(id);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(hashBuffer);
  }

  async readReference(refId: string): Promise<ChainReference> {
    const api = await this._getAPI();
    const { firstValueFrom } = await import(/* @vite-ignore */ 'rxjs');
    const state = await (firstValueFrom as any)(api.state$);

    const entry = state.references.get(refId) as
      | { storageId: Uint8Array | string; storageProvider: string | Uint8Array }
      | undefined;

    if (!entry) {
      throw new Error(`[dStorage/midnight] No reference found on-chain for refId: ${refId}`);
    }

    const storageId = entry.storageId instanceof Uint8Array
      ? Buffer.from(entry.storageId).toString('hex')
      : String(entry.storageId);
    const storageProvider = typeof entry.storageProvider === 'string'
      ? entry.storageProvider
      : new TextDecoder().decode(entry.storageProvider as Uint8Array);

    return { storageId, storageProvider, owner: '', createdAt: 0 };
  }

  async listReferences(): Promise<Array<{ refId: string; ref: ChainReference }>> {
    const api = await this._getAPI();
    const { firstValueFrom } = await import(/* @vite-ignore */ 'rxjs');
    const state = await (firstValueFrom as any)(api.state$);

    const results: Array<{ refId: string; ref: ChainReference }> = [];
    for (const [refId, entry] of state.references as Map<string, unknown>) {
      const e = entry as { storageId: Uint8Array | string; storageProvider: string | Uint8Array };
      const storageId = e.storageId instanceof Uint8Array
        ? Buffer.from(e.storageId).toString('hex')
        : String(e.storageId);
      const storageProvider = typeof e.storageProvider === 'string'
        ? e.storageProvider
        : new TextDecoder().decode(e.storageProvider as Uint8Array);
      results.push({
        refId,
        ref: { storageId, storageProvider, owner: '', createdAt: 0 },
      });
    }
    return results;
  }

  // ── Generic circuit API (still part of ChainAdapter interface) ────────────

  async callCircuit(circuitName: string, _inputs: unknown[]): Promise<CircuitCallResult> {
    throw new Error(
      `[dStorage/midnight] callCircuit('${circuitName}') is not supported. ` +
        'Use the DataRegistry-specific methods (writeReference, listReferences) instead.'
    );
  }

  async queryCircuit<T = unknown>(_queryName: string, _inputs: unknown[]): Promise<T> {
    throw new Error(
      '[dStorage/midnight] queryCircuit() is not supported. ' +
        'Use listReferences() or readReference() to query DataRegistry state.'
    );
  }

  // ── DataRegistry deployment ────────────────────────────────────────────────

  /**
   * Deploy the DataRegistry contract and return the deployed address.
   *
   * In facade mode: uses the wallet's dust seed to seed the private state,
   *   which provides the localSecretKey witness during circuit execution.
   * In connector mode: deployment is not supported — pass contractAddress instead.
   *
   * Must be called after init() (facade mode).
   */
  async deployDataRegistry(): Promise<string> {
    if (this.walletMode === 'connector') {
      throw new Error(
        '[dStorage/midnight] deployDataRegistry() is not supported in connector mode.\n' +
          '  Deploy the DataRegistry contract manually and pass contractAddress in the adapter config.'
      );
    }

    if (!this.facade) {
      throw new Error('[dStorage/midnight] deployDataRegistry() called before init().');
    }

    // Seed private state with dust seed for deterministic witness execution.
    const { createDataRegistryPrivateState } = await import('./contracts/src/index.js');
    this._privateStateMap.set(
      dataRegistryPrivateStateKey,
      createDataRegistryPrivateState(this.facadeDustSeed!.slice(0, 32))
    );

    const providers = await this._buildDataRegistryProviders();
    const { DataRegistryAPI: API } = await import('./api.js');

    console.log('[dStorage/midnight] Deploying DataRegistry contract…');

    const api = await API.deploy(providers);
    this._api = api;
    this._contractAddress = api.deployedContractAddress;

    console.log(`[dStorage/midnight] DataRegistry deployed at: ${api.deployedContractAddress}`);
    return api.deployedContractAddress;
  }

  /**
   * Derive a deterministic AES-GCM encryption key from the adapter's credentials.
   * Only available in facade mode (where credentials are held by the adapter).
   * Throws in connector mode (credentials are held by the wallet extension).
   */
  async getEncryptionKey(): Promise<CryptoKey> {
    if (this.walletMode === 'facade' && this.config.credentials) {
      const { KeyDeriver } = await import('@dstorage/crypto');
      return new KeyDeriver(this.config.credentials).deriveEncryptionKey();
    }
    throw new Error(
      '[dStorage/midnight] getEncryptionKey() is not available in connector mode.\n' +
        '  Encryption key derivation requires wallet credentials (facade mode only).'
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
  async init(): Promise<WalletAddresses> {
    // Set global network ID (required by Midnight JS SDK)
    const { setNetworkId } = await import(/* @vite-ignore */ '@midnight-ntwrk/midnight-js-network-id');
    setNetworkId(this.config.network);

    if (this.walletMode === 'facade') {
      return this._initFacade();
    } else {
      return this._initConnector();
    }
  }

  /**
   * Initialize in facade mode: derive keys, build WalletFacade, wait for sync.
   */
  private async _initFacade(): Promise<WalletAddresses> {
    // Credentials are guaranteed by constructor validation
    const credentials = this.config.credentials!;

    // 1. Derive signing key seeds
    const { KeyDeriver } = await import('@dstorage/crypto');
    const deriver = new KeyDeriver(credentials);
    const { zswapSeed, dustSeed, nightExternalSeed } =
      await deriver.deriveMidnightSigningKeys();

    // 2. Derive typed secret keys
    const ledger = await import(/* @vite-ignore */ '@midnight-ntwrk/ledger-v7');
    const shieldedSecretKeys = (ledger as any).ZswapSecretKeys.fromSeed(zswapSeed);
    const dustSecretKey = (ledger as any).DustSecretKey.fromSeed(dustSeed);

    // Store raw hex public keys for walletProvider.getCoinPublicKey/getEncryptionPublicKey.
    this.facadeCoinPublicKey = shieldedSecretKeys.coinPublicKey as string;
    this.facadeEncPublicKey = shieldedSecretKeys.encryptionPublicKey as string;
    // Store 32-byte dust seed as a default witness key for the DataRegistry localSecretKey witness.
    this.facadeDustSeed = (dustSeed as Uint8Array).slice(0, 32);
    // Store full secret key objects for WalletFacade.balanceUnboundTransaction.
    this.facadeShieldedSecretKeys = shieldedSecretKeys;
    this.facadeDustSecretKey = dustSecretKey;

    // 3. Derive unshielded keystore
    const {
      createKeystore,
      InMemoryTransactionHistoryStorage,
      PublicKey: UnshieldedPublicKey,
      UnshieldedWallet,
    } = await import(/* @vite-ignore */ '@midnight-ntwrk/wallet-sdk-unshielded-wallet');
    const unshieldedKeystore = (createKeystore as any)(nightExternalSeed, this.config.network);

    // 4. Build wallet config
    const feeOverhead =
      this.config.network === 'undeployed'
        ? 500_000_000_000_000_000n
        : 300_000_000_000_000_000n;
    const walletCfg = {
      networkId: this.config.network,
      costParameters: { additionalFeeOverhead: feeOverhead, feeBlocksMargin: 5 },
      relayURL: new URL(this.config.nodeEndpoint),
      provingServerUrl: new URL(this.config.proofServerEndpoint),
      indexerClientConnection: {
        indexerHttpUrl: this.config.indexerEndpoint,
        indexerWsUrl: this.config.indexerWsEndpoint ?? '',
      },
      indexerUrl: this.config.indexerWsEndpoint ?? '',
    };

    // 5. Construct the three wallet parts
    const { ShieldedWallet } = await import(/* @vite-ignore */ '@midnight-ntwrk/wallet-sdk-shielded');
    const { DustWallet } = await import(/* @vite-ignore */ '@midnight-ntwrk/wallet-sdk-dust-wallet');

    const shielded = (ShieldedWallet as any)(walletCfg).startWithSecretKeys(shieldedSecretKeys);
    const dust = (DustWallet as any)(walletCfg).startWithSecretKey(
      dustSecretKey,
      (ledger as any).LedgerParameters.initialParameters().dust
    );
    const unshielded = (UnshieldedWallet as any)({
      ...walletCfg,
      txHistoryStorage: new (InMemoryTransactionHistoryStorage as any)(),
    }).startWithPublicKey(
      (UnshieldedPublicKey as any).fromKeyStore(unshieldedKeystore)
    );

    // 6. Start WalletFacade
    const { WalletFacade } = await import(/* @vite-ignore */ '@midnight-ntwrk/wallet-sdk-facade');
    const facade = new (WalletFacade as any)(shielded, unshielded, dust);
    await facade.start(shieldedSecretKeys, dustSecretKey);
    this.facade = facade;

    // 7. Derive wallet addresses from keys
    const {
      ShieldedCoinPublicKey,
      ShieldedEncryptionPublicKey,
      ShieldedAddress,
      DustAddress,
    } = await import(/* @vite-ignore */ '@midnight-ntwrk/wallet-sdk-address-format');

    const cpk = (ShieldedCoinPublicKey as any).fromHexString(
      shieldedSecretKeys.coinPublicKey
    );
    const epk = (ShieldedEncryptionPublicKey as any).fromHexString(
      shieldedSecretKeys.encryptionPublicKey
    );
    this.addresses = {
      unshielded: unshieldedKeystore.getBech32Address().toString(),
      shielded: (ShieldedAddress as any).codec
        .encode(this.config.network, new (ShieldedAddress as any)(cpk, epk))
        .toString(),
      dust: (DustAddress as any).encodePublicKey(this.config.network, dustSecretKey.publicKey),
    };

    // 8. Wait for wallet sync with indexer (60 s timeout)
    const { firstValueFrom, filter, timeout } = await import(/* @vite-ignore */ 'rxjs');
    try {
      await (firstValueFrom as any)(
        facade.state().pipe(
          filter((s: { isSynced?: boolean }) => s.isSynced === true),
          (timeout as any)(60_000)
        )
      );
    } catch (err) {
      const isTimeout = (err as any)?.name === 'TimeoutError';
      if (isTimeout) {
        throw new Error(
          '[dStorage/midnight] Wallet sync timed out after 60 s.\n' +
          '  Make sure the Midnight node and indexer are running:\n' +
          `  Node:    ${this.config.nodeEndpoint}\n` +
          `  Indexer: ${this.config.indexerEndpoint}`
        );
      }
      throw err;
    }

    return this.addresses;
  }

  /**
   * Initialize in connector mode: connect to browser wallet extension.
   *
   * Discovers available wallets by enumerating window.midnight, as per the
   * dApp connector spec: https://docs.midnight.network/api-reference/dapp-connector
   */
  private async _initConnector(): Promise<WalletAddresses> {
    const windowAny = typeof window !== 'undefined' ? (window as any) : null;
    const midnightObj = windowAny?.midnight;

    if (!midnightObj || typeof midnightObj !== 'object') {
      throw new Error(
        '[dStorage/midnight] window.midnight is not available.\n' +
          '  No Midnight wallet extension detected. Install Midnight Lace or another compatible wallet.'
      );
    }

    // Discover all wallets injected at window.midnight.{walletId}
    const availableWallets = Object.entries(midnightObj)
      .filter(([, v]) => v && typeof v === 'object' && typeof (v as any).connect === 'function')
      .map(([id, v]) => ({ id, wallet: v as { name?: string; apiVersion?: string; connect: (networkId: string) => Promise<ConnectedAPI> } }));

    if (availableWallets.length === 0) {
      throw new Error(
        '[dStorage/midnight] No compatible wallets found at window.midnight.\n' +
          '  Install a Midnight-compatible wallet extension (e.g., Midnight Lace).'
      );
    }

    console.log(
      `[dStorage/midnight] Found ${availableWallets.length} wallet(s): ` +
        availableWallets.map(w => `${w.id} (${w.wallet.name ?? 'unknown'})`).join(', ')
    );

    // Select the wallet: prefer the configured connectorName, otherwise use the first available
    let selected = availableWallets.find(w => w.id === this.connectorName);
    if (!selected) {
      console.warn(
        `[dStorage/midnight] Configured wallet "${this.connectorName}" not found. ` +
          `Using first available: "${availableWallets[0]!.id}"`
      );
      selected = availableWallets[0]!;
    }

    console.log(
      `[dStorage/midnight] Connecting to wallet "${selected.id}" ` +
        `(name: ${selected.wallet.name ?? 'unknown'}, apiVersion: ${selected.wallet.apiVersion ?? 'unknown'}) ` +
        `on network "${this.config.network}"...`
    );

    // Step 1: Connect to the wallet extension
    let connectedAPI: ConnectedAPI;
    try {
      connectedAPI = await selected.wallet.connect(this.config.network);
      this.connectorAPI = connectedAPI;
    } catch (err) {
      throw new Error(
        `[dStorage/midnight] Failed to connect to wallet "${selected.id}": ` +
          (err instanceof Error ? err.message : String(err))
      );
    }

    console.log(`[dStorage/midnight] ✓ Connected to wallet "${selected.id}"`);

    // Step 2: Retrieve wallet configuration (respects user preferences for proof server, indexer, etc.)
    try {
      const walletConfig = await connectedAPI.getConfiguration();
      console.log('[dStorage/midnight] Wallet configuration:', walletConfig);
      this.connectorIndexerHttp = walletConfig.indexerUri ?? this.config.indexerEndpoint;
      this.connectorIndexerWs = walletConfig.indexerWsUri ?? this.config.indexerWsEndpoint ?? null;
      this.connectorProofServer = walletConfig.proverServerUri ?? this.config.proofServerEndpoint;
    } catch (err) {
      console.warn(
        '[dStorage/midnight] Failed to retrieve wallet configuration:',
        err instanceof Error ? err.message : String(err)
      );
    }

    // Step 3: Extract addresses from connector
    try {
      let shieldedAddr = '';
      try {
        const r = await connectedAPI.getShieldedAddresses();
        const obj = Array.isArray(r) ? r[0] : r;
        shieldedAddr = (obj as any)?.shieldedAddress ?? (obj as any)?.address ?? (typeof obj === 'string' ? obj : '');
        this.connectorCoinPublicKey = (obj as any)?.shieldedCoinPublicKey ?? null;
        this.connectorEncPublicKey = (obj as any)?.shieldedEncryptionPublicKey ?? null;
      } catch (err) {
        console.warn('[dStorage/midnight] getShieldedAddresses() failed:', err);
      }

      let unshieldedAddr = '';
      try {
        const r = await (connectedAPI as any).getUnshieldedAddress?.();
        unshieldedAddr = (r as any)?.unshieldedAddress ?? (typeof r === 'string' ? r : '');
      } catch {
        console.warn('[dStorage/midnight] Could not retrieve unshielded address');
      }

      let dustAddr = '';
      try {
        const r = await (connectedAPI as any).getDustAddress?.();
        dustAddr = (r as any)?.dustAddress ?? (typeof r === 'string' ? r : '');
      } catch {
        console.warn('[dStorage/midnight] Could not retrieve dust address');
      }

      if (!shieldedAddr && !unshieldedAddr && !dustAddr) {
        throw new Error('No addresses available from wallet');
      }

      this.addresses = {
        shielded: shieldedAddr,
        unshielded: unshieldedAddr,
        dust: dustAddr,
      };

      console.log('[dStorage/midnight] Wallet addresses:', {
        shielded: shieldedAddr ? `${shieldedAddr.slice(0, 20)}…` : '(none)',
        unshielded: unshieldedAddr ? `${unshieldedAddr.slice(0, 20)}…` : '(none)',
        dust: dustAddr ? `${dustAddr.slice(0, 20)}…` : '(none)',
      });
      return this.addresses;
    } catch (err) {
      throw new Error(
        `[dStorage/midnight] Failed to extract addresses from wallet: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }

  /**
   * Return wallet addresses derived during init().
   * Throws if init() not yet called.
   */
  getAddresses(): WalletAddresses {
    if (!this.addresses) {
      throw new Error('[dStorage/midnight] getAddresses() called before init().');
    }
    return this.addresses;
  }

  /**
   * Read NIGHT and DUST balances.
   * - Facade mode: reads from synced wallet state
   * - Connector mode: returns 0n (known limitation)
   */
  async getBalances(): Promise<WalletBalances> {
    if (this.walletMode === 'facade') {
      if (!this.facade) {
        throw new Error('[dStorage/midnight] getBalances() called before init().');
      }

      const { firstValueFrom } = await import(/* @vite-ignore */ 'rxjs');
      const ledger = await import(/* @vite-ignore */ '@midnight-ntwrk/ledger-v7');

      const state = await (firstValueFrom as any)(
        ((this.facade as any).state as () => any)()
      );
      const nightToken = (ledger as any).unshieldedToken();

      return {
        night: (state as any).unshielded?.balances?.[nightToken.raw] ?? 0n,
        dust: (state as any).dust?.walletBalance?.(new Date()) ?? 0n,
      };
    } else {
      if (!this.connectorAPI) {
        throw new Error('[dStorage/midnight] getBalances() called before init().');
      }
      return {
        night: 0n,
        dust: 0n,
      };
    }
  }

  /**
   * Stop the wallet and release resources. No-op if init() was never called.
   * - Facade mode: stops the WalletFacade
   * - Connector mode: disconnects from the browser wallet (if available)
   */
  async stop(): Promise<void> {
    if (this.walletMode === 'facade') {
      if (!this.facade) return;

      const stopFn = ((this.facade as any).stop as (() => Promise<void>) | undefined);
      await Promise.race([
        stopFn?.() ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]).catch(() => undefined);

      this.facade = null;
      this.facadeCoinPublicKey = null;
      this.facadeEncPublicKey = null;
      this.facadeDustSeed = null;
      this.facadeShieldedSecretKeys = null;
      this.facadeDustSecretKey = null;
    } else {
      if (this.connectorAPI && typeof (this.connectorAPI as any).disconnect === 'function') {
        try {
          await (this.connectorAPI as any).disconnect();
        } catch {
          // Ignore disconnection errors
        }
      }
      this.connectorAPI = null;
    }

    // Reset DataRegistry API state
    this._api = null;
    this._privateStateMap.clear();
    this.addresses = null;
  }
}
