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

  private readonly config: {
    nodeEndpoint: string;
    indexerEndpoint: string;
    indexerWsEndpoint?: string;
    proofServerEndpoint: string;
    contractAddress: string;
    wallet: unknown;
  };

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
   * Try to load the compiled DataRegistry contract ABI.
   *
   * Returns the ABI module when the contract has been compiled with `compactc`,
   * or `null` when the compiled output is not present.
   * The compiled output is generated by: `npm run compile:contract` in packages/chain.
   */
  private async tryGetCompiledContract(): Promise<unknown> {
    try {
      // Variable indirection + @vite-ignore prevent bundlers from resolving
      // this path at build time — the file only exists after running compile:contract.
      const contractPath = '../contracts/managed/DataRegistry/index.js';
      const managed = await import(/* @vite-ignore */ contractPath);
      return managed.DataRegistry ?? managed.default ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Load and initialise a full contract instance using the Midnight JS dApp SDK.
   *
   * Requires BOTH the compiled contract ABI (`npm run compile:contract`) AND the
   * peer dependency `@midnight-ntwrk/midnight-js-contracts` to be installed.
   * Throws descriptive errors if either is missing.
   */
  private async getContract(): Promise<unknown> {
    const abi = await this.tryGetCompiledContract();
    if (!abi) {
      throw new Error(
        '[dStorage/midnight] Compiled DataRegistry contract ABI not found.\n' +
          '  Run: npm run compile:contract in packages/chain\n' +
          '  Then rebuild: npm run build --workspace=@dstorage/chain'
      );
    }

    let sdk: { Contract: new (abi: unknown, address: string, opts: unknown) => unknown };
    try {
      const sdkId = '@midnight-ntwrk/midnight-js-contracts';
      sdk = await import(/* @vite-ignore */ sdkId);
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
    const contract = await this.getContract() as {
      call: { storeReference(a: string, b: string, c: string, d: string): Promise<UnprovenTx> };
    };

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
    // Step 1: confirm the contract exists on-chain via a direct indexer query.
    // This is a plain HTTP+GraphQL call — no compiled contract ABI needed.
    const action = await this.fetchIndexerContractState();

    if (action === null) {
      throw new Error(
        `[dStorage/midnight] Contract not found at "${this.config.contractAddress}".\n` +
          `  • Verify the address is correct\n` +
          `  • Confirm DataRegistry is deployed on this network\n` +
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
    const c = contract as {
      query: { getReference(refId: string): Promise<{ storageId: string; storageProvider: string; owner: string; dataLabel: string; createdAt: number } | null> };
    };
    const entry = await c.query.getReference(refId);
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
    const contract = await this.getContract() as {
      call: { grantAccess(refId: string, grantee: string): Promise<UnprovenTx> };
    };

    const unproven = await contract.call.grantAccess(permission.refId, permission.grantee);
    const receipt = await this.executeTransaction(unproven);

    console.log(
      `[dStorage/midnight] Access granted: ${permission.grantee} → ${permission.refId} (tx: ${receipt.txHash})`
    );

    return receipt.txHash;
  }

  async revokeAccess(refId: string, grantee: string): Promise<void> {
    const contract = await this.getContract() as {
      call: { revokeAccess(refId: string, grantee: string): Promise<UnprovenTx> };
    };

    const unproven = await contract.call.revokeAccess(refId, grantee);
    await this.executeTransaction(unproven);

    console.log(`[dStorage/midnight] Access revoked: ${grantee} → ${refId}`);
  }

  async hasAccess(refId: string, wallet: string): Promise<boolean> {
    const contract = await this.getContract() as {
      query: { hasAccess(refId: string, wallet: string): Promise<boolean> };
    };

    // Pure query — no transaction submitted, reads contract state from indexer
    return contract.query.hasAccess(refId, wallet);
  }
}
