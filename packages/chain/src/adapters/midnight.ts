/**
 * @dstorage/chain — adapters/midnight.ts
 *
 * Real Midnight Network chain adapter.
 *
 * Talks to a deployed DataRegistry contract on the Midnight network using the
 * Midnight.js SDK. Each write operation follows the standard Midnight flow:
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
} from '../types.js';

// ── Config ─────────────────────────────────────────────────────────────────────

export interface MidnightChainAdapterConfig {
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
   * Deployed DataRegistry contract address on Midnight.
   * Required for live network operations.
   */
  contractAddress: string;
  /**
   * Connected wallet object.
   * - Browser: the ConnectedAPI returned by connectMidnightWallet()
   * - Node.js: a WalletBuilder instance from @midnight-ntwrk/wallet
   * This object is used to balance transactions (attach DUST fees) and submit them.
   */
  wallet: unknown;
}

// ── Internal Midnight SDK types (minimal surface needed) ───────────────────────

interface MidnightContract {
  call: {
    storeReference(
      storageId: string,
      storageProvider: string,
      owner: string,
      dataLabel: string
    ): Promise<UnprovenTx>;
    grantAccess(refId: string, grantee: string): Promise<UnprovenTx>;
    revokeAccess(refId: string, grantee: string): Promise<UnprovenTx>;
  };
  query: {
    hasAccess(refId: string, wallet: string): Promise<boolean>;
    getReference(refId: string): Promise<MidnightReferenceEntry | null>;
  };
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

interface MidnightReferenceEntry {
  storageId: string;
  storageProvider: string;
  owner: string;
  dataLabel: string;
  createdAt: number;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class MidnightChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = 'midnight';

  private readonly config: {
    nodeEndpoint: string;
    indexerEndpoint: string;
    indexerWsEndpoint?: string;
    proofServerEndpoint: string;
    contractAddress: string;
    wallet: unknown;
  };

  /** Lazily initialised contract instance */
  private contract: MidnightContract | null = null;

  constructor(config: MidnightChainAdapterConfig) {
    if (!config.contractAddress) {
      throw new Error(
        '[dStorage/midnight] contractAddress is required. ' +
          'Deploy DataRegistry.compact to Midnight and pass the address.'
      );
    }
    if (!config.wallet) {
      throw new Error(
        '[dStorage/midnight] wallet is required. ' +
          'Call connectMidnightWallet() and pass walletInfo.walletApi.'
      );
    }

    this.config = {
      nodeEndpoint: config.nodeEndpoint ?? 'https://rpc.testnet-02.midnight.network',
      indexerEndpoint:
        config.indexerEndpoint ?? 'https://indexer.testnet-02.midnight.network/api/v1/graphql',
      ...(config.indexerWsEndpoint !== undefined
        ? { indexerWsEndpoint: config.indexerWsEndpoint }
        : {}),
      proofServerEndpoint: config.proofServerEndpoint ?? 'http://localhost:6300',
      contractAddress: config.contractAddress,
      wallet: config.wallet,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Lazily load the Midnight SDK and create a contract instance.
   * Throws a clear error if the peer dependency is not installed.
   */
  private async getContract(): Promise<MidnightContract> {
    if (this.contract) return this.contract;

    let sdk: { Contract: new (abi: unknown, address: string, options: unknown) => MidnightContract };
    try {
      // @vite-ignore and the variable indirection both tell the bundler not to
      // try resolving this at build time — it is only available at runtime
      // after the peer dependency is installed.
      const sdkId = '@midnight-ntwrk/midnight-js-contracts';
      sdk = await import(/* @vite-ignore */ sdkId);
    } catch {
      throw new Error(
        '[dStorage/midnight] @midnight-ntwrk/midnight-js-contracts is not installed. ' +
          'Run: npm install @midnight-ntwrk/midnight-js-contracts @midnight-ntwrk/compact-runtime @midnight-ntwrk/dapp-connector-api'
      );
    }

    let abi: unknown;
    try {
      // The compiled contract ABI is generated by: npm run compile:contract
      // Output path: src/contracts/managed/DataRegistry/index.js (generated by compactc)
      // Variable indirection + @vite-ignore prevent the bundler from resolving
      // this path at build time (the file only exists after running compile:contract).
      const contractPath = '../contracts/managed/DataRegistry/index.js';
      const managed = await import(/* @vite-ignore */ contractPath);
      abi = managed.DataRegistry ?? managed.default;
    } catch {
      throw new Error(
        '[dStorage/midnight] Compiled DataRegistry contract not found. ' +
          'Run: npm run compile:contract in packages/chain'
      );
    }

    this.contract = new sdk.Contract(abi, this.config.contractAddress, {
      nodeEndpoint: this.config.nodeEndpoint,
      indexerEndpoint: this.config.indexerEndpoint,
    });

    return this.contract;
  }

  // ── Full Midnight transaction flow ─────────────────────────────────────────

  /**
   * Execute the full Midnight tx pipeline: build → prove → balance → submit.
   * Returns the transaction receipt.
   */
  private async executeTransaction(unproven: UnprovenTx): Promise<TxReceipt> {
    // Step 1: Generate ZK proof via proof server
    const proven = await unproven.prove(this.config.proofServerEndpoint);

    // Step 2: Attach DUST fees via the connected wallet
    const balanced = await proven.balance(this.config.wallet);

    // Step 3: Submit to the Midnight network and wait for block inclusion
    const receipt = await balanced.submit();

    return receipt;
  }

  // ── ChainAdapter implementation ────────────────────────────────────────────

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    const contract = await this.getContract();

    const unproven = await contract.call.storeReference(
      ref.storageId,
      ref.storageProvider,
      ref.owner,
      ref.dataLabel ?? ''
    );

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
    const contract = await this.getContract();

    // Try the indexer query first (fast, no ZK proof required)
    const entry = await contract.query.getReference(refId);
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
    const contract = await this.getContract();

    const unproven = await contract.call.grantAccess(permission.refId, permission.grantee);
    const receipt = await this.executeTransaction(unproven);

    console.log(
      `[dStorage/midnight] Access granted: ${permission.grantee} → ${permission.refId} (tx: ${receipt.txHash})`
    );

    return receipt.txHash;
  }

  async revokeAccess(refId: string, grantee: string): Promise<void> {
    const contract = await this.getContract();

    const unproven = await contract.call.revokeAccess(refId, grantee);
    await this.executeTransaction(unproven);

    console.log(`[dStorage/midnight] Access revoked: ${grantee} → ${refId}`);
  }

  async hasAccess(refId: string, wallet: string): Promise<boolean> {
    const contract = await this.getContract();

    // Pure query — no transaction submitted, reads contract state from indexer
    return contract.query.hasAccess(refId, wallet);
  }
}
