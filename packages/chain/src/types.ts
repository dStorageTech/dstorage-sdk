/**
 * @dstorage/chain — types.ts
 * Interface every chain adapter must implement.
 * Chains store only cryptographic references — never raw user data.
 */

export type ChainProviderName = 'mock' | 'midnight' | 'ethereum' | 'solana';

/** An on-chain reference record — what gets written to the smart contract. */
export interface ChainReference {
  /** The storage content ID (e.g. Arweave txId, Autonomi address) */
  storageId: string;
  /** Storage network used */
  storageProvider: string;
  /** Owner wallet address */
  owner: string;
  /** Optional label for the data type e.g. "profile", "document" */
  dataLabel?: string;
  /** Unix timestamp of when the reference was written on-chain */
  createdAt: number;
}

/** Result of writing a reference to chain */
export interface ChainWriteResult {
  /** On-chain transaction / reference ID */
  refId: string;
  /** Chain used */
  provider: ChainProviderName;
  /** Block or ledger position (if available) */
  blockHeight?: number;
  /** Unix timestamp */
  writtenAt: number;
}

/** Permission record stored on-chain for selective access */
export interface ChainPermission {
  /** The reference this permission applies to */
  refId: string;
  /** Wallet address being granted access */
  grantee: string;
  /** Optional expiry timestamp */
  expiresAt?: number;
}

/** Result of calling a custom ZK circuit */
export interface CircuitCallResult {
  /** Transaction hash returned by the network */
  txHash: string;
  /** Block height at which the transaction was included (if available) */
  blockHeight?: number;
  /** Unix timestamp of when the call was made */
  calledAt: number;
}

/** Every chain adapter must implement this interface */
export interface ChainAdapter {
  readonly name: ChainProviderName;

  /**
   * Write an encrypted data reference to the blockchain.
   * Only the storage pointer + metadata is stored — never the data itself.
   */
  writeReference(ref: ChainReference): Promise<ChainWriteResult>;

  /**
   * Retrieve a reference by its on-chain ID.
   */
  readReference(refId: string): Promise<ChainReference>;

  /**
   * Grant read access for a specific reference to another wallet.
   */
  grantAccess(permission: ChainPermission): Promise<string>;

  /**
   * Revoke previously granted access.
   */
  revokeAccess(refId: string, grantee: string): Promise<void>;

  /**
   * Check if a wallet has access to a reference.
   */
  hasAccess(refId: string, wallet: string): Promise<boolean>;

  /**
   * Call a custom ZK circuit by name, running the full prove → balance → submit pipeline.
   * Optional — not all adapters support ZK proving (e.g. plain mock adapters).
   */
  callCircuit?(circuitName: string, inputs: unknown[]): Promise<CircuitCallResult>;

  /**
   * Query read-only contract state by circuit/query name without generating a proof.
   * Optional — not all adapters support direct contract state queries.
   */
  queryCircuit?<T = unknown>(queryName: string, inputs: unknown[]): Promise<T>;
}
