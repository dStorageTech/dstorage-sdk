// Core SDK
export * from "./types.js";
export * from "./dStorage.js";
export * from "./metaTx/index.js";
export { CHUNK_SIZE, isManifest } from "./chunked.js";
export type { ChunkManifest, ChunkEntry } from "./chunked.js";

// Crypto + encryption adapters (lightweight, no heavy deps)
export * from "@dstorage/crypto";
export * from "@dstorage/encryption";

// Storage: types + mock only.
// Full package imports (not subpaths) so dts.resolve can inline type declarations.
// Tree-shaking via sideEffects:false drops unused adapters (arweave, autonomi, etc.).
export type {
  StorageAdapter,
  StorageAdapterLogger,
  StorageProviderName,
  StorageQuote,
  StorageUploadResult,
} from "@dstorage/storage";
export { MockStorageAdapter } from "@dstorage/storage";
export type { MockStorageAdapterConfig } from "@dstorage/storage";

// Payment: types + mock only
export type {
  PaymentAdapter,
  PaymentAdapterLogger,
  PaymentQuote,
  PaymentReceipt,
  NetworkType,
  TokenSymbol,
  Token,
  PaymentNetworkName,
  MidnightWalletProvider,
} from "@dstorage/payment";
export { MockPaymentAdapter, TOKENS } from "@dstorage/payment";

// Chain: types + mock only. MidnightChainAdapter is tree-shaken away (sideEffects:false).
export type {
  ChainAdapter,
  ChainProviderName,
  ChainReference,
  ChainReferenceUpdate,
  ChainWriteResult,
  ChainAdapterLogger,
  WalletBalances,
  DataReferenceSummary,
  ChainQuote,
} from "@dstorage/chain";
export { MockChainAdapter, MockMidnightChainAdapter } from "@dstorage/chain";
