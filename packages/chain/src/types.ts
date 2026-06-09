/**
 * @dstorage/chain — types.ts
 * Interface every chain adapter must implement.
 * Chains store only cryptographic references — never raw user data.
 * More chains can be supported in the future
 */

import type { PaymentReceipt, TokenSymbol } from "@dstorage/payment";
import type { EncryptionScheme } from "@dstorage/crypto";

export type { EncryptionScheme } from "@dstorage/crypto";

/**
 * The on-chain schema version reflected by this SDK build.
 * Corresponds to the contractVersion ledger field in DataRegistry.compact.
 * Bump this constant when the contract is redeployed with breaking schema changes.
 */
export const CONTRACT_VERSION = 0;

/**
 * Minimal logger interface accepted by every SDK class.
 * Compatible with `console` — pass `logger: console` for zero-boilerplate logging.
 * Omit the field entirely to suppress all SDK output.
 */
export interface ChainAdapterLogger {
  log(component: string, msg: string): void;
  warn(component: string, msg: string): void;
  error(component: string, msg: string): void;
  debug?(component: string, msg: string): void;
}

export type ChainProviderName = "mock" | "midnight" | "httpgateway";

/** An on-chain reference record — what gets written to the smart contract. */
export interface ChainReference {
  /**
   * Optional caller-supplied reference ID.
   * Adapters that control their own ID generation (e.g. mock, HTTP gateway) use
   * this as the stored and returned identifier. Adapters where the on-chain
   * protocol determines the ID (e.g. Midnight) ignore this field — the
   * chain-assigned ID is always returned.
   */
  refId?: string;
  /**
   * The storage content ID, base64url-encoded after client-side encryption.
   * (e.g. Arweave txId, encrypted before storage).
   * The encryption algorithm is recorded in encryptionScheme.
   * Absent for metadata-only references (registered without content).
   */
  storageId?: string;
  /**
   * Identifies the algorithm used to encrypt storageId and content.
   * "xchacha20poly1305-v1" — encrypted with XChaCha20-Poly1305 (per-upload random DEK).
   * "" or undefined — unencrypted; storageId and content are stored as plaintext (public data).
   */
  encryptionScheme?: EncryptionScheme;
  /** Storage network used */
  storageProvider: string;
  /** Timestamp of when the reference was written on-chain */
  writtenAt: number;
  /**
   * JSON-encoded KeyEnvelope containing the wrapped DEK (private) or ownerSeed (public).
   * Always a non-empty JSON string — private refs wrap the DEK, public refs wrap the ownerSeed.
   * Any KEK holder can unwrap the key and re-derive ownerSecret = HKDF(key, rawStorageId).
   */
  keyEnvelope: string;
  /**
   * Encrypted on-chain metadata. Base64url-encoded ciphertext produced by encrypting
   * `JSON.stringify(Record<string, string>)` with the content DEK and METADATA_AAD.
   * Absent for public uploads (no DEK).
   */
  encryptedMetadata?: string;
  /**
   * Pre-computed owner secret for ZK witness injection.
   * Derived by the core SDK as: HKDF-SHA256(dek, rawStorageId).
   * Internal use only — consumed by the chain adapter to set private state before proof generation.
   * Never stored on-chain.
   */
  ownerSecret?: Uint8Array;
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
  /** Encryption scheme recorded on-chain. null/"" = public/unencrypted; "xchacha20poly1305-v1" = encrypted. */
  encryptionScheme: EncryptionScheme | null;
  /** JSON-encoded KeyEnvelope wrapping the DEK (private) or ownerSeed (public). Always a non-empty string. */
  keyEnvelope: string;
  /**
   * Hex-encoded owner commitment stored on-chain.
   * The commitment itself is public, but does not reveal the owner's identity.
   */
  ownerCommitment: string;
  /**
   * Set when the core SDK cannot unwrap the keyEnvelope using the configured KEKs.
   * Undefined means ownership was verified (the caller can decrypt and manage this reference).
   * A non-undefined value means the reference is either owned by someone else or the key
   * has been rotated/corrupted — check the message for details.
   */
  decryptionError?: string;
  /**
   * Raw encrypted metadata ciphertext (base64url). Set by chain adapters when the
   * on-chain record contains an encryptedMetadata field. Core's listReferences()
   * decrypts this into the `metadata` field using the caller's DEK.
   */
  encryptedMetadata?: string;
  /**
   * Decrypted on-chain metadata. Populated by the core SDK when the caller owns the reference
   * and metadata was provided at upload time. Absent if no metadata was uploaded or decryption failed.
   */
  metadata?: Record<string, string>;
}

/**
 * Fields that can be updated in an existing reference.
 * All fields are optional — only the provided fields will override the stored values.
 * ownerCommitment is intentionally excluded; ownership cannot be transferred.
 */
export interface ChainReferenceUpdate {
  storageId: string;
  encryptionScheme: EncryptionScheme;
  storageProvider: string;
  writtenAt: number;
  /** JSON-encoded KeyEnvelope wrapping the DEK (private) or ownerSeed (public). Always a non-empty string. */
  keyEnvelope: string;
  /**
   * Encrypted on-chain metadata. Base64url-encoded ciphertext produced by encrypting
   * `JSON.stringify(Record<string, string>)` with the content DEK and METADATA_AAD.
   * Absent when no metadata was provided at upload time.
   */
  encryptedMetadata?: string;
}

/**
 * A cost quote returned by ChainAdapter.estimateCost().
 *
 * Quotes have a limited validity window. Real adapters may tighten
 * this window based on network fee volatility.
 */
export interface ChainQuote {
  /** Token this quote is denominated in */
  token: TokenSymbol;
  /** Amount in the native token (string to preserve precision) */
  amount: string;
  /** The network this quote is for. */
  network: string;
  /** Timestamp after which this quote should be refreshed */
  expiresAt: number;
}

/** Every chain adapter must implement this interface */
export interface ChainAdapter {
  readonly name: ChainProviderName;
  readonly providerName: string;

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

  /**
   * Get a cost estimate for a payload of the given size.
   */
  estimateCost(): Promise<ChainQuote>;

  /**
   * Remove a reference from the on-chain registry.
   * Only the owner can successfully call this — the chain enforces ownership via ZK proof.
   * ownerSecret: the HKDF-derived witness secret computed by the core SDK.
   * Optional — adapters that do not support removal can omit this method.
   */
  removeReference?(refId: string, ownerSecret?: Uint8Array): Promise<void>;

  /**
   * Update the mutable fields of an existing reference.
   * Only the owner can successfully call this — the chain enforces ownership via ZK proof.
   * Ownership (ownerCommitment) is preserved and cannot be changed.
   * ownerSecret: the HKDF-derived witness secret computed by the core SDK.
   * Optional — adapters that do not support updates can omit this method.
   */
  updateReference?(
    refId: string,
    update: ChainReferenceUpdate,
    ownerSecret?: Uint8Array,
  ): Promise<void>;
}
