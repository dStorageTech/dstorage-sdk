/**
 * @dstorage/core — metaTransaction.ts
 *
 * The MetaTransaction orchestrator.
 *
 * Presents a single conceptual action to the user while internally executing:
 *   [0] Estimate   → compute storage + chain costs
 *   [1] Encrypt    → AES-GCM encrypt the file client-side
 *   [2] PayStorage → simulate storage payment (AR / ANT / MOCK)
 *   [3] Upload     → upload encrypted blob to decentralised storage
 *   [4] PayChain   → simulate chain transaction fee payment
 *   [5] Reference  → write CID + metadata reference on-chain
 *   [✓] Complete   → return full receipt
 *
 * Usage:
 *   const metaTx = new MetaTransaction(dStorage);
 *   metaTx.onProgress((progress) => updateUI(progress));
 *   const receipt = await metaTx.execute(file);
 */

import { encrypt, serializePayload } from "@dstorage/crypto";
import type { StorageAdapter } from "@dstorage/storage";
import type { ChainAdapter } from "@dstorage/chain";
import type { PaymentAdapter } from "@dstorage/payment";
import { MockPaymentAdapter } from "@dstorage/payment";
import {
  buildCostEstimate,
  defaultChainToken,
} from "./payment.js";
import type { CostEstimate, PaymentReceipt, TokenSymbol } from "./payment.js";

// ── Step definitions ──────────────────────────────────────────────────────────

export type MetaTxStepId =
  | "estimate"
  | "encrypt"
  | "payment_storage"
  | "upload"
  | "payment_chain"
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
    sizeDisplay: string;
  };
  /** Payment receipts */
  storagePayment: PaymentReceipt;
  chainPayment: PaymentReceipt;
  /** Tokens used */
  storageToken: TokenSymbol;
  chainToken: TokenSymbol;
  /** Total cost in USD */
  totalUsd: string;
  /** Contract invoked (if selected) */
  contract?: {
    address: string;
    name: string;
  };
  /** Circuit invoked on the contract (if selected) */
  circuit?: {
    id: string;
    name: string;
  };
  completedAt: number;
  /** Duration of the full meta-transaction in ms */
  totalDurationMs: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface MetaTxConfig {
  /**
   * @deprecated Token is now determined by the payment adapter's `token` property.
   * Pass a configured payment adapter via DStorageConfig.chainPaymentAdapter instead.
   */
  chainToken?: TokenSymbol;
  /** Optional metadata to attach to the on-chain reference */
  metadata?: Record<string, string>;
  /** Selected contract address (from the contract registry) */
  contractAddress?: string;
  /** Selected contract name (for display / receipt) */
  contractName?: string;
  /** Selected circuit id to invoke on the contract */
  circuitId?: string;
  /** Selected circuit name (for display / receipt) */
  circuitName?: string;
}

// ── SDK context interface ─────────────────────────────────────────────────────

/**
 * Minimal SDK surface required by MetaTransaction.
 * Implemented by DStorage — MetaTransaction receives the SDK instance directly
 * rather than individual adapters/keys/address to avoid redundant constructor args.
 */
export interface DStorageContext {
  readonly storageAdapter: StorageAdapter;
  readonly chainAdapter: ChainAdapter;
  readonly chainPaymentAdapter: PaymentAdapter | undefined;
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
   * Returns the encrypted form (80-char base64url) when a storageIdKey is available,
   * or the original id unchanged when not connected / no key.
   */
  encryptStorageIdForChain(storageId: string): Promise<string | null>;
}

// ── File validation ───────────────────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "application/json",
  // Archives
  "application/zip",
]);

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}

export function validateFile(file: File): FileValidationResult {
  if (file.size === 0) {
    return { valid: false, error: "File is empty." };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return {
      valid: false,
      error: `File too large: ${mb} MB. Maximum is 10 MB.`,
    };
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return {
      valid: false,
      error: `File type not supported: ${file.type || "unknown"}. Allowed: images, PDF, text, JSON, ZIP.`,
    };
  }
  return { valid: true };
}

// ── Initial step states ───────────────────────────────────────────────────────

function buildInitialSteps(): MetaTxStepState[] {
  return [
    {
      id: "estimate",
      label: "Estimate Costs",
      description: "Calculate storage fee + chain transaction fee",
      status: "pending",
    },
    {
      id: "encrypt",
      label: "Encrypt File",
      description: "Client side encryption using your wallet key",
      status: "pending",
    },
    {
      id: "payment_storage",
      label: "Storage Payment",
      description: "Pay storage network fee",
      status: "pending",
    },
    {
      id: "upload",
      label: "Upload to Storage",
      description: "Send encrypted file to decentralised network",
      status: "pending",
    },
    {
      id: "payment_chain",
      label: "Chain Fee Payment",
      description: "Pay blockchain transaction fee",
      status: "pending",
    },
    {
      id: "chain_reference",
      label: "Write On-Chain Reference",
      description: "Store file pointer + metadata on blockchain",
      status: "pending",
    },
    {
      id: "complete",
      label: "Complete",
      description: "Meta-transaction finalised",
      status: "pending",
    },
  ];
}

// ── MetaTransaction class ─────────────────────────────────────────────────────

export class MetaTransaction {
  private sdk: DStorageContext;
  private storagePaymentAdapter: PaymentAdapter;
  private chainPaymentAdapter: PaymentAdapter;
  private progressCallback: ((p: MetaTxProgress) => void) | null = null;
  private steps: MetaTxStepState[] = buildInitialSteps();
  private startedAt = 0;

  constructor(sdk: DStorageContext) {
    this.sdk = sdk;

    // Storage payment adapter is owned by the storage adapter itself.
    this.storagePaymentAdapter = sdk.storageAdapter.paymentAdapter;
    // Chain payment adapter can be overridden via DStorageConfig; falls back to Mock.
    this.chainPaymentAdapter =
      sdk.chainPaymentAdapter ??
      new MockPaymentAdapter({
        type: "chain",
        token: defaultChainToken(sdk.chainAdapter.name),
      });
  }

  /** Register a progress listener. Called after every step state change. */
  onProgress(cb: (progress: MetaTxProgress) => void): this {
    this.progressCallback = cb;
    return this;
  }

  // ── Public: execute the full meta-transaction ─────────────────────────────

  async execute(file: File, config: MetaTxConfig = {}): Promise<MetaTxReceipt> {
    this.startedAt = Date.now();
    this.steps = buildInitialSteps();

    this.emit({ overallStatus: "running" });

    try {
      // ── Step 0: Estimate ────────────────────────────────────────────────
      this.startStep("estimate", "Analysing file and fetching price feeds…");

      // Fetch quotes from both payment adapters in parallel — they are independent.
      const [storageQuote, chainQuote] = await Promise.all([
        this.storagePaymentAdapter.estimateCost(file.size),
        this.chainPaymentAdapter.estimateCost(file.size),
      ]);

      const estimate = buildCostEstimate(storageQuote, chainQuote, file.size);
      await sleep(400); // Realistic pause
      this.completeStep("estimate", `~$${estimate.totalUsd} USD total`);
      this.emit({ overallStatus: "running", estimate });

      // ── Step 1: Encrypt ─────────────────────────────────────────────────
      this.startStep("encrypt", "Reading file bytes…");
      const fileBytes = await readFileAsBytes(file);
      this.updateStepDetail("encrypt", "Encrypting with AES-GCM 256…");

      // Encrypt the payload if key is available; otherwise store raw bytes
      const uploadData =
        (await this.sdk.encryptPayload(fileBytes)) ?? fileBytes;

      this.completeStep(
        "encrypt",
        `${estimate.fileSizeDisplay} encrypted (${(uploadData.byteLength / 1024).toFixed(1)} KB ciphertext)`,
      );

      // Build upload metadata once — used by both provideUploadData and upload().
      const uploadMetadata: Record<string, string> = {
        "dstorage-version": "0.1.0",
        "dstorage-owner": this.sdk.connectedAddress ?? "",
        "dstorage-filename": file.name,
        "dstorage-filetype": file.type,
        "dstorage-filesize": String(file.size),
        ...(config.contractAddress
          ? { "dstorage-contract": config.contractAddress }
          : {}),
        ...(config.circuitId ? { "dstorage-circuit": config.circuitId } : {}),
        ...(config.metadata ?? {}),
      };

      // If the storage payment adapter needs the data to build and sign the
      // payment transaction before broadcasting (e.g. Arweave), provide it now.
      if (this.storagePaymentAdapter.provideUploadData) {
        this.storagePaymentAdapter.provideUploadData(uploadData, uploadMetadata);
      }

      // ── Step 2: Storage payment ─────────────────────────────────────────
      this.startStep(
        "payment_storage",
        `Preparing ${storageQuote.amount} ${storageQuote.token} payment…`,
      );

      const storageReceipt = await this.storagePaymentAdapter.pay(
        storageQuote,
        (msg) => this.updateStepDetail("payment_storage", msg),
      );

      this.completeStep(
        "payment_storage",
        `${storageReceipt.amount} ${storageReceipt.token} ≈ $${storageReceipt.fiat_amount}`,
      );

      // ── Step 3: Upload ──────────────────────────────────────────────────
      this.startStep("upload", `Uploading to ${this.sdk.storageAdapter.name}…`);

      // Pass the same metadata to upload(). Storage adapters that consumed a
      // pre-signed transaction (Arweave sign-then-post flow) will ignore it;
      // others (Mock, Autonomi) use it to attach metadata to the upload.
      const uploadResult = await this.sdk.storageAdapter.upload(
        uploadData,
        uploadMetadata,
      );

      this.completeStep(
        "upload",
        `Stored on ${uploadResult.provider} → ${truncateId(uploadResult.id)}`,
      );

      // ── Step 4: Chain fee payment ────────────────────────────────────────
      this.startStep(
        "payment_chain",
        `Preparing ${chainQuote.amount} ${chainQuote.token} transaction…`,
      );

      const chainReceipt = await this.chainPaymentAdapter.pay(
        chainQuote,
        (msg) => this.updateStepDetail("payment_chain", msg),
      );

      this.completeStep(
        "payment_chain",
        `${chainReceipt.amount} ${chainReceipt.token} ≈ $${chainReceipt.fiat_amount}`,
      );

      // ── Step 5: On-chain reference ───────────────────────────────────────
      this.startStep(
        "chain_reference",
        `Writing reference to ${this.sdk.chainAdapter.name}…`,
      );

      const chainResult = await this.sdk.chainAdapter.writeReference({
        storageId:
          (await this.sdk.encryptStorageIdForChain(uploadResult.id)) ??
          uploadResult.id,
        storageProvider: uploadResult.provider,
        dataLabel: file.name,
        writtenAt: Date.now(),
      });

      const circuitLabel = config.circuitName
        ? ` via ${config.circuitName}`
        : "";
      const contractLabel = config.contractName
        ? ` on ${config.contractName}`
        : "";

      this.completeStep(
        "chain_reference",
        `Reference confirmed${contractLabel}${circuitLabel} → ${truncateId(chainResult.refId)}`,
      );

      // ── Step 6: Complete ─────────────────────────────────────────────────
      const dataId = `${uploadResult.id}::${chainResult.refId}`;
      const totalDurationMs = Date.now() - this.startedAt;

      this.completeStep(
        "complete",
        `Completed in ${(totalDurationMs / 1000).toFixed(1)}s`,
      );

      const receipt: MetaTxReceipt = {
        dataId,
        storageId: uploadResult.id,
        chainRefId: chainResult.refId,
        file: {
          name: file.name,
          type: file.type,
          sizeBytes: file.size,
          sizeDisplay: estimate.fileSizeDisplay,
        },
        storagePayment: storageReceipt,
        chainPayment: chainReceipt,
        storageToken: storageReceipt.token,
        chainToken: chainReceipt.token,
        totalUsd: estimate.totalUsd,
        ...(config.contractAddress
          ? {
              contract: {
                address: config.contractAddress,
                name: config.contractName ?? config.contractAddress,
              },
            }
          : {}),
        ...(config.circuitId
          ? {
              circuit: {
                id: config.circuitId,
                name: config.circuitName ?? config.circuitId,
              },
            }
          : {}),
        completedAt: Date.now(),
        totalDurationMs,
      };

      this.emit({ overallStatus: "complete", estimate, receipt });
      return receipt;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mark the currently running step as errored
      const runningStep = this.steps.find((s) => s.status === "running");
      if (runningStep) {
        runningStep.status = "error";
        runningStep.detail = message;
      }
      this.emit({ overallStatus: "error", error: message });
      throw err;
    }
  }

  // ── Private step helpers ──────────────────────────────────────────────────

  private startStep(id: MetaTxStepId, detail: string): void {
    const step = this.getStep(id);
    step.status = "running";
    step.detail = detail;
    step.startedAt = Date.now();
    this.emit({ overallStatus: "running", currentStepId: id });
  }

  private updateStepDetail(id: MetaTxStepId, detail: string): void {
    const step = this.getStep(id);
    step.detail = detail;
    this.emit({ overallStatus: "running", currentStepId: id });
  }

  private completeStep(id: MetaTxStepId, detail: string): void {
    const step = this.getStep(id);
    step.status = "done";
    step.detail = detail;
    if (step.startedAt) step.durationMs = Date.now() - step.startedAt;
    this.emit({ overallStatus: "running", currentStepId: id });
  }

  private getStep(id: MetaTxStepId): MetaTxStepState {
    const step = this.steps.find((s) => s.id === id);
    if (!step) throw new Error(`Unknown step: ${id}`);
    return step;
  }

  private emit(overrides: Partial<Omit<MetaTxProgress, "steps">>): void {
    if (!this.progressCallback) return;
    const currentRunning = this.steps.find((s) => s.status === "running");
    this.progressCallback({
      steps: [...this.steps.map((s) => ({ ...s }))],
      currentStepId: currentRunning?.id ?? overrides.currentStepId ?? null,
      overallStatus: "running",
      ...overrides,
    });
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncateId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

async function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsArrayBuffer(file);
  });
}
