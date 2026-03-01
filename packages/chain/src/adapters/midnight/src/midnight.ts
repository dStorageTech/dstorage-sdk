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
} from '../../../types.js';

import path from 'node:path';
import type { DataRegistryAPI, PrivateStateId } from './api.js';
import type { DataRegistryProviders } from './common-types.js';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { DataRegistryPrivateState} from '../contracts/src/index.js';
import { type WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { MidnightWalletProvider } from './wallet-provider';
import { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { firstValueFrom } from 'rxjs';
import { waitForUnshieldedFunds } from './wallet-utils';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v7';
import { ShieldedAddress, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

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
  network: 'preprod' | 'undeployed';
}

export type MidnightChainAdapterConfig = BaseConfig & (
  | {
      /**
       * Wallet mode. Default: 'facade' (uses wallet-sdk-facade for Node.js CLI).
       * Set to 'connector' to use browser wallet extension (e.g., Midnight Lace).
       */
      walletMode: 'facade';
      /**
       * Wallet credentials. Provide exactly one of mnemonic or seedHex.
       * Used by init() to derive Midnight signing keys in facade mode.
       * Required only when walletMode is 'facade'.
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
  readonly providerName: string = 'Midnight';

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
  private _zkArtifactsPath: string | undefined;
  private _initialized = false;

  // DataRegistry API — lazily initialized by _getAPI().
  // Reset to null when contract address changes (setContractAddress) or on stop().
  private _api: DataRegistryAPI | null = null;

  private readonly _credentials: { mnemonic?: string; seedHex?: string };

  private readonly config: EnvironmentConfiguration;

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
    this._credentials = (walletMode === 'facade' && 'credentials' in config) ? config.credentials : {};
    this._zkArtifactsPath = (walletMode === 'facade' && 'zkArtifactsPath' in config)
      ? (config as Extract<MidnightChainAdapterConfig, { walletMode: 'facade' }>).zkArtifactsPath
      : undefined;

    /*
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
    */
    this.config = {
      walletNetworkId: config.network,
      networkId: config.network,
      indexer: config.indexerEndpoint,
      indexerWS: config.indexerWsEndpoint,
      node: config.nodeEndpoint,
      nodeWS: config.nodeWsEndpoint,
      faucet: 'https://faucet.preprod.midnight.network/api/request-tokens',
      proofServer: config.proofServerEndpoint
    };
  }

  // ── ZK config provider ─────────────────────────────────────────────────────

  /**
   * Build a mode-specific ZK config provider.
   *
   * Facade (Node.js): reads ZK artifact files from the local filesystem via zkArtifactsPath.
   * Connector (browser): fetches ZK artifacts over HTTP via zkConfigBaseUrl.
   */
  private async _buildZkConfigProvider(): Promise<NodeZkConfigProvider<'storeReference'>> {
    if (!this._zkArtifactsPath) {
      throw new Error(
        '[dStorage/midnight] zkArtifactsPath is required in facade mode.\n' +
          '  Set it to the directory containing keys/ and zkir/ from the compiled DataRegistry contract.\n' +
          '  Example: zkArtifactsPath: path.resolve(__dirname, \'../packages/chain/src/adapters/midnight/contracts/dataregistry/managed\')'
      );
    }
    const zkConfigPath = this._zkArtifactsPath;
    console.log(`[dStorage/midnight] ZK artifacts path: ${zkConfigPath}`);

    return new NodeZkConfigProvider<'storeReference'>(zkConfigPath);

    /*if (this.walletMode === 'facade') {
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
    */
  }

  /**
   * Build the full set of Midnight providers needed by DataRegistryAPI.
   */
  /*
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
      const ledger = await import(/* @vite-ignore  '@midnight-ntwrk/ledger-v7');
/*
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
  */

  /**
   * Build a DataRegistryProviders object by combining the Midnight providers
   * (wallet, proof server, indexer, node) with an in-memory private state store.
   */
  private async _buildDataRegistryProviders(): Promise<DataRegistryProviders> {
    const zkConfigProvider = await this._buildZkConfigProvider();

    const walletProvider = await MidnightWalletProvider.build(this.config, this._credentials.seedHex);
    //providersToBeStopped.push(walletProvider);
    const walletFacade: WalletFacade = walletProvider.wallet;
    await walletProvider.start();

    const unshieldedState = await waitForUnshieldedFunds(
      walletFacade,
      this.config,
      unshieldedToken(),
      false
    );
    const nightBalance = unshieldedState.balances[unshieldedToken().raw];
    if (nightBalance === undefined) {
      console.log('No funds received, exiting...');
      throw new Error('[dStorage/midnight] No NIGHT funds received/detected.');
    }
    console.log(`Your NIGHT wallet balance is: ${nightBalance}`);

    const facadeState = await firstValueFrom((walletFacade as any).state() as any);
    this.addresses = {
      shielded: ShieldedAddress.codec.encode(getNetworkId(), (facadeState as any).shielded.address).toString(),
      unshielded: UnshieldedAddress.codec.encode(getNetworkId(), (facadeState as any).unshielded.address).toString(),
      dust: (facadeState as any).dust.dustAddress,
    };

    const privateStateStoreName = 'data-registry-private-state';
    const basePrivateStateProvider = levelPrivateStateProvider<PrivateStateId, DataRegistryPrivateState>({
      privateStateStoreName,
      signingKeyStoreName: `${privateStateStoreName}-signing-keys`,
      privateStoragePasswordProvider: () => {
        return 'key-just-for-testing-here!';
      },
    });
    // midnight-js-contracts calls setContractAddress() which is not yet in the
    // levelPrivateStateProvider implementation — add a no-op shim.
    const privateStateProvider = Object.assign(basePrivateStateProvider, {
      setContractAddress: (_address: string) => { /* no-op: levelDb scopes by privateStateId */ },
    });
    const providers: DataRegistryProviders = {
      privateStateProvider: privateStateProvider as unknown as DataRegistryProviders['privateStateProvider'],
      publicDataProvider: indexerPublicDataProvider(this.config.indexer, this.config.indexerWS),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(this.config.proofServer, zkConfigProvider as any),
      walletProvider: walletProvider as unknown as DataRegistryProviders['walletProvider'],
      midnightProvider: walletProvider,
    };

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
      throw new Error('[dStorage/midnight] Not initialized. Call await chain.init() first.');
    }

    const providers = await this._buildDataRegistryProviders();
    
    const { DataRegistryAPI } = await import('./api.js');
    if (!this._contractAddress) {
      console.log('[dStorage/midnight] Deploying DataRegistry contract…');
      this._api = await DataRegistryAPI.deploy(providers);
      this._contractAddress = this._api.deployedContractAddress;
      console.log(`[dStorage/midnight] DataRegistry deployed at: ${this._contractAddress}`);
    } else {
      this._api = await DataRegistryAPI.join(providers, this._contractAddress);
      console.log(`[dStorage/midnight] DataRegistry joined at: ${this._contractAddress}`);
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
    return this._contractAddress ?? '';
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

  // ── DataRegistry deployment ────────────────────────────────────────────────

  /**
   * Derive a deterministic AES-GCM encryption key from the adapter's credentials.
   * Only available in facade mode (where credentials are held by the adapter).
   * Throws in connector mode (credentials are held by the wallet extension).
   */
  async getEncryptionKey(): Promise<CryptoKey> {
    if (this.walletMode === 'facade' && this._credentials) {
      const { KeyDeriver } = await import('@dstorage/crypto');
      return new KeyDeriver(this._credentials).deriveEncryptionKey();
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
  async init(): Promise<string> {
    this._initialized = true;

    // Set global network ID (required by Midnight JS SDK)
    const { setNetworkId } = await import(/* @vite-ignore */ '@midnight-ntwrk/midnight-js-network-id');
    setNetworkId(this.config.networkId);

    await this._getAPI();

    /*if (this.walletMode === 'facade') {     
      return this._initFacade();
    } else {
      return this._initConnector();
    }*/

    return this._contractAddress ?? '';
  }

  /**
   * Initialize in facade mode: derive keys, build WalletFacade, wait for sync.
   */
  private async _initFacade(): Promise<WalletAddresses> {
    return {
      shielded: 'shieldedAddr',
      unshielded: 'unshieldedAddr',
      dust: 'dustAddr',
    };
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
        `on network "${this.config.networkId}"...`
    );

    // Step 1: Connect to the wallet extension
    let connectedAPI: ConnectedAPI;
    try {
      connectedAPI = await selected.wallet.connect(this.config.networkId);
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
      this.connectorIndexerHttp = walletConfig.indexerUri ?? this.config.indexer;
      this.connectorIndexerWs = walletConfig.indexerWsUri ?? this.config.indexerWS ?? null;
      this.connectorProofServer = walletConfig.proverServerUri ?? this.config.proofServer;
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

      const state = await firstValueFrom(
        (this.facade as any).state() as any
      );
      const nightToken = unshieldedToken();

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
}
