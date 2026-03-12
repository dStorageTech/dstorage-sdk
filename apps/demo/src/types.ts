export type AppStep =
  | "connect"
  | "ready"
  | "upload"
  | "uploaded"
  | "prove"
  | "done";

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
  | "mock"
  | "arweave-local"
  | "arweave"
  | "autonomi";
export type ChainAdapterKey = "mock" | "midnight-connector";
export type PaymentAdapterKey = "local" | "managed";
