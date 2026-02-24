/**
 * @dstorage/chain — adapters/midnight.ts
 *
 * Midnight Network chain adapter.
 * Uses Midnight.js SDK + Compact smart contracts to store data references.
 *
 * Midnight stores only cryptographic pointers + ZK-protected metadata on-chain.
 * Raw user data is NEVER written to the Midnight ledger.
 *
 * Status: Structure defined. Wire-up pending Midnight.js SDK integration.
 * Docs: https://docs.midnight.network
 *
 * Compact contract (packages/chain/contracts/DataRegistry.compact):
 *   - storeReference(storageId, storageProvider, owner, label) → refId
 *   - grantAccess(refId, grantee)
 *   - revokeAccess(refId, grantee)
 *   - hasAccess(refId, wallet) → bool
 */

import type {
  ChainAdapter,
  ChainPermission,
  ChainProviderName,
  ChainReference,
  ChainWriteResult,
} from '../types.js';

export interface MidnightAdapterConfig {
  /**
   * Midnight node RPC endpoint.
   * Testnet-02: https://rpc.testnet-02.midnight.network
   */
  nodeEndpoint?: string;
  /**
   * Midnight indexer endpoint for querying state.
   */
  indexerEndpoint?: string;
  /**
   * Lace wallet / Midnight DApp connector — injected by the browser extension.
   * In Node.js, pass a programmatic wallet instance.
   */
  wallet?: unknown;
  /**
   * Deployed DataRegistry contract address on Midnight.
   */
  contractAddress?: string;
}

export class MidnightChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = 'midnight';

  private config: MidnightAdapterConfig;

  constructor(config: MidnightAdapterConfig = {}) {
    this.config = {
      nodeEndpoint:
        config.nodeEndpoint ?? 'https://rpc.testnet-02.midnight.network',
      indexerEndpoint:
        config.indexerEndpoint ?? 'https://indexer.testnet-02.midnight.network',
      ...(config.wallet !== undefined ? { wallet: config.wallet } : {}),
      ...(config.contractAddress !== undefined ? { contractAddress: config.contractAddress } : {}),
    };

    console.warn(
      '[dStorage/midnight] Midnight adapter preview mode — real on-chain writes pending Midnight.js v1 integration.'
    );
  }

  // ── Preview in-memory store until real SDK wired ──────────────────────────
  private refs = new Map<string, ChainReference>();
  private permissions = new Map<string, Set<string>>();

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    /**
     * TODO: Replace with real Midnight.js call:
     *
     *   import { Contract, createBalancedTx } from '@midnight-ntwrk/midnight-js';
     *   import { DataRegistry } from '../contracts/DataRegistry.compact';
     *
     *   const contract = new Contract(DataRegistry, this.config.contractAddress);
     *   const tx = await contract.call.storeReference(
     *     ref.storageId, ref.storageProvider, ref.owner, ref.dataLabel ?? ''
     *   );
     *   const balanced = await createBalancedTx(tx, this.config.wallet);
     *   const receipt  = await balanced.submit();
     *   return { refId: receipt.txHash, provider: 'midnight', blockHeight: receipt.blockHeight, ... };
     *
     * Midnight uses ZK proofs to hide the reference owner from public view while
     * still allowing the owner to prove ownership selectively.
     */

    const refId = `midnight_ref_${Date.now()}`;
    this.refs.set(refId, { ...ref, createdAt: Date.now() });

    console.log(`[dStorage/midnight] (preview) Reference stored → refId: ${refId}`);
    return { refId, provider: 'midnight', writtenAt: Date.now() };
  }

  async readReference(refId: string): Promise<ChainReference> {
    /**
     * TODO: Real implementation:
     *   const state = await contract.query.getReference(refId);
     *   return mapToChainReference(state);
     */
    const ref = this.refs.get(refId);
    if (!ref) throw new Error(`[dStorage/midnight] No reference found: ${refId}`);
    return ref;
  }

  async grantAccess(permission: ChainPermission): Promise<string> {
    /**
     * TODO:
     *   const tx = await contract.call.grantAccess(permission.refId, permission.grantee);
     *   const receipt = await balanced.submit();
     *   return receipt.txHash;
     */
    const { refId, grantee } = permission;
    if (!this.permissions.has(refId)) this.permissions.set(refId, new Set());
    this.permissions.get(refId)!.add(grantee);
    return `midnight_perm_${refId}_${grantee}`;
  }

  async revokeAccess(refId: string, grantee: string): Promise<void> {
    /**
     * TODO:
     *   await contract.call.revokeAccess(refId, grantee);
     */
    this.permissions.get(refId)?.delete(grantee);
  }

  async hasAccess(refId: string, wallet: string): Promise<boolean> {
    const ref = this.refs.get(refId);
    if (ref?.owner === wallet) return true;
    return this.permissions.get(refId)?.has(wallet) ?? false;
  }
}
