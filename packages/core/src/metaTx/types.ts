/**
 * @dstorage/core — metaTx/types.ts
 *
 * All public interfaces and type aliases for the MetaTx orchestrator.
 */

import type { StorageAdapter } from "@dstorage/storage";
import type { ChainAdapter } from "@dstorage/chain";
import type { CryptoScheme, EncryptionScheme } from "@dstorage/crypto";
import type { CostEstimate, PaymentReceipt, TokenSymbol } from "./payment.js";

// ── Step definitions ──────────────────────────────────────────────────────────

export type MetaTxStepId =
  | "estimate"
  | "encrypt"
  | "payment_storage"
  | "upload"
  | "chain_reference"
  | "complete";

export type MetaTxStepStatus = "pending" | "running" | "done" | "error";

export interface MetaTxStepState {
  id: MetaTxStepId;
  label: string;
  description: string;
  status: MetaTxStepStatus;
  /** Live detail message updated during the step */
  detail?: string;
  /** Duration in ms (set when done) */
  durationMs?: number;
  startedAt?: number;
}

// ── Progress snapshot ─────────────────────────────────────────────────────────

export interface MetaTxProgress {
  steps: MetaTxStepState[];
  currentStepId: MetaTxStepId | null;
  overallStatus:
    | "idle"
    | "awaiting_confirmation"
    | "running"
    | "complete"
    | "error";
  /** Cost estimate — set after 'estimate' step completes */
  estimate?: CostEstimate;
  /** Final receipt — set when complete */
  receipt?: MetaTxReceipt;
  /** Error message if overallStatus is 'error' */
  error?: string;
}

// ── Final receipt ─────────────────────────────────────────────────────────────

export interface MetaTxReceipt {
  dataId: string;
  storageId: string;
  chainRefId: string;
  /** Original file info */
  file: {
    name: string;
    type: string;
    sizeBytes: number;
  };
  /** Payment receipts */
  storagePayment: PaymentReceipt;
  chainPayment: PaymentReceipt;
  /** Tokens used */
  storageToken: TokenSymbol;
  chainToken: TokenSymbol;
  /** Contract invoked (if selected) */
  contract?: {
    address: string;
    name: string;
  };
  completedAt: number;
  /** Duration of the full meta-transaction in ms */
  totalDurationMs: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface MetaTxConfig {
  /** Optional metadata to attach to the on-chain reference */
  metadata?: Record<string, string>;
  /** Selected contract address (from the contract registry) */
  contractAddress?: string;
  /** Selected contract name (for display / receipt) */
  contractName?: string;
}

// ── Upload crypto materials ───────────────────────────────────────────────────

/**
 * Crypto materials for a single upload: a fresh random DEK wrapped in a
 * key envelope, ready to encrypt payload and storageId.
 *
 * For private uploads: uploadScheme encrypts content; dek is the per-upload
 * Data Encryption Key used both to encrypt content AND to derive
 * ownerSecret = HKDF(dek, rawStorageId). Any KEK holder can re-derive the
 * ownerSecret by unwrapping the envelope DEK.
 * For public uploads: uploadScheme is null; ownerSeed is a random secret wrapped
 * under every KEK in keyEnvelope, and ownerSecret = HKDF(ownerSeed, rawStorageId).
 * Any single KEK holder can re-derive the ownerSecret by unwrapping the envelope.
 */
export interface UploadCrypto {
  /** XChaChaScheme built from a fresh random DEK. null for public uploads. */
  uploadScheme: CryptoScheme | null;
  /** JSON-encoded KeyEnvelope wrapping the DEK (private) or ownerSeed (public) under every KEK. */
  keyEnvelope: string;
  /** Encryption scheme identifier to record on-chain. "" for public uploads. */
  encryptionScheme: EncryptionScheme;
  /**
   * The raw per-upload DEK for private uploads; undefined for public uploads.
   * Used by MetaTx to derive ownerSecret = HKDF(dek, rawStorageId) after upload.
   * Not stored anywhere — must not be persisted.
   */
  dek?: Uint8Array;
  /**
   * The raw ownerSeed for public uploads; undefined for private uploads.
   * Used by MetaTx to derive ownerSecret = HKDF(ownerSeed, rawStorageId) after upload.
   * Not stored anywhere — must not be persisted.
   */
  ownerSeed?: Uint8Array;
}

// ── SDK context interface ─────────────────────────────────────────────────────

/**
 * Minimal SDK surface required by MetaTx.
 * Implemented by DStorage — MetaTx receives the SDK instance directly
 * rather than individual adapters/keys/address to avoid redundant constructor args.
 */
export interface DStorageContext {
  readonly storageAdapter: StorageAdapter;
  readonly chainAdapter: ChainAdapter;
  /** Wallet address of the connected user, or null if using init() / facade mode. */
  readonly connectedAddress: string | null;
  /**
   * Generate a fresh random DEK, wrap it under the KEK, and return the
   * upload crypto materials needed to encrypt payload and storageId.
   * @param isPublic  Pass true to skip encryption (returns null scheme + no envelope).
   */
  prepareUploadCrypto(isPublic?: boolean): Promise<UploadCrypto>;
}

// ── File validation result ────────────────────────────────────────────────────

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}
