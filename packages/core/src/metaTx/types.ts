/**
 * @dstorage/core — metaTx/types.ts
 *
 * All public interfaces and type aliases for the MetaTx orchestrator.
 */

import type { StorageAdapter } from "@dstorage/storage";
import type { ChainAdapter } from "@dstorage/chain";
import type { EncryptionScheme } from "@dstorage/crypto";
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
   * Encrypt raw payload bytes with the active client-side key and serialize them
   * into the SDK wire format expected by storage adapters.
   * Returns null when no encryption key is available.
   */
  encryptPayload(bytes: Uint8Array): Promise<Uint8Array | null>;
  /**
   * Encrypts a plain storageId (43-char base64url) for on-chain storage.
   * Returns the encrypted form when a key is available, null otherwise.
   */
  encryptStorageIdForChain(storageId: string): Promise<string | null>;
  /**
   * The encryption scheme used for new writes (e.g. "xchacha20poly1305-v1").
   * Must be recorded on-chain alongside the encrypted storageId so the SDK
   * can dispatch the correct decryption scheme on read.
   * Empty string "" when no encryption is active.
   */
  readonly defaultEncryptionScheme: EncryptionScheme;
}

// ── File validation result ────────────────────────────────────────────────────

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}
