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
  ChainPermission,
  ChainProviderName,
  ChainReference,
  ChainWriteResult,
  CircuitCallResult,
} from '../types.js';

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

/** Shape of a decoded NoteEntry from the compiled contract's ledger. */
interface NoteEntry {
  storageId: Uint8Array;
  storageProvider: Uint8Array;
  owner: Uint8Array;
  dataLabel: Uint8Array;
  createdAt: bigint;
}

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
  balanceUnsealedTransaction(tx: string): Promise<string>;
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
   * Required for live network operations.
   */
  contractAddress: string;
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
    }
);

// ── Circuit name defaults ───────────────────────────────────────────────────────

const CIRCUIT_DEFAULTS = {
  writeReference: 'storeReference',
  grantAccess:    'grantAccess',
  revokeAccess:   'revokeAccess',
  hasAccess:      'hasAccess',
  readReference:  'getReference',
} as const;

// ── Internal Midnight SDK types (minimal surface needed) ───────────────────────

// Shape returned by the indexer's contractAction GraphQL query.
interface IndexerContractAction {
  address: string;
  state: string; // hex-encoded serialised ledger state
}

interface UnprovenTx {
  prove(proofServerEndpoint: string): Promise<ProvenTx>;
}

interface ProvenTx {
  balance(wallet: unknown): Promise<BalancedTx>;
}

interface BalancedTx {
  submit(): Promise<TxReceipt>;
}

interface TxReceipt {
  txHash: string;
  blockHeight: number;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class MidnightChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = 'midnight';

  private facade: unknown | null = null;
  private connectorAPI: ConnectedAPI | null = null;
  private addresses: WalletAddresses | null = null;

  private readonly walletMode: 'facade' | 'connector';
  private readonly connectorName: string;

  private readonly config: {
    nodeEndpoint: string;
    indexerEndpoint: string;
    indexerWsEndpoint?: string;
    proofServerEndpoint: string;
    contractAddress: string;
    compiledContract: object;
    network: 'testnet' | 'preprod' | 'undeployed';
    credentials?: { mnemonic?: string; seedHex?: string };
    circuitNames?: MidnightChainAdapterConfig['circuitNames'];
    stateDecoder?: MidnightChainAdapterConfig['stateDecoder'];
  };

  constructor(config: MidnightChainAdapterConfig) {
    if (!config.contractAddress) {
      throw new Error(
        '[dStorage/midnight] contractAddress is required. ' +
          'Deploy your compiled contract to Midnight and pass the address.'
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

    this.config = {
      nodeEndpoint: config.nodeEndpoint ?? 'https://rpc.testnet-02.midnight.network',
      indexerEndpoint:
        config.indexerEndpoint ?? 'https://indexer.testnet-02.midnight.network/api/v1/graphql',
      ...(config.indexerWsEndpoint !== undefined
        ? { indexerWsEndpoint: config.indexerWsEndpoint }
        : {}),
      proofServerEndpoint: config.proofServerEndpoint ?? 'http://localhost:6300',
      contractAddress: config.contractAddress,
      compiledContract: config.compiledContract,
      network: config.network,
      ...(walletMode === 'facade' && 'credentials' in config ? { credentials: config.credentials } : {}),
      ...(config.circuitNames !== undefined ? { circuitNames: config.circuitNames } : {}),
      ...(config.stateDecoder !== undefined ? { stateDecoder: config.stateDecoder } : {}),
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
    const query = `{ contractAction(address: "${this.config.contractAddress}") { address state } }`;

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
   * Load and initialise a full contract instance using the Midnight JS dApp SDK.
   *
   * Uses the compiledContract provided in the constructor config. Requires the
   * peer dependency `@midnight-ntwrk/midnight-js-contracts` to be installed.
   * Throws a descriptive error if the SDK is missing.
   */
  private async getContract(): Promise<unknown> {
    // Support both a full module object ({ Contract, ledger, ... }) and a bare class.
    const moduleOrClass = this.config.compiledContract as { Contract?: unknown };
    const abi = moduleOrClass.Contract ?? this.config.compiledContract;

    let sdk: { Contract: new (abi: unknown, address: string, opts: unknown) => unknown };
    try {
      sdk = await import('@midnight-ntwrk/midnight-js-contracts' as string);
    } catch {
      throw new Error(
        '[dStorage/midnight] @midnight-ntwrk/midnight-js-contracts is not installed.\n' +
          '  Run: npm install @midnight-ntwrk/midnight-js-contracts @midnight-ntwrk/compact-runtime'
      );
    }

    return new sdk.Contract(abi, this.config.contractAddress, {
      nodeEndpoint: this.config.nodeEndpoint,
      indexerEndpoint: this.config.indexerEndpoint,
    });
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

  // ── Full Midnight transaction flow ─────────────────────────────────────────

  /**
   * Execute the full Midnight tx pipeline: build → prove → balance → submit.
   * Branches based on wallet mode:
   *   - 'facade': use WalletFacade for balance + submit
   *   - 'connector': use browser connector API for balance + submit
   * Returns the transaction receipt.
   */
  private async executeTransaction(unproven: UnprovenTx): Promise<TxReceipt> {
    if (this.walletMode === 'facade') {
      // Facade mode: prove → balance via facade → submit
      const proven = await unproven.prove(this.config.proofServerEndpoint);
      if (!this.facade) {
        throw new Error('[dStorage/midnight] Wallet not initialized. Call await chain.init() first.');
      }
      const balanced = await proven.balance(this.facade);
      const receipt = await balanced.submit();
      return receipt;
    } else {
      // Connector mode: use the wallet's configured proof server and connector API
      if (!this.connectorAPI) {
        throw new Error('[dStorage/midnight] Connector not initialized. Call await chain.init() first.');
      }

      // Step 1: Get the wallet's configured proof server URL (respects user preferences)
      const walletCfg = await this.connectorAPI.getConfiguration();
      const proofServerUrl = walletCfg.proverServerUri ?? this.config.proofServerEndpoint;

      // Step 2: Generate ZK proof using the connector's configured proof server
      const proven = await unproven.prove(proofServerUrl);

      // Step 3: Serialize proven transaction and balance via connector
      // The proven transaction is converted to its serialized form (JSON string in hex format)
      const provenHex = JSON.stringify((proven as any).toJSON?.() ?? proven);

      // Step 4: Balance the transaction via connector
      const balancedHex = await this.connectorAPI.balanceUnsealedTransaction(provenHex);

      // Step 5: Submit the balanced transaction via connector
      const txId = await this.connectorAPI.submitTransaction(balancedHex);

      // Return a receipt-like object; the actual blockHeight may not be available immediately
      return {
        txHash: txId,
        blockHeight: 0, // Connector doesn't provide block height at submission time
      };
    }
  }

  // ── ChainAdapter implementation ────────────────────────────────────────────

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    const circuitFn = this.circuitName('writeReference');
    const contract = await this.getContract() as {
      call: Record<string, (a: string, b: string, c: string, d: string) => Promise<UnprovenTx>>;
    };

    const fn = contract.call[circuitFn];
    if (!fn) {
      throw new Error(`[dStorage/midnight] Circuit '${circuitFn}' not found in compiled contract`);
    }
    const unproven = await fn(ref.storageId, ref.storageProvider, ref.owner, ref.dataLabel ?? '');

    const receipt = await this.executeTransaction(unproven);

    console.log(
      `[dStorage/midnight] Reference written at block ${receipt.blockHeight} → refId: ${receipt.txHash}`
    );

    return {
      refId: receipt.txHash,
      provider: 'midnight',
      blockHeight: receipt.blockHeight,
      writtenAt: Date.now(),
    };
  }

  async readReference(refId: string): Promise<ChainReference> {
    // Step 1: confirm the contract exists on-chain via a direct indexer query.
    // This is a plain HTTP+GraphQL call — no compiled contract ABI needed.
    const action = await this.fetchIndexerContractState();

    if (action === null) {
      throw new Error(
        `[dStorage/midnight] Contract not found at "${this.config.contractAddress}".\n` +
          `  • Verify the address is correct\n` +
          `  • Confirm the contract is deployed on this network\n` +
          `  • Check you are connected to the right network (undeployed vs preprod)`
      );
    }

    // Step 2: decoding the ledger state to look up a specific refId requires the
    // compiled contract ABI (generated by compactc) plus the Midnight JS dApp SDK.
    // Try to load both and surface a clear error when either is missing.
    let contract: unknown;
    try {
      contract = await this.getContract();
    } catch (err) {
      const statePreview = action.state.slice(0, 32);
      throw new Error(
        `[dStorage/midnight] Contract FOUND at "${this.config.contractAddress}" ` +
          `(state: ${statePreview}…) but cannot decode reference data:\n` +
          `  ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Step 3: use the compiled contract to look up the refId in the ledger state.
    // This path is reached only once both the ABI and the dApp SDK are present.
    const readFn = this.circuitName('readReference');
    const c = contract as {
      query: Record<string, (refId: string) => Promise<{ storageId: string; storageProvider: string; owner: string; dataLabel: string; createdAt: number } | null>>;
    };
    const entry = await c.query[readFn]?.(refId);
    if (!entry) {
      throw new Error(`[dStorage/midnight] No reference found on-chain for refId: ${refId}`);
    }

    return {
      storageId: entry.storageId,
      storageProvider: entry.storageProvider,
      owner: entry.owner,
      ...(entry.dataLabel ? { dataLabel: entry.dataLabel } : {}),
      createdAt: entry.createdAt,
    };
  }

  async grantAccess(permission: ChainPermission): Promise<string> {
    const circuitFn = this.circuitName('grantAccess');
    const contract = await this.getContract() as {
      call: Record<string, (refId: string, grantee: string) => Promise<UnprovenTx>>;
    };

    const fn = contract.call[circuitFn];
    if (!fn) {
      throw new Error(`[dStorage/midnight] Circuit '${circuitFn}' not found in compiled contract`);
    }
    const unproven = await fn(permission.refId, permission.grantee);
    const receipt = await this.executeTransaction(unproven);

    console.log(
      `[dStorage/midnight] Access granted: ${permission.grantee} → ${permission.refId} (tx: ${receipt.txHash})`
    );

    return receipt.txHash;
  }

  async revokeAccess(refId: string, grantee: string): Promise<void> {
    const circuitFn = this.circuitName('revokeAccess');
    const contract = await this.getContract() as {
      call: Record<string, (refId: string, grantee: string) => Promise<UnprovenTx>>;
    };

    const fn = contract.call[circuitFn];
    if (!fn) {
      throw new Error(`[dStorage/midnight] Circuit '${circuitFn}' not found in compiled contract`);
    }
    const unproven = await fn(refId, grantee);
    await this.executeTransaction(unproven);

    console.log(`[dStorage/midnight] Access revoked: ${grantee} → ${refId}`);
  }

  async hasAccess(refId: string, wallet: string): Promise<boolean> {
    const queryFn = this.circuitName('hasAccess');
    const contract = await this.getContract() as {
      query: Record<string, (refId: string, wallet: string) => Promise<boolean>>;
    };

    // Pure query — no transaction submitted, reads contract state from indexer
    const fn = contract.query[queryFn];
    if (!fn) {
      throw new Error(`[dStorage/midnight] Query '${queryFn}' not found in compiled contract`);
    }
    return fn(refId, wallet);
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
        `[dStorage/midnight] Contract not found at "${this.config.contractAddress}".\n` +
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

    const notes = ledger['notes'] as {
      [Symbol.iterator](): Iterator<[Uint8Array, NoteEntry]>;
    } | undefined;

    if (!notes || typeof notes[Symbol.iterator] !== 'function') {
      // Contract has no iterable 'notes' map — not a dStorage todoList contract.
      return [];
    }

    const results: Array<{ refId: string; ref: ChainReference }> = [];
    for (const [refIdBytes, entry] of notes) {
      results.push({
        refId: Buffer.from(refIdBytes).toString('hex'),
        ref: {
          storageId:       trimNull(entry.storageId),
          storageProvider: trimNull(entry.storageProvider),
          owner:           trimNull(entry.owner),
          ...(entry.dataLabel.some((b: number) => b !== 0)
            ? { dataLabel: trimNull(entry.dataLabel) }
            : {}),
          createdAt: Number(entry.createdAt),
        },
      });
    }
    return results;
  }

  // ── Generic circuit API ───────────────────────────────────────────────────

  async callCircuit(circuitName: string, inputs: unknown[]): Promise<CircuitCallResult> {
    const contract = await this.getContract() as {
      call: Record<string, (...args: unknown[]) => Promise<UnprovenTx>>;
    };

    const fn = contract.call[circuitName];
    if (!fn) {
      throw new Error(`[dStorage/midnight] Circuit '${circuitName}' not found in compiled contract`);
    }

    const receipt = await this.executeTransaction(await fn(...inputs));

    return {
      txHash:      receipt.txHash,
      blockHeight: receipt.blockHeight,
      calledAt:    Date.now(),
    };
  }

  async queryCircuit<T = unknown>(queryName: string, inputs: unknown[]): Promise<T> {
    const contract = await this.getContract() as {
      query: Record<string, (...args: unknown[]) => Promise<T>>;
    };

    const fn = contract.query[queryName];
    if (!fn) {
      throw new Error(`[dStorage/midnight] Query '${queryName}' not found in compiled contract`);
    }

    return fn(...inputs);
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
    const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id' as string);
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
    const ledger = await import('@midnight-ntwrk/ledger-v7' as string);
    const shieldedSecretKeys = (ledger as any).ZswapSecretKeys.fromSeed(zswapSeed);
    const dustSecretKey = (ledger as any).DustSecretKey.fromSeed(dustSeed);

    // 3. Derive unshielded keystore
    const {
      createKeystore,
      InMemoryTransactionHistoryStorage,
      PublicKey: UnshieldedPublicKey,
      UnshieldedWallet,
    } = await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet' as string);
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
    const { ShieldedWallet } = await import('@midnight-ntwrk/wallet-sdk-shielded' as string);
    const { DustWallet } = await import('@midnight-ntwrk/wallet-sdk-dust-wallet' as string);

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
    const { WalletFacade } = await import('@midnight-ntwrk/wallet-sdk-facade' as string);
    const facade = new (WalletFacade as any)(shielded, unshielded, dust);
    await facade.start(shieldedSecretKeys, dustSecretKey);
    this.facade = facade;

    // 7. Derive wallet addresses from keys
    const {
      ShieldedCoinPublicKey,
      ShieldedEncryptionPublicKey,
      ShieldedAddress,
      DustAddress,
    } = await import('@midnight-ntwrk/wallet-sdk-address-format' as string);

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
    const { firstValueFrom, filter } = await import('rxjs' as string);
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

      const { firstValueFrom } = await import('rxjs' as string);
      const ledger = await import('@midnight-ntwrk/ledger-v7' as string);

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
