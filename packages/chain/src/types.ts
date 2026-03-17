/**
 * @dstorage/chain — types.ts
 * Interface every chain adapter must implement.
 * Chains store only cryptographic references — never raw user data.
 * More chains can be supported in the future
 */

import type { PaymentReceipt } from "@dstorage/payment";
import type { PaymentAdapter } from "@dstorage/payment";

/**
 * The on-chain schema version reflected by this SDK build.
 * Corresponds to the contractVersion ledger field in DataRegistry.compact.
 * Bump this constant when the contract is redeployed with breaking schema changes.
 */
export const CONTRACT_VERSION = 0;

/**
 * Identifies the encryption algorithm used to encrypt a storageId.
 * Recorded on-chain in ReferenceEntry.encryptionScheme so the SDK
 * can dispatch the correct decryption function at read time.
 *
 * Current values:
 *   "aes-gcm-v1" — AES-256-GCM (PBKDF2-derived key); 60-byte binary payload
 *                 base64url-encoded to an 80-char string before writing on-chain
 *   ""           — No encryption; storageId and content are stored as plaintext (public data)
 *
 * Post-quantum schemes are introduced in the PQ encryption PR and
 * extend this union without breaking existing entries.
 */
export type EncryptionScheme = "aes-gcm-v1" | "";

/**
 * Minimal logger interface accepted by every SDK class.
 * Compatible with `console` — pass `logger: console` for zero-boilerplate logging.
 * Omit the field entirely to suppress all SDK output.
 */
export interface Logger {
  log(component: string, msg: string): void;
  warn(component: string, msg: string): void;
  error(component: string, msg: string): void;
  debug?(component: string, msg: string): void;
}

export type ChainProviderName = "mock" | "midnight";

/** An on-chain reference record — what gets written to the smart contract. */
export interface ChainReference {
  /**
   * The storage content ID, base64url-encoded after client-side encryption.
   * (e.g. Arweave txId, encrypted before storage).
   * The encryption algorithm is recorded in encryptionScheme.
   */
  storageId: string;
  /**
   * Identifies the algorithm used to encrypt storageId and content.
   * "aes-gcm-v1" — encrypted with AES-256-GCM (PBKDF2-derived key).
   * "" or undefined — unencrypted; storageId and content are stored as plaintext (public data).
   */
  encryptionScheme?: EncryptionScheme;
  /** Storage network used */
  storageProvider: string;
  /** Optional label for the referenced data e.g. "profile", "document" */
  dataLabel?: string;
  /** Timestamp of when the reference was written on-chain */
  writtenAt: number;
}

/** Result of writing a reference to chain */
export interface ChainWriteResult {
  /** On-chain transaction / reference ID */
  refId: string;
  /** Chain used */
  provider: ChainProviderName;
  /** Block or ledger position (if available) */
  blockHeight?: number;
  /** Timestamp of when the reference was written on-chain */
  writtenAt: number;
  /**
   * Payment receipt for the chain transaction fee, when the adapter handles
   * payment internally (e.g. Midnight managed payment via signing server).
   * When present, MetaTransaction records this as the chain payment in the final receipt.
   */
  paymentReceipt?: PaymentReceipt;
}

/**
 * Wallet token balances keyed by token symbol/name (e.g. night, dust).
 * Values are expressed in base units as bigint.
 */
export type WalletBalances = Record<string, bigint>;

/** Minimal on-chain reference shape returned from DataRegistry listing APIs. */
export interface DataReferenceSummary {
  /** Unique on-chain reference identifier. */
  refId: string;
  /** Storage-network content identifier referenced by this record.
   * If the storageId couldn't be decrypted then it's null */
  storageId: string | null;
  /** Storage backend/provider where the encrypted payload is stored. */
  storageProvider: string;
  /** Encryption scheme recorded on-chain. null/"" = public/unencrypted; "aes-gcm-v1" = encrypted. */
  encryptionScheme: EncryptionScheme | null;
}

/** Every chain adapter must implement this interface */
export interface ChainAdapter {
  readonly name: ChainProviderName;
  readonly providerName: string;
  /** Payment adapter responsible for paying chain network fees for this adapter. */
  readonly paymentAdapter: PaymentAdapter;

  /** Initialize the wallet: derive keys, wait for sync.
   *  Must be called before any read/write operations. */
  init?(): Promise<string>;

  /**
   * Write an encrypted data reference to the blockchain.
   * Only the storage pointer + (optional) label is stored — never the data itself.
   */
  writeReference(ref: ChainReference): Promise<ChainWriteResult>;

  /**
   * List references currently stored in the DataRegistry contract.
   */
  listReferences(): Promise<DataReferenceSummary[]>;

  /**
   * Retrieve a reference by its on-chain ID.
   */
  readReference(refId: string): Promise<ChainReference>;

  /**
   * Read NIGHT and DUST balances from synced wallet state.
   *  Optional — only for adapters that manage wallet lifecycle. */
  getBalances?(): Promise<WalletBalances>;

  /** Deploy the DataRegistry contract and return the deployed contract address.
   *  Optional — only for adapters that support on-chain deployment. */
  deployDataRegistry?(): Promise<string>;

  /** Set the contract address to use for subsequent operations.
   *  Called by the SDK after deploy or when connecting to an existing contract.
   *  Optional — only for adapters that manage contract address lifecycle. */
  setContractAddress?(address: string): void;

  /** Get the contract address. **/
  getContractAddress(): string;

  /** Derive a deterministic encryption key from the adapter's credentials.
   *  Optional — only for adapters that hold wallet credentials (e.g. facade mode). */
  getEncryptionKey?(): Promise<CryptoKey | null>;

  /** Derive a deterministic AES-GCM key for storage ID encryption.
   *  Uses the same root credentials as getEncryptionKey() but a different PBKDF2 salt,
   *  producing an authenticated cipher stored as an Opaque<"string"> in the contract.
   *  Optional — only for adapters that hold wallet credentials (e.g. facade mode).
   *  In connector mode the key is derived from the wallet signature in DStorage.connect(). */
  getStorageIdKey?(): Promise<CryptoKey | null>;
}
