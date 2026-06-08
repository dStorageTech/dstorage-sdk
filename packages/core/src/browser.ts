// Core SDK
export * from "./types.js";
export * from "./dStorage.js";
export * from "./metaTx/index.js";
export { CHUNK_SIZE, isManifest } from "./chunked.js";
export type { ChunkManifest, ChunkEntry } from "./chunked.js";

// Crypto + encryption (always browser-safe)
export * from "@dstorage/crypto";
export * from "@dstorage/encryption";

// Storage: types + all adapters.
export type {
  StorageAdapter,
  StorageAdapterLogger,
  StorageProviderName,
  StorageQuote,
  StorageUploadResult,
} from "@dstorage/storage";
export { MockStorageAdapter } from "@dstorage/storage";
export type { MockStorageAdapterConfig } from "@dstorage/storage";
export { ArweaveStorageAdapter } from "@dstorage/storage";
export { ArweaveTurboStorageAdapter } from "@dstorage/storage";
export { AutonomiStorageAdapter } from "@dstorage/storage";
// ArweaveLocalStorageAdapter: no node:http dependency — uses fetch() throughout.
// Requires arlocal running at a browser-reachable URL (CORS enabled).
export {
  ArweaveLocalStorageAdapter,
  ArweaveLocalHelper,
  ARWEAVE_LOCAL,
  arlocalGateway,
  ArweaveLocalError,
} from "@dstorage/storage";
export type {
  ArweaveLocalAdapterConfig,
  ArweaveLocalHelperConfig,
  ArweaveLocalInfo,
  ArweaveLocalBalance,
} from "@dstorage/storage";

// Payment: types + all browser-safe adapters
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
export { ArweavePaymentAdapter } from "@dstorage/payment";
export { ManagedPaymentAdapter } from "@dstorage/payment";

// Chain: browser-safe entry (mocks + HttpGateway + MidnightChainAdapter connector mode).
// MidnightChainAdapter provider/facade mode (uses node:fs) is excluded via the /browser subpath.
export * from "@dstorage/chain/browser";
