/**
 * @dstorage/core — metaTx/MetaTx.ts
 *
 * The MetaTx orchestrator.
 *
 * Presents a single conceptual action to the user while internally executing:
 *   [0] Estimate   → compute storage + chain costs
 *   [1] Encrypt    → AES-GCM encrypt the file client-side
 *   [2] PayStorage → simulate storage payment (AR / ANT / MOCK)
 *   [3] Upload     → upload encrypted blob to decentralised storage
 *   [4] Reference  → pay chain fee + write CID + metadata reference on-chain
 *   [✓] Complete   → return full receipt
 *
 * Usage:
 *   const metaTx = new MetaTx(dStorage);
 *   metaTx.onProgress((progress) => updateUI(progress));
 *   const receipt = await metaTx.execute(file);
 */

import type { EncryptionScheme } from "@dstorage/crypto";
import { buildCostEstimate } from "./payment.js";
import type {
  DStorageContext,
  MetaTxConfig,
  MetaTxProgress,
  MetaTxReceipt,
  MetaTxStepId,
  MetaTxStepState,
} from "./types.js";
import {
  buildInitialSteps,
  readFileAsBytes,
  sleep,
  truncateId,
} from "./utils.js";

export class MetaTx {
  private sdk: DStorageContext;
  private progressCallback: ((p: MetaTxProgress) => void) | null = null;
  private steps: MetaTxStepState[] = buildInitialSteps();
  private startedAt = 0;

  constructor(sdk: DStorageContext) {
    this.sdk = sdk;
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
        this.sdk.storageAdapter.paymentAdapter.estimateCost(file.size),
        this.sdk.chainAdapter.estimateCost(),
      ]);

      const estimate = buildCostEstimate(storageQuote, chainQuote, file.size);
      await sleep(400); // Realistic pause
      this.completeStep(
        "estimate",
        `${estimate.storageCost.amount} ${estimate.storageCost.token} + ${estimate.chainCost.amount} ${estimate.chainCost.token}`,
      );
      this.emit({ overallStatus: "running", estimate });

      // ── Step 1: Encrypt ─────────────────────────────────────────────────
      this.startStep("encrypt", "Reading file bytes…");
      const fileBytes = await readFileAsBytes(file);
      this.updateStepDetail("encrypt", "Encrypting with AES-GCM 256…");

      // Encrypt the payload if key is available; otherwise store raw bytes
      const uploadData =
        (await this.sdk.encryptPayload(fileBytes)) ?? fileBytes;

      // Let's create a human-readable file size, e.g. "1.2 MB" or "340.0 KB"
      const fileSizeMB = file.size / (1024 * 1024);
      const fileSizeDisplay =
        fileSizeMB < 1.1
          ? `${(file.size / 1024).toFixed(2)} KB`
          : `${fileSizeMB.toFixed(2)} MB`;
      this.completeStep(
        "encrypt",
        `${fileSizeDisplay} encrypted (${(uploadData.byteLength / 1024).toFixed(2)} KB ciphertext)`,
      );

      // Build upload metadata once — used by both provideUploadData and upload().
      const uploadMetadata: Record<string, string> = {
        "dstorage-version": "0.1.0",
        "dstorage-filename": file.name,
        "dstorage-filetype": file.type,
        "dstorage-filesize": String(file.size),
        ...(config.metadata ?? {}),
      };

      // If the storage payment adapter needs the data to build and sign the
      // payment transaction before broadcasting (e.g. Arweave), provide it now.
      if (this.sdk.storageAdapter.paymentAdapter.provideUploadData) {
        this.sdk.storageAdapter.paymentAdapter.provideUploadData(
          uploadData,
          uploadMetadata,
        );
      }

      // ── Step 2: Storage payment ─────────────────────────────────────────
      this.startStep(
        "payment_storage",
        `Preparing ${storageQuote.amount} ${storageQuote.token} payment…`,
      );

      const storageReceipt = await this.sdk.storageAdapter.paymentAdapter.pay(
        storageQuote,
        (msg) => this.updateStepDetail("payment_storage", msg),
      );

      this.completeStep(
        "payment_storage",
        `${storageReceipt.amount} ${storageReceipt.token}`,
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

      // ── Step 4: On-chain fee payment and write reference ────────────────
      this.startStep(
        "chain_reference",
        `Fee payment and writing reference to ${this.sdk.chainAdapter.name}…`,
      );

      const encryptedStorageId = await this.sdk.encryptStorageIdForChain(
        uploadResult.id,
      );
      const onChainStorageId = encryptedStorageId ?? uploadResult.id;
      const encryptionScheme: EncryptionScheme = encryptedStorageId
        ? this.sdk.defaultEncryptionScheme
        : "";

      const chainResult = await this.sdk.chainAdapter.writeReference({
        storageId: onChainStorageId,
        encryptionScheme,
        storageProvider: uploadResult.provider,
        dataLabel: file.name,
        writtenAt: Date.now(),
        isOurs: true,
      });

      // If the chain adapter handled payment internally (e.g. Midnight managed
      // payment embedded in the transaction), use that receipt instead.
      const finalChainReceipt = chainResult.paymentReceipt ?? {
        amount: "<unknown>",
        token: chainQuote.token,
        txHash: "",
        type: "chain",
        paidAt: 0,
      };

      this.completeStep(
        "chain_reference",
        `Reference written → ${finalChainReceipt.amount} ${finalChainReceipt.token} → ${truncateId(chainResult.refId)}`,
      );

      // ── Step 5: Complete ─────────────────────────────────────────────────
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
        },
        storagePayment: storageReceipt,
        chainPayment: finalChainReceipt,
        storageToken: storageReceipt.token,
        chainToken: finalChainReceipt.token,
        ...(config.contractAddress
          ? {
              contract: {
                address: config.contractAddress,
                name: config.contractName ?? config.contractAddress,
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
