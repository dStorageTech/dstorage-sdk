import type { CostEstimate, StoreResult } from "@dstorage-tech/dstorage-sdk";

export type AppStep =
  "connect" | "ready" | "upload" | "uploaded" | "prove" | "done";

export interface StoredRecord {
  dataId: string;
  storageId: string | null;
  refId: string;
  fileName: string;
  uploadedAt: number;
  chainRefId: string;
}

export type ThemeMode = "light" | "dark";

export type PendingCertificate = {
  record: StoredRecord;
  refId: string;
  storageId: string | null;
  chainLabel: string;
  previewKind: "text" | "pdf" | "binary";
  preview: string;
  truncated: boolean;
  bytesLength: number;
  pdfUrl?: string;
};

export type StorageAdapterKey =
  "mock" | "arweave-local" | "arweave" | "arweave-bundler";
export type ChainAdapterKey = "mock" | "midnight-connector";
export type PaymentAdapterKey = "local" | "managed";

// ── Upload pipeline (drawer UI) ────────────────────────────────────────────────

export type UploadStepId =
  "estimate" | "store" | "chain_reference" | "complete";
export type UploadStepStatus = "pending" | "running" | "done" | "error";

export interface UploadStepState {
  id: UploadStepId;
  status: UploadStepStatus;
}

/**
 * Local drawer-display state for the SDK's `store()` call. Rebuilt from the
 * signals `store()` actually exposes: the pre-flight `estimateCost()` result,
 * the single `onProgress({ phase: "stored" })` event fired after the storage
 * write (before the chain write), and the final resolved `StoreResult`.
 */
export interface UploadProgress {
  steps: UploadStepState[];
  overallStatus: "running" | "complete" | "error";
  /** Cost estimate — set once estimateCost() resolves. */
  estimate?: CostEstimate;
  /** Final result — set when store() resolves. */
  result?: StoreResult;
  dataId?: string;
}
