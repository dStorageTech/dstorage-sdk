/**
 * @dstorage/chain — adapters/midnight.ts
 *
 * Real Midnight Network chain adapter.
 *
 * Talks to a deployed contract on the Midnight network using the Midnight.js SDK.
 * Each write operation follows the standard Midnight flow:
 *   1. Build  — construct the unproven circuit call
 *   2. Prove  — send to proof server for ZK proof generation
 *   3. Balance — attach DUST fees via the connected wallet
 *   4. Submit — broadcast to the Midnight node
 *   5. Confirm — wait for block inclusion
 *
 * The adapter dynamically imports '@midnight-ntwrk/midnight-js-contracts' at
 * runtime to avoid hard build failures when the peer dependency is not installed.
 * A clear error is thrown if the SDK is absent when a live network call is made.
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

// ── Internal types ────────────────────────────────────────────────────────────

/** Decode a null-padded fixed-size byte array to a UTF-8 string. */
function trimNull(bytes: Uint8Array): string {
  const nullIdx = bytes.indexOf(0);
  return new TextDecoder().decode(nullIdx >= 0 ? bytes.slice(0, nullIdx) : bytes);
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
   * Needed when using indexerPublicDataProvider for contract state queries.
   * Example: wss://indexer.preprod.midnight.network/api/v3/graphql/ws
   */
  indexerWsEndpoint?: string;
  /**
   * Proof server URL.
   * Default: http://localhost:6300 (local proof server).
   */
  proofServerEndpoint?: string;
  /**
   * On-chain address of the deployed contract.
   * Optional — if omitted, call deployDataRegistry() (or sdk.init()) to deploy a new contract.
   */
  contractAddress?: string;
  /**
   * Compiled contract output from compactc.
   *
   * Preferred: pass the **full module** (all named exports).
   * E.g.: `import * as compiledContract from './contracts/managed/todoList/contract/index.js'`
   *
   * The full module contains both the `Contract` class (used for tx calls) and the
   * `ledger()` function (used by `listReferences()` to decode on-chain state).
   *
   * Legacy: passing just the `Contract` class still works for write/read/grant operations
   * but `listReferences()` will throw if the `ledger` function is absent.
   */
  compiledContract: object;
  /**
   * Target network. Controls wallet networkId, address format, and fee overhead.
   */
  network: 'testnet' | 'preprod' | 'undeployed';
  /**
   * Witnesses for the compiled contract's circuit execution.
   *
   * Compact contracts may declare `witness` functions — callbacks that provide private
   * off-chain data (e.g. a secret key) during circuit execution. The object keys must
   * match the witness names declared in the `.compact` file.
   *
   * Each witness function receives a `WitnessContext` and must return a tuple of
   * `[updatedPrivateState, witnessReturnValue]`.
   *
   * In facade mode (Node.js), the adapter auto-provides a `localSecretKey` witness
   * derived from the wallet's dust seed when no witnesses are configured. This covers
   * the bboard-style contract pattern. For all other contracts, or if you need a
   * different key, pass explicit witnesses here.
   *
   * @example
   * witnesses: {
   *   localSecretKey: (ctx) => [ctx.privateState, mySecretKeyBytes],
   * }
   */
  witnesses?: Record<string, (...args: unknown[]) => unknown>;

  /**
   * Optional remapping from built-in operation names to the actual circuit names
   * used in your compiled contract.
   *
   * Useful when your contract uses different function names than the SDK defaults,
   * e.g. `storeInsuranceRecord` instead of `storeReference`.
   *
   * Omitted keys fall back to the SDK defaults.
   *
   * @example
   * circuitNames: {
   *   writeReference: 'saveRecord',
   *   grantAccess:    'allowViewer',
   * }
   */
  circuitNames?: {
    writeReference?: string; // default: 'storeReference'
    grantAccess?:    string; // default: 'grantAccess'
    revokeAccess?:   string; // default: 'revokeAccess'
    hasAccess?:      string; // default: 'hasAccess'
    readReference?:  string; // default: 'getReference'
  };
  /**
   * Optional mapper that converts a ChainReference into the argument list
   * expected by the write circuit.
   *
   * Default behaviour passes 4 string args: (storageId, storageProvider, owner, dataLabel).
   * Use this when your contract's write circuit has a different signature — for
   * example, bboard's `post(newMessage)` takes a single string argument.
   *
   * @example
   * circuitArgMapper: (ref) => [JSON.stringify(ref)]  // bboard: single JSON string
   */
  circuitArgMapper?: (ref: ChainReference) => unknown[];
  /**
   * Decodes the hex-encoded contract state (returned by the indexer) into a
   * `ChargedState` that can be passed to the compiled contract's `ledger()` function.
   *
   * Required for ledger read operations (`readLedgerEntry`, `listReferences`) because
   * `@midnight-ntwrk/compact-runtime` must be imported from the consumer's module context
   * — the package resolution starting from `@dstorage/chain`'s install location may not
   * find it.
   *
   * @example
   * ```ts
   * import { ContractState } from '@midnight-ntwrk/compact-runtime';
   *
   * new MidnightChainAdapter({
   *   ...
   *   stateDecoder: (hexState) =>
   *     ContractState.deserialize(Buffer.from(hexState, 'hex')).data,
   * });
   * ```
   */
  stateDecoder?(hexState: string): unknown;
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
       * Path to the directory that contains the compiled contract's ZK artifacts.
       * Expected sub-directories:
       *   ${zkArtifactsPath}/keys/${circuitId}.prover
       *   ${zkArtifactsPath}/keys/${circuitId}.verifier
       *   ${zkArtifactsPath}/zkir/${circuitId}.bzkir
       *
       * Required for circuit calls (callCircuit, writeReference, etc.) in facade mode.
       * Typically the parent directory that compactc writes `keys/` and `zkir/` into.
       *
       * @example
       * import { fileURLToPath } from 'node:url';
       * import path from 'node:path';
       * const __dirname = path.dirname(fileURLToPath(import.meta.url));
       * // zkArtifactsPath: path.resolve(__dirname, '../contracts/managed/bboard')
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
       * Base URL from which the ZK artifacts (keys/*, zkir/*) for the compiled
       * contract are served. Must be an absolute http/https URL.
       *
       * The adapter fetches:
       *   ${zkConfigBaseUrl}/keys/${circuitId}.verifier
       *   ${zkConfigBaseUrl}/keys/${circuitId}.prover
       *   ${zkConfigBaseUrl}/zkir/${circuitId}.bzkir
       *
       * In Vite apps copy the compiled contract's `keys/` and `zkir/` directories
       * to `public/` and set this to `window.location.origin`.
       *
       * Required for circuit calls (writeReference, grantAccess, etc.) in connector mode.
       */
      zkConfigBaseUrl?: string;
    }
);

// ── Circuit name defaults ───────────────────────────────────────────────────────

const CIRCUIT_DEFAULTS = {
  writeReference: 'storeReference',
  readReference:  'getReference',
} as const;

// ── Internal Midnight SDK types (minimal surface needed) ───────────────────────

// Shape returned by the indexer's contractAction GraphQL query.
interface IndexerContractAction {
  address: string;
  state: string; // hex-encoded serialised ledger state
}

interface TxReceipt {
  txHash: string;
  blockHeight: number;
  /** Circuit-computed return value (e.g. refId from storeReference). */
  circuitResult?: Uint8Array;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class MidnightChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = 'midnight';

  private facade: unknown | null = null;
  private connectorAPI: ConnectedAPI | null = null;
  private addresses: WalletAddresses | null = null;

  // Facade mode: shielded public keys and dust seed derived during _initFacade().
  // Required by _submitCircuitCall for circuit execution.
  private facadeCoinPublicKey: string | null = null;
  private facadeEncPublicKey: string | null = null;
  private facadeDustSeed: Uint8Array | null = null;
  // Full secret key objects needed for balanceTx (WalletFacade.balanceUnboundTransaction).
  private facadeShieldedSecretKeys: unknown | null = null;
  private facadeDustSecretKey: unknown | null = null;

  // Connector mode: shielded wallet keys retrieved from Lace during init().
  // Required by createUnprovenCallTx for circuit execution.
  private connectorCoinPublicKey: string | null = null;
  private connectorEncPublicKey: string | null = null;
  // Connector mode: endpoints from wallet configuration (may differ from config defaults).
  private connectorIndexerHttp: string | null = null;
  private connectorIndexerWs: string | null = null;
  private connectorProofServer: string | null = null;

  private readonly walletMode: 'facade' | 'connector';
  private readonly connectorName: string;

  private _contractAddress: string | undefined;

  private readonly config: {
    nodeEndpoint: string;
    indexerEndpoint: string;
    indexerWsEndpoint?: string;
    proofServerEndpoint: string;
    contractAddress?: string;
    compiledContract: object;
    network: 'testnet' | 'preprod' | 'undeployed';
    credentials?: { mnemonic?: string; seedHex?: string };
    circuitNames?: MidnightChainAdapterConfig['circuitNames'];
    circuitArgMapper?: MidnightChainAdapterConfig['circuitArgMapper'];
    stateDecoder?: MidnightChainAdapterConfig['stateDecoder'];
    witnesses?: MidnightChainAdapterConfig['witnesses'];
    zkConfigBaseUrl?: string;   // connector mode
    zkArtifactsPath?: string;   // facade mode
  };

  constructor(config: MidnightChainAdapterConfig) {
    if (config.contractAddress !== undefined && !config.contractAddress) {
      throw new Error(
        '[dStorage/midnight] contractAddress is required. ' +
          'Deploy your compiled contract to Midnight and pass the address, ' +
          'or omit it to auto-deploy via deployDataRegistry().'
      );
    }
    if (!config.compiledContract) {
      throw new Error(
        '[dStorage/midnight] compiledContract is required. ' +
          'Import the compactc output and pass the contract class/object here.'
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
      compiledContract: config.compiledContract,
      network: config.network,
      ...(walletMode === 'facade' && 'credentials' in config ? { credentials: config.credentials } : {}),
      ...(config.circuitNames !== undefined ? { circuitNames: config.circuitNames } : {}),
      ...(config.circuitArgMapper !== undefined ? { circuitArgMapper: config.circuitArgMapper } : {}),
      ...(config.stateDecoder !== undefined ? { stateDecoder: config.stateDecoder } : {}),
      ...(config.witnesses !== undefined ? { witnesses: config.witnesses } : {}),
      ...(walletMode === 'connector' && 'zkConfigBaseUrl' in config && config.zkConfigBaseUrl !== undefined
        ? { zkConfigBaseUrl: config.zkConfigBaseUrl }
        : {}),
      ...(walletMode === 'facade' && 'zkArtifactsPath' in config && (config as any).zkArtifactsPath !== undefined
        ? { zkArtifactsPath: (config as any).zkArtifactsPath }
        : {}),
    };
  }

  // ── Indexer helpers ────────────────────────────────────────────────────────

  /**
   * Query the Midnight indexer for the latest state of the configured contract.
   *
   * Uses a plain GraphQL HTTP POST (native `fetch`) — no extra client library needed.
   * Returns `null` when the indexer has no record of the contract address (i.e. the
   * contract hasn't been deployed, or the address is wrong).
   *
   * Throws with a descriptive message when the indexer is unreachable or returns
   * a GraphQL error.
   */
  async fetchIndexerContractState(): Promise<IndexerContractAction | null> {
    const query = `{ contractAction(address: "${this._effectiveContractAddress()}") { address state } }`;

    let response: Response;
    try {
      response = await fetch(this.config.indexerEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[dStorage/midnight] Cannot reach indexer at ${this.config.indexerEndpoint}: ${msg}\n` +
          `  Is the Midnight indexer running?`
      );
    }

    if (!response.ok) {
      throw new Error(
        `[dStorage/midnight] Indexer returned HTTP ${response.status} ${response.statusText}`
      );
    }

    const json = (await response.json()) as {
      data?: { contractAction: IndexerContractAction | null };
      errors?: { message: string }[];
    };

    if (json.errors?.length) {
      throw new Error(
        `[dStorage/midnight] Indexer query error: ${json.errors.map((e) => e.message).join(', ')}`
      );
    }

    return json.data?.contractAction ?? null;
  }

  /**
   * Build a mode-specific ZK config provider.
   *
   * Facade (Node.js): reads ZK artifact files from the local filesystem via zkArtifactsPath.
   * Connector (browser): fetches ZK artifacts over HTTP via zkConfigBaseUrl.
   *
   * The ZK config provider is shared between createUnprovenCallTx (local simulation) and
   * httpClientProofProvider (which sends ZKIR to the proof server for actual proving).
   */
  private async _buildZkConfigProvider(): Promise<unknown> {
    if (this.walletMode === 'facade') {
      const zkArtifactsPath = this.config.zkArtifactsPath;
      if (!zkArtifactsPath) {
        throw new Error(
          '[dStorage/midnight] zkArtifactsPath is required in facade mode to load ZK artifacts.\n' +
            '  Set it to the directory containing the compiled contract\'s keys/ and zkir/ subdirectories.\n' +
            '  Example: zkArtifactsPath: path.resolve(__dirname, \'../contracts/managed/bboard\')'
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
   * Build a CompiledContract with the correct TypeId (via CompiledContract.make) and witnesses.
   *
   * submitCallTx / createUnprovenCallTx require a CompiledContract built via
   * CompiledContract.make() from @midnight-ntwrk/compact-js — not the raw module or Contract
   * class. The TypeId symbol must be set via make(), otherwise getContractContext() returns
   * undefined and circuit execution throws "Cannot read properties of undefined (reading 'ctor')".
   */
  private async _buildCompiledContract(): Promise<unknown> {
    const rawModule = this.config.compiledContract as {
      Contract?: new (...args: unknown[]) => unknown;
      [key: string]: unknown;
    };
    const ContractCtor = rawModule.Contract;
    if (!ContractCtor) {
      throw new Error(
        '[dStorage/midnight] compiledContract does not export a Contract class.\n' +
          '  Pass the full module: import * as compiledContract from "./contract/index.js"'
      );
    }

    let CompiledContractModule: {
      make: (tag: string, ctor: unknown) => unknown;
      withWitnesses: (self: unknown, witnesses: unknown) => unknown;
      withVacantWitnesses: (self: unknown) => unknown;
    };
    try {
      const mod = await import('@midnight-ntwrk/compact-js');
      CompiledContractModule = (mod as any).CompiledContract;
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        '[dStorage/midnight] @midnight-ntwrk/compact-js is not installed.\n' +
          '  Run: npm install @midnight-ntwrk/compact-js\n' +
          `  Cause: ${cause}`
      );
    }

    const tag = (ContractCtor as { name?: string }).name ?? this._contractAddress ?? this.config.contractAddress ?? 'DataRegistry';
    let compiledContract: unknown = CompiledContractModule.make(tag, ContractCtor);

    const configWitnesses = this.config.witnesses;
    if (configWitnesses && Object.keys(configWitnesses).length > 0) {
      compiledContract = CompiledContractModule.withWitnesses(compiledContract, configWitnesses);
    } else if (this.walletMode === 'facade' && this.facadeDustSeed) {
      // Auto-provide a localSecretKey witness in facade mode using the wallet's dust seed.
      // This covers bboard-style contracts. For other contracts, pass explicit witnesses.
      const seed = this.facadeDustSeed;
      compiledContract = CompiledContractModule.withWitnesses(compiledContract, {
        localSecretKey: (ctx: unknown) => [(ctx as { privateState: unknown }).privateState, seed],
      });
    } else {
      compiledContract = CompiledContractModule.withVacantWitnesses(compiledContract);
    }

    return compiledContract;
  }

  /**
   * Build the full set of Midnight providers needed by submitCallTx.
   *
   * Providers:
   *   publicDataProvider  — indexer client for querying contract + zswap state
   *   zkConfigProvider    — ZK artifact loader (filesystem in facade, HTTP in connector)
   *   proofProvider       — HTTP client that sends unproven tx to proof server for ZK proofs
   *   walletProvider      — balance transactions + provide coin/enc public keys
   *   midnightProvider    — submit finalized transactions to the network node
   *
   * @param zkConfigProvider Built by _buildZkConfigProvider(); shared with proof provider.
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
          // Serialize the unbound (proven, unbalanced) tx and send to Lace wallet for balancing.
          // Lace returns a finalized (proven + balanced + signed) transaction.
          const serializedTx = toHex((tx as any).serialize());
          const received = await connectorAPI.balanceUnsealedTransaction(serializedTx);
          // Handle both string and { tx: string } return types across different wallet versions.
          const balancedHex = typeof received === 'string' ? received : received.tx;
          return (ledger as any).Transaction.deserialize(
            'signature', 'proof', 'binding',
            fromHex(balancedHex)
          );
        },
      };
      const midnightProvider = {
        submitTx: async (tx: unknown) => {
          // Submit the finalized transaction via Lace connector and extract the txId.
          await connectorAPI.submitTransaction(toHex((tx as any).serialize()));
          return (tx as any).identifiers()[0];
        },
      };

      return { publicDataProvider, zkConfigProvider, proofProvider, walletProvider, midnightProvider };
    }
  }

  /**
   * Submit a circuit call through the full Midnight transaction pipeline:
   *   1. Build CompiledContract with witnesses
   *   2. Build all providers (zkConfig, proof server, wallet, indexer, node)
   *   3. Call submitCallTx from @midnight-ntwrk/midnight-js-contracts which:
   *      a. Creates the unproven transaction locally
   *      b. Sends it to the proof server for ZK proof generation
   *      c. Balances via the wallet (attaches DUST fees)
   *      d. Submits to the Midnight node
   *      e. Waits for on-chain finalization
   *
   * Works in both facade (Node.js) and connector (browser dApp) modes.
   */
  private async _submitCircuitCall(circuitId: string, args: unknown[]): Promise<TxReceipt> {
    const zkConfigProvider = await this._buildZkConfigProvider();
    const providers = await this._buildProviders(zkConfigProvider);
    const compiledContract = await this._buildCompiledContract();

    let submitCallTx: (providers: unknown, options: unknown) => Promise<{ public: { txId: string } }>;
    try {
      const mod = await import('@midnight-ntwrk/midnight-js-contracts');
      submitCallTx = (mod as any).submitCallTx;
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        '[dStorage/midnight] @midnight-ntwrk/midnight-js-contracts is not installed.\n' +
          '  Run: npm install @midnight-ntwrk/midnight-js-contracts\n' +
          `  Cause: ${cause}`
      );
    }

    const result = await submitCallTx(providers, {
      compiledContract,
      contractAddress: this._effectiveContractAddress(),
      circuitId,
      args,
    });

    // Extract circuit-computed return value if available (e.g. refId from storeReference)
    const circuitResult = (result as any).private?.result;

    return {
      txHash: result.public.txId,
      blockHeight: 0,
      ...(circuitResult instanceof Uint8Array ? { circuitResult } : {}),
    };
  }

  // ── Contract address management ────────────────────────────────────────────

  /**
   * Set the contract address to use for subsequent operations.
   * Called by the SDK after deploy or when connecting to an existing contract.
   */
  setContractAddress(address: string): void {
    this._contractAddress = address;
  }

  /**
   * Returns the effective contract address, throwing a descriptive error if
   * neither the config nor a deployed address is available.
   */
  private _effectiveContractAddress(): string {
    const addr = this._contractAddress ?? this.config.contractAddress;
    if (!addr) {
      throw new Error(
        '[dStorage/midnight] No contract address configured. ' +
          'Call sdk.init() to auto-deploy, or pass contractAddress in the adapter config.'
      );
    }
    return addr;
  }

  // ── Circuit name resolution ────────────────────────────────────────────────

  /**
   * Resolve the actual circuit name for a built-in operation.
   * Uses the user-supplied remapping when present, otherwise falls back to the
   * SDK default.
   */
  private circuitName(key: keyof typeof CIRCUIT_DEFAULTS): string {
    return this.config.circuitNames?.[key] ?? CIRCUIT_DEFAULTS[key];
  }

  // ── ChainAdapter implementation ────────────────────────────────────────────

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    const circuitFn = this.circuitName('writeReference');
    let args: unknown[];
    if (this.config.circuitArgMapper) {
      args = this.config.circuitArgMapper(ref);
    } else {
      // DataRegistry storeReference(storageId: Bytes<32>, storageProvider: Opaque<"string">)
      const encodedStorageId = await this._encodeStorageId(ref.storageId);
      args = [encodedStorageId, ref.storageProvider];
    }

    const receipt = await this._submitCircuitCall(circuitFn, args);

    // Use circuit-computed refId if available, otherwise fall back to txHash
    const refId = receipt.circuitResult
      ? Buffer.from(receipt.circuitResult).toString('hex')
      : receipt.txHash;

    console.log(
      `[dStorage/midnight] Reference written at block ${receipt.blockHeight} → refId: ${refId}`
    );

    return {
      refId,
      provider: 'midnight',
      blockHeight: receipt.blockHeight,
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
    // Step 1: confirm the contract exists on-chain via a direct indexer query.
    // This is a plain HTTP+GraphQL call — no compiled contract ABI needed.
    const action = await this.fetchIndexerContractState();

    if (action === null) {
      throw new Error(
        `[dStorage/midnight] Contract not found at "${this._effectiveContractAddress()}".\n` +
          `  • Verify the address is correct\n` +
          `  • Confirm the contract is deployed on this network\n` +
          `  • Check you are connected to the right network (undeployed vs preprod)`
      );
    }

    // Step 2: decode ledger state and look up refId.
    // readReference uses decodeLedger() (indexer query + compiled module's ledger() fn)
    // which does not require midnight-js-contracts or ZK artifacts.
    const ledger = this.config.compiledContract as {
      ledger?(state: unknown): { notes?: Map<string, unknown> | unknown };
    };
    if (typeof ledger.ledger !== 'function') {
      throw new Error(
        '[dStorage/midnight] compiledContract does not expose a ledger() function.\n' +
          '  Pass the full compiled module: import * as compiledContract from "./contract/index.js"'
      );
    }
    const decoded = await this.decodeLedger();
    if (!decoded) {
      throw new Error(`[dStorage/midnight] Contract not found at "${this._effectiveContractAddress()}".`);
    }

    // Look up by refId — contracts using a notes/records map keyed by txHash
    const notesMap = (decoded['notes'] ?? decoded['records']) as Map<string, unknown> | undefined;
    if (!notesMap) {
      throw new Error(
        '[dStorage/midnight] Cannot read reference: compiled contract ledger has no iterable notes/records map.'
      );
    }

    for (const [key, val] of notesMap as Iterable<[string, unknown]>) {
      const entry = val as { storageId?: string; storageProvider?: string; owner?: string; dataLabel?: string; createdAt?: number };
      if (key === refId || entry.storageId === refId) {
        return {
          storageId: entry.storageId ?? '',
          storageProvider: entry.storageProvider ?? '',
          owner: entry.owner ?? '',
          ...(entry.dataLabel ? { dataLabel: entry.dataLabel } : {}),
          createdAt: entry.createdAt ?? 0,
        };
      }
    }

    throw new Error(`[dStorage/midnight] No reference found on-chain for refId: ${refId}`);
  }

  /**
   * Decode the contract's ledger state from the indexer into a plain JS object.
   * Returns `null` when the contract is not found on the indexer.
   *
   * Requires the compiled module (with a `ledger()` export) to be passed as
   * `compiledContract`, and `@midnight-ntwrk/compact-runtime` to be installed.
   * Works with ANY Compact contract — the shape of the returned object matches
   * whatever ledger fields the compiled contract declares.
   */
  private async decodeLedger(): Promise<Record<string, unknown> | null> {
    const action = await this.fetchIndexerContractState();
    if (!action) return null;

    const compiledModule = this.config.compiledContract as {
      ledger?(state: unknown): Record<string, unknown>;
    };

    if (typeof compiledModule.ledger !== 'function') {
      throw new Error(
        '[dStorage/midnight] compiledContract does not expose a ledger() function.\n' +
          '  Pass the full compiled module instead of just the Contract class:\n' +
          '  import * as compiledContract from "./contracts/managed/.../contract/index.js"'
      );
    }

    let chargedState: unknown;
    if (this.config.stateDecoder) {
      // Consumer-provided decoder — runs in the caller's module context where
      // @midnight-ntwrk/compact-runtime is resolvable.
      chargedState = this.config.stateDecoder(action.state);
    } else {
      // Fallback: try a dynamic import (works only when compact-runtime is
      // resolvable from @dstorage/chain's install location).
      let ContractStateClass: { deserialize(raw: Uint8Array): { data: unknown } };
      try {
        const runtimeId = '@midnight-ntwrk/compact-runtime';
        const runtime = await import(/* @vite-ignore */ runtimeId) as {
          ContractState: { deserialize(raw: Uint8Array): { data: unknown } };
        };
        ContractStateClass = runtime.ContractState;
      } catch {
        throw new Error(
          '[dStorage/midnight] Cannot decode ledger state: @midnight-ntwrk/compact-runtime ' +
            'is not resolvable from @dstorage/chain.\n' +
            '  Pass a stateDecoder in the adapter config:\n' +
            '    import { ContractState } from \'@midnight-ntwrk/compact-runtime\';\n' +
            '    stateDecoder: (hex) => ContractState.deserialize(Buffer.from(hex, \'hex\')).data'
        );
      }
      chargedState = ContractStateClass.deserialize(Buffer.from(action.state, 'hex')).data;
    }

    return compiledModule.ledger(chargedState);
  }

  async readLedgerEntry(entryName: string): Promise<unknown> {
    const ledger = await this.decodeLedger();
    if (ledger === null) {
      throw new Error(
        `[dStorage/midnight] Contract not found at "${this._effectiveContractAddress()}".\n` +
          `  • Verify the address is correct\n` +
          `  • Confirm the contract is deployed on this network`
      );
    }
    if (!(entryName in ledger)) {
      throw new Error(
        `[dStorage/midnight] Ledger entry '${entryName}' not found.\n` +
          `  Available entries: ${Object.keys(ledger).join(', ')}`
      );
    }
    return ledger[entryName];
  }

  async listReferences(): Promise<Array<{ refId: string; ref: ChainReference }>> {
    const ledger = await this.decodeLedger();
    if (!ledger) return [];

    // DataRegistry uses 'references' map (Bytes<32> → ReferenceEntry)
    // Fall back to 'notes' for legacy contracts
    const refsMap = (ledger['references'] ?? ledger['notes']) as {
      [Symbol.iterator](): Iterator<[Uint8Array, unknown]>;
    } | undefined;

    if (!refsMap || typeof refsMap[Symbol.iterator] !== 'function') {
      return [];
    }

    const results: Array<{ refId: string; ref: ChainReference }> = [];
    for (const [refIdBytes, entry] of refsMap) {
      const e = entry as {
        storageId: Uint8Array | string;
        storageProvider: Uint8Array | string;
        owner?: Uint8Array;
        dataLabel?: Uint8Array;
        createdAt?: bigint;
      };
      const storageId = e.storageId instanceof Uint8Array
        ? Buffer.from(e.storageId).toString('hex')
        : String(e.storageId);
      const storageProvider = typeof e.storageProvider === 'string'
        ? e.storageProvider
        : trimNull(e.storageProvider as Uint8Array);
      results.push({
        refId: Buffer.from(refIdBytes).toString('hex'),
        ref: {
          storageId,
          storageProvider,
          owner: e.owner ? trimNull(e.owner) : '',
          ...(e.dataLabel && (e.dataLabel as Uint8Array).some((b: number) => b !== 0)
            ? { dataLabel: trimNull(e.dataLabel as Uint8Array) }
            : {}),
          createdAt: Number(e.createdAt ?? 0),
        },
      });
    }
    return results;
  }

  // ── Generic circuit API ───────────────────────────────────────────────────

  async callCircuit(circuitName: string, inputs: unknown[]): Promise<CircuitCallResult> {
    const receipt = await this._submitCircuitCall(circuitName, inputs);

    return {
      txHash:      receipt.txHash,
      blockHeight: receipt.blockHeight,
      calledAt:    Date.now(),
    };
  }

  async queryCircuit<T = unknown>(queryName: string, inputs: unknown[]): Promise<T> {
    // Pure circuit queries: use pureCircuits from compiled contract module.
    const compiledModule = this.config.compiledContract as {
      pureCircuits?: Record<string, (...args: unknown[]) => T>;
    };
    const fn = compiledModule.pureCircuits?.[queryName];
    if (!fn) {
      throw new Error(
        `[dStorage/midnight] Pure circuit '${queryName}' not found in compiled contract's pureCircuits.`
      );
    }
    return fn(...inputs);
  }

  // ── DataRegistry deployment ────────────────────────────────────────────────

  /**
   * Deploy the DataRegistry contract and return the deployed address.
   *
   * In facade mode: uses the wallet's dust seed as a signing key for the deploy tx.
   * In connector mode: deployment is not supported (connector users should pass a
   *   pre-deployed contractAddress instead).
   *
   * Must be called after init() (facade mode) or not at all (connector mode).
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

    const zkConfigProvider = await this._buildZkConfigProvider();
    const providers = await this._buildProviders(zkConfigProvider);
    const compiledContract = await this._buildCompiledContract();

    let submitDeployTx: (providers: unknown, options: unknown) => Promise<{ public: { contractAddress: string; txId: string } }>;
    try {
      const mod = await import('@midnight-ntwrk/midnight-js-contracts');
      submitDeployTx = (mod as any).submitDeployTx;
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        '[dStorage/midnight] @midnight-ntwrk/midnight-js-contracts is not installed.\n' +
          '  Run: npm install @midnight-ntwrk/midnight-js-contracts\n' +
          `  Cause: ${cause}`
      );
    }

    console.log('[dStorage/midnight] Deploying DataRegistry contract…');

    const result = await submitDeployTx(providers, {
      compiledContract,
      args: [],
    });

    const address = result.public.contractAddress;
    this._contractAddress = address;

    console.log(`[dStorage/midnight] DataRegistry deployed at: ${address} (txId: ${result.public.txId})`);
    return address;
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
    // Store 32-byte dust seed as a default witness key (e.g. localSecretKey for bboard-style contracts).
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

    // 8. Wait for wallet sync with indexer
    const { firstValueFrom, filter } = await import(/* @vite-ignore */ 'rxjs');
    await (firstValueFrom as any)(
      facade.state().pipe(
        filter((s: { isSynced?: boolean }) => s.isSynced === true)
      )
    );

    return this.addresses;
  }

  /**
   * Initialize in connector mode: connect to browser wallet extension.
   *
   * Discovers available wallets by enumerating window.midnight, as per the
   * dApp connector spec: https://docs.midnight.network/api-reference/dapp-connector
   *
   * Each wallet extension injects an InitialAPI at window.midnight.{walletId}
   * with properties: name, icon, apiVersion, and a connect() method.
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
    // Each value should be an InitialAPI with { name, icon, apiVersion, connect() }
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
      // Store endpoints from the wallet's config for use during circuit calls.
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
      // Extract addresses from the connector.
      // Lace returns: { shieldedAddress, shieldedCoinPublicKey, shieldedEncryptionPublicKey }
      //               { unshieldedAddress }
      //               { dustAddress }
      let shieldedAddr = '';
      try {
        const r = await connectedAPI.getShieldedAddresses();
        // Could be a single object or an array
        const obj = Array.isArray(r) ? r[0] : r;
        shieldedAddr = (obj as any)?.shieldedAddress ?? (obj as any)?.address ?? (typeof obj === 'string' ? obj : '');
        // Also store the coin and encryption public keys needed for circuit execution.
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

      // Use whatever we got — at least one address should be available
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
   * - Connector mode: returns 0n (known limitation; could be queried directly from indexer in future)
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
      // Connector mode: balance queries not available from current connector API
      // This is a known limitation; could be extended in the future
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
      // Connector mode: attempt to disconnect if the API supports it
      if (this.connectorAPI && typeof (this.connectorAPI as any).disconnect === 'function') {
        try {
          await (this.connectorAPI as any).disconnect();
        } catch {
          // Ignore disconnection errors
        }
      }
      this.connectorAPI = null;
    }

    this.addresses = null;
  }
}
