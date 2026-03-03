/**
 * @dstorage/chain — types.ts
 * Interface every chain adapter must implement.
 * Chains store only cryptographic references — never raw user data.
 */

export type ChainProviderName = "mock" | "midnight" | "ethereum" | "solana";

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
  readonly providerName: string;

  /**
   * Write an encrypted data reference to the blockchain.
   * Only the storage pointer + metadata is stored — never the data itself.
   */
  writeReference(ref: ChainReference): Promise<ChainWriteResult>;

  /**
   * Retrieve a reference by its on-chain ID.
   */
  //readReference(refId: string): Promise<ChainReference>;

  /** Initialize the wallet: derive keys, build WalletFacade, wait for sync.
   *  Must be called before write operations or getBalances().
   *  Optional — only for adapters that manage wallet lifecycle (e.g. Midnight). */
  init?(): Promise<string>;

  /** Return wallet addresses derived during init(). Throws if init() not yet called.
   *  Optional — only for adapters that manage wallet lifecycle. */
  getAddresses?(): import("./adapters/midnight/src/midnight.js").WalletAddresses;

  /** Read NIGHT and DUST balances from synced wallet state.
   *  Optional — only for adapters that manage wallet lifecycle. */
  getBalances?(): Promise<
    import("./adapters/midnight/src/midnight.js").WalletBalances
  >;

  /** Deploy the DataRegistry contract and return the deployed contract address.
   *  Optional — only for adapters that support on-chain deployment. */
  deployDataRegistry?(): Promise<string>;

  /** Set the contract address to use for subsequent operations.
   *  Called by the SDK after deploy or when connecting to an existing contract.
   *  Optional — only for adapters that manage contract address lifecycle. */
  setContractAddress?(address: string): void;

  /** Get the contract address. **/
  getContractAddress(): string;

  /** Derive a deterministic AES-GCM encryption key from the adapter's credentials.
   *  Optional — only for adapters that hold wallet credentials (e.g. facade mode). */
  getEncryptionKey?(): Promise<CryptoKey>;
}
